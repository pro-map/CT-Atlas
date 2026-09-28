import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

const EXCHANGE_ADDRESS_VERSION = "crypto-exchange-addresses-v1";
const EVM_CHAIN_IDS = Object.freeze({ ethereum: "1", bsc: "56", polygon: "137", arbitrum: "42161", base: "8453" });
const EVM_CHAINS = new Set(Object.keys(EVM_CHAIN_IDS));
const CHAIN_SET = new Set(["bitcoin", "ethereum", "bsc", "polygon", "arbitrum", "base", "tron"]);
const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/i;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BTC_ADDRESS_RE = /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{24,33})$/i;
const MAX_LOOKUP_ADDRESSES = 100;
const OFFICIAL_SEED_LABELS = Object.freeze([
  ...[
    "bc1qpy4jwethqenp4r7hqls660wy8287vw0my32lmy",
    "3LhhDLBVWBZChNQv8Dn4nDKFnCyojG1FqN",
    "3QsGsAXQ4rqRNvh5pEW55hf3F9PEyb7rVq",
    "bc1qr4dl5wa7kl8yu792dceg9z5knl2gkn220lk7a9",
    "bc1q4c8n5t00jmj8temxdgcc3t32nkg2wjwz24lywv",
    "14m3sd9HCCFJW4LymahJCKMabAxTK4DAqW"
  ].map(address => ({ chain: "bitcoin", address })),
  ...[
    "0x72A53cDBBcc1b9efa39c834A540550e23463AAcB",
    "0x7758e507850da48cd47df1fb5f875c23e3340c50",
    "0xcffad3200574698b78f32232aa9d63eabd290703",
    "0x6262998Ced04146fA42253a5C0AF90CA02dfd2A3"
  ].map(address => ({ chain: "ethereum", address }))
].map(entry => ({
  ...entry,
  name: "Crypto.com",
  wallet_role: "COLD_WALLET",
  confidence: "MEDIUM",
  source_type: "Official exchange disclosure",
  source_title: "Crypto.com cold wallet addresses (11 Nov 2022)",
  source_url: "https://crypto.com/en/company-news/transparency-first",
  notes: "Explicitly published by Crypto.com as a cold wallet address. Historical disclosure from 11 Nov 2022; Crypto.com said this list represented only a portion of its reserves. Verify current control before relying on it."
})));

function normalizeChain(value) {
  const chain = cleanText(value, 24).toLowerCase();
  return CHAIN_SET.has(chain) ? chain : "";
}

function normalizeAddress(chain, value) {
  const address = cleanText(value, 180);
  if (!address) return "";
  if (EVM_CHAINS.has(chain)) return address.toLowerCase();
  return address;
}

function validAddress(chain, address) {
  if (!chain || !address) return false;
  if (EVM_CHAINS.has(chain)) return EVM_ADDRESS_RE.test(address);
  if (chain === "tron") return TRON_ADDRESS_RE.test(address);
  if (chain === "bitcoin") return BTC_ADDRESS_RE.test(address);
  return false;
}

function safeConfidence(value) {
  const confidence = cleanText(value, 16).toUpperCase();
  return ["HIGH", "MEDIUM", "LOW"].includes(confidence) ? confidence : "MEDIUM";
}

function safeWalletRole(value) {
  const role = cleanText(value, 32).toUpperCase();
  return ["DEPOSIT_ADDRESS", "HOT_WALLET", "COLD_WALLET", "PROOF_OF_RESERVES", "UNKNOWN"].includes(role)
    ? role
    : "UNKNOWN";
}

function safeUrl(value) {
  const url = cleanText(value, 1200);
  return /^https:\/\//i.test(url) ? url : "";
}

