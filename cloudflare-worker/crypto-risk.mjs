// Automated risk indicators for one analysed wallet. Pure: no fetch, no clock and no
// randomness, so the same analysis and context always give the same result. An
// indicator prompts analyst review and establishes nothing about a person. Every
// threshold here was checked on synthetic fixtures only (tests/fixtures/crypto-risk).
const RISK_VERSION = "crypto-risk-v1-provisional";

const MINUTE = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;
const MIN_USABLE_ROWS = 5;
const MAX_TX_IDS = 12;
const REPORTING_BANDS = [1000, 3000, 10000];
const EVM_CHAINS = new Set(["ethereum", "bsc", "polygon", "arbitrum", "base"]);

const THRESHOLDS = Object.freeze({
  elevated: 25,
  high: 60,
  behaviour_cap: 59,
  strong_families_for_high: 3,
  service_factor: 0.25,
  provisional: true,
  note: "Provisional: these thresholds were checked on synthetic data only and have not been calibrated on real wallets."
});

const DISCLAIMER = "Indicator, not proof. Automated rules applied to a bounded public sample. This does not establish identity, ownership, intent, criminality, terrorist financing or sanctions liability.";

// Only contracts confirmed on 2026-11-05 on an issuer or explorer page. Left out for
// now: USDT and USDC on BSC and USDT on Polygon (the explorers refused the check),
// USDC on TRON (Tronscan shows "USD Coin Old"), USDT on Base (BaseScan says Tether
// does not issue it) and bridged USDC variants.
const STABLECOINS = Object.freeze({
  ethereum: new Set([
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT: etherscan.io, tether.to
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC: developers.circle.com
    "0x6b175474e89094c44da98b954eedeac495271d0f" // DAI: etherscan.io
  ]),
  polygon: new Set(["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"]), // USDC: developers.circle.com
  arbitrum: new Set([
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC: developers.circle.com
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" // USD₮0: arbiscan.io
  ]),
  base: new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]), // USDC: developers.circle.com
  tron: new Set(["tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t"]) // USDT: tether.to
});

// Public Etherscan name tags, checked 2026-11-05. Not on the current sanctions list.
const MIXER_REGISTRY = Object.freeze({
  ethereum: new Map([
    ["0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc", "Tornado.Cash: 0.1 ETH"],
    ["0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936", "Tornado.Cash: 1 ETH"],
    ["0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", "Tornado.Cash: 10 ETH"],
    ["0xa160cdab225685da1d56aa342ad8841c3b53f291", "Tornado.Cash: 100 ETH"]
  ])
});
const LISTED_MIXER_RE = /\b(?:blender\.io|sinbad|tornado|mixer)\b/i;

// In asset units, so never comparable across assets. A token outside the allow-list
// has no known value, so it cannot be shown to be material.
const DUST_FLOOR = Object.freeze({ BTC: 0.00001, ETH: 0.0001, BNB: 0.0005, POL: 0.5, TRX: 2 });
const STABLE_DUST_FLOOR = 1;
// Rough size of a small payment, to tell a tip jar from a treasury. Not a valuation.
const SMALL_PAYMENT = Object.freeze({ BTC: 0.005, ETH: 0.1, BNB: 0.5, POL: 500, TRX: 1000 });
const STABLE_SMALL_PAYMENT = 200;

function isStablecoin(chain, contract) {
  return Boolean(STABLECOINS[chain]?.has(String(contract || "").toLowerCase()));
}

function partyKey(chain, address) {
  const value = String(address || "").trim();
  return EVM_CHAINS.has(chain) || /^bc1/i.test(value) ? value.toLowerCase() : value;
}

const sum = values => values.reduce((total, value) => total + value, 0);
const round = (value, places = 2) => Number(value.toFixed(places));
const isIn = row => row.direction === "IN";
const isOut = row => row.direction === "OUT";
const stronger = (best, item) => (!best || item.points > best.points ? item : best);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
}

function uniqueParties(rows) {
  const parties = new Set();
  for (const row of rows) for (const party of row.cps) parties.add(party);
  return parties;
}

// A Bitcoin transaction's inputs are one sender, however many addresses they use.
function senderCount(rows, chain) {
  return chain === "bitcoin" ? new Set(rows.map(row => row.id)).size : uniqueParties(rows).size;
}

function compareRows(a, b) {
  return a.t - b.t
    || String(a.id).localeCompare(String(b.id))
    || a.direction.localeCompare(b.direction)
    || a.assetKey.localeCompare(b.assetKey)
    || a.amount - b.amount;
}

