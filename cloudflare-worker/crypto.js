import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";
import { tronAddress, isValidWalletAddress } from "./address-utils.js";
import { loadSanctions, screenAnalysis, sanctionsObservation } from "./sanctions.js";
import { resolveExchangeLabels } from "./exchange-addresses.js";
import { detectExchangeBehavior, EXCHANGE_BEHAVIOR_VERSION } from "./exchange-behavior.mjs";
import { isStablecoin, assessWallet, derivePatterns, deriveAlertSummary } from "./crypto-risk.mjs";

const CRYPTO_VERSION = "crypto-intel-v6-risk-assessment";

const EVM_CHAINS = {
  ethereum: { chainid: "1", name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" },
  polygon: { chainid: "137", name: "Polygon", symbol: "POL", explorer: "https://polygonscan.com" },
  arbitrum: { chainid: "42161", name: "Arbitrum One", symbol: "ETH", explorer: "https://arbiscan.io" }
};

// Etherscan's free plan refuses these chains. Saved cases, labels and watches still name them, so
// they stay valid data, but a request naming one is refused: it is never read on another chain.
const RETIRED_CHAINS = {
  bsc: { name: "BNB Smart Chain", explorer: "https://bscscan.com" },
  base: { name: "Base", explorer: "https://basescan.org" }
};

const EVM_CHAIN_KEYS = new Set(Object.keys(EVM_CHAINS));
const HEX64_RE = /^[a-fA-F0-9]{64}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BTC_BASE58_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{24,33}$/;
const BTC_BECH32_RE = /^bc1[ac-hj-np-z02-9]{11,71}$/i;
const BLOCKSTREAM_API = "https://blockstream.info/api";
const TRONGRID_API = "https://api.trongrid.io";
const PROVIDER_TIMEOUT_MS = 12000;
const RATE_LIMIT_RETRY_MS = 1100;
const RATE_LIMIT_RE = /rate limit|too many requests/i;
const NO_ROWS_RE = /no (?:\w+ )?(?:transactions|records) found/i;
const DISPLAY_COUNTERPARTIES = 12;
const BTC_PAGE_SIZE = 25;
const MAX_OUT_VALUES = 30;
const COINJOIN_MIN_PARTIES = 5;
// Airdrop spam advertises itself in the token's own name.
const SPAM_TOKEN_RE = /https?:|www\.|\b(?:claim|visit|airdrop|reward)\b|\.(?:io|org|net|xyz|app|top|site|click|live|vip)\b/i;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeChainHint(value) {
  const hint = cleanText(value || "auto", 32).toLowerCase();
  if (hint === "btc") return "bitcoin";
  if (hint === "trx") return "tron";
  if (hint === "eth") return "ethereum";
  return hint || "auto";
}

function retiredChainError(chain) {
  if (!Object.hasOwn(RETIRED_CHAINS, chain)) return "";
  const { name, explorer } = RETIRED_CHAINS[chain];
  return name + " is no longer supported by CT Atlas, so nothing was analysed. Saved work on this chain is kept, and " + explorer + " still shows it.";
}

function looksLikeBitcoinAddress(value) {
  return BTC_BASE58_RE.test(value) || BTC_BECH32_RE.test(value);
}

// Bech32 is case-insensitive and QR codes use upper case, but providers answer in
// lower case: an upper-case seed would never match its own rows.
function addressTarget(chain, value) {
  if (!isValidWalletAddress(chain, value)) {
    return { error: "This address fails its checksum. Check that it was copied in full." };
  }
  return { chain, kind: "address", value: /^bc1/i.test(value) ? value.toLowerCase() : value };
}

function detectCryptoInput(query, chainHint = "auto") {
  const value = cleanText(query, 180);
  const hint = normalizeChainHint(chainHint);
  const retired = retiredChainError(hint);
  if (retired) return { error: retired };
  if (!value) return { error: "Enter a wallet address or transaction hash." };

  if (hint === "bitcoin") {
    if (looksLikeBitcoinAddress(value)) return addressTarget("bitcoin", value);
    if (HEX64_RE.test(value)) return { chain: "bitcoin", kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like a Bitcoin address or transaction ID." };
  }

  if (hint === "tron") {
    if (TRON_ADDRESS_RE.test(value)) return addressTarget("tron", value);
    if (HEX64_RE.test(value)) return { chain: "tron", kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like a TRON address or transaction ID." };
  }

  if (EVM_CHAIN_KEYS.has(hint)) {
    if (EVM_ADDRESS_RE.test(value)) return { chain: hint, kind: "address", value: value.toLowerCase() };
    if (EVM_TX_RE.test(value)) return { chain: hint, kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like an EVM address or transaction hash." };
  }

  // Past this line a 0x address reads as Ethereum, which is right only when no chain was named.
  if (hint !== "auto") return { error: "This blockchain is not supported by CT Atlas, so nothing was analysed." };

  if (TRON_ADDRESS_RE.test(value)) return addressTarget("tron", value);
  if (EVM_ADDRESS_RE.test(value)) return { chain: "ethereum", kind: "address", value: value.toLowerCase() };
  if (looksLikeBitcoinAddress(value)) return addressTarget("bitcoin", value);
  if (EVM_TX_RE.test(value)) {
    return {
      error: "A 0x transaction hash can exist on several EVM chains. Select Ethereum, Polygon or Arbitrum."
    };
  }
  if (HEX64_RE.test(value)) {
    return {
      error: "A 64-character transaction ID can exist on Bitcoin or TRON. Select the blockchain before searching."
    };
  }

  return { error: "Unsupported or unrecognized address / transaction format." };
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error || payload?.message || response.statusText || "request failed";
    throw new Error(label + ": " + cleanText(message, 220));
  }
  // A maintenance or challenge page arrives as 200 HTML; read as data it would
  // pass for an empty, clean wallet.
  if (payload === null) throw new Error(label + ": the provider did not return JSON.");
  return payload;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Etherscan reports its rate limit as an HTTP 200, so the status code alone would
// miss it. One retry only: every attempt spends a subrequest.
async function getJson(url, options, label) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error(label + ": the provider did not answer in time.");
      throw error;
    }
    if (response.status === 429 && attempt === 0) {
      await pause(RATE_LIMIT_RETRY_MS);
      continue;
    }
    const payload = await readJson(response, label);
    if (attempt === 0 && typeof payload?.result === "string" && RATE_LIMIT_RE.test(payload.result)) {
      await pause(RATE_LIMIT_RETRY_MS);
      continue;
    }
    return payload;
  }
}

function aggregateFlows(transactions, seed) {
  const map = new Map();
  const seedLower = String(seed || "").toLowerCase();

  for (const tx of transactions || []) {
    if (tx.failed === true) continue;
    const asset = cleanText(tx.asset || "", 32) || "UNKNOWN";
    const amount = Math.abs(finiteNumber(tx.amount, 0));
    const counterparties = Array.isArray(tx.counterparties) ? tx.counterparties.filter(Boolean) : [];
    const unique = [...new Set(counterparties.map(String))].slice(0, 12);

    for (const counterparty of unique) {
      const cpLower = counterparty.toLowerCase();
      if (!cpLower || cpLower === seedLower) continue;
      const outgoing = tx.direction === "OUT";
      const from = outgoing ? seed : counterparty;
      const to = outgoing ? counterparty : seed;
      // By contract where known: a symbol is free text, so a fake USDT must not merge with the real one.
      const key = [from.toLowerCase(), to.toLowerCase(), tx.asset_key || asset].join("|");
      const item = map.get(key) || {
        from,
        to,
        asset,
        ...(tx.asset_key ? { asset_key: tx.asset_key } : {}),
        amount: 0,
        tx_count: 0,
        approximation: false
      };
      item.amount += unique.length ? amount / unique.length : amount;
      item.tx_count += 1;
      if (unique.length > 1) item.approximation = true;
      map.set(key, item);
    }
  }

  return [...map.values()]
    .sort((a, b) => b.tx_count - a.tx_count || b.amount - a.amount)
    .slice(0, 80)
    .map(item => ({ ...item, amount: Number(item.amount.toPrecision(10)) }));
}

function buildObservations(transactions, seed) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const incoming = rows.filter(row => row.direction === "IN");
  const outgoing = rows.filter(row => row.direction === "OUT");
  const counterparties = new Set(rows.flatMap(row => Array.isArray(row.counterparties) ? row.counterparties : []).filter(Boolean));
  const assets = new Set(rows.map(row => row.asset).filter(Boolean));
  const notes = [];

  notes.push(
    rows.length
      ? `The returned sample contains ${rows.length} transaction records involving ${counterparties.size} unique counterparties across ${assets.size || 1} asset(s).`
      : "No transaction records were returned for the requested sample."
  );

  if (incoming.length || outgoing.length) {
    notes.push(`Direction mix in the returned sample: ${incoming.length} incoming and ${outgoing.length} outgoing records.`);
  }

  // Per asset: 2,000 USDT in and 1,800 ETH out are not comparable amounts.
  const totals = new Map();
  for (const row of rows) {
    if (row.failed === true) continue;
    const key = row.asset_key || row.asset || "";
    const entry = totals.get(key) || { IN: 0, OUT: 0 };
    if (row.direction in entry) entry[row.direction] += Math.abs(finiteNumber(row.amount, 0));
    totals.set(key, entry);
  }
  if ([...totals.values()].some(({ IN, OUT }) => IN > 0 && OUT > 0 && Math.min(IN, OUT) / Math.max(IN, OUT) >= 0.7)) {
    notes.push("The sample shows substantial value moving in both directions in one asset. This can indicate pass-through activity, but it is not by itself evidence of layering, laundering, or common ownership.");
  }

  const activity = new Map();
  for (const row of rows) {
    const amount = Math.abs(finiteNumber(row.amount, 0));
    for (const cp of row.counterparties || []) {
      if (!cp || String(cp).toLowerCase() === String(seed).toLowerCase()) continue;
      const entry = activity.get(cp) || { count: 0, value: 0 };
      entry.count += 1;
      entry.value += amount;
      activity.set(cp, entry);
    }
  }
  const top = [...activity.entries()].sort((a, b) => b[1].count - a[1].count || b[1].value - a[1].value)[0];
  if (top) notes.push(`Most frequently observed counterparty in this sample: ${top[0]} (${top[1].count} linked record(s)).`);

  notes.push("On-chain linkage shows transaction relationships only. It does not establish that two addresses have the same owner or identify a person or organization.");
  return notes;
}