function sanitizeExchangeLabel(raw, { createdBy = "", reviewedBy = "", provider = "" } = {}) {
  const chain = normalizeChain(raw?.chain);
  const address = normalizeAddress(chain, raw?.address);
  const name = cleanText(raw?.name, 120);
  const sourceType = cleanText(raw?.source_type, 60);
  const sourceTitle = cleanText(raw?.source_title, 240);
  const sourceUrl = safeUrl(raw?.source_url);
  if (!validAddress(chain, address) || !name || (!sourceType && !sourceTitle && !sourceUrl)) return null;
  const now = new Date().toISOString();
  return {
    id: cleanText(raw?.id || crypto.randomUUID(), 80),
    chain,
    address,
    name,
    category: "EXCHANGE",
    wallet_role: safeWalletRole(raw?.wallet_role),
    confidence: safeConfidence(raw?.confidence),
    source_type: sourceType,
    source_title: sourceTitle,
    source_url: sourceUrl,
    notes: cleanText(raw?.notes, 1200),
    provider: cleanText(provider || raw?.provider, 40),
    created_by: cleanText(raw?.created_by || createdBy, 80),
    reviewed_by: cleanText(raw?.reviewed_by || reviewedBy, 80),
    created_at: cleanText(raw?.created_at, 64) || now,
    updated_at: now
  };
}

function entryKey(entry) {
  return `${entry.chain}:${normalizeAddress(entry.chain, entry.address)}`;
}

function collectAddressEntries(result) {
  const entries = new Map();
  const add = (address, chain = result?.chain) => {
    const normalizedChain = normalizeChain(chain);
    const normalizedAddress = normalizeAddress(normalizedChain, address);
    if (!validAddress(normalizedChain, normalizedAddress)) return;
    const entry = { chain: normalizedChain, address: normalizedAddress };
    entries.set(entryKey(entry), entry);
  };

  add(result?.query);
  const transactions = [
    ...(Array.isArray(result?.transactions) ? result.transactions : []),
    ...(result?.transaction && typeof result.transaction === "object" ? [result.transaction] : [])
  ];
  for (const tx of transactions) {
    for (const field of ["from", "to", "from_address", "to_address", "owner_address", "address"]) add(tx?.[field]);
    for (const address of Array.isArray(tx?.counterparties) ? tx.counterparties : []) add(address);
    for (const address of [...(Array.isArray(tx?.input_addresses) ? tx.input_addresses : []), ...(Array.isArray(tx?.output_addresses) ? tx.output_addresses : [])]) add(address);
  }
  for (const flow of Array.isArray(result?.flows) ? result.flows : []) {
    add(flow?.from);
    add(flow?.to);
  }
  return [...entries.values()].slice(0, MAX_LOOKUP_ADDRESSES);
}

async function providerCachePut(env, entries) {
  if (!entries.length) return;
  try {
    await gateCall(env, "/crypto-exchange-provider-put", { entries });
  } catch (error) {
    console.warn("Crypto provider label cache write failed", error);
  }
}

async function lookupShared(env, entries) {
  if (!entries.length) return { labels: [], cached_labels: [] };
  const response = await gateCall(env, "/crypto-exchange-labels-lookup", { entries });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "Exchange label lookup failed.");
  return {
    labels: Array.isArray(payload.labels) ? payload.labels : [],
    cached_labels: Array.isArray(payload.cached_labels) ? payload.cached_labels : []
  };
}

function isExchangeNameTag(row) {
  const labels = Array.isArray(row?.labels) ? row.labels : [];
  return labels.some(label => /^(exchange|cex)$/i.test(String(label || "")));
}

function etherscanLabel(entry, row) {
  if (!row || !isExchangeNameTag(row)) return null;
  const name = cleanText(row.nametag, 120);
  if (!name) return null;
  return sanitizeExchangeLabel({
    ...entry,
    name,
    confidence: "MEDIUM",
    source_type: "Block explorer metadata",
    source_title: "Etherscan public name tag",
    source_url: `https://${entry.chain === "ethereum" ? "etherscan.io" : entry.chain === "bsc" ? "bscscan.com" : entry.chain === "polygon" ? "polygonscan.com" : entry.chain === "arbitrum" ? "arbiscan.io" : "basescan.org"}/address/${entry.address}`,
    notes: cleanText(row.shortdescription || row.notes_1 || "Public explorer exchange attribution; verify the source before relying on it.", 1200),
    provider: "etherscan"
  }, { provider: "etherscan" });
}

