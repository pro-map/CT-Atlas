// Which exchange is an exchange-like wallet likely to belong to? The automatic
// trace (crypto.js) stops a branch at a wallet whose behaviour scores as an
// exchange (exchange-behavior.mjs) and sends those wallets here, with what the
// trace saw around them: their behaviour metrics, their labelled neighbours,
// the assets they move. Gemini returns its best estimate of the operator,
// a confidence, the basis and the alternatives -- an AI-assessed lead, never
// a sourced attribution: the page and the report say so.
import {
  GEMINI_URL,
  cleanText,
  jsonResponse,
  gateCall,
  normalizeUsername,
  isAllowedUser,
  extractGeminiText,
  geminiModelRotation,
  waitBeforeGeminiRetry,
  GEMINI_SECOND_FALLBACK_MODEL
} from "./shared.js";

const EXCHANGE_ATTRIBUTION_VERSION = "exchange-attribution-v1";
const ATTRIBUTION_MODEL = "gemini-3.5-flash-lite";
const MAX_WALLETS = 8;
const MAX_NEIGHBOURS = 12;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHAINS = new Set(["bitcoin", "ethereum", "bsc", "polygon", "arbitrum", "base", "tron"]);
const CONFIDENCE = new Set(["low", "moderate", "high"]);

const INSTRUCTION = `
You are a blockchain-intelligence analyst. For each wallet below, an automatic
trace stopped because the wallet behaves like an exchange (high throughput,
many distinct counterparties, bidirectional flows, many assets). Assess:

1. service_type: what the wallet most likely is -- "exchange_hot_wallet",
   "exchange_deposit_address", "exchange_cold_wallet", "otc_desk",
   "payment_processor", "bridge", "mixer", "defi_protocol", or "unknown".
2. likely_exchange: the operator you assess as most likely (e.g. "Binance",
   "OKX", "HTX", "Bybit", "Kraken", "Coinbase", "KuCoin", "Gate.io"...), or
   "Unknown" when nothing supports a name.
3. confidence: "high" only when you recognise the exact address as a publicly
   documented wallet of that operator or several labelled wallets of the same
   operator surround it; "moderate" when the labelled neighbours or the
   operator's well-known patterns on this chain point to it; otherwise "low".
4. basis: 1-4 short reasons, each naming the evidence it rests on (a
   labelled neighbour, the address itself, the asset mix, the chain,
   the behaviour metrics).
5. alternatives: up to 3 other plausible operators or service types.

Rules: use the supplied evidence and your knowledge of publicly documented
exchange wallets and patterns. Never invent a label for a neighbour. If the
evidence is thin, say "Unknown" with low confidence rather than guessing a
famous name. This is an investigative lead, not an attribution: it does not
establish control or ownership.
`;

const SCHEMA = {
  type: "object",
  properties: {
    wallets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          address: { type: "string" },
          service_type: { type: "string" },
          likely_exchange: { type: "string" },
          confidence: { type: "string" },
          basis: { type: "array", items: { type: "string" } },
          alternatives: { type: "array", items: { type: "string" } }
        },
        required: ["address", "service_type", "likely_exchange", "confidence", "basis"]
      }
    }
  },
  required: ["wallets"]
};

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The wallets as the page sent them, bounded and cleaned: nothing else
// reaches the prompt.
function parseWallets(value, chain) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const address = cleanText(item?.address, 120);
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const metrics = item?.metrics && typeof item.metrics === "object" ? item.metrics : {};
    out.push({
      address,
      hop: Math.max(0, Math.min(9, Math.trunc(number(item?.hop)))),
      behaviour_score: Math.max(0, Math.min(100, Math.trunc(number(item?.score)))),
      behaviour_evidence: (Array.isArray(item?.evidence) ? item.evidence : []).slice(0, 8).map(text => cleanText(text, 160)).filter(Boolean),
      metrics: Object.fromEntries(Object.entries(metrics).slice(0, 12).map(([key, val]) => [cleanText(key, 40), number(val)])),
      assets: (Array.isArray(item?.assets) ? item.assets : []).slice(0, 12).map(asset => cleanText(asset, 24)).filter(Boolean),
      related_exchange: cleanText(item?.related_exchange, 80),
      labelled_neighbours: (Array.isArray(item?.labelled_neighbours) ? item.labelled_neighbours : []).slice(0, MAX_NEIGHBOURS)
        .map(neighbour => ({
          address: cleanText(neighbour?.address, 120),
          name: cleanText(neighbour?.name, 80),
          category: cleanText(neighbour?.category, 40),
          source: cleanText(neighbour?.source, 80)
        }))
        .filter(neighbour => neighbour.address && neighbour.name)
    });
    if (out.length >= MAX_WALLETS) break;
  }
  return out;
}