// The display cap must not limit what is screened: one transaction can carry
// thousands of outputs, and a listed one past the cap would read as NO MATCH.
function counterpartyFields(addresses) {
  const all = [...new Set(addresses)];
  return {
    counterparties: all.slice(0, DISPLAY_COUNTERPARTIES),
    all_counterparties: all,
    counterparties_total: all.length,
    counterparties_truncated: all.length > DISPLAY_COUNTERPARTIES
  };
}

function looksLikeCoinjoin(inputs, outputs) {
  if (inputs.length < COINJOIN_MIN_PARTIES) return false;
  const counts = new Map();
  for (const output of outputs) {
    const value = finiteNumber(output?.value);
    if (value > 0) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.values()].some(count => count >= COINJOIN_MIN_PARTIES);
}

function btcAddressTransactions(address, raw) {
  return (raw || []).map(tx => {
    const inputs = tx.vin || [];
    const outputs = tx.vout || [];
    const seedInputs = inputs.filter(input => input?.prevout?.scriptpubkey_address === address);
    const otherOutputs = outputs.filter(output =>
      output?.scriptpubkey_address !== address && (output?.scriptpubkey_address || finiteNumber(output?.value) > 0)
    );
    const received = outputs
      .filter(output => output?.scriptpubkey_address === address)
      .reduce((sum, output) => sum + finiteNumber(output.value), 0);
    const sent = seedInputs.reduce((sum, input) => sum + finiteNumber(input?.prevout?.value), 0);
    const net = received - sent;
    // A paid fee keeps the net from reaching zero, so a spend back to itself has to
    // be recognised from its parties. Its amount is what moved, not the fee.
    const selfSpend = inputs.length > 0 && seedInputs.length === inputs.length && otherOutputs.length === 0;
    const direction = selfSpend || net === 0 ? "SELF" : net > 0 ? "IN" : "OUT";
    const inputAddresses = inputs.map(input => input?.prevout?.scriptpubkey_address).filter(item => item && item !== address);
    const counterparties = direction === "IN"
      ? inputAddresses
      : outputs.map(output => output?.scriptpubkey_address).filter(item => item && item !== address);
    const amountSats = selfSpend ? received : Math.abs(net);

    return {
      id: tx.txid,
      time: tx.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : "",
      confirmed: Boolean(tx.status?.confirmed),
      direction,
      asset: "BTC",
      asset_key: "native",
      amount: amountSats / 1e8,
      amount_raw: String(amountSats),
      fee: finiteNumber(tx.fee) / 1e8,
      ...counterpartyFields(counterparties),
      // Spent alongside the seed: a closer link than a payment, but no value went
      // to them, so they are screened without counting as recipients. Other outputs
      // of an IN row are not kept: they are only fellow payees of a batch payout.
      co_inputs: direction === "IN" ? [] : [...new Set(inputAddresses)],
      inputs_count: inputs.length,
      outputs_count: outputs.length,
      out_values: sent > 0 ? otherOutputs.slice(0, MAX_OUT_VALUES).map(output => finiteNumber(output.value) / 1e8) : [],
      self_spend: selfSpend,
      // What was paid, without the fee that a net amount includes.
      payment_amount: sent > 0 ? otherOutputs.reduce((sum, output) => sum + finiteNumber(output.value), 0) / 1e8 : null,
      coinjoin_like: looksLikeCoinjoin(inputs, outputs),
      is_coinbase: Boolean(inputs[0]?.is_coinbase),
      block_height: tx.status?.block_height ?? null,
      explorer_url: "https://blockstream.info/tx/" + encodeURIComponent(tx.txid)
    };
  });
}