async function lookupEtherscan(env, entries) {
  if (env.ETHERSCAN_NAME_TAGS_ENABLED !== "true" || !env.ETHERSCAN_API_KEY) return [];
  const byChain = new Map();
  for (const entry of entries) {
    if (!EVM_CHAINS.has(entry.chain)) continue;
    const group = byChain.get(entry.chain) || [];
    group.push(entry);
    byChain.set(entry.chain, group);
  }
  const labels = [];
  for (const [chain, group] of byChain) {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", EVM_CHAIN_IDS[chain]);
    url.searchParams.set("module", "nametag");
    url.searchParams.set("action", "getaddresstag");
    url.searchParams.set("address", group.map(entry => entry.address).join(","));
    url.searchParams.set("apikey", env.ETHERSCAN_API_KEY);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) continue;
      const payload = await response.json();
      const byAddress = new Map((Array.isArray(payload?.result) ? payload.result : []).map(row => [String(row.address || "").toLowerCase(), row]));
      for (const entry of group) {
        const label = etherscanLabel(entry, byAddress.get(entry.address));
        if (label) labels.push(label);
      }
    } catch (error) {
      console.warn("Etherscan name-tag lookup failed", error);
    }
  }
  return labels;
}

const KNOWN_EXCHANGE_NAME_RE = /\b(binance|coinbase|kraken|okx|bybit|bitfinex|kucoin|htx|huobi|gate\.io|crypto\.com|bitstamp|gemini|bitget|mexc|upbit|bithumb|poloniex|deribit|bitmart|whitebit|phemex|ascendex|lbank|coincheck|bitflyer|paybis|celsius|ftx)\b/i;

async function lookupTronScan(env, entries) {
  if (env.TRONSCAN_TAG_LOOKUP_ENABLED !== "true" || !env.TRONSCAN_API_KEY) return [];
  const labels = [];
  for (const entry of entries.filter(item => item.chain === "tron").slice(0, 6)) {
    try {
      const url = new URL("https://apilist.tronscanapi.com/api/account/tag");
      url.searchParams.set("address", entry.address);
      const response = await fetch(url, {
        headers: { "TRON-PRO-API-KEY": env.TRONSCAN_API_KEY },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const tags = [payload?.publicTag, payload?.blueTag, payload?.greyTag, payload?.redTag]
        .map(value => cleanText(value, 120)).filter(Boolean);
      const match = tags.find(value => KNOWN_EXCHANGE_NAME_RE.test(value) || /\b(exchange|cex)\b/i.test(value));
      if (!match) continue;
      const label = sanitizeExchangeLabel({
        ...entry,
        name: match,
        confidence: "MEDIUM",
        source_type: "Block explorer metadata",
        source_title: "TronScan public account tag",
        source_url: `https://tronscan.org/#/address/${entry.address}`,
        notes: "Public TronScan tag; confirm that it identifies an exchange wallet before relying on the attribution.",
        provider: "tronscan"
      }, { provider: "tronscan" });
      if (label) labels.push(label);
    } catch (error) {
      console.warn("TronScan tag lookup failed", error);
    }
  }
  return labels;
}

async function resolveExchangeLabels(result, env) {
  const entries = collectAddressEntries(result);
  if (!entries.length) return [];
  let stored = { labels: [], cached_labels: [] };
  try {
    stored = await lookupShared(env, entries);
  } catch (error) {
    console.warn("Shared exchange label lookup failed", error);
  }
  const found = new Map();
  for (const label of [...stored.labels, ...stored.cached_labels]) {
    const clean = sanitizeExchangeLabel(label, { provider: label?.provider });
    if (clean && !found.has(entryKey(clean))) found.set(entryKey(clean), clean);
  }
  const missing = entries.filter(entry => !found.has(entryKey(entry)));
  const [etherscan, tronscan] = await Promise.all([
    lookupEtherscan(env, missing),
    lookupTronScan(env, missing)
  ]);
  const providerLabels = [...etherscan, ...tronscan];
  for (const label of providerLabels) found.set(entryKey(label), label);
  if (providerLabels.length) {
    await providerCachePut(env, providerLabels.map(label => ({
      entry: { chain: label.chain, address: label.address },
      label,
      expires_at: Date.now() + 24 * 60 * 60 * 1000
    })));
  }
  return [...found.values()];
}

async function authenticate(request, env, username) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return { error: "Authenticated session required.", status: 401 };
  const response = await gateCall(env, "/session-get", { session_token: token });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || session?.username !== username) return { error: "Unauthorized session.", status: 401 };
  return { ok: true };
}

