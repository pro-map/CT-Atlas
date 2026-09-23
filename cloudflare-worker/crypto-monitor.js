import { cleanText, gateCall } from "./shared.js";
import { analyzeCryptoAddress } from "./crypto.js";

const CRYPTO_MONITOR_VERSION = "crypto-monitor-v1-scheduled-6h";
const MONITOR_BATCH_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeAddress(address, chain) {
  const value = String(address || "");
  return ["ethereum","bsc","polygon","arbitrum","base"].includes(chain)
    ? value.toLowerCase()
    : value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function snapshotFromAnalysis(analysis, now = Date.now()) {
  const rows = (analysis?.transactions || [])
    .slice()
    .sort((a,b) => String(b.time || "").localeCompare(String(a.time || "")));
  const recent = rows.filter(row => {
    const time = Date.parse(row.time || "");
    return Number.isFinite(time) && time >= now - DAY_MS;
  });
  return {
    checked_at: new Date(now).toISOString(),
    newest_tx_id: cleanText(rows[0]?.id, 180),
    newest_tx_time: cleanText(rows[0]?.time, 64),
    tx_count: recent.length,
    aggregate_value: recent.reduce((sum,row) => sum + Math.abs(Number(row.amount) || 0), 0)
  };
}

function alertBase(watch, type, severity, title, detail, txId = "") {
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
    created_at: new Date().toISOString()
  };
}

function buildMonitorAlerts(target, analysis, now = Date.now()) {
  const watch = target.watch || {};
  const previous = watch.last_snapshot || null;
  const rows = Array.isArray(analysis?.transactions) ? analysis.transactions : [];
  const snapshot = snapshotFromAnalysis(analysis, now);
  const alerts = [];

  const previousTime = Date.parse(previous?.newest_tx_time || "");
  const newRows = Number.isFinite(previousTime)
    ? rows.filter(row => {
        const time = Date.parse(row.time || "");
        return Number.isFinite(time) && time > previousTime;
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
    for (const row of newRows.filter(row => Math.abs(Number(row.amount) || 0) >= minAmount).slice(0, 10)) {
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
    alerts.push(alertBase(
      watch,
      "AGGREGATE_24H",
      "MEDIUM",
      "24h aggregate threshold crossed",
      String(snapshot.aggregate_value) + " observed aggregate value across the returned last-24h sample."
    ));
  }

  const velocity = numberOrNull(watch.thresholds?.velocity_24h);
  if (velocity !== null && velocity > 0 && snapshot.tx_count >= velocity) {
    alerts.push(alertBase(
      watch,
      "VELOCITY_24H",
      "MEDIUM",
      "24h velocity threshold crossed",
      snapshot.tx_count + " transaction records observed in the last 24 hours."
    ));
  }

  const dormantDays = numberOrNull(watch.thresholds?.dormant_days);
  if (
    previous &&
    dormantDays !== null &&
    dormantDays > 0 &&
    Number.isFinite(previousTime) &&
    snapshot.newest_tx_time &&
    snapshot.newest_tx_id !== previous.newest_tx_id
  ) {
    const gap = Date.parse(snapshot.newest_tx_time) - previousTime;
    if (Number.isFinite(gap) && gap >= dormantDays * DAY_MS) {
      alerts.push(alertBase(
        watch,
        "REACTIVATION",
        "MEDIUM",
        "Activity after configured dormant interval",
        "New activity followed an observed gap of at least " + dormantDays + " days.",
        snapshot.newest_tx_id
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

  return { snapshot, alerts };
}

function providerAvailable(chain, env) {
  if (chain === "bitcoin") return true;
  if (chain === "tron") return Boolean(env.TRONGRID_API_KEY);
  if (["ethereum","bsc","polygon","arbitrum","base"].includes(chain)) {
    return Boolean(env.ETHERSCAN_API_KEY);
  }
  return false;
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
  let checked = 0;
  let skipped = 0;
  let alertsAdded = 0;
  let failed = 0;

  for (const target of targets) {
    const watch = target.watch || {};
    if (!providerAvailable(watch.chain, env)) {
      skipped++;
      continue;
    }

    try {
      const analysis = await analyzeCryptoAddress(watch.address, watch.chain, 60, env);
      const { snapshot, alerts } = buildMonitorAlerts(target, analysis);
      const updateResponse = await gateCall(env, "/crypto-monitor-update", {
        username: target.username,
        watch_id: watch.id,
        snapshot,
        alerts
      });
      const updatePayload = await updateResponse.json().catch(() => ({}));
      if (!updateResponse.ok) throw new Error(updatePayload?.error || "Unable to save monitoring result.");
      checked++;
      alertsAdded += Number(updatePayload.alerts_added || 0);
    } catch (error) {
      failed++;
      console.error("Crypto automatic monitor failed", target.username, watch.address, error);
    }
  }

  const result = {
    ok: true,
    version: CRYPTO_MONITOR_VERSION,
    generated_at: new Date().toISOString(),
    total_watchlist: Number(targetPayload.total || targets.length),
    selected: targets.length,
    checked,
    skipped,
    failed,
    alerts_added: alertsAdded
  };
  console.log("Crypto automatic monitor", JSON.stringify(result));
  return result;
}

export {
  CRYPTO_MONITOR_VERSION,
  MONITOR_BATCH_LIMIT,
  snapshotFromAnalysis,
  buildMonitorAlerts,
  runCryptoMonitor
};
