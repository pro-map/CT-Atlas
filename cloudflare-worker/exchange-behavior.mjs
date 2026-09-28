const EXCHANGE_BEHAVIOR_VERSION = "exchange-behavior-v1";
const DEFAULT_THRESHOLD = 80;
const EVM_CHAINS = new Set(["ethereum", "bsc", "polygon", "arbitrum", "base"]);

function normalizeAddress(chain, address) {
  const value = String(address || "").trim();
  return EVM_CHAINS.has(String(chain || "").toLowerCase()) ? value.toLowerCase() : value;
}

function labelKey(chain, address) {
  return String(chain || "").toLowerCase() + ":" + normalizeAddress(chain, address);
}

function detectExchangeBehavior(analysis, rawLabels = [], threshold = DEFAULT_THRESHOLD) {
  const minScore = Math.max(0, Math.min(100, Number(threshold) || DEFAULT_THRESHOLD));
  const chain = String(analysis?.chain || "").toLowerCase();
  const address = String(analysis?.query || "");
  if (analysis?.kind !== "address" || !chain || !address) {
    return { version: EXCHANGE_BEHAVIOR_VERSION, status: "not_assessed", candidate: false, threshold: minScore };
  }

  const exchangeLabels = (Array.isArray(rawLabels) ? rawLabels : [])
    .filter(label => String(label?.category || "").toUpperCase() === "EXCHANGE" && label?.address && label?.name);
  const labelsByKey = new Map(exchangeLabels.map(label => [labelKey(label.chain || chain, label.address), label]));
  const exactLabel = labelsByKey.get(labelKey(chain, address));
  if (exactLabel) {
    return {
      version: EXCHANGE_BEHAVIOR_VERSION,
      status: "sourced_match",
      candidate: false,
      threshold: minScore,
      address,
      chain,
      exchange_name: String(exactLabel.name),
      wallet_role: String(exactLabel.wallet_role || "UNKNOWN"),
      source_type: String(exactLabel.source_type || ""),
      source_title: String(exactLabel.source_title || ""),
      source_url: String(exactLabel.source_url || ""),
      source_confidence: String(exactLabel.confidence || "MEDIUM")
    };
  }

  const rows = Array.isArray(analysis?.transactions) ? analysis.transactions : [];
  const metrics = {
    sample_records: rows.length,
    unique_counterparties: 0,
    incoming_records: 0,
    outgoing_records: 0,
    incoming_counterparties: 0,
    outgoing_counterparties: 0,
    active_days: 0,
    assets: 0,
    related_exchange_wallets: 0,
    related_exchange_records: 0
  };
  if (!rows.length) {
    return {
      version: EXCHANGE_BEHAVIOR_VERSION,
      status: "insufficient_sample",
      candidate: false,
      threshold: minScore,
      score: 0,
      address,
      chain,
      metrics,
      evidence: []
    };
  }

  const allCounterparties = new Set();
  const inboundCounterparties = new Set();
  const outboundCounterparties = new Set();
  const activeDays = new Set();
  const assets = new Set();
  const exchangeTouches = new Map();
  const rootKey = normalizeAddress(chain, address);

  for (const row of rows) {
    const direction = String(row?.direction || "").toUpperCase();
    if (direction === "IN") metrics.incoming_records++;
    if (direction === "OUT") metrics.outgoing_records++;
    if (row?.asset) assets.add(String(row.asset).trim().toUpperCase());
    const timestamp = Date.parse(String(row?.time || ""));
    if (Number.isFinite(timestamp)) activeDays.add(new Date(timestamp).toISOString().slice(0, 10));

    const counterparties = [...new Set((Array.isArray(row?.counterparties) ? row.counterparties : [])
      .map(value => String(value || "").trim())
      .filter(value => value && normalizeAddress(chain, value) !== rootKey))];
    for (const counterparty of counterparties) {
      const counterpartyKey = normalizeAddress(chain, counterparty);
      allCounterparties.add(counterpartyKey);
      if (direction === "IN") inboundCounterparties.add(counterpartyKey);
      if (direction === "OUT") outboundCounterparties.add(counterpartyKey);

      const label = labelsByKey.get(labelKey(chain, counterparty));
      if (!label) continue;
      const key = String(label.name).trim();
      const touch = exchangeTouches.get(key) || { name: key, addresses: new Set(), records: 0, sources: [] };
      touch.addresses.add(counterpartyKey);
      touch.records++;
      if (label.source_title && !touch.sources.includes(label.source_title)) touch.sources.push(label.source_title);
      exchangeTouches.set(key, touch);
    }
  }

  metrics.unique_counterparties = allCounterparties.size;
  metrics.incoming_counterparties = inboundCounterparties.size;
  metrics.outgoing_counterparties = outboundCounterparties.size;
  metrics.active_days = activeDays.size;
  metrics.assets = assets.size;

  const related = [...exchangeTouches.values()]
    .sort((a, b) => b.addresses.size - a.addresses.size || b.records - a.records)[0] || null;
  if (related) {
    metrics.related_exchange_wallets = related.addresses.size;
    metrics.related_exchange_records = related.records;
  }

  let score = 0;
  const evidence = [];
  const add = (points, condition, detail) => {
    if (!condition) return;
    score += points;
    evidence.push(detail);
  };

  add(20, rows.length >= 75, `${rows.length} sampled transaction records (75+ signal)`);
  if (rows.length >= 50 && rows.length < 75) add(16, true, `${rows.length} sampled transaction records (50+ signal)`);
  else if (rows.length >= 25 && rows.length < 50) add(10, true, `${rows.length} sampled transaction records (25+ signal)`);

  add(20, allCounterparties.size >= 25, `${allCounterparties.size} distinct counterparties`);
  if (allCounterparties.size >= 15 && allCounterparties.size < 25) add(15, true, `${allCounterparties.size} distinct counterparties`);
  else if (allCounterparties.size >= 8 && allCounterparties.size < 15) add(8, true, `${allCounterparties.size} distinct counterparties`);

  add(15, metrics.incoming_records >= 5 && metrics.outgoing_records >= 5, `${metrics.incoming_records} incoming and ${metrics.outgoing_records} outgoing records`);
  if (metrics.incoming_records >= 2 && metrics.outgoing_records >= 2 && !(metrics.incoming_records >= 5 && metrics.outgoing_records >= 5)) {
    add(8, true, `${metrics.incoming_records} incoming and ${metrics.outgoing_records} outgoing records`);
  }

  add(10, inboundCounterparties.size >= 10, `${inboundCounterparties.size} distinct incoming counterparties`);
  if (inboundCounterparties.size >= 5 && inboundCounterparties.size < 10) add(5, true, `${inboundCounterparties.size} distinct incoming counterparties`);
  add(10, outboundCounterparties.size >= 10, `${outboundCounterparties.size} distinct outgoing counterparties`);
  if (outboundCounterparties.size >= 5 && outboundCounterparties.size < 10) add(5, true, `${outboundCounterparties.size} distinct outgoing counterparties`);

  add(10, activeDays.size >= 10, `activity observed on ${activeDays.size} separate days`);
  if (activeDays.size >= 5 && activeDays.size < 10) add(5, true, `activity observed on ${activeDays.size} separate days`);
  add(10, assets.size >= 4, `${assets.size} distinct assets in the sample`);
  if (assets.size >= 2 && assets.size < 4) add(5, true, `${assets.size} distinct assets in the sample`);

  const relatedExchange = related && related.records >= 3 && related.addresses.size >= 2 ? {
    name: related.name,
    labelled_wallets: related.addresses.size,
    observed_records: related.records,
    source_titles: related.sources
  } : null;
  if (related && related.records >= 5 && related.addresses.size >= 3) {
    add(15, true, `repeated transfers involving ${related.addresses.size} separately labelled ${related.name} wallet(s)`);
  } else if (related && related.records >= 3 && related.addresses.size >= 2) {
    add(10, true, `repeated transfers involving ${related.addresses.size} separately labelled ${related.name} wallet(s)`);
  } else if (related && related.records >= 5) {
    add(8, true, `repeated transfers involving a labelled ${related.name} wallet`);
  }

  score = Math.min(100, score);
  const candidate = score >= minScore && rows.length >= 25 && allCounterparties.size >= 8;
  return {
    version: EXCHANGE_BEHAVIOR_VERSION,
    status: candidate ? "behavioral_candidate" : "below_threshold",
    candidate,
    threshold: minScore,
    score,
    address,
    chain,
    classification: candidate
      ? (relatedExchange ? `Exchange-like wallet with repeated ${relatedExchange.name} connections` : "Exchange-like high-throughput hub")
      : "",
    related_exchange: candidate ? relatedExchange : null,
    metrics,
    evidence: candidate ? evidence : [],
    limitations: "Rules-based screening score, not a calibrated probability. It describes a bounded recent transaction sample and does not prove exchange identity, control, custody, or common ownership. A high-throughput wallet may be another exchange, bridge, payment service, protocol, or other service."
  };
}

export { EXCHANGE_BEHAVIOR_VERSION, DEFAULT_THRESHOLD, detectExchangeBehavior };