async function handleExchangeAddressLabels(request, env) {
  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }
  } else if (request.method !== "GET") {
    return jsonResponse({ error: "Unsupported method." }, 405, env);
  }
  const url = new URL(request.url);
  const username = normalizeUsername(request.method === "GET" ? url.searchParams.get("user_id") : body.user_id);
  if (!username || !isAllowedUser(username, env)) return jsonResponse({ error: "Unknown user." }, 400, env);
  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);
  const action = cleanText(request.method === "GET" ? url.searchParams.get("action") : body.action, 24).toLowerCase();
  const admin = username === "admin";

  if (action === "propose") {
    const proposal = sanitizeExchangeLabel(body.label, { createdBy: username });
    if (!proposal) return jsonResponse({ error: "A valid address, exchange name, and source are required." }, 400, env);
    const response = await gateCall(env, "/crypto-exchange-proposal-create", { proposal });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }

  if (action === "pending" || action === "migrate") {
    if (!admin) return jsonResponse({ error: "Admin access required." }, 403, env);
    if (action === "pending") {
      const response = await gateCall(env, "/crypto-exchange-proposals-list", {});
      return jsonResponse(await response.json().catch(() => ({})), response.status, env);
    }
    const response = await gateCall(env, "/crypto-exchange-proposals-migrate", { reviewed_by: username });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }

  if (action === "review") {
    if (!admin) return jsonResponse({ error: "Admin access required." }, 403, env);
    const proposalId = cleanText(body.proposal_id, 240);
    const decision = cleanText(body.decision, 16).toLowerCase();
    if (!proposalId || !["approve", "reject"].includes(decision)) return jsonResponse({ error: "Invalid proposal review." }, 400, env);
    const response = await gateCall(env, "/crypto-exchange-proposal-review", { proposal_id: proposalId, decision, reviewed_by: username });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }

  if (action === "import") {
    if (!admin) return jsonResponse({ error: "Admin access required." }, 403, env);
    const records = Array.isArray(body.labels) ? body.labels.slice(0, 100) : [];
    const labels = records.map(raw => sanitizeExchangeLabel(raw, { createdBy: username, reviewedBy: username }))
      .filter(Boolean).map(label => ({ ...label, source_type: label.source_type || "Official exchange disclosure" }));
    if (!labels.length) return jsonResponse({ error: "No valid sourced exchange labels to import." }, 400, env);
    const response = await gateCall(env, "/crypto-exchange-labels-import", { labels, imported_by: username });
    return jsonResponse(await response.json().catch(() => ({})), response.status, env);
  }

  if (action === "seed") {
    if (!admin) return jsonResponse({ error: "Admin access required." }, 403, env);
    const labels = OFFICIAL_SEED_LABELS.map(raw => sanitizeExchangeLabel(raw, { createdBy: username, reviewedBy: username }));
    const response = await gateCall(env, "/crypto-exchange-labels-import", { labels, imported_by: username });
    return jsonResponse({ ...(await response.json().catch(() => ({}))), seed: "crypto.com-2022", source_records: labels.length }, response.status, env);
  }

  return jsonResponse({ error: "Unsupported exchange label action." }, 400, env);
}

export {
  EXCHANGE_ADDRESS_VERSION,
  sanitizeExchangeLabel,
  collectAddressEntries,
  resolveExchangeLabels,
  handleExchangeAddressLabels
};