// The rows that rules may read. Failed, unconfirmed, self and zero-value rows are
// set aside here so that no rule can count them by accident.
function prepare(analysis) {
  const chain = String(analysis?.chain || "").toLowerCase();
  const seed = partyKey(chain, analysis?.query);
  const excluded = { failed: 0, pending: 0, zero_value: 0, spam: 0 };
  const rows = [];
  const self = [];
  const zero = [];
  const screening = analysis?.sanctions_screening || null;
  const listed = new Map((Array.isArray(screening?.counterparty_matches) ? screening.counterparty_matches : [])
    .map(match => [partyKey(chain, match.address), []]));

  for (const raw of Array.isArray(analysis?.transactions) ? analysis.transactions : []) {
    const parties = Array.isArray(raw?.all_counterparties) ? raw.all_counterparties : Array.isArray(raw?.counterparties) ? raw.counterparties : [];
    const cps = [...new Set(parties.map(party => partyKey(chain, party)).filter(party => party && party !== seed))];
    const coInputs = (Array.isArray(raw?.co_inputs) ? raw.co_inputs : []).map(party => partyKey(chain, party));
    const row = {
      ...raw,
      t: Date.parse(String(raw?.time || "")),
      direction: String(raw?.direction || "").toUpperCase(),
      amount: Math.abs(Number(raw?.amount) || 0),
      assetKey: String(raw?.asset_key || raw?.token_contract || "native").toLowerCase(),
      cps
    };
    // Exposure reads every link to a listed address, including rows the behaviour rules drop.
    for (const party of new Set([...cps, ...coInputs])) listed.get(party)?.push(row);
    if (raw?.failed === true) excluded.failed++;
    else if (!Number.isFinite(row.t)) excluded.pending++;
    else if (row.direction === "SELF" || raw?.self_spend === true) self.push(row);
    else if (row.amount === 0) {
      excluded.zero_value++;
      zero.push(row);
    } else if (raw?.spam === true) excluded.spam++;
    else if (isIn(row) || isOut(row)) rows.push(row);
  }

  rows.sort(compareRows);
  self.sort(compareRows);
  zero.sort(compareRows);
  const byAsset = new Map();
  for (const row of rows) {
    if (!byAsset.has(row.assetKey)) byAsset.set(row.assetKey, []);
    byAsset.get(row.assetKey).push(row);
  }
  return { chain, rows, self, zero, byAsset, listed, excluded, screening };
}

function coverageOf(analysis, data) {
  const given = analysis?.coverage || {};
  const times = data.rows.map(row => row.t);
  const iso = value => new Date(value).toISOString();
  return {
    rows: Number.isFinite(given.rows) ? given.rows : (Array.isArray(analysis?.transactions) ? analysis.transactions.length : 0),
    oldest: given.oldest ?? (times.length ? iso(Math.min(...times)) : ""),
    newest: given.newest ?? (times.length ? iso(Math.max(...times)) : ""),
    complete: given.complete === true,
    lifetime_tx_count: given.lifetime_tx_count ?? null,
    partial: given.partial === true,
    usable_rows: data.rows.length,
    excluded: data.excluded,
    sanctions_status: data.screening?.status || "unavailable"
  };
}

function finding({ code, family, strength, points, title, explanation, metrics = {}, rows = [], benign, ...extra }) {
  const times = rows.map(row => row.t).filter(Number.isFinite);
  return {
    code,
    family,
    strength,
    points,
    title,
    explanation,
    metrics,
    tx_ids: [...new Set(rows.map(row => row.id).filter(Boolean))].slice(0, MAX_TX_IDS),
    window: times.length
      ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() }
      : null,
    benign,
    ...extra
  };
}

// The slice of time-sorted rows inside `span` that scores highest on `measure`.
function bestWindow(rows, span, measure = list => list.length) {
  let best = [];
  let bestScore = 0;
  let left = 0;
  for (let right = 0; right < rows.length; right++) {
    while (rows[right].t - rows[left].t > span) left++;
    const slice = rows.slice(left, right + 1);
    const score = measure(slice);
    if (score > bestScore) {
      best = slice;
      bestScore = score;
    }
  }
  return best;
}

// bestWindow by distinct parties. Counted incrementally, because one Bitcoin row can
// carry thousands: rebuilding a set per position took seconds on a busy hot wallet.
function widestWindow(rows, span) {
  const counts = new Map();
  let left = 0;
  let best = [0, 0];
  let bestSize = 0;
  for (let right = 0; right < rows.length; right++) {
    for (const party of rows[right].cps) counts.set(party, (counts.get(party) || 0) + 1);
    while (rows[right].t - rows[left].t > span) {
      for (const party of rows[left].cps) {
        const count = counts.get(party) - 1;
        if (count) counts.set(party, count);
        else counts.delete(party);
      }
      left++;
    }
    if (counts.size > bestSize) {
      bestSize = counts.size;
      best = [left, right + 1];
    }
  }
  return rows.slice(best[0], best[1]);
}

// FIFO inside one asset: an outgoing amount explains one incoming amount once.
function passThroughPairs(rows, windowMs) {
  const outs = rows.filter(isOut).map(row => ({ row, left: row.amount }));
  const pairs = [];
  for (const incoming of rows.filter(isIn)) {
    let left = incoming.amount;
    let reached = null;
    const used = [];
    for (const out of outs) {
      if (out.left <= 0 || out.row.t < incoming.t || out.row.t - incoming.t > windowMs) continue;
      const take = Math.min(left, out.left);
      out.left -= take;
      left -= take;
      used.push(out.row);
      // Dwell is the time until 80% has left: a small residual must not stretch it.
      if (reached === null && incoming.amount - left >= incoming.amount * 0.8) reached = out.row.t;
      if (left <= incoming.amount * 0.001) break;
    }
    if (reached !== null) pairs.push({ incoming, outs: used, moved: incoming.amount - left, dwell: reached - incoming.t });
  }
  return pairs;
}