function sanitizeAttribution(raw, wallets) {
  const byAddress = new Map((Array.isArray(raw?.wallets) ? raw.wallets : [])
    .map(item => [cleanText(item?.address, 120).toLowerCase(), item]));
  return wallets.map(wallet => {
    const item = byAddress.get(wallet.address.toLowerCase()) || {};
    const confidence = cleanText(item.confidence, 12).toLowerCase();
    const likely = cleanText(item.likely_exchange, 60) || "Unknown";
    return {
      address: wallet.address,
      service_type: cleanText(item.service_type, 40) || "unknown",
      likely_exchange: likely,
      confidence: CONFIDENCE.has(confidence) ? confidence : "low",
      basis: (Array.isArray(item.basis) ? item.basis : []).slice(0, 4).map(text => cleanText(text, 220)).filter(Boolean),
      alternatives: (Array.isArray(item.alternatives) ? item.alternatives : []).slice(0, 3).map(text => cleanText(text, 60)).filter(Boolean),
      assessed: true
    };
  });
}

async function callAttributionModel(env, input) {
  const rotation = geminiModelRotation([ATTRIBUTION_MODEL, GEMINI_SECOND_FALLBACK_MODEL]);
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const model = rotation.next();
    let response;
    try {
      response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, input, system_instruction: INSTRUCTION, store: false,
          response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
          generation_config: { max_output_tokens: 3000, thinking_level: "minimal" }
        })
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) { await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1); continue; }
      throw lastError;
    }
    if (response.status === 429 || response.status >= 500) {
      if (response.status === 429) rotation.spent(model);
      lastError = new Error(`Gemini temporarily unavailable (${response.status}).`);
      if (attempt < maxAttempts - 1) { await waitBeforeGeminiRetry(attempt, response, maxAttempts - 1); continue; }
      throw lastError;
    }
    if (!response.ok) throw new Error(`Gemini error ${response.status}.`);
    try {
      const raw = (await extractGeminiText(await response.json())).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      return JSON.parse(raw);
    } catch (_) {
      lastError = new Error("Gemini's attribution could not be read.");
      if (attempt < maxAttempts - 1) { await waitBeforeGeminiRetry(attempt, null, maxAttempts - 1); continue; }
      throw lastError;
    }
  }
  throw lastError || new Error("Gemini attribution failed.");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleExchangeAttribution(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
  const username = normalizeUsername(body?.user_id);
  if (!username || !isAllowedUser(username, env)) return jsonResponse({ error: "Unknown or missing user." }, 400, env);
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return jsonResponse({ error: "Authenticated session required." }, 401, env);
  const session = await gateCall(env, "/session-get", { session_token: token }).then(r => r.json().then(p => ({ ok: r.ok, p }))).catch(() => ({ ok: false }));
  if (!session.ok || session.p?.username !== username) return jsonResponse({ error: "Unauthorized session." }, 401, env);

  const chain = cleanText(body?.chain, 20).toLowerCase();
  if (!CHAINS.has(chain)) return jsonResponse({ error: "Unsupported chain." }, 400, env);
  const wallets = parseWallets(body?.wallets, chain);
  if (!wallets.length) return jsonResponse({ version: EXCHANGE_ATTRIBUTION_VERSION, attributions: [] }, 200, env);
  if (!env.GEMINI_API_KEY) return jsonResponse({ error: "AI attribution is not configured." }, 503, env);

  const cacheKey = "exchange-attribution:" + await sha256Hex(EXCHANGE_ATTRIBUTION_VERSION + "|" + chain + "|" + JSON.stringify(wallets));
  const cached = await gateCall(env, "/cache-get", { cacheKey }).then(r => r.json()).catch(() => ({}));
  if (cached?.hit && cached.report) return jsonResponse({ ...cached.report, cached: true }, 200, env);

  try {
    const raw = await callAttributionModel(env, "Chain: " + chain + "\nWallets:\n" + JSON.stringify(wallets));
    const payload = {
      version: EXCHANGE_ATTRIBUTION_VERSION,
      model: ATTRIBUTION_MODEL,
      attributions: sanitizeAttribution(raw, wallets),
      note: "AI-assessed investigative lead from behaviour, labelled neighbours and publicly documented patterns. Not a sourced attribution; it does not establish control or ownership."
    };
    await gateCall(env, "/cache-put", { cacheKey, report: payload, expires_at: Date.now() + CACHE_TTL_MS }).catch(() => {});
    return jsonResponse(payload, 200, env);
  } catch (error) {
    return jsonResponse({ error: cleanText(error?.message, 200) || "AI attribution failed." }, 502, env);
  }
}

export {
  EXCHANGE_ATTRIBUTION_VERSION,
  MAX_WALLETS,
  parseWallets,
  sanitizeAttribution,
  handleExchangeAttribution
};
