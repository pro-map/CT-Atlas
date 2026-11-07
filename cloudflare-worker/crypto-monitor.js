import { cleanText, normalizeUsername, isAllowedUser, jsonResponse, gateCall } from "./shared.js";
import { analyzeCryptoAddress, authenticate, retiredChainError } from "./crypto.js";
import { sanitizeProviderMessage } from "./crypto-provider-health.js";

const CRYPTO_MONITOR_VERSION = "crypto-monitor-v2-scheduled-6h";
const MONITOR_BATCH_LIMIT = 8;
// Each wallet costs 3 provider calls (Bitcoin: address read plus 2 pages of 25), a
// label lookup and an update. A full batch then spends 42 of the 50 subrequests a
// run may use, and the rest covers rate-limit retries. A wallet that cannot be read
// still sends its update, which records the failure, and the run's outcome rides on
// the last update: neither adds a call.
const MONITOR_SAMPLE_ROWS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeAddress(address, chain) {
  const value = String(address || "");
  return ["ethereum","polygon","arbitrum"].includes(chain)
    ? value.toLowerCase()
    : value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function thresholdScope(watch) {
  return cleanText(watch?.thresholds?.asset, 80).toLowerCase();
}

// Amounts only compare within one asset. With no asset chosen, a threshold covers
// the native asset and allow-listed stablecoins: a 100 meant for ETH must not fire
// on 5,000,000 of a token whose value is unknown.
function inThresholdScope(row, scope) {
  if (scope) return [row?.asset, row?.asset_key, row?.token_contract].some(value => String(value || "").toLowerCase() === scope);
  return !row?.token_contract || row?.stable === true;
}

function movedValue(row) {
  return row?.failed !== true && row?.spam !== true && Number(row?.amount) !== 0;
}

function recentTransfers(rows, now) {
  return rows.filter(row => {
    const time = Date.parse(row.time || "");
    return movedValue(row) && Number.isFinite(time) && time >= now - DAY_MS;
  });
}

function largestAssetTotal(rows, scope) {
  const totals = new Map();
  for (const row of rows) {
    if (String(row?.direction || "").toUpperCase() === "SELF" || !inThresholdScope(row, scope)) continue;
    const key = row.asset_key || row.asset || "";
    const entry = totals.get(key) || { asset: cleanText(row.asset, 24), total: 0 };
    entry.total += Math.abs(Number(row.amount) || 0);
    totals.set(key, entry);
  }
  return [...totals.values()].reduce((best, item) => item.total > best.total ? item : best, { asset: "", total: 0 });
}

function snapshotFromAnalysis(analysis, now = Date.now(), scope = "") {
  const rows = (analysis?.transactions || [])
    .slice()
    .sort((a,b) => String(b.time || "").localeCompare(String(a.time || "")));
  const recent = recentTransfers(rows, now);
  return {
    checked_at: new Date(now).toISOString(),
    newest_tx_id: cleanText(rows[0]?.id, 180),
    newest_tx_time: cleanText(rows[0]?.time, 64),
    tx_count: recent.length,
    aggregate_value: largestAssetTotal(recent, scope).total
  };
}

function alertBase(watch, type, severity, title, detail, txId = "", dayBucket = "") {
  return {
    id: crypto.randomUUID(),
    watch_id: cleanText(watch.id, 80),
    chain: cleanText(watch.chain, 24).toLowerCase(),
    address: cleanText(watch.address, 180),
    type,
    severity,
    title,
    detail,
    tx_id: cleanText(txId, 180),
    day_bucket: dayBucket,
    created_at: new Date().toISOString()
  };
}

function buildMonitorAlerts(target, analysis, now = Date.now()) {
  const watch = target.watch || {};
  const previous = watch.last_snapshot || null;
  const rows = Array.isArray(analysis?.transactions) ? analysis.transactions : [];
  const scope = thresholdScope(watch);
  const snapshot = snapshotFromAnalysis(analysis, now, scope);
  const dayBucket = new Date(now).toISOString().slice(0, 10);
  const alerts = [];

  // No snapshot means no baseline yet. A snapshot with no time means the wallet was
  // empty when it was taken, so everything seen since is new.
  const previousTime = Date.parse(previous?.newest_tx_time || "");
  const hasBaselineTime = Number.isFinite(previousTime);
  const newRows = previous
    ? rows.filter(row => {
        const time = Date.parse(row.time || "");
        return movedValue(row) && Number.isFinite(time) && (!hasBaselineTime || time > previousTime);
      })
    : [];

  if (
    previous &&
    snapshot.newest_tx_id &&
    snapshot.newest_tx_id !== previous.newest_tx_id
  ) {
    alerts.push(alertBase(
      watch,
      "NEW_TRANSACTION",
      "LOW",
      "New transaction observed",
      "A transaction newer than the saved automatic-monitoring baseline was observed.",
      snapshot.newest_tx_id
    ));
  }

  const minAmount = numberOrNull(watch.thresholds?.min_amount);
  if (minAmount !== null && minAmount > 0) {
    const crossing = newRows.filter(row =>
      String(row.direction || "").toUpperCase() !== "SELF" &&
      inThresholdScope(row, scope) &&
      Math.abs(Number(row.amount) || 0) >= minAmount
    );
    for (const row of crossing.slice(0, 10)) {
      alerts.push(alertBase(
        watch,
        "LARGE_TRANSFER",
        "MEDIUM",
        "Transfer threshold crossed",
        String(row.amount || 0) + " " + cleanText(row.asset, 24) +
          " crossed the configured single-transfer threshold.",
        row.id
      ));
    }
  }

  const aggregate = numberOrNull(watch.thresholds?.aggregate_24h);
  if (aggregate !== null && aggregate > 0 && snapshot.aggregate_value >= aggregate) {
    const largest = largestAssetTotal(recentTransfers(rows, now), scope);
    alerts.push(alertBase(
      watch,
      "AGGREGATE_24H",
      "MEDIUM",
      "24h aggregate threshold crossed",
      String(Number(largest.total.toPrecision(10))) + " " + largest.asset + " observed in the returned last-24h sample.",
      "",
      dayBucket
    ));
  }

  const velocity = numberOrNull(watch.thresholds?.velocity_24h);
  if (velocity !== null && velocity > 0 && snapshot.tx_count >= velocity) {
    alerts.push(alertBase(
      watch,
      "VELOCITY_24H",
      "MEDIUM",
      "24h velocity threshold crossed",
      snapshot.tx_count + " transaction records observed in the last 24 hours.",
      "",
      dayBucket
    ));
  }

  // The gap ends at the oldest new row, not the newest: a check that runs ten days
  // late must not read a wallet active every day as ten quiet days.
  const dormantDays = numberOrNull(watch.thresholds?.dormant_days);
  if (dormantDays !== null && dormantDays > 0 && hasBaselineTime && newRows.length) {
    const firstNew = newRows.reduce((first, row) => Date.parse(row.time) < Date.parse(first.time) ? row : first);
    if (Date.parse(firstNew.time) - previousTime >= dormantDays * DAY_MS) {
      alerts.push(alertBase(
        watch,
        "REACTIVATION",
        "MEDIUM",
        "Activity after configured dormant interval",
        "New activity followed an observed gap of at least " + dormantDays + " days.",
        firstNew.id
      ));
    }
  }

  const sensitiveLabels = new Map();
  for (const label of target.sensitive_labels || []) {
    const key = normalizeAddress(label.address, watch.chain);
    if (key) sensitiveLabels.set(key, label);
  }

  for (const row of newRows.slice(0, 40)) {
    for (const cp of row.counterparties || []) {
      const label = sensitiveLabels.get(normalizeAddress(cp, watch.chain));
      if (!label) continue;
      alerts.push(alertBase(
        watch,
        "WATCHLIST_EXPOSURE",
        "HIGH",
        "New direct exposure to " + cleanText(label.category, 48),
        "New transaction relationship observed with sourced label " +
          cleanText(label.name || cp, 120) +
          (label.source_title ? " (source: " + cleanText(label.source_title, 200) + ")." : "."),
        row.id
      ));
    }
  }

  // NOT_ASSESSED says nothing about the wallet, so it keeps the last real label:
  // otherwise a screening outage followed by recovery would read as a rise.
  const assessment = analysis?.risk_assessment;
  snapshot.risk_label = RISK_RANK[assessment?.label] ? assessment.label : cleanText(previous?.risk_label, 24);

  // Sanctions hits are the highest-value alerts and the gate keeps only the
  // first 40 per update, so they go to the front. The gate de-duplicates on
  // watch|type|tx|title|day, so a persistent hit alerts once, not every 6 hours.
  const sanctionsAlerts = buildSanctionsAlerts(watch, analysis?.sanctions_screening);
  return { snapshot, alerts: [...sanctionsAlerts, ...buildRiskAlert(watch, previous, assessment, dayBucket), ...alerts] };
}

const RISK_RANK = Object.freeze({ LOW: 1, ELEVATED: 2, HIGH: 3 });

function buildRiskAlert(watch, previous, assessment, dayBucket) {
  const before = RISK_RANK[previous?.risk_label];
  const after = RISK_RANK[assessment?.label];
  if (!before || !after || after <= before) return [];
  const reasons = (assessment.reasons || []).map(reason => cleanText(reason, 160)).join("; ");
  return [alertBase(
    watch,
    "RISK_LABEL_RAISED",
    assessment.label === "HIGH" ? "HIGH" : "MEDIUM",
    "Automated risk label raised to " + assessment.label,
    "The label moved from " + previous.risk_label + " to " + assessment.label + (reasons ? ": " + reasons : "") +
      ". Indicator, not proof: review the wallet before relying on it.",
    "",
    dayBucket
  )];
}

const MAX_SANCTIONS_ALERTS = 12;
const SANCTIONS_CAVEAT = " A list match is not a determination of ownership or intent.";

function buildSanctionsAlerts(watch, screening) {
  if (!screening?.hit) return [];
  const alerts = [];
  if (screening.seed_match) {
    alerts.push(alertBase(
      watch,
      "SANCTIONED_ADDRESS",
      "HIGH",
      "Monitored wallet appears on a sanctions list",
      "This address is listed: " + cleanText(screening.seed_match.summary, 600) + "." + SANCTIONS_CAVEAT
    ));
  }
  for (const match of screening.counterparty_matches || []) {
    for (const txId of (match.tx_ids || []).slice(0, 3)) {
      if (alerts.length >= MAX_SANCTIONS_ALERTS) return alerts;
      alerts.push(alertBase(
        watch,
        "SANCTIONS_EXPOSURE",
        "HIGH",
        "Direct exposure to a sanctioned address",
        "A transaction relationship with " + cleanText(match.address, 100) + " was observed; that address is listed: " +
          cleanText(match.summary, 500) + "." + SANCTIONS_CAVEAT,
        txId
      ));
    }
  }
  return alerts;
}

function providerAvailable(chain, env) {
  if (chain === "bitcoin") return true;
  if (chain === "tron") return Boolean(env.TRONGRID_API_KEY);
  if (["ethereum","polygon","arbitrum"].includes(chain)) {
    return Boolean(env.ETHERSCAN_API_KEY);
  }
  return false;
}

// What the analysts read when a check fails: an error can quote a provider URL, and Etherscan's carries the key.
function failureReason(error, env) {
  return sanitizeProviderMessage(error?.message, [env.ETHERSCAN_API_KEY, env.TRONGRID_API_KEY]) || "The provider could not be read.";
}

// Why a read cannot replace the baseline, or "" when it can. A baseline taken from a partial
// read would make the next full read look like new activity. A chain only grows, so a wallet
// with saved activity cannot come back empty, or with nothing as recent as its baseline.
function unusableRead(watch, analysis) {
  const coverage = analysis?.coverage;
  if (coverage?.partial) {
    const sources = (Array.isArray(coverage.failed_sources) ? coverage.failed_sources : []).map(source => cleanText(source, 60)).filter(Boolean);
    return "Partial read: " + (sources.join(", ") || "part of the history") + " could not be read.";
  }
  const previous = watch.last_snapshot;
  if (!previous?.newest_tx_id) return "";
  const rows = Array.isArray(analysis?.transactions) ? analysis.transactions : [];
  if (!rows.length) return "The provider returned no history for a wallet with saved activity.";
  const baseline = Date.parse(previous.newest_tx_time || "");
  const newest = Math.max(-Infinity, ...rows.map(row => Date.parse(row?.time || "")).filter(Number.isFinite));
  if (Number.isFinite(baseline) && newest < baseline) return "The provider returned only history older than the saved baseline.";
  return "";
}

// Never throws: a wallet that cannot be read still reports, so its failure is recorded.
async function readMonitorTarget(target, env) {
  const watch = target.watch || {};
  try {
    const analysis = await analyzeCryptoAddress(watch.address, watch.chain, MONITOR_SAMPLE_ROWS, env, { skipBalance: true });
    const problem = unusableRead(watch, analysis);
    if (!problem) return { state: "checked", problem, ...buildMonitorAlerts(target, analysis) };
    // Nothing in this read may move the baseline or count as new activity. A sanctions match among
    // the rows it did return is still a match, so it alerts and says the read was incomplete.
    const alerts = buildSanctionsAlerts(watch, analysis?.sanctions_screening).map(alert => ({
      ...alert,
      detail: alert.detail + " " + problem + " Other records may be missing from this check."
    }));
    return { state: analysis?.coverage?.partial ? "partial" : "failed", problem, snapshot: null, alerts };
  } catch (error) {
    return { state: "failed", problem: failureReason(error, env), snapshot: null, alerts: [] };
  }
}

async function saveMonitorResult(target, env, result, run = null) {
  const updateResponse = await gateCall(env, "/crypto-monitor-update", {
    username: target.username,
    watch_id: target.watch?.id,
    snapshot: result.snapshot,
    alerts: result.alerts,
    check: { ok: result.state === "checked", error: result.problem },
    ...(run ? { run } : {})
  });
  const updatePayload = await updateResponse.json().catch(() => ({}));
  if (!updateResponse.ok) throw new Error(updatePayload?.error || "Unable to save monitoring result.");
  return Number(updatePayload.alerts_added || 0);
}

async function runCryptoMonitor(env) {
  const targetResponse = await gateCall(env, "/crypto-monitor-targets", {
    limit: MONITOR_BATCH_LIMIT
  });
  const targetPayload = await targetResponse.json().catch(() => ({}));
  if (!targetResponse.ok) {
    throw new Error(targetPayload?.error || "Unable to read Crypto monitoring targets.");
  }

  const targets = Array.isArray(targetPayload.targets) ? targetPayload.targets : [];
  const checkable = targets.filter(target => providerAvailable(target.watch?.chain, env));
  // Retired-chain watches stay out of the rotation, so the gate only counts them.
  const skipped = (Number(targetPayload.retired) || 0) + targets.length - checkable.length;
  const counts = { checked: 0, partial: 0, failed: 0 };
  let alertsAdded = 0;

  for (const [index, target] of checkable.entries()) {
    const read = await readMonitorTarget(target, env);
    counts[read.state]++;
    const run = index === checkable.length - 1 ? { selected: targets.length, ...counts } : null;
    try {
      alertsAdded += await saveMonitorResult(target, env, read, run);
    } catch (error) {
      counts[read.state]--;
      counts.failed++;
      read.problem = cleanText(error?.message, 200);
    }
    if (read.problem) console.error("Crypto automatic monitor check failed", target.username, target.watch?.address, read.problem);
  }

  const status = !counts.partial && !counts.failed ? "ok" : counts.checked ? "degraded" : "failed";
  const result = {
    // Every wallet failing is an outage, not a quiet run.
    ok: status !== "failed",
    status,
    version: CRYPTO_MONITOR_VERSION,
    generated_at: new Date().toISOString(),
    total_watchlist: Number(targetPayload.total || targets.length),
    selected: targets.length,
    checked: counts.checked,
    partial: counts.partial,
    skipped,
    failed: counts.failed,
    alerts_added: alertsAdded
  };
  if (result.ok) console.log("Crypto automatic monitor", JSON.stringify(result));
  else console.error("Crypto automatic monitor", JSON.stringify(result));
  return result;
}

// CHECK NOW for one wallet. The gate takes alerts and baselines only from the
// monitor, so an on-demand check has to run here, through the same alert builder.
async function handleCryptoMonitorCheck(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const username = normalizeUsername(body.user_id);
  if (!username || !isAllowedUser(username, env)) return jsonResponse({ error: "Unknown user." }, 400, env);
  const auth = await authenticate(request, env, username);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, env);
  // Without an id the gate would answer with the scheduled rotation, other users' wallets included.
  const watchId = cleanText(body.watch_id, 80);
  if (!watchId) return jsonResponse({ error: "Choose a monitored wallet." }, 400, env);

  const targetResponse = await gateCall(env, "/crypto-monitor-targets", { username, watch_id: watchId });
  const targetPayload = await targetResponse.json().catch(() => ({}));
  const target = Array.isArray(targetPayload.targets) ? targetPayload.targets[0] : null;
  if (!targetResponse.ok || !target) return jsonResponse({ error: "Monitored wallet not found." }, 404, env);
  const retired = retiredChainError(target.watch.chain);
  if (retired) return jsonResponse({ error: retired }, 400, env);
  if (!providerAvailable(target.watch.chain, env)) {
    return jsonResponse({ error: "This chain's provider is not configured." }, 503, env);
  }

  try {
    const read = await readMonitorTarget(target, env);
    const alertsAdded = await saveMonitorResult(target, env, read);
    if (read.problem) return jsonResponse({ error: read.problem, alerts_added: alertsAdded }, 503, env);
    await gateCall(env, "/usage-increment", {
      username,
      metrics: { blockchain_searches: 1 },
      log: { feature: "blockchain", details: {
        query: target.watch.address, kind: "address", chain: target.watch.chain,
        chain_hint: target.watch.chain, limit: MONITOR_SAMPLE_ROWS, origin: "monitor"
      } }
    }).catch(error => console.error("Blockchain search usage record failed", error));
    return jsonResponse({ ok: true, alerts_added: alertsAdded }, 200, env);
  } catch (error) {
    console.error("Crypto monitor check failed", error);
    return jsonResponse({ error: cleanText(error?.message || "Monitor check failed.", 320) }, 503, env);
  }
}

export {
  CRYPTO_MONITOR_VERSION,
  MONITOR_BATCH_LIMIT,
  snapshotFromAnalysis,
  buildMonitorAlerts,
  buildSanctionsAlerts,
  runCryptoMonitor,
  handleCryptoMonitorCheck
};