function detectPassThrough({ byAsset }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const received = sum(rows.filter(isIn).map(row => row.amount));
    if (!received) continue;
    const pairs = passThroughPairs(rows, 6 * HOUR);
    const split = pairs.some(pair => pair.outs.length >= 4);
    if (pairs.length < 2 && !split) continue;
    const ratio = sum(pairs.map(pair => pair.moved)) / received;
    const dwell = median(pairs.map(pair => pair.dwell));
    const strong = pairs.length >= 3 && dwell <= 30 * MINUTE && ratio >= 0.7;
    const moderate = dwell <= 6 * HOUR && ratio >= (pairs.length >= 2 ? 0.5 : 0.9);
    if (!strong && !moderate) continue;
    best = stronger(best, finding({
      code: "RAPID_PASS_THROUGH",
      family: "FLOW",
      strength: strong ? "strong" : "moderate",
      points: strong ? 30 : 15,
      title: "Funds left soon after arriving",
      explanation: "Most of what arrived in this asset moved on within hours of being received.",
      metrics: { matched_pairs: pairs.length, pass_ratio: round(ratio), median_dwell_minutes: Math.round(dwell / MINUTE), asset: rows[0].asset },
      rows: pairs.flatMap(pair => [pair.incoming, ...pair.outs]),
      benign: ["exchange or payment hot wallet", "OTC desk or market maker", "arbitrage or bot activity"]
    }));
  }
  return best;
}

function detectCycling({ byAsset }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const partners = new Map();
    for (const row of rows) {
      for (const party of row.cps) {
        if (!partners.has(party)) partners.set(party, []);
        partners.get(party).push(row);
      }
    }
    for (const [party, list] of partners) {
      const outs = list.filter(isOut);
      const used = new Set();
      const trips = [];
      for (const incoming of list.filter(isIn)) {
        const back = outs.find(out => !used.has(out)
          && Math.abs(out.t - incoming.t) <= 72 * HOUR
          && Math.abs(out.amount - incoming.amount) <= incoming.amount * 0.1);
        if (!back) continue;
        used.add(back);
        trips.push(incoming, back);
      }
      const count = trips.length / 2;
      if (count < 3) continue;
      best = stronger(best, finding({
        code: "VALUE_CYCLING",
        family: "FLOW",
        strength: count >= 5 ? "strong" : "moderate",
        points: count >= 5 ? 25 : 12,
        title: "Similar value moved back and forth with one counterparty",
        explanation: "Comparable amounts went out to and came back from the same address within 72 hours, several times.",
        metrics: { round_trips: count, counterparty: party, asset: rows[0].asset },
        rows: trips,
        benign: ["exchange deposit and withdrawal tests", "market making", "loan repayments"]
      }));
    }
  }
  return best;
}

function detectVelocity({ rows }) {
  const burst = bestWindow(rows, DAY);
  if (burst.length < 20) return null;
  return finding({
    code: "HIGH_VELOCITY",
    family: "FLOW",
    strength: "moderate",
    points: 12,
    title: "Unusually many transfers in one day",
    explanation: "At least 20 transfers fell inside one 24-hour period. This counts records and says nothing about value.",
    metrics: { records_in_24h: burst.length },
    rows: burst,
    benign: ["bot or automated service", "busy trader"]
  });
}

function detectFanOut({ byAsset, chain }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const sends = widestWindow(rows.filter(isOut), DAY);
    const receivers = uniqueParties(sends);
    if (receivers.size < 8) continue;
    const start = sends[0].t;
    const end = sends[sends.length - 1].t;
    const funding = rows.filter(row => isIn(row) && row.t <= end && row.t >= start - DAY);
    if (!funding.length) continue;
    const sources = senderCount(funding, chain);
    const sent = sum(sends.map(row => row.amount));
    if (sources > 2 || sent < 0.7 * sum(funding.map(row => row.amount))) continue;
    const amounts = sends.map(row => row.amount);
    const mean = sum(amounts) / amounts.length;
    const spread = Math.sqrt(sum(amounts.map(amount => (amount - mean) ** 2)) / amounts.length) / (mean || 1);
    const seenBefore = uniqueParties(rows.filter(row => row.t < start));
    const fresh = [...receivers].filter(party => !seenBefore.has(party)).length / receivers.size;
    const strong = receivers.size >= 15 || (fresh >= 0.7 && spread <= 0.2 && end - start <= 6 * HOUR);
    best = stronger(best, finding({
      code: "FAN_OUT",
      family: "FRAGMENTATION",
      strength: strong ? "strong" : "moderate",
      points: strong ? 20 : 10,
      title: "One source split across many recipients",
      explanation: "Funds from one or two sources went out to many addresses within a day.",
      metrics: { receivers: receivers.size, funding_sources: sources, amount_cv: round(spread), fresh_share: round(fresh), asset: rows[0].asset },
      rows: sends,
      benign: ["payroll or airdrop", "batched exchange withdrawals", "mining pool payout"]
    }));
  }
  return best;
}

