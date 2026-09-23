import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

const CRYPTO_VERSION = "crypto-intel-v1-multichain-flows";

const EVM_CHAINS = {
  ethereum: { chainid: "1", name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" },
  bsc: { chainid: "56", name: "BNB Smart Chain", symbol: "BNB", explorer: "https://bscscan.com" },
  polygon: { chainid: "137", name: "Polygon", symbol: "POL", explorer: "https://polygonscan.com" },
  arbitrum: { chainid: "42161", name: "Arbitrum One", symbol: "ETH", explorer: "https://arbiscan.io" },
  base: { chainid: "8453", name: "Base", symbol: "ETH", explorer: "https://basescan.org" }
};

const EVM_CHAIN_KEYS = new Set(Object.keys(EVM_CHAINS));
const HEX64_RE = /^[a-fA-F0-9]{64}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BTC_ADDRESS_RE = /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{24,33})$/i;

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

function detectCryptoInput(query, chainHint = "auto") {
  const value = cleanText(query, 180);
  const hint = normalizeChainHint(chainHint);
  if (!value) return { error: "Enter a wallet address or transaction hash." };

  if (hint === "bitcoin") {
    if (BTC_ADDRESS_RE.test(value)) return { chain: "bitcoin", kind: "address", value };
    if (HEX64_RE.test(value)) return { chain: "bitcoin", kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like a Bitcoin address or transaction ID." };
  }

  if (hint === "tron") {
    if (TRON_ADDRESS_RE.test(value)) return { chain: "tron", kind: "address", value };
    if (HEX64_RE.test(value)) return { chain: "tron", kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like a TRON address or transaction ID." };
  }

  if (EVM_CHAIN_KEYS.has(hint)) {
    if (EVM_ADDRESS_RE.test(value)) return { chain: hint, kind: "address", value: value.toLowerCase() };
    if (EVM_TX_RE.test(value)) return { chain: hint, kind: "transaction", value: value.toLowerCase() };
    return { error: "This does not look like an EVM address or transaction hash." };
  }

  if (TRON_ADDRESS_RE.test(value)) return { chain: "tron", kind: "address", value };
  if (EVM_ADDRESS_RE.test(value)) return { chain: "ethereum", kind: "address", value: value.toLowerCase() };
  if (BTC_ADDRESS_RE.test(value)) return { chain: "bitcoin", kind: "address", value };
  if (EVM_TX_RE.test(value)) {
    return {
      error: "A 0x transaction hash can exist on several EVM chains. Select Ethereum, BNB Chain, Polygon, Arbitrum or Base."
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
  return payload;
}

async function getJson(url, options, label) {
  return readJson(await fetch(url, options), label);
}

function aggregateFlows(transactions, seed) {
  const map = new Map();
  const seedLower = String(seed || "").toLowerCase();

  for (const tx of transactions || []) {
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
      const key = [from.toLowerCase(), to.toLowerCase(), asset].join("|");
      const item = map.get(key) || {
        from,
        to,
        asset,
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
  const totalIn = incoming.reduce((sum, row) => sum + Math.abs(finiteNumber(row.amount, 0)), 0);
  const totalOut = outgoing.reduce((sum, row) => sum + Math.abs(finiteNumber(row.amount, 0)), 0);
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

  if (totalIn > 0 && totalOut > 0) {
    const ratio = Math.min(totalIn, totalOut) / Math.max(totalIn, totalOut);
    if (ratio >= 0.7) {
      notes.push("The sample shows substantial value moving in both directions. This can indicate pass-through activity, but it is not by itself evidence of layering, laundering, or common ownership.");
    }
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

function btcAddressTransactions(address, raw) {
  return (raw || []).map(tx => {
    const received = (tx.vout || [])
      .filter(output => output?.scriptpubkey_address === address)
      .reduce((sum, output) => sum + finiteNumber(output.value), 0);
    const sent = (tx.vin || [])
      .filter(input => input?.prevout?.scriptpubkey_address === address)
      .reduce((sum, input) => sum + finiteNumber(input?.prevout?.value), 0);
    const net = received - sent;
    const direction = net > 0 ? "IN" : net < 0 ? "OUT" : "SELF";
    const counterparties = direction === "IN"
      ? (tx.vin || []).map(input => input?.prevout?.scriptpubkey_address).filter(Boolean)
      : (tx.vout || []).map(output => output?.scriptpubkey_address).filter(item => item && item !== address);

    return {
      id: tx.txid,
      time: tx.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : "",
      confirmed: Boolean(tx.status?.confirmed),
      direction,
      asset: "BTC",
      amount: Math.abs(net) / 1e8,
      fee: finiteNumber(tx.fee) / 1e8,
      counterparties: [...new Set(counterparties)].slice(0, 12),
      explorer_url: "https://blockstream.info/tx/" + encodeURIComponent(tx.txid)
    };
  });
}

async function analyzeBitcoin(target, limit) {
  const base = "https://blockstream.info/api";

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
        output_addresses: [...new Set((tx.vout || []).map(item => item?.scriptpubkey_address).filter(Boolean))].slice(0, 30)
      },
      transactions: [],
      flows: [],
      observations: ["Transaction-level view. Inputs and outputs are on-chain relationships; they do not establish common ownership."]
    };
  }

  const [info, txs] = await Promise.all([
    getJson(base + "/address/" + encodeURIComponent(target.value), {}, "Blockstream address lookup"),
    getJson(base + "/address/" + encodeURIComponent(target.value) + "/txs", {}, "Blockstream transaction history")
  ]);
  const transactions = btcAddressTransactions(target.value, txs).slice(0, limit);
  const funded = finiteNumber(info?.chain_stats?.funded_txo_sum) + finiteNumber(info?.mempool_stats?.funded_txo_sum);
  const spent = finiteNumber(info?.chain_stats?.spent_txo_sum) + finiteNumber(info?.mempool_stats?.spent_txo_sum);

  return {
    chain: "bitcoin",
    chain_name: "Bitcoin",
    kind: "address",
    query: target.value,
    provider: "Blockstream Esplora",
    explorer_url: "https://blockstream.info/address/" + encodeURIComponent(target.value),
    balance: { amount: (funded - spent) / 1e8, asset: "BTC" },
    activity: {
      confirmed_tx_count: finiteNumber(info?.chain_stats?.tx_count),
      mempool_tx_count: finiteNumber(info?.mempool_stats?.tx_count),
      returned_records: transactions.length
    },
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: buildObservations(transactions, target.value),
    sampling_note: "Blockstream's address endpoint returns recent history first; the current CT Atlas view uses the returned recent sample, not a full lifetime crawl."
  };
}

function etherscanUrl(params, apiKey) {
  const search = new URLSearchParams({ ...params, apikey: apiKey });
  return "https://api.etherscan.io/v2/api?" + search.toString();
}

function parseEtherscanList(payload, label) {
  if (payload?.status === "1" && Array.isArray(payload.result)) return payload.result;
  const message = String(payload?.result || payload?.message || "");
  if (/no transactions found/i.test(message)) return [];
  throw new Error(label + ": " + cleanText(message || "provider error", 240));
}

function evmRows(address, nativeRows, tokenRows, chain) {
  const addressLower = address.toLowerCase();
  const native = nativeRows.map(tx => {
    const from = String(tx.from || "").toLowerCase();
    const to = String(tx.to || "").toLowerCase();
    const direction = from === addressLower && to === addressLower ? "SELF" : from === addressLower ? "OUT" : "IN";
    return {
      id: tx.hash,
      time: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : "",
      confirmed: Number(tx.confirmations || 0) > 0,
      direction,
      asset: chain.symbol,
      amount: finiteNumber(tx.value) / 1e18,
      fee: finiteNumber(tx.gasUsed) * finiteNumber(tx.gasPrice) / 1e18,
      counterparties: [direction === "OUT" ? tx.to : tx.from].filter(Boolean),
      from_address: cleanText(tx.from || "", 80),
      to_address: cleanText(tx.to || "", 80),
      method_id: cleanText(tx.methodId || "", 24),
      function_name: cleanText(tx.functionName || "", 180),
      input_present: Boolean(tx.input && tx.input !== "0x"),
      explorer_url: chain.explorer + "/tx/" + tx.hash,
      failed: String(tx.isError || "0") === "1"
    };
  });

  const tokens = tokenRows.map(tx => {
    const from = String(tx.from || "").toLowerCase();
    const to = String(tx.to || "").toLowerCase();
    const direction = from === addressLower && to === addressLower ? "SELF" : from === addressLower ? "OUT" : "IN";
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
      amount,
      fee: null,
      counterparties: [direction === "OUT" ? tx.to : tx.from].filter(Boolean),
      from_address: cleanText(tx.from || "", 80),
      to_address: cleanText(tx.to || "", 80),
      explorer_url: chain.explorer + "/tx/" + tx.hash,
      failed: false
    };
  });

  return [...native, ...tokens]
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, 100);
}

async function analyzeEvm(target, limit, env) {
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
    if (!payload?.result) throw new Error("Etherscan did not return this transaction on the selected chain.");
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
      observations: ["Transaction-level view from the selected EVM chain. Contract calls and token transfers may require log-level interpretation beyond this first transaction view."]
    };
  }

  const offset = Math.min(100, Math.max(10, limit));
  const [balancePayload, nativePayload, tokenPayload] = await Promise.all([
    getJson(
      etherscanUrl({ ...common, module: "account", action: "balance", address: target.value, tag: "latest" }, env.ETHERSCAN_API_KEY),
      {},
      "Etherscan balance"
    ),
    getJson(
      etherscanUrl({ ...common, module: "account", action: "txlist", address: target.value, startblock: "0", endblock: "9999999999", page: "1", offset: String(offset), sort: "desc" }, env.ETHERSCAN_API_KEY),
      {},
      "Etherscan transactions"
    ),
    getJson(
      etherscanUrl({ ...common, module: "account", action: "tokentx", address: target.value, startblock: "0", endblock: "9999999999", page: "1", offset: String(offset), sort: "desc" }, env.ETHERSCAN_API_KEY),
      {},
      "Etherscan token transfers"
    )
  ]);

  if (balancePayload?.status !== "1") {
    throw new Error("Etherscan balance: " + cleanText(balancePayload?.result || balancePayload?.message || "provider error", 220));
  }

  const nativeRows = parseEtherscanList(nativePayload, "Etherscan transactions");
  const tokenRows = parseEtherscanList(tokenPayload, "Etherscan token transfers");
  const transactions = evmRows(target.value, nativeRows, tokenRows, chain).slice(0, limit);

  return {
    chain: target.chain,
    chain_name: chain.name,
    kind: "address",
    query: target.value,
    provider: "Etherscan API V2",
    explorer_url: chain.explorer + "/address/" + target.value,
    balance: { amount: finiteNumber(balancePayload.result) / 1e18, asset: chain.symbol },
    activity: {
      native_records_found: nativeRows.length,
      token_records_found: tokenRows.length,
      returned_records: transactions.length
    },
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: buildObservations(transactions, target.value),
    sampling_note: "The CT Atlas Crypto view requests a bounded recent page of native and token transfers; it is not a complete archival crawl."
  };
}

function tronHeaders(env) {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "TRON-PRO-API-KEY": env.TRONGRID_API_KEY
  };
}