function arrayOrThrow(payload, label) {
  if (!Array.isArray(payload)) throw new Error(label + ": unexpected response.");
  return payload;
}

function buildCoverage(rows, { complete, lifetimeTxCount = null, failedSources = [] }) {
  const times = rows.map(row => Date.parse(String(row?.time || ""))).filter(Number.isFinite);
  const partial = failedSources.length > 0;
  return {
    rows: rows.length,
    oldest: times.length ? new Date(Math.min(...times)).toISOString() : "",
    newest: times.length ? new Date(Math.max(...times)).toISOString() : "",
    complete: Boolean(complete) && !partial,
    lifetime_tx_count: lifetimeTxCount,
    partial,
    ...(partial ? { failed_sources: failedSources } : {})
  };
}

// Partial history beats none as long as it says so. With every history call failed
// there is nothing to show, and a wallet with no rows must not read as clean.
function settledLists(results, labels) {
  if (results.every(result => result.status === "rejected")) throw results[0].reason;
  return {
    lists: results.map(result => result.status === "fulfilled" ? result.value : []),
    failedSources: labels.filter((_, index) => results[index].status === "rejected")
  };
}

function coverageNotes(failedSources, summaryMissing = false) {
  return [
    ...(failedSources.length ? ["Partial result: " + failedSources.join(", ") + " could not be read, so records are missing from this sample."] : []),
    ...(summaryMissing ? ["The address summary could not be read, so the balance is not shown."] : [])
  ];
}