function detectFanIn({ byAsset, chain }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const receipts = bestWindow(rows.filter(isIn), DAY, list => senderCount(list, chain));
    const senders = senderCount(receipts, chain);
    if (senders < 8) continue;
    const start = receipts[0].t;
    const end = receipts[receipts.length - 1].t;
    const after = rows.filter(row => isOut(row) && row.t >= start && row.t <= end + 72 * HOUR);
    const moved = sum(after.map(row => row.amount)) / (sum(receipts.map(row => row.amount)) || 1);
    const receivers = uniqueParties(after).size;
    const strong = moved >= 0.7 && receivers <= 2;
    best = stronger(best, finding({
      code: "FAN_IN",
      family: "AGGREGATION",
      strength: strong ? "strong" : "moderate",
      points: strong ? 15 : 8,
      title: "Many sources converged within a day",
      explanation: strong
        ? "Many senders paid in within a day and most of it moved on to one or two addresses."
        : "Many senders paid in within a day.",
      metrics: { senders_in_24h: senders, moved_on_ratio: round(moved), receivers, asset: rows[0].asset },
      rows: [...receipts, ...after],
      benign: ["exchange deposit sweep", "payment gateway settlement"]
    }));
  }
  return best;
}

function smallPaymentLimit(row) {
  if (row.stable === true) return STABLE_SMALL_PAYMENT;
  return row.token_contract ? 0 : SMALL_PAYMENT[String(row.asset).toUpperCase()] ?? 0;
}

function detectDonationFanIn({ byAsset, chain }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const receipts = rows.filter(isIn);
    const outs = rows.filter(isOut);
    if (receipts.length < 15 || !outs.length) continue;
    const senders = senderCount(receipts, chain);
    const spanDays = (receipts[receipts.length - 1].t - receipts[0].t) / DAY;
    const amounts = receipts.map(row => row.amount);
    const typical = median(amounts);
    const small = typical <= 0.05 * Math.max(...amounts) || typical <= smallPaymentLimit(rows[0]);
    const sweeps = new Map();
    for (const out of outs) for (const party of out.cps) sweeps.set(party, (sweeps.get(party) || 0) + 1);
    const repeatSweep = [...sweeps.values()].some(count => count >= 2);
    if (senders < 15 || spanDays < 7 || !small || receipts.length < 5 * outs.length || !repeatSweep) continue;
    best = stronger(best, finding({
      code: "DONATION_STYLE_FAN_IN",
      family: "AGGREGATION",
      strength: "moderate",
      points: 25,
      title: "Many small payers, periodically swept to one place",
      explanation: "Small payments from many senders arrived over at least a week and were swept out repeatedly to the same address.",
      metrics: { distinct_senders: senders, span_days: Math.round(spanDays), median_amount: typical, sweeps: outs.length, asset: rows[0].asset },
      rows: [...receipts.slice(-8), ...outs],
      benign: ["merchant or tip jar", "charity", "faucet or payment page"]
    }));
  }
  return best;
}

function detectStructuring({ byAsset }) {
  let best = null;
  for (const rows of byAsset.values()) {
    if (rows[0].stable !== true) continue;
    for (const direction of ["IN", "OUT"]) {
      const list = rows.filter(row => row.direction === direction);
      for (const limit of REPORTING_BANDS) {
        const band = bestWindow(list.filter(row => row.amount >= limit * 0.9 && row.amount < limit), 7 * DAY);
        if (band.length < 3) continue;
        const first = band[0].t;
        const last = band[band.length - 1].t;
        const aggregate = sum(band.map(row => row.amount));
        const share = band.length / list.filter(row => row.t >= first && row.t <= last).length;
        if (aggregate < 1.5 * limit || share < 0.6) continue;
        const parties = uniqueParties(band).size;
        const strong = band.length >= 5 && aggregate >= 3 * limit && parties <= 3;
        best = stronger(best, finding({
          code: "STRUCTURING_BAND",
          family: "FRAGMENTATION",
          strength: strong ? "strong" : "moderate",
          points: strong ? 25 : 12,
          title: "Repeated amounts just under a common reporting threshold",
          explanation: "Several stablecoin transfers in one direction sat just below a round threshold. These are fiat and exchange thresholds with no force on-chain.",
          metrics: { band: "just under " + limit, count: band.length, aggregate, direction, counterparties: parties, asset: rows[0].asset },
          rows: band,
          benign: ["platform or P2P limit set near this value", "fixed payment plan"]
        }));
      }
    }
  }
  return best;
}

function twoSignificantFigures(value) {
  if (!value) return 0;
  const unit = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / unit) * unit;
}