function tronTokenRows(address, rows) {
  const seed = address.toLowerCase();
  return (rows || []).map(tx => {
    const from = String(tx.from || "");
    const to = String(tx.to || "");
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
      amount,
      fee: null,
      counterparties: [direction === "OUT" ? to : from].filter(Boolean),
      from_address: cleanText(from, 80),
      to_address: cleanText(to, 80),
      explorer_url: "https://tronscan.org/#/transaction/" + (tx.transaction_id || "")
    };
  });
}

function tronTrxRows(address, outgoingRows, incomingRows) {
  const merged = new Map();
  const add = (tx, direction) => {
    const contract = tx?.raw_data?.contract?.[0];
    const value = contract?.parameter?.value || {};
    const amountSun = finiteNumber(value.amount, 0);
    const counterparty = direction === "OUT" ? value.to_address : value.owner_address;
    const id = tx.txID || tx.txid || "";
    if (!id || merged.has(id)) return;
    merged.set(id, {
      id,
      time: tx.block_timestamp ? new Date(Number(tx.block_timestamp)).toISOString() : "",
      confirmed: true,
      direction,
      asset: "TRX",
      amount: amountSun / 1e6,
      fee: null,
      counterparties: counterparty ? [String(counterparty)] : [],
      from_address: cleanText(value.owner_address || "", 100),
      to_address: cleanText(value.to_address || "", 100),
      explorer_url: "https://tronscan.org/#/transaction/" + id,
      contract_type: cleanText(contract?.type || "", 80)
    });
  };
  (outgoingRows || []).forEach(tx => add(tx, "OUT"));
  (incomingRows || []).forEach(tx => add(tx, "IN"));
  return [...merged.values()].sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

async function analyzeTron(target, limit, env) {
  if (!env.TRONGRID_API_KEY) {
    throw new Error("TRON analysis is installed but TRONGRID_API_KEY is not configured in the Cloudflare Worker.");
  }
  const base = "https://api.trongrid.io";
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
        owner_address: value.owner_address || "",
        to_address: value.to_address || "",
        amount_trx: value.amount ? finiteNumber(value.amount) / 1e6 : null,
        fee_trx: receipt?.fee ? finiteNumber(receipt.fee) / 1e6 : 0,
        block_number: receipt?.blockNumber ?? null,
        time: receipt?.blockTimeStamp ? new Date(Number(receipt.blockTimeStamp)).toISOString() : "",
        execution_result: receipt?.receipt?.result || body?.ret?.[0]?.contractRet || ""
      },
      transactions: [],
      flows: [],
      observations: ["Solidified TRON transaction body and receipt. Smart-contract token movements can require event-level interpretation."]
    };
  }

  const bounded = Math.min(100, Math.max(10, limit));
  const q = "only_confirmed=true&limit=" + bounded + "&order_by=block_timestamp,desc";
  const [accountPayload, tokenPayload, outPayload, inPayload] = await Promise.all([
    getJson(base + "/v1/accounts/" + encodeURIComponent(target.value) + "?only_confirmed=true", { headers }, "TronGrid account"),
    getJson(base + "/v1/accounts/" + encodeURIComponent(target.value) + "/transactions/trc20?" + q, { headers }, "TronGrid TRC-20 history"),
    getJson(base + "/v1/accounts/" + encodeURIComponent(target.value) + "/transactions?" + q + "&only_from=true", { headers }, "TronGrid outgoing history"),
    getJson(base + "/v1/accounts/" + encodeURIComponent(target.value) + "/transactions?" + q + "&only_to=true", { headers }, "TronGrid incoming history")
  ]);

  const account = Array.isArray(accountPayload?.data) ? accountPayload.data[0] : null;
  const tokenRows = tronTokenRows(target.value, tokenPayload?.data || []);
  const trxRows = tronTrxRows(target.value, outPayload?.data || [], inPayload?.data || []);
  const transactions = [...tokenRows, ...trxRows]
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, limit);

  return {
    chain: "tron",
    chain_name: "TRON",
    kind: "address",
    query: target.value,
    provider: "TronGrid",
    explorer_url: "https://tronscan.org/#/address/" + target.value,
    balance: { amount: finiteNumber(account?.balance) / 1e6, asset: "TRX" },
    activity: {
      trc20_records_found: tokenRows.length,
      trx_records_found: trxRows.length,
      returned_records: transactions.length
    },
    transactions,
    flows: aggregateFlows(transactions, target.value),
    observations: buildObservations(transactions, target.value),
    sampling_note: "The CT Atlas Crypto view requests a bounded recent page of confirmed TRX and TRC-20 activity. It is not a complete archival crawl."
  };
}