async function analyzeBitcoin(target, limit) {
  const base = BLOCKSTREAM_API;

  if (target.kind === "transaction") {
    const tx = await getJson(base + "/tx/" + encodeURIComponent(target.value), {}, "Blockstream transaction lookup");
    return {
      chain: "bitcoin",
      chain_name: "Bitcoin",
      kind: "transaction",
      query: target.value,
      provider: "Blockstream Esplora",
      explorer_url: "https://blockstream.info/tx/" + encodeURIComponent(target.value),
      transaction: {
        id: tx.txid,
        confirmed: Boolean(tx.status?.confirmed),
        time: tx.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : "",
        fee: finiteNumber(tx.fee) / 1e8,
        inputs: (tx.vin || []).length,
        outputs: (tx.vout || []).length,
        input_addresses: [...new Set((tx.vin || []).map(item => item?.prevout?.scriptpubkey_address).filter(Boolean))].slice(0, 30),
        output_addresses: [...new Set((tx.vout || []).map(item => item?.scriptpubkey_address).filter(Boolean))].slice(0, 30),
        all_addresses: [...new Set([
          ...(tx.vin || []).map(item => item?.prevout?.scriptpubkey_address),
          ...(tx.vout || []).map(item => item?.scriptpubkey_address)
        ].filter(Boolean))]
      },
      transactions: [],
      flows: [],
      observations: ["Transaction-level view. Inputs and outputs are on-chain relationships; they do not establish common ownership."],
      suspicious_patterns: []
    };
  }

  const address = base + "/address/" + encodeURIComponent(target.value);
  const historyLabel = "Blockstream transaction history";
  const [infoResult, historyResult] = await Promise.allSettled([
    getJson(address, {}, "Blockstream address lookup").then(payload => {
      if (!payload?.chain_stats) throw new Error("Blockstream address lookup: unexpected response.");
      return payload;
    }),
    getJson(address + "/txs", {}, historyLabel).then(payload => arrayOrThrow(payload, historyLabel))
  ]);
  if (historyResult.status === "rejected") throw historyResult.reason;
  const info = infoResult.status === "fulfilled" ? infoResult.value : null;
  const lifetime = info ? finiteNumber(info.chain_stats.tx_count) : null;

  // Older pages are keyed on the last confirmed txid and a page holds 25, so the
  // loop runs at most 3 more times. A failed page keeps what was already read.
  const failedSources = [];
  const rows = btcAddressTransactions(target.value, historyResult.value);
  let page = historyResult.value.filter(tx => tx?.status?.confirmed);
  let confirmedRead = page.length;
  while (rows.length < limit && page.length >= BTC_PAGE_SIZE && (lifetime === null || confirmedRead < lifetime)) {
    const label = "Blockstream older transactions";
    try {
      page = arrayOrThrow(await getJson(address + "/txs/chain/" + encodeURIComponent(page[page.length - 1].txid), {}, label), label);
    } catch (error) {
      console.warn("Blockstream pagination stopped", error);
      failedSources.push(label);
      break;
    }
    rows.push(...btcAddressTransactions(target.value, page));
    confirmedRead += page.length;
  }

  const transactions = rows.slice(0, limit);
  const confirmedKept = transactions.filter(row => row.confirmed).length;
  const funded = finiteNumber(info?.chain_stats?.funded_txo_sum) + finiteNumber(info?.mempool_stats?.funded_txo_sum);
  const spent = finiteNumber(info?.chain_stats?.spent_txo_sum) + finiteNumber(info?.mempool_stats?.spent_txo_sum);

  return {
    chain: "bitcoin",
    chain_name: "Bitcoin",
    kind: "address",
    query: target.value,
    provider: "Blockstream Esplora",
    explorer_url: "https://blockstream.info/address/" + encodeURIComponent(target.value),
    balance: info ? { amount: (funded - spent) / 1e8, asset: "BTC" } : null,
    activity: {
      confirmed_tx_count: lifetime,
      mempool_tx_count: info ? finiteNumber(info.mempool_stats?.tx_count) : null,
      returned_records: transactions.length
    },
    coverage: buildCoverage(transactions, {
      complete: lifetime !== null && confirmedKept >= lifetime,
      lifetimeTxCount: lifetime === null ? null : lifetime + (finiteNumber(info?.mempool_stats?.tx_count) || 0),
      failedSources
    }),
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: [...buildObservations(transactions, target.value), ...coverageNotes(failedSources, !info)],
    sampling_note: "Blockstream returns recent history first. This view holds the newest " + transactions.length + " records" +
      (lifetime === null ? "" : " of " + (lifetime + (finiteNumber(info?.mempool_stats?.tx_count) || 0)) + " lifetime transactions") + "."
  };
}

function etherscanUrl(params, apiKey) {
  const search = new URLSearchParams({ ...params, apikey: apiKey });
  return "https://api.etherscan.io/v2/api?" + search.toString();
}

function parseEtherscanList(payload, label) {
  if (payload?.status === "1" && Array.isArray(payload.result)) return payload.result;
  // The empty answer is status "0" with result []. An empty array is truthy, so
  // `result || message` read as "" and every wallet with an empty list failed.
  const detail = typeof payload?.result === "string" && payload.result ? payload.result : String(payload?.message || "");
  if (NO_ROWS_RE.test(detail)) return [];
  throw new Error(label + ": " + cleanText(detail || "provider error", 240));
}

function evmDirection(tx, addressLower) {
  const from = String(tx.from || "").toLowerCase();
  const to = String(tx.to || "").toLowerCase();
  return from === addressLower && to === addressLower ? "SELF" : from === addressLower ? "OUT" : "IN";
}

// Value is compared by contract: a symbol is free text, so anyone can mint a "USDT".
function tokenFields(chainKey, contract, symbol, name, rawValue) {
  const stable = isStablecoin(chainKey, contract);
  return {
    asset_key: cleanText(contract || "unknown-token", 80).toLowerCase(),
    amount_raw: String(rawValue ?? "0"),
    ...(stable ? { stable: true } : {}),
    ...(!stable && SPAM_TOKEN_RE.test(String(symbol || "") + " " + String(name || "")) ? { spam: true } : {})
  };
}