function detectRoundAmounts({ byAsset }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const outs = rows.filter(isOut);
    if (outs.length < 5) continue;
    const buckets = new Map();
    for (const row of outs) {
      // A Bitcoin row's amount includes the fee, which hides a round payment.
      const value = row.payment_amount ?? row.amount;
      if (Math.abs(value - twoSignificantFigures(value)) > value * 1e-9) continue;
      const key = value.toPrecision(6);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    const top = [...buckets.values()].sort((a, b) => b.length - a.length)[0] || [];
    if (top.length < 5 || top.length / outs.length < 0.6) continue;
    best = stronger(best, finding({
      code: "ROUND_AMOUNT_CLUSTER",
      family: "FRAGMENTATION",
      strength: "moderate",
      points: 10,
      title: "Same round amount repeated",
      explanation: "Most outgoing transfers in this asset used one round amount.",
      metrics: { count: top.length, share: round(top.length / outs.length), value: top[0].payment_amount ?? top[0].amount, asset: rows[0].asset },
      rows: top,
      benign: ["subscription or salary", "exchange withdrawal preset"]
    }));
  }
  return best;
}

function detectPeelStep({ chain, rows }, coverage) {
  if (chain !== "bitcoin" || !coverage.complete || rows.length !== 2) return null;
  const receipt = rows.find(isIn);
  const spend = rows.find(isOut);
  if (!receipt || !spend || !Array.isArray(spend.out_values) || spend.out_values.length !== 2) return null;
  if ((spend.outputs_count ?? 2) !== 2 || spend.t < receipt.t || spend.t - receipt.t > 24 * HOUR) return null;
  const larger = Math.max(...spend.out_values);
  const share = larger / sum(spend.out_values);
  if (share < 0.85) return null;
  return finding({
    code: "PEEL_STEP",
    family: "FRAGMENTATION",
    strength: "moderate",
    points: 15,
    title: "Single-use wallet: most funds forwarded, a small slice taken off",
    explanation: "The wallet received once, spent once within a day, and most of the value went to one of two outputs.",
    metrics: { larger_output_share: round(share, 3), hours_held: round((spend.t - receipt.t) / HOUR, 1) },
    rows: [receipt, spend],
    benign: ["ordinary payment with change to a new address"],
    needs_trace: "A chain needs at least 3 such hops: check with AUTO TRACE."
  });
}

function detectDormancy({ rows }, coverage, analysis) {
  if (rows.length < 6) return null;
  let gap = 0;
  let index = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].t - rows[i - 1].t > gap) {
      gap = rows[i].t - rows[i - 1].t;
      index = i;
    }
  }
  if (gap < 90 * DAY) return null;
  const burst = rows.slice(index).filter(row => row.t - rows[index].t <= 48 * HOUR);
  if (burst.length < 5) return null;
  const drained = Math.max(0, ...[...new Set(burst.map(row => row.assetKey))].map(key => {
    const received = sum(rows.filter(row => row.assetKey === key && isIn(row)).map(row => row.amount));
    return received ? sum(burst.filter(row => row.assetKey === key && isOut(row)).map(row => row.amount)) / received : 0;
  }));
  const strong = gap >= 180 * DAY && drained >= 0.8;
  return finding({
    code: "DORMANT_THEN_BURST",
    family: "TEMPORAL",
    strength: strong ? "strong" : "moderate",
    points: strong ? 20 : 10,
    title: "Long silence, then a burst",
    explanation: coverage.complete
      ? "The wallet's history shows a long quiet period followed by a burst of activity."
      : "This sample shows a long quiet period followed by a burst. Only gaps inside the sample are visible.",
    metrics: {
      gap_days: Math.round(gap / DAY),
      records_in_48h: burst.length,
      drained_share: round(drained),
      sample_complete: coverage.complete,
      lifetime_tx_count: coverage.lifetime_tx_count,
      account_created_at: analysis?.activity?.account_created_at || null
    },
    rows: burst,
    benign: ["long-term holder moving funds", "wallet migration or key rotation"]
  });
}

function detectExchangeHopping({ rows, chain }, labels) {
  const exchanges = new Map(labels
    .filter(label => String(label?.category || "").toUpperCase() === "EXCHANGE" && (label?.source_title || label?.source_url))
    .map(label => [partyKey(chain, label.address), String(label.name)]));
  if (!exchanges.size) return null;
  const touches = rows.flatMap(row => row.cps.filter(party => exchanges.has(party)).map(party => ({ row, name: exchanges.get(party) })));
  const outs = touches.filter(item => isOut(item.row));
  const namesIn = list => new Set(outs.filter(item => list.includes(item.row)).map(item => item.name));
  const sendRows = [...new Set(outs.map(item => item.row))];
  const names = namesIn(bestWindow(sendRows, 7 * DAY, list => namesIn(list).size));
  let relays = 0;
  for (const incoming of touches.filter(item => isIn(item.row))) {
    if (outs.some(out => out.name !== incoming.name
      && out.row.assetKey === incoming.row.assetKey
      && out.row.t >= incoming.row.t
      && out.row.t - incoming.row.t <= 24 * HOUR)) relays++;
  }
  if (names.size < 3 && relays < 2) return null;
  const strong = names.size >= 3 && relays >= 1;
  return finding({
    code: "EXCHANGE_HOPPING",
    family: "OBFUSCATION",
    strength: strong ? "strong" : "moderate",
    points: strong ? 20 : 10,
    title: "Funds moved between several exchanges",
    explanation: "Transfers touched several exchanges with sourced labels within days. Few exchange wallets are labelled, so this rule misses far more than it finds.",
    metrics: { exchanges: [...names], relays },
    rows: touches.map(item => item.row),
    benign: ["arbitrage trader", "OTC desk"]
  });
}

