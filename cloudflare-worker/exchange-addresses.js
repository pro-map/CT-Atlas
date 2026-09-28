import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

const EXCHANGE_ADDRESS_VERSION = "crypto-exchange-addresses-v4";
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

const BINANCE_SEED_LABELS = Object.freeze([
  ...[
    "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
    "3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb",
    "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6",
    "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"
  ].map(address => ({ chain: "bitcoin", address })),
  ...[
    "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8",
    "0xf977814e90da44bfa03b6295a0616a897441acec",
    "0x5a52e96bacdabb82fd05763e25335261b270efcb",
    "0x28c6c06298d514db089934071355e5743bf21d60",
    "0x9696f59e4d72e237be84ffd425dcad154bf96976",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d",
    "0x56eddb7aa87536c09ccc2793473599fd21a8b17f",
    "0x4976a4a02f38326660d17bf34b431dc6e2eb2327",
    "0xa344c7aDA83113B3B56941F6e85bf2Eb425949f3",
    "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"
  ].map(address => ({ chain: "ethereum", address })),
  ...[
    "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi",
    "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9",
    "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
    "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
    "TAzsQ9Gx8eqFNFSKbeXrbi45CuVPHzA8wr",
    "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm",
    "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G",
    "TYASr5UV6HEcXatwdFQfmLVUqQQQMUxHLS"
  ].map(address => ({ chain: "tron", address }))
].map(entry => ({
  ...entry,
  name: "Binance",
  wallet_role: "UNKNOWN",
  confidence: "MEDIUM",
  source_type: "Official exchange disclosure",
  source_title: "Binance wallet address snapshot (10 Nov 2022)",
  source_url: "https://www.binance.com/en-IN/blog/community/2895840147147652626",
  notes: "Published in Binance's official 10 Nov 2022 wallet disclosure; snapshot 10 Nov 2022 00:00 UTC. The page states that this was not a complete data set. Role is not specified per address, and current control must be re-verified."
})));

const OKX_SEED_LABELS = Object.freeze([
  { chain: "bitcoin", address: "3A1JRKqfGGxoq2qSHLv85u4zn935VR9ToL" },
  { chain: "ethereum", address: "0xc5451b523d5fffe1351337a221688a62806ad91a" }
].map(entry => ({
  ...entry,
  name: "OKX",
  wallet_role: "PROOF_OF_RESERVES",
  confidence: "MEDIUM",
  source_type: "Official proof-of-reserves verification guide",
  source_title: "OKX wallet reserve address verification examples (2022 snapshot)",
  source_url: "https://www.okx.com/en-eu/help/how-to-verify-okx-ownership-and-balance-of-the-wallet-address",
  notes: "Address appears as an OKX reserve-address example in the official verification guide. Historical example only, not the full current address list; verify ownership and snapshot before relying on it."
})));

const BINANCE_BSC_SEED_LABELS = Object.freeze([
  "0xf977814e90da44bfa03b6295a0616a897441acec",
  "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8",
  "0x5a52e96bacdabb82fd05763e25335261b270efcb",
  "0x3c783c21a0383057d128bae431894a5c19f9cf06",
  "0xdccf3b77da55107280bd850ea519df3705d1a75a",
  "0x8894e0a0c962cb723c1976a4421c95949be2d4e3",
  "0x515b72ed8a97f42c568d6a143232775018f133c8",
  "0xbd612a3f30dca67bf60a39fd0d35e39b7ab80774",
  "0x01c952174c24e1210d26961d456a77a39e1f0bb0",
  "0x29bdfbf7d27462a2d115748ace2bd71a2646946c",
  "0xe2fc31f816a9b94326492132018c3aecc4a93ae1",
  "0x73f5ebe90f27b46ea12e5795d16c4b408b19cc6f",
  "0x161ba15a5f335c9f06bb5bbb0a9ce14076fbb645",
  "0x1fbe2acee135d991592f167ac371f3dd893a508b",
  "0xeb2d2f1b8c558a40207669291fda468e50c8a0bb",
  "0xa180fe01b906a1be37be6c534a3300785b20d947"
].map(address => ({
  chain: "bsc",
  address,
  name: "Binance",
  wallet_role: "UNKNOWN",
  confidence: "MEDIUM",
  source_type: "Official exchange disclosure",
  source_title: "Binance wallet address snapshot (10 Nov 2022; BEP20)",
  source_url: "https://www.binance.com/en-IN/blog/community/2895840147147652626",
  notes: "Address listed for BNB BEP20 on BSC in Binance's official 10 Nov 2022 disclosure. Historical snapshot; the source states the list was incomplete and current control should be re-verified."
})));

const BYBIT_SEED_LABELS = Object.freeze([
  { chain: "ethereum", address: "0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4" },
  { chain: "base", address: "0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4" },
  { chain: "ethereum", address: "0x6Bd869be16359f9E26f0608A50497f6Ef122eE3E" },
  { chain: "ethereum", address: "0x922fa922da1b0b28d0af5aa274d7326eaa108c3d" },
  ...["ethereum", "bsc", "base", "polygon", "arbitrum"].map(chain => ({ chain, address: "0x88a1493366d48225fc3cefbdae9ebb23e323ade3" })),
  ...["ethereum", "base"].map(chain => ({ chain, address: "0xA7A93fd0a276fc1C0197a5B5623eD117786eeD06" })),
  ...["ethereum", "base"].map(chain => ({ chain, address: "0xbaed383ede0e5d9d72430661f3285daa77e9439f" })),
  ...["ethereum", "arbitrum", "base", "bsc"].map(chain => ({ chain, address: "0xee5B5B923fFcE93A870B3104b7CA09c3db80047A" }))
].map(entry => ({
  ...entry,
  name: "Bybit",
  wallet_role: "PROOF_OF_RESERVES",
  confidence: "MEDIUM",
  source_type: "Official proof-of-reserves audit disclosure",
  source_title: "Bybit PoR audit wallet list (official PDF)",
  source_url: "https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_Dec.pdf",
  notes: "Listed in Bybit's official PoR audit PDF for the specified network. The report is a dated snapshot, not proof of present control; verify against the latest Bybit report before relying on this attribution."
})));

const ALL_OFFICIAL_SEED_LABELS = Object.freeze([
  ...OFFICIAL_SEED_LABELS,
  ...BINANCE_SEED_LABELS,
  ...BINANCE_BSC_SEED_LABELS,
  ...OKX_SEED_LABELS,
  ...BYBIT_SEED_LABELS
]);

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
    const labels = ALL_OFFICIAL_SEED_LABELS.map(raw => sanitizeExchangeLabel(raw, { createdBy: username, reviewedBy: username }));
    const response = await gateCall(env, "/crypto-exchange-labels-import", { labels, imported_by: username, skip_existing: true });
    return jsonResponse({ ...(await response.json().catch(() => ({}))), seed: "official-exchanges-2022", source_records: labels.length }, response.status, env);
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