function evmRows(target, { nativeRows, tokenRows, internalRows }, chain) {
  const addressLower = target.value.toLowerCase();
  const native = nativeRows.map(tx => {
    const direction = evmDirection(tx, addressLower);
    return {
      id: tx.hash,
      time: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : "",
      confirmed: Number(tx.confirmations || 0) > 0,
      direction,
      asset: chain.symbol,
      asset_key: "native",
      amount: finiteNumber(tx.value) / 1e18,
      amount_raw: String(tx.value ?? "0"),
      fee: finiteNumber(tx.gasUsed) * finiteNumber(tx.gasPrice) / 1e18,
      counterparties: [direction === "OUT" ? tx.to : tx.from].filter(Boolean),
      from_address: cleanText(tx.from || "", 80),
      to_address: cleanText(tx.to || "", 80),
      method_id: cleanText(tx.methodId || "", 24),
      function_name: cleanText(tx.functionName || "", 180),
      input_present: Boolean(tx.input && tx.input !== "0x"),
      block_number: finiteNumber(tx.blockNumber, null),
      nonce: finiteNumber(tx.nonce, null),
      explorer_url: chain.explorer + "/tx/" + tx.hash,
      failed: String(tx.isError || "0") === "1"
    };
  });

  // Native value paid out by a contract, such as a mixer withdrawal or an exchange
  // payout, exists only here. A zero-value trace moves nothing and would crowd the sample.
  const internal = internalRows.filter(tx => finiteNumber(tx.value) > 0).map(tx => {
    const direction = evmDirection(tx, addressLower);
    return {
      id: tx.hash,
      time: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : "",
      confirmed: true,
      direction,
      asset: chain.symbol,
      asset_key: "native",
      amount: finiteNumber(tx.value) / 1e18,
      amount_raw: String(tx.value ?? "0"),
      fee: null,
      counterparties: [direction === "OUT" ? tx.to : tx.from].filter(Boolean),
      from_address: cleanText(tx.from || "", 80),
      to_address: cleanText(tx.to || "", 80),
      internal: true,
      block_number: finiteNumber(tx.blockNumber, null),
      explorer_url: chain.explorer + "/tx/" + tx.hash,
      failed: String(tx.isError || "0") === "1"
    };
  });

  const tokens = tokenRows.map(tx => {
    const direction = evmDirection(tx, addressLower);
    const decimals = clamp(finiteNumber(tx.tokenDecimal, 0), 0, 30);
    const divisor = 10 ** Math.min(decimals, 18);
    let amount = finiteNumber(tx.value);
    if (decimals <= 18) amount /= divisor;
    else amount = finiteNumber(tx.value) / 1e18 / (10 ** (decimals - 18));
    return {
      id: tx.hash,
      time: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : "",
      confirmed: Number(tx.confirmations || 0) > 0,
      direction,
      asset: cleanText(tx.tokenSymbol || "TOKEN", 24),
      token_name: cleanText(tx.tokenName || "", 80),
      token_contract: cleanText(tx.contractAddress || "", 80),
      ...tokenFields(target.chain, tx.contractAddress, tx.tokenSymbol, tx.tokenName, tx.value),
      amount,
      fee: null,
      counterparties: [direction === "OUT" ? tx.to : tx.from].filter(Boolean),
      from_address: cleanText(tx.from || "", 80),
      to_address: cleanText(tx.to || "", 80),
      block_number: finiteNumber(tx.blockNumber, null),
      explorer_url: chain.explorer + "/tx/" + tx.hash,
      failed: false
    };
  });

  return [...native, ...internal, ...tokens]
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

async function analyzeEvm(target, limit, env, options = {}) {
  if (!env.ETHERSCAN_API_KEY) {
    throw new Error("EVM analysis is installed but ETHERSCAN_API_KEY is not configured in the Cloudflare Worker.");
  }

  const chain = EVM_CHAINS[target.chain];
  const common = { chainid: chain.chainid };

  if (target.kind === "transaction") {
    const payload = await getJson(
      etherscanUrl({ ...common, module: "proxy", action: "eth_getTransactionByHash", txhash: target.value }, env.ETHERSCAN_API_KEY),
      {},
      "Etherscan transaction lookup"
    );
    if (!payload?.result || typeof payload.result !== "object") {
      throw new Error("Etherscan did not return this transaction on the selected chain.");
    }
    const tx = payload.result;
    return {
      chain: target.chain,
      chain_name: chain.name,
      kind: "transaction",
      query: target.value,
      provider: "Etherscan API V2",
      explorer_url: chain.explorer + "/tx/" + target.value,
      transaction: {
        id: target.value,
        from: tx.from || "",
        to: tx.to || "",
        value: tx.value ? parseInt(tx.value, 16) / 1e18 : 0,
        asset: chain.symbol,
        block_number: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
        input_bytes: tx.input ? Math.max(0, (tx.input.length - 2) / 2) : 0
      },
      transactions: [],
      flows: [],
      observations: ["Transaction-level view from the selected EVM chain. Contract calls and token transfers may require log-level interpretation beyond this first transaction view."],
      suspicious_patterns: []
    };
  }

  const offset = Math.min(100, Math.max(10, limit));
  const history = (action, label) => getJson(
    etherscanUrl({ ...common, module: "account", action, address: target.value, startblock: "0", endblock: "9999999999", page: "1", offset: String(offset), sort: "desc" }, env.ETHERSCAN_API_KEY),
    {},
    label
  ).then(payload => parseEtherscanList(payload, label));
  const historyLabels = ["Etherscan transactions", "Etherscan token transfers", "Etherscan internal transactions"];

  const [balanceResult, ...historyResults] = await Promise.allSettled([
    options.skipBalance ? null : getJson(
      etherscanUrl({ ...common, module: "account", action: "balance", address: target.value, tag: "latest" }, env.ETHERSCAN_API_KEY),
      {},
      "Etherscan balance"
    ).then(payload => {
      if (payload?.status !== "1") {
        throw new Error("Etherscan balance: " + cleanText(payload?.result || payload?.message || "provider error", 220));
      }
      return payload.result;
    }),
    history("txlist", historyLabels[0]),
    history("tokentx", historyLabels[1]),
    history("txlistinternal", historyLabels[2])
  ]);

  const { lists, failedSources } = settledLists(historyResults, historyLabels);
  const [nativeRows, tokenRows, internalRows] = lists;
  const merged = evmRows(target, { nativeRows, tokenRows, internalRows }, chain);
  const transactions = merged.slice(0, limit);
  const balanceRaw = balanceResult.status === "fulfilled" ? balanceResult.value : null;

  return {
    chain: target.chain,
    chain_name: chain.name,
    kind: "address",
    query: target.value,
    provider: "Etherscan API V2",
    explorer_url: chain.explorer + "/address/" + target.value,
    balance: balanceRaw === null ? null : { amount: finiteNumber(balanceRaw) / 1e18, asset: chain.symbol },
    activity: {
      native_records_found: nativeRows.length,
      token_records_found: tokenRows.length,
      internal_records_found: internalRows.length,
      returned_records: transactions.length
    },
    coverage: buildCoverage(transactions, {
      complete: lists.every(list => list.length < offset) && merged.length <= limit,
      failedSources
    }),
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: [
      ...buildObservations(transactions, target.value),
      ...coverageNotes(failedSources, balanceResult.status === "rejected")
    ],
    sampling_note: "The CT Atlas Crypto view requests a bounded recent page of native, internal and token transfers; it is not a complete archival crawl."
  };
}

function tronHeaders(env) {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "TRON-PRO-API-KEY": env.TRONGRID_API_KEY
  };
}