function detectPoisoning({ rows, zero }) {
  const appearing = zero.filter(row => row.token_contract && isOut(row));
  if (!appearing.length) return null;
  const known = new Set(rows.flatMap(row => row.cps.map(party => party.slice(0, 6) + party.slice(-4))));
  const parties = new Set(rows.flatMap(row => row.cps));
  const lookAlike = appearing.filter(row => row.cps.some(party => !parties.has(party) && known.has(party.slice(0, 6) + party.slice(-4))));
  if (appearing.length < 2 && !lookAlike.length) return null;
  return finding({
    code: "ADDRESS_POISONING_TARGET",
    family: "OBFUSCATION",
    strength: "info",
    points: 0,
    title: "Zero-value look-alike transfers aimed at this wallet",
    explanation: "Zero-value token rows appear as sent by this wallet. Third parties can create these without the owner's key.",
    metrics: { zero_value_rows: appearing.length, look_alike: lookAlike.length },
    rows: appearing,
    benign: ["spam aimed at this wallet: this is not behaviour of the owner"]
  });
}

function isDustRow(row) {
  if (row.stable === true) return row.amount <= STABLE_DUST_FLOOR;
  if (row.token_contract) return true;
  return row.amount <= (DUST_FLOOR[String(row.asset).toUpperCase()] ?? 0);
}

function isUnvaluedToken(row) {
  return Boolean(row.token_contract) && row.stable !== true && row.amount > 0;
}

function detectDustSpray({ byAsset }) {
  let best = null;
  for (const rows of byAsset.values()) {
    const largest = Math.max(...rows.map(row => row.amount));
    // Per recipient, since one Bitcoin transaction can pay many. A floor decides where
    // one exists; an unknown token has none, so only its own scale can call it tiny.
    const tiny = rows.filter(row => {
      if (!isOut(row)) return false;
      const each = row.amount / Math.max(1, row.cps.length);
      return row.token_contract && row.stable !== true ? each <= largest * 0.0001 : isDustRow({ ...row, amount: each });
    });
    const spray = widestWindow(tiny, DAY);
    const recipients = uniqueParties(spray).size;
    if (recipients < 20) continue;
    best = stronger(best, finding({
      code: "DUST_SPRAY",
      family: "OBFUSCATION",
      strength: "moderate",
      points: 10,
      title: "Tiny amounts sprayed to many addresses",
      explanation: "Very small transfers went to at least 20 addresses within a day.",
      metrics: { recipients, asset: rows[0].asset },
      rows: spray,
      benign: ["airdrop or marketing", "gas or fee top-ups"]
    }));
  }
  return best;
}

function detectSelfChurn({ self }) {
  const moved = bestWindow(self.filter(row => row.amount > 0), 7 * DAY);
  if (moved.length < 5) return null;
  return finding({
    code: "SELF_TRANSFER_CHURN",
    family: "OBFUSCATION",
    strength: "moderate",
    points: 8,
    title: "Repeated transfers to itself",
    explanation: "At least five value-bearing transfers from this wallet to itself fell within a week.",
    metrics: { count: moved.length },
    rows: moved,
    benign: ["UTXO consolidation", "wallet maintenance"]
  });
}