async function analyzeCryptoAddress(address, chain, limit, env) {
  const target = detectCryptoInput(address, chain);
  if (target.error) throw new Error(target.error);
  if (target.kind !== "address") throw new Error("Automatic monitoring supports wallet addresses only.");
  const bounded = clamp(Math.trunc(finiteNumber(limit, 50)), 10, 100);
  if (target.chain === "bitcoin") return analyzeBitcoin(target, bounded);
  if (target.chain === "tron") return analyzeTron(target, bounded, env);
  if (EVM_CHAIN_KEYS.has(target.chain)) return analyzeEvm(target, bounded, env);
  throw new Error("Unsupported blockchain.");
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
    let result;
    if (target.chain === "bitcoin") result = await analyzeBitcoin(target, limit);
    else if (target.chain === "tron") result = await analyzeTron(target, limit, env);
    else if (EVM_CHAIN_KEYS.has(target.chain)) result = await analyzeEvm(target, limit, env);
    else throw new Error("Unsupported blockchain.");

    return jsonResponse({
      ok: true,
      version: CRYPTO_VERSION,
      generated_at: new Date().toISOString(),
      ...result
    }, 200, env);
  } catch (error) {
    console.error("Crypto analysis failed", error);
    return jsonResponse({ error: cleanText(error?.message || "Crypto analysis failed.", 320) }, 503, env);
  }
}

export {
  CRYPTO_VERSION,
  EVM_CHAINS,
  detectCryptoInput,
  aggregateFlows,
  buildObservations,
  analyzeCryptoAddress,
  handleCrypto
};