const tronHistoryQuery = limit => "only_confirmed=true&limit=" + limit + "&order_by=block_timestamp,desc";

// TronGrid's /v1/accounts/.../transactions endpoint returns raw_data addresses
// as 21-byte hex ("41...") rather than the base58check "T..." form users paste
// and explorers show; tronAddress() converts so the analysed wallet matches its
// own counterparties and sanctions/watchlist lookups can match TRX transfers.

function tronTokenRows(address, rows) {
  const seed = address.toLowerCase();
  // Only a Transfer moves value: an Approval's value is an allowance, often near 2^256.
  return (rows || []).filter(tx => !tx?.type || tx.type === "Transfer").map(tx => {
    const from = tronAddress(tx.from);
    const to = tronAddress(tx.to);
    const direction = from.toLowerCase() === seed && to.toLowerCase() === seed ? "SELF" : from.toLowerCase() === seed ? "OUT" : "IN";
    const decimals = clamp(finiteNumber(tx.token_info?.decimals, 0), 0, 30);
    let amount = finiteNumber(tx.value);
    if (decimals <= 18) amount /= 10 ** decimals;
    else amount = amount / 1e18 / (10 ** (decimals - 18));
    return {
      id: tx.transaction_id || "",
      time: tx.block_timestamp ? new Date(Number(tx.block_timestamp)).toISOString() : "",
      confirmed: true,
      direction,
      asset: cleanText(tx.token_info?.symbol || "TRC20", 24),
      token_name: cleanText(tx.token_info?.name || "", 80),
      token_contract: cleanText(tx.token_info?.address || "", 80),
      ...tokenFields("tron", tx.token_info?.address, tx.token_info?.symbol, tx.token_info?.name, tx.value),
      amount,
      fee: null,
      counterparties: direction === "SELF" ? [] : [direction === "OUT" ? to : from].filter(Boolean),
      from_address: cleanText(from, 80),
      to_address: cleanText(to, 80),
      explorer_url: "https://tronscan.org/#/transaction/" + (tx.transaction_id || "")
    };
  });
}