function directSanctionsFinding(match, linked) {
  const live = linked.filter(row => row.failed !== true);
  const sent = Number(match.sent_to_count) || 0;
  const spentWith = Number(match.spent_with_count) || 0;
  const received = Number(match.received_from_count) || 0;
  const metrics = {
    address: match.address,
    summary: match.summary,
    received_from: received,
    sent_to: sent,
    spent_with: spentWith,
    first_seen: match.first_seen || "",
    last_seen: match.last_seen || ""
  };
  // Anyone can send to any address, so a tiny unsolicited receipt says nothing about the owner.
  if (!sent && !spentWith && live.length && live.every(isDustRow) && !live.some(isUnvaluedToken)) {
    return finding({
      code: "SANCTIONED_DUST_RECEIVED",
      family: "EXPOSURE",
      strength: "info",
      points: 5,
      title: "Tiny inbound transfer from a listed address (anyone can send this)",
      explanation: "The only link to this listed address is a tiny inbound transfer, which the owner cannot prevent.",
      metrics,
      rows: live,
      benign: ["unsolicited dusting"]
    });
  }
  // No price exists for this token: it can be spam or real money, so it needs an analyst.
  if (!sent && !spentWith && live.length && live.every(isDustRow)) {
    return finding({
      code: "LISTED_UNKNOWN_TOKEN_RECEIVED",
      family: "EXPOSURE",
      strength: "moderate",
      points: 30,
      title: "Inbound token of unknown value from a listed address",
      explanation: "The only link to this listed address is an inbound token whose value CT Atlas cannot price, so this may be spam or real funds.",
      metrics,
      rows: live,
      benign: ["spam or airdropped token", "anyone can send a token to any address"]
    });
  }
  const terrorism = (match.entities || []).some(entity => entity?.terrorism === true);
  const noValueMoved = linked.length > 0 && !live.length;
  return finding({
    code: "DIRECT_SANCTIONS_EXPOSURE",
    family: "EXPOSURE",
    strength: "strong",
    points: terrorism ? 70 : 60,
    floor: "HIGH",
    title: spentWith && !sent && !received ? "Spent in one transaction with a listed address" : "Direct transfer with a listed address",
    explanation: noValueMoved
      ? "Every record linking this wallet to the listed address failed, so no value moved in this sample."
      : "A record in this sample links this wallet directly to an address on a sanctions list.",
    metrics: { ...metrics, programmes: [...new Set((match.entities || []).flatMap(entity => entity?.programs || []))], terrorism_program: terrorism, no_value_moved: noValueMoved },
    rows: linked,
    benign: [
      "incidental payment: a listed exchange or service touches many ordinary users",
      "the match is an exact address string and may be historical",
      ...(spentWith ? ["a CoinJoin-style transaction combines inputs from unrelated wallets"] : [])
    ],
    ...(linked.length ? {} : { tx_ids: (match.tx_ids || []).slice(0, MAX_TX_IDS) })
  });
}

function exposureFindings(data, labels) {
  const { chain, screening, listed, rows } = data;
  const found = [];
  if (screening?.seed_match) {
    found.push(finding({
      code: "LISTED_WALLET",
      family: "EXPOSURE",
      strength: "strong",
      points: 100,
      floor: "HIGH",
      title: "This address appears on a sanctions list",
      explanation: "The analysed address matches a sanctions list entry character for character.",
      metrics: { summary: screening.seed_match.summary },
      benign: ["the match is an exact address string and may be historical: verify against the source list"]
    }));
  }

  const matches = Array.isArray(screening?.counterparty_matches) ? screening.counterparty_matches : [];
  for (const match of matches) found.push(directSanctionsFinding(match, listed.get(partyKey(chain, match.address)) || []));

  const mixers = new Map(MIXER_REGISTRY[chain] || []);
  for (const label of labels) {
    if (String(label?.category || "").toUpperCase() === "MIXER") mixers.set(partyKey(chain, label.address), String(label.name || "Labelled mixer"));
  }
  for (const match of matches) {
    const name = (match.entities || []).map(entity => String(entity?.name || "")).find(value => LISTED_MIXER_RE.test(value));
    if (name) mixers.set(partyKey(chain, match.address), name);
  }
  const touched = new Set();
  const mixerRows = rows.filter(row => {
    const hits = row.cps.filter(party => mixers.has(party));
    for (const party of hits) touched.add(mixers.get(party));
    return hits.length > 0;
  });
  const coinjoins = rows.filter(row => row.coinjoin_like === true);
  if (mixerRows.length || coinjoins.length) {
    found.push(finding({
      code: "DIRECT_MIXER_EXPOSURE",
      family: "EXPOSURE",
      strength: "strong",
      points: 45,
      title: mixerRows.length ? "Direct transfer with a mixing service" : "Took part in a CoinJoin-like transaction",
      explanation: mixerRows.length
        ? "A record in this sample links this wallet directly to a known mixing service."
        : "A transaction with at least 5 inputs and at least 5 equal outputs involves this wallet.",
      metrics: {
        services: [...touched],
        funds_from: mixerRows.filter(isIn).length,
        funds_to: mixerRows.filter(isOut).length,
        coinjoin_like_records: coinjoins.length
      },
      rows: [...mixerRows, ...coinjoins],
      benign: ["privacy use is not illicit in itself", "Tornado Cash is not on the current sanctions list"]
    }));
  }
  return found;
}

function notEvaluated(data, coverage, usable, labels) {
  const list = [];
  const add = (code, reason) => list.push({ code, reason });
  if (!["ok", "stale"].includes(coverage.sanctions_status)) add("SANCTIONS_SCREENING", "Sanctions screening did not run.");
  if (coverage.partial) add("PARTIAL_HISTORY", "A provider call failed, so some records are missing from this sample.");
  if (!usable) add("BEHAVIOUR_RULES", "Only " + coverage.usable_rows + " usable records; these rules need at least " + MIN_USABLE_ROWS + ".");
  add("STRUCTURING_BAND", (STABLECOINS[data.chain] ? "Stablecoins only" : "No stablecoin contract is verified for this chain") +
    ": native assets not evaluated, because no price source is available.");
  if (data.chain === "bitcoin" && !coverage.complete) add("PEEL_STEP", "Needs the wallet's complete history.");
  if (!coverage.complete) add("DORMANT_THEN_BURST", "Only gaps inside this sample are visible.");
  if (!labels.some(label => String(label?.category || "").toUpperCase() === "EXCHANGE")) add("EXCHANGE_HOPPING", "No sourced exchange label matched this sample.");
  add("ONE_HOP_EXPOSURE", "Runs in the browser, on request.");
  add("PEEL_CHAIN", "Runs in the browser, on traced wallets.");
  // Listed here because this is the list the page and the report print in full.
  add("THRESHOLD_CALIBRATION", THRESHOLDS.note);
  return list;
}