function tronTrxRows(address, outgoingRows, incomingRows) {
  const merged = new Map();
  const add = (tx, listDirection) => {
    const contract = tx?.raw_data?.contract?.[0];
    // Every TRC20/dApp interaction on TRON is also a "TransferContract"-shaped
    // entry in this same transaction list, but as a TriggerSmartContract call
    // -- its value.amount/to_address describe the contract call, not a real
    // TRX transfer. Without this filter every such call produced a spurious
    // zero-amount, no-counterparty "TRX" row duplicating the correct TRC20
    // entry from tronTokenRows() and polluting suspicious-pattern detection.
    if (String(contract?.type || "") !== "TransferContract") return;
    const value = contract?.parameter?.value || {};
    const amountSun = finiteNumber(value.amount, 0);
    const ownerAddress = tronAddress(value.owner_address);
    const toAddress = tronAddress(value.to_address);
    // A self-transfer is in both lists, so the list a row came from cannot give its direction.
    const direction = ownerAddress === address && toAddress === address ? "SELF"
      : ownerAddress === address ? "OUT"
        : toAddress === address ? "IN" : listDirection;
    const counterparty = direction === "SELF" ? "" : direction === "OUT" ? toAddress : ownerAddress;
    const id = tx.txID || tx.txid || "";
    if (!id || merged.has(id)) return;
    merged.set(id, {
      id,
      time: tx.block_timestamp ? new Date(Number(tx.block_timestamp)).toISOString() : "",
      confirmed: true,
      direction,
      asset: "TRX",
      asset_key: "native",
      amount: amountSun / 1e6,
      amount_raw: String(amountSun),
      fee: null,
      failed: Boolean(tx.ret?.[0]?.contractRet) && tx.ret[0].contractRet !== "SUCCESS",
      counterparties: counterparty ? [counterparty] : [],
      from_address: cleanText(ownerAddress, 100),
      to_address: cleanText(toAddress, 100),
      explorer_url: "https://tronscan.org/#/transaction/" + id,
      contract_type: cleanText(contract?.type || "", 80)
    });
  };
  (outgoingRows || []).forEach(tx => add(tx, "OUT"));
  (incomingRows || []).forEach(tx => add(tx, "IN"));
  return [...merged.values()].sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

function tronRows(payload, label) {
  if (!Array.isArray(payload?.data)) throw new Error(label + ": unexpected response.");
  return payload.data;
}

async function analyzeTron(target, limit, env, options = {}) {
  if (!env.TRONGRID_API_KEY) {
    throw new Error("TRON analysis is installed but TRONGRID_API_KEY is not configured in the Cloudflare Worker.");
  }
  const base = TRONGRID_API;
  const headers = tronHeaders(env);

  if (target.kind === "transaction") {
    const [body, receipt] = await Promise.all([
      getJson(base + "/walletsolidity/gettransactionbyid", { method: "POST", headers, body: JSON.stringify({ value: target.value }) }, "TronGrid transaction"),
      getJson(base + "/walletsolidity/gettransactioninfobyid", { method: "POST", headers, body: JSON.stringify({ value: target.value }) }, "TronGrid transaction receipt")
    ]);
    if (!body?.txID && !receipt?.id) throw new Error("TronGrid did not return this solidified transaction.");
    const contract = body?.raw_data?.contract?.[0];
    const value = contract?.parameter?.value || {};
    return {
      chain: "tron",
      chain_name: "TRON",
      kind: "transaction",
      query: target.value,
      provider: "TronGrid",
      explorer_url: "https://tronscan.org/#/transaction/" + target.value,
      transaction: {
        id: body?.txID || receipt?.id || target.value,
        contract_type: contract?.type || "",
        owner_address: tronAddress(value.owner_address),
        to_address: tronAddress(value.to_address),
        amount_trx: value.amount ? finiteNumber(value.amount) / 1e6 : null,
        fee_trx: receipt?.fee ? finiteNumber(receipt.fee) / 1e6 : 0,
        block_number: receipt?.blockNumber ?? null,
        time: receipt?.blockTimeStamp ? new Date(Number(receipt.blockTimeStamp)).toISOString() : "",
        execution_result: receipt?.receipt?.result || body?.ret?.[0]?.contractRet || ""
      },
      transactions: [],
      flows: [],
      observations: ["Solidified TRON transaction body and receipt. Smart-contract token movements can require event-level interpretation."],
      suspicious_patterns: []
    };
  }

  const bounded = Math.min(100, Math.max(10, limit));
  const q = tronHistoryQuery(bounded);
  const account = base + "/v1/accounts/" + encodeURIComponent(target.value);
  const history = (path, label) => getJson(account + path, { headers }, label).then(payload => tronRows(payload, label));
  const historyLabels = ["TronGrid TRC-20 history", "TronGrid outgoing history", "TronGrid incoming history"];
  const [accountResult, ...historyResults] = await Promise.allSettled([
    options.skipBalance ? null : history("?only_confirmed=true", "TronGrid account"),
    history("/transactions/trc20?" + q, historyLabels[0]),
    history("/transactions?" + q + "&only_from=true", historyLabels[1]),
    history("/transactions?" + q + "&only_to=true", historyLabels[2])
  ]);

  const { lists, failedSources } = settledLists(historyResults, historyLabels);
  const [tokenList, outgoingList, incomingList] = lists;
  const accountData = accountResult.status === "fulfilled" ? accountResult.value : null;
  const accountRow = accountData?.[0] || null;
  const tokenRows = tronTokenRows(target.value, tokenList);
  const trxRows = tronTrxRows(target.value, outgoingList, incomingList);
  const merged = [...tokenRows, ...trxRows]
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const transactions = merged.slice(0, limit);

  return {
    chain: "tron",
    chain_name: "TRON",
    kind: "address",
    query: target.value,
    provider: "TronGrid",
    explorer_url: "https://tronscan.org/#/address/" + target.value,
    balance: accountData ? { amount: finiteNumber(accountRow?.balance) / 1e6, asset: "TRX" } : null,
    activity: {
      trc20_records_found: tokenRows.length,
      trx_records_found: trxRows.length,
      returned_records: transactions.length,
      ...(accountRow?.create_time ? { account_created_at: new Date(Number(accountRow.create_time)).toISOString() } : {})
    },
    coverage: buildCoverage(transactions, {
      complete: lists.every(list => list.length < bounded) && merged.length <= limit,
      failedSources
    }),
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: [
      ...buildObservations(transactions, target.value),
      ...coverageNotes(failedSources, accountResult.status === "rejected")
    ],
    sampling_note: "The CT Atlas Crypto view requests a bounded recent page of confirmed TRX and TRC-20 activity. It is not a complete archival crawl."
  };
}

// Screens a finished analysis against the sanctions list. A screening failure
// must never break the analysis itself, and must never read as a clean pass:
// it degrades to status "unavailable" so the UI says "not screened".
async function withSanctionsScreening(result, env) {
  let screening;
  try {
    screening = screenAnalysis(result, await loadSanctions(env));
  } catch (error) {
    console.error("Sanctions screening failed", error);
    screening = screenAnalysis(result, {
      status: "unavailable",
      reason: cleanText(error?.message || "Sanctions screening failed.", 200),
      index: null,
      meta: null
    });
  }
  const observation = sanctionsObservation(screening);
  return {
    ...result,
    sanctions_screening: screening,
    observations: observation ? [observation, ...(result.observations || [])] : result.observations
  };
}

// These lists can run to thousands of addresses per row and exist only for the
// screening step; the response keeps the capped display fields.
function withoutServerFields(result) {
  const { all_addresses: _parties, ...transaction } = result.transaction || {};
  return {
    ...result,
    transactions: (result.transactions || []).map(({ all_counterparties: _all, co_inputs: _spent, ...row }) => row),
    ...(result.transaction ? { transaction } : {})
  };
}

// One path for searches and monitors, so the two cannot disagree about a wallet.
async function withRiskAssessment(result, env, now = Date.now()) {
  const exchangeLabels = await resolveExchangeLabels(result, env);
  const exchangeBehavior = detectExchangeBehavior(result, exchangeLabels);
  const labelled = { ...result, exchange_labels: exchangeLabels, exchange_behavior: exchangeBehavior };
  if (result.kind !== "address") return labelled;
  const assessment = assessWallet(result, { labels: exchangeLabels, exchangeBehavior, now });
  return {
    ...labelled,
    risk_assessment: assessment,
    suspicious_patterns: derivePatterns(assessment),
    alert_summary: deriveAlertSummary(assessment),
    observations: assessment.reasons.length
      ? [...(result.observations || []), "Automated indicators in this sample, not findings: " + assessment.reasons.join("; ") + "."]
      : result.observations
  };
}

async function runAnalysis(target, limit, env, options = {}) {
  let result;
  if (target.chain === "bitcoin") result = await analyzeBitcoin(target, limit);
  else if (target.chain === "tron") result = await analyzeTron(target, limit, env, options);
  else if (EVM_CHAIN_KEYS.has(target.chain)) result = await analyzeEvm(target, limit, env, options);
  else throw new Error("Unsupported blockchain.");
  return withoutServerFields(await withRiskAssessment(await withSanctionsScreening(result, env), env));
}

async function analyzeCryptoAddress(address, chain, limit, env, options = {}) {
  const target = detectCryptoInput(address, chain);
  if (target.error) throw new Error(target.error);
  if (target.kind !== "address") throw new Error("Automatic monitoring supports wallet addresses only.");
  const bounded = clamp(Math.trunc(finiteNumber(limit, 50)), 10, 100);
  return runAnalysis(target, bounded, env, options);
}

async function authenticate(request, env, username) {
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  if (!token) return { error: "Authenticated session required.", status: 401 };
  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || session?.username !== username) {
    return { error: "Unauthorized session.", status: 401 };
  }
  return { ok: true };
}

async function handleCrypto(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const username = normalizeUsername(body.user_id);
  if (!username || !isAllowedUser(username, env)) {
    return jsonResponse({ error: "Unknown user." }, 400, env);
  }

  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);

  const target = detectCryptoInput(body.query, body.chain);
  if (target.error) return jsonResponse({ error: target.error }, 400, env);

  const limit = clamp(Math.trunc(finiteNumber(body.limit, 50)), 10, 100);

  try {
    const result = await runAnalysis(target, limit, env);
    try {
      // What was looked up, for the admin search history (origin: search, url, trace or monitor).
      const origin = cleanText(body.origin, 16).toLowerCase();
      await gateCall(env, "/usage-increment", {
        username,
        metrics: { blockchain_searches: 1 },
        log: { feature: "blockchain", details: {
          query: target.value, kind: target.kind, chain: target.chain,
          chain_hint: cleanText(body.chain, 40) || "auto", limit,
          ...(["search", "url", "trace", "monitor"].includes(origin) ? { origin } : {})
        } }
      });
    } catch (usageError) {
      console.error("Blockchain search usage record failed", usageError);
    }

    return jsonResponse({
      ok: true,
      version: CRYPTO_VERSION,
      exchange_behavior_version: EXCHANGE_BEHAVIOR_VERSION,
      generated_at: new Date().toISOString(),
      ...result,
      suspicious_patterns: Array.isArray(result?.suspicious_patterns) ? result.suspicious_patterns : [],
      alert_summary: result?.alert_summary || { highest_severity: "LOW", highest_score: 0, total: 0 }
    }, 200, env);
  } catch (error) {
    console.error("Crypto analysis failed", error);
    return jsonResponse({ error: cleanText(error?.message || "Crypto analysis failed.", 320) }, 503, env);
  }
}

export {
  CRYPTO_VERSION,
  EVM_CHAINS,
  RETIRED_CHAINS,
  retiredChainError,
  BLOCKSTREAM_API,
  TRONGRID_API,
  etherscanUrl,
  tronHeaders,
  tronHistoryQuery,
  detectCryptoInput,
  aggregateFlows,
  buildObservations,
  withSanctionsScreening,
  analyzeCryptoAddress,
  authenticate,
  handleCrypto
};