// Scoring takes the highest finding per family so correlated rules cannot stack, and
// behaviour alone stays below HIGH unless enough independent families are strong.
function assessWallet(analysis, ctx = {}) {
  const data = prepare(analysis);
  const coverage = coverageOf(analysis, data);
  const labels = Array.isArray(ctx.labels) ? ctx.labels : [];
  const usable = data.rows.length >= MIN_USABLE_ROWS;
  const exposure = exposureFindings(data, labels);
  const behaviour = [
    ...(usable ? [
      detectPassThrough(data),
      detectCycling(data),
      detectVelocity(data),
      detectFanOut(data),
      detectStructuring(data),
      detectRoundAmounts(data),
      detectFanIn(data),
      detectDonationFanIn(data),
      detectDormancy(data, coverage, analysis),
      detectExchangeHopping(data, labels),
      detectDustSpray(data)
    ] : []),
    detectPeelStep(data, coverage),
    detectPoisoning(data),
    detectSelfChurn(data)
  ].filter(Boolean);

  const service = ["behavioral_candidate", "sourced_match"].includes(ctx.exchangeBehavior?.status);
  const families = new Map();
  for (const item of behaviour) families.set(item.family, stronger(families.get(item.family), item));
  const top = [...families.values()];
  let behaviourScore = sum(top.map(item => item.points)) * (service ? THRESHOLDS.service_factor : 1);
  if (top.filter(item => item.strength === "strong").length < THRESHOLDS.strong_families_for_high) {
    behaviourScore = Math.min(behaviourScore, THRESHOLDS.behaviour_cap);
  }
  const exposureByCode = new Map();
  for (const item of exposure) exposureByCode.set(item.code, Math.max(exposureByCode.get(item.code) || 0, item.points));
  let total = behaviourScore + sum([...exposureByCode.values()]);
  // An informational finding must not be what lifts behaviour past its cap.
  if (top.filter(item => item.strength === "strong").length < THRESHOLDS.strong_families_for_high
      && exposure.every(item => item.strength === "info")) {
    total = Math.min(total, THRESHOLDS.behaviour_cap);
  }
  const score = Math.min(100, Math.round(total));

  const findings = [...exposure, ...behaviour].sort((a, b) => b.points - a.points || a.code.localeCompare(b.code));
  const scoring = findings.filter(item => item.points > 0);
  let label = exposure.some(item => item.floor === "HIGH") || score >= THRESHOLDS.high
    ? "HIGH"
    : score >= THRESHOLDS.elevated ? "ELEVATED" : "LOW";
  // LOW reads as a statement about the wallet, so it needs screening, a whole read and enough rows.
  const screened = ["ok", "stale"].includes(coverage.sanctions_status);
  if (label === "LOW" && (!screened || coverage.partial || (!usable && !scoring.length))) label = "NOT_ASSESSED";

  return {
    version: RISK_VERSION,
    label,
    score,
    thresholds: THRESHOLDS,
    service_discount: service,
    reasons: scoring.slice(0, 3).map(item => item.title),
    findings,
    not_evaluated: notEvaluated(data, coverage, usable, labels),
    coverage,
    disclaimer: DISCLAIMER,
    assessed_at: Number.isFinite(ctx.now) ? new Date(ctx.now).toISOString() : ""
  };
}

// The older response fields, kept as a reading of the assessment so nothing can disagree with it.
function derivePatterns(assessment) {
  return (assessment?.findings || []).filter(item => item.points > 0).slice(0, 5).map(item => ({
    code: item.code,
    label: item.title,
    severity: item.floor === "HIGH" ? "HIGH" : item.strength === "strong" ? "MEDIUM" : "LOW",
    confidence: item.family === "EXPOSURE" ? "HIGH" : "LOW",
    score: item.points,
    explanation: item.explanation + " This is an indicator and does not establish wrongdoing.",
    evidence: item.metrics,
    tx_ids: item.tx_ids
  }));
}

function deriveAlertSummary(assessment) {
  const label = assessment?.label;
  return {
    highest_severity: label === "HIGH" ? "HIGH" : label === "ELEVATED" ? "MEDIUM" : "LOW",
    highest_score: Number(assessment?.score) || 0,
    total: (assessment?.findings || []).filter(item => item.points > 0).length
  };
}

export {
  RISK_VERSION,
  THRESHOLDS,
  DISCLAIMER,
  isStablecoin,
  assessWallet,
  derivePatterns,
  deriveAlertSummary
};
