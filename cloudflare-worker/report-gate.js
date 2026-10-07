import{getAllowedUsers,REPORT_COOLDOWN_MS,SESSION_TTL_MS,QUICK_ASK_COOLDOWN_MS,QUICK_ASK_DAILY_LIMIT,QUICK_ASK_GLOBAL_DAILY_LIMIT,FEEDBACK_COOLDOWN_MS,FEEDBACK_DAILY_LIMIT,FEEDBACK_GLOBAL_DAILY_LIMIT,normalizeUsername,isAllowedUser,parisDayKey,usageTemplate,cleanText}from"./shared.js";

const ADMIN_DISPLAY_NAMES=Object.freeze({
  "group-i-1":"Ed",
  "group-i-2":"Stephen",
  "group-i-3":"Kayla",
  "group-i-4":"Bridget",
  "group-i-5":"Alexandru",
  "group-i-6":"Oskaras",
  "group-i-7":"Elodie",
  "group-i-8":"Marius",
  "group-i-9":"Kiara",
  "group-i-10":"Sebastien",
  "group-i-11":"Kitty",
  "group-i-12":"Camilla Bio",
  "group-i-13":"Tarun",
  "group-p-1":"Dritan",
  "group-p-2":"Allyson",
  "group-p-3":"Roberto",
  "group-p-4":"Daniele",
  "group-p-5":"Simon",
  "group-p-6":"Zaydoun",
  "group-p-7":"Saleh",
  "group-p-8":"Lasha",
  "group-p-9":"MTS",
  "group-p-10":"Alexandre",
  "group-p-11":"Cheong Ju Bio",
  "group-s-1":"Maddy",
  "group-s-2":"Sebastien Breuil",
  "group-s-3":"Andreas",
  "group-s-4":"William Hippert",
  "group-s-5":"Carlos Leniart",
  "group-s-6":"Juan",
  "group-s-7":"Thierry",
  "group-s-8":"Bigdan",
  "group-s-9":"Nadim",
  "group-s-10":"Abdelraoouf",
  "group-s-11":"Adrien CBRN"
});

function withAdminDisplayName(row){
  const displayName=ADMIN_DISPLAY_NAMES[normalizeUsername(row?.username)]||"";
  return displayName?{...row,display_name:displayName}:row;
}
const SOCIAL_REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TAB_ACCESS_FIELDS = Object.freeze({ map: true, crypto: true, facial: true, darkweb: true, ip: true });
function tabAccessTemplate(username = "") {
  return { username, map: 0, crypto: 0, facial: 0, darkweb: 0, ip: 0 };
}

// Per-user search history behind the admin counters. One small value per search,
// written in the same storage put as the counter it explains, under
// usage-log:<Paris day>:<username>:<feature>:<epoch ms>:<random>, so a clicked
// count lists its own rows and old days are removed with one range delete.
const USAGE_LOG_PREFIX = "usage-log:";
const USAGE_LOG_RETENTION_DAYS = 90;
const USAGE_LOG_STARTED = "2026-10-06";
const USAGE_HISTORY_LIMIT = 500;
const USAGE_LOG_MAX_PER_MINUTE = 120;
const USAGE_LOG_FIELDS = Object.freeze({
  report_generator: { region: ["text", 100], topic: ["text", 120], actor_group: ["text", 100], period_days: ["num"], compare: ["bool"], outcome: ["text", 20], title: ["text", 200] },
  deep_search: { question: ["text", 1200], region: ["text", 100], topic: ["text", 120], actor_group: ["text", 100], scope: ["text", 200], outcome: ["text", 20], title: ["text", 200], period: ["text", 120] },
  blockchain: { query: ["text", 180], kind: ["text", 20], chain: ["text", 40], chain_hint: ["text", 40], origin: ["text", 16], limit: ["num"] },
  facial_extraction: { files: ["num"], videos: ["num"], bytes: ["num"] },
  facial_search: { engines: ["list", 4, 20], face: ["text", 40] },
  event_list: { text: ["text", 200], region: ["text", 100], topic: ["text", 120], actor_group: ["text", 100], period_days: ["num"], scope: ["text", 200], country: ["text", 120], sort: ["text", 10], results: ["num"] },
  darkweb_search: { text: ["text", 200], view: ["text", 16], outlet: ["text", 120], material: ["text", 16], results: ["num"], loaded_back_to: ["text", 10] },
  ip_lookup: { target: ["text", 253], kind: ["text", 10], registered_domain: ["text", 253], parent_domain: ["text", 253] },
  ...Object.fromEntries(Object.keys(TAB_ACCESS_FIELDS).map(tab => ["tab_" + tab, {}]))
});
// Only these fields of a logged request can change afterwards (the report outcome).
const USAGE_LOG_UPDATES = Object.freeze({
  report_generator: ["outcome", "title"],
  deep_search: ["outcome", "title", "period"]
});
const USAGE_LOG_OUTCOMES = new Set(["cached", "generated", "no_events", "failed"]);
// Admin counter (or workspace tab) -> the logged features that explain it.
const USAGE_HISTORY_METRICS = Object.freeze({
  report_requests: ["report_generator", "deep_search"],
  report_generator_requests: ["report_generator"],
  deep_search_requests: ["deep_search"],
  searches: ["event_list"],
  event_list_searches: ["event_list"],
  map_searches: [],
  quick_ask_requests: [],
  blockchain_searches: ["blockchain"],
  facial_extractions: ["facial_extraction"],
  facial_searches: ["facial_search"],
  darkweb_searches: ["darkweb_search"],
  ip_lookups: ["ip_lookup"],
  ...Object.fromEntries(Object.keys(TAB_ACCESS_FIELDS).map(tab => ["tab:" + tab, ["tab_" + tab]])),
  all: Object.keys(USAGE_LOG_FIELDS)
});

function sanitizeUsageDetails(feature, details) {
  const fields = USAGE_LOG_FIELDS[feature];
  const out = {};
  if (!fields || !details || typeof details !== "object" || Array.isArray(details)) return out;
  const text = (value, max) => typeof value === "string" || typeof value === "number" ? cleanText(value, max) : "";
  for (const [name, [type, first, second]] of Object.entries(fields)) {
    const value = details[name];
    if (value === undefined || value === null || value === "") continue;
    if (type === "text") {
      const clean = text(value, first);
      if (clean) out[name] = clean;
    } else if (type === "num") {
      const number = Number(value);
      if (typeof value !== "boolean" && Number.isFinite(number)) out[name] = Math.round(number);
    } else if (type === "bool") {
      if (typeof value === "boolean") out[name] = value;
    } else if (type === "list" && Array.isArray(value)) {
      const items = value.slice(0, first).map(item => text(item, second)).filter(Boolean);
      if (items.length) out[name] = items;
    }
  }
  return out;
}

function usageLogKeyParts(key) {
  const parts = String(key || "").split(":");
  if (parts.length !== 6 || parts[0] + ":" !== USAGE_LOG_PREFIX) return null;
  const [, day, username, feature, at] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{13}$/.test(at) || !Object.hasOwn(USAGE_LOG_FIELDS, feature)) return null;
  return { day, username, feature, at: Number(at) };
}
const MIGRATION_PAGE_SIZE = 250;
const EXCHANGE_CHAINS = new Set(["bitcoin", "ethereum", "bsc", "polygon", "arbitrum", "base", "tron"]);
const EXCHANGE_EVM_CHAINS = new Set(["ethereum", "bsc", "polygon", "arbitrum", "base"]);
function exchangeAddressKey(chainValue, addressValue) {
  const chain = cleanText(chainValue, 24).toLowerCase();
  let address = cleanText(addressValue, 180);
  if (!EXCHANGE_CHAINS.has(chain) || !address) return "";
  if (EXCHANGE_EVM_CHAINS.has(chain)) address = address.toLowerCase();
  const valid = EXCHANGE_EVM_CHAINS.has(chain)
    ? /^0x[a-f0-9]{40}$/i.test(address)
    : chain === "tron"
      ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
      : /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{24,33})$/i.test(address);
  return valid ? `${chain}:${address}` : "";
}

export class ReportGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async scheduleExpiry(expiresAt) {
    const when = Number(expiresAt || 0);
    if (!Number.isFinite(when) || when <= 0) return;
    const current = await this.state.storage.getAlarm();
    if (current == null || when < current) {
      await this.state.storage.setAlarm(when);
    }
  }

  async readSocialWorkspace(key, value) {
    const stored = value === undefined ? await this.state.storage.get(key) : value;
    if (stored?.format !== "social-chunks-v1") return stored;
    const chunks = [];
    for (let i=0; i<stored.chunks; i++) {
      const chunk = await this.state.storage.get(`social-chunk:${key}:${i}`);
      if (typeof chunk !== "string") throw new Error("Saved Social report data is incomplete.");
      chunks.push(chunk);
    }
    return JSON.parse(chunks.join(""));
  }

  async writeSocialWorkspace(key, workspace) {
    const serialized = JSON.stringify(workspace);
    const previous = await this.state.storage.get(key);
    if (serialized.length <= 32000 && previous?.format !== "social-chunks-v1") {
      await this.state.storage.put(key, workspace);
      return;
    }
    // Evidence-rich histories exceed the per-value storage limit. Atomic chunks
    // preserve all reports and the existing expiry/delete semantics.
    await this.state.storage.transaction(async storage => {
      const count = Math.ceil(serialized.length / 32000);
      for (let i=0; i<count; i++) await storage.put(`social-chunk:${key}:${i}`, serialized.slice(i*32000,(i+1)*32000));
      for (let i=count; i<(previous?.chunks||0); i++) await storage.delete(`social-chunk:${key}:${i}`);
      await storage.put(key, {format:"social-chunks-v1",chunks:count});
    });
  }

  async pruneSocialWorkspace(workspace, now = Date.now()) {
    if (!workspace || typeof workspace !== "object") return { workspace, changed: false, nextExpiry: null };
    const reports = Array.isArray(workspace.reports) ? workspace.reports : [];
    let changed = false;
    let nextExpiry = null;
    const kept = [];
    for (const report of reports) {
      const generated = Date.parse(String(report?.generated_at || ""));
      if (Number.isFinite(generated)) {
        const expiresAt = generated + SOCIAL_REPORT_RETENTION_MS;
        if (expiresAt <= now) {
          changed = true;
          continue;
        }
        if (nextExpiry == null || expiresAt < nextExpiry) nextExpiry = expiresAt;
      }
      kept.push(report);
    }
    if (changed) {
      workspace = { ...workspace, reports: kept, updated_at: new Date(now).toISOString() };
    }
    return { workspace, changed, nextExpiry };
  }

  async purgeExpired(now = Date.now()) {
    let nextExpiry = null;
    const track = value => {
      const when = Number(value || 0);
      if (Number.isFinite(when) && when > now && (nextExpiry == null || when < nextExpiry)) nextExpiry = when;
    };

    // Search history: delete whole Paris days past the retention window, and keep the
    // alarm armed while rows remain (daily, or within a minute when a purge stopped
    // at its page cap), so rows are removed on time even if nobody logs in.
    try {
      const purge = await this.purgeUsageLogs(now);
      if (purge.more) track(now + 60000);
      else if ((await this.state.storage.list({ prefix: USAGE_LOG_PREFIX, limit: 1 }))?.size) track(now + 86400000);
    } catch (error) {
      console.error("Usage history purge failed.", error);
      track(now + 3600000);
    }

    for (const prefix of ["cache:", "source-image-token:", "session:", "crypto-provider-label:"]) {
      let startAfter = "";
      for (let page = 0; page < 100; page++) {
        const options = { prefix, limit: 500 };
        if (startAfter) options.startAfter = startAfter;
        const batch = await this.state.storage.list(options);
        if (!batch || !batch.size) break;
        const expired = [];
        for (const [key, value] of batch.entries()) {
          const expiresAt = Number(value?.expires_at || 0);
          if (expiresAt && expiresAt <= now) expired.push(key);
          else track(expiresAt);
        }
        if (expired.length) await this.state.storage.delete(expired);
        const keys = Array.from(batch.keys());
        const lastKey = keys[keys.length - 1];
        if (batch.size < 500 || !lastKey || lastKey === startAfter) break;
        startAfter = lastKey;
      }
    }

    let socialStartAfter = "";
    for (let page = 0; page < 100; page++) {
      const options = { prefix: "social-workspace:", limit: 250 };
      if (socialStartAfter) options.startAfter = socialStartAfter;
      const batch = await this.state.storage.list(options);
      if (!batch || !batch.size) break;
      for (const [key, workspace] of batch.entries()) {
        const pruned = await this.pruneSocialWorkspace(await this.readSocialWorkspace(key, workspace), now);
        if (pruned.changed) await this.writeSocialWorkspace(key, pruned.workspace);
        track(pruned.nextExpiry);
      }
      const keys = Array.from(batch.keys());
      const lastKey = keys[keys.length - 1];
      if (batch.size < 250 || !lastKey || lastKey === socialStartAfter) break;
      socialStartAfter = lastKey;
    }

    return nextExpiry;
  }

  async alarm() {
    const nextExpiry = await this.purgeExpired(Date.now());
    if (nextExpiry != null) await this.state.storage.setAlarm(nextExpiry);
    else await this.state.storage.deleteAlarm();
  }

  // A history row for one search; incrementUsage/recordTabAccess store it with the counter.
  usageLogEntry(username, feature, details, now = Date.now()) {
    username = normalizeUsername(username);
    if (!username || !Object.hasOwn(USAGE_LOG_FIELDS, feature)) return null;
    const minute = Math.floor(now / 60000);
    this.usageLogBudget ||= new Map();
    const budget = this.usageLogBudget.get(username);
    if (!budget || budget.minute !== minute) this.usageLogBudget.set(username, { minute, count: 1 });
    else if (budget.count >= USAGE_LOG_MAX_PER_MINUTE) return null;
    else budget.count++;
    const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    return {
      key: `${USAGE_LOG_PREFIX}${parisDayKey(now)}:${username}:${feature}:${String(now).padStart(13, "0")}:${random}`,
      value: { at: new Date(now).toISOString(), feature, ...sanitizeUsageDetails(feature, details) }
    };
  }

  // Adds the outcome of a logged request (e.g. a report served from cache) to its row.
  async updateUsageLog(username, update) {
    username = normalizeUsername(username);
    const id = String(update?.id || "");
    const parts = usageLogKeyParts(id);
    const allowed = parts && USAGE_LOG_UPDATES[parts.feature];
    if (!allowed || parts.username !== username) return false;
    const patch = sanitizeUsageDetails(parts.feature, update);
    for (const name of Object.keys(patch)) if (!allowed.includes(name)) delete patch[name];
    if (patch.outcome && !USAGE_LOG_OUTCOMES.has(patch.outcome)) delete patch.outcome;
    if (!Object.keys(patch).length) return false;
    const current = await this.state.storage.get(id);
    if (!current) return false;
    await this.state.storage.put(id, { ...current, ...patch });
    return true;
  }

  async usageHistory(targetUsername, metric, period, now = Date.now()) {
    const username = normalizeUsername(targetUsername);
    const features = USAGE_HISTORY_METRICS[metric];
    const days = period === "today" ? 1 : period === "all" ? USAGE_LOG_RETENTION_DAYS : Number(period);
    const dayKeys = [...new Set(Array.from({ length: days }, (_, offset) => parisDayKey(now - offset * 86400000)))];
    const wanted = new Set(features);
    const rows = [];
    // Newest day first; within a day each feature's newest rows, merged by time. Every row of a
    // day is newer than any row of the previous day, so a full day of rows ends the scan.
    for (const day of dayKeys) {
      for (const prefix of features.map(feature => `${USAGE_LOG_PREFIX}${day}:${username}:${feature}:`)) {
        const batch = await this.state.storage.list({ prefix, reverse: true, limit: USAGE_HISTORY_LIMIT + 1 });
        for (const [key, value] of batch.entries()) {
          const parts = usageLogKeyParts(key);
          if (!parts || parts.username !== username || !wanted.has(parts.feature)) continue;
          rows.push({ id: key, ...value, feature: parts.feature, at: value?.at || new Date(parts.at).toISOString(), _ms: parts.at });
        }
      }
      if (rows.length > USAGE_HISTORY_LIMIT) break;
    }
    rows.sort((a, b) => b._ms - a._ms || (a.id < b.id ? 1 : -1));
    const periodLabel =
      period === "today" ? "Today · Europe/Paris" :
      period === "7" ? "Last 7 days · Europe/Paris" :
      period === "30" ? "Last 30 days · Europe/Paris" :
      `Last ${USAGE_LOG_RETENTION_DAYS} days (history retention) · Europe/Paris`;
    return {
      ...withAdminDisplayName({ username }),
      metric,
      period,
      period_label: periodLabel,
      retention_days: USAGE_LOG_RETENTION_DAYS,
      recorded_since: USAGE_LOG_STARTED,
      truncated: rows.length > USAGE_HISTORY_LIMIT,
      rows: rows.slice(0, USAGE_HISTORY_LIMIT).map(({ _ms, ...row }) => row)
    };
  }

  // Deletes history rows older than the retention window (whole Paris days).
  async purgeUsageLogs(now = Date.now()) {
    const end = USAGE_LOG_PREFIX + parisDayKey(now - (USAGE_LOG_RETENTION_DAYS - 1) * 86400000);
    let removed = 0;
    for (let page = 0; page < 200; page++) {
      const batch = await this.state.storage.list({ prefix: USAGE_LOG_PREFIX, end, limit: 128 });
      const keys = Array.from(batch?.keys?.() || []).filter(key => key < end);
      if (!keys.length) return { removed, more: false };
      await this.state.storage.delete(keys);
      removed += keys.length;
      if (keys.length < 128) return { removed, more: false };
    }
    return { removed, more: true };
  }

  async incrementUsage(username, metrics = {}, now = Date.now(), log = null) {
    username = normalizeUsername(username);
    if (!isAllowedUser(username, this.env)) return null;

    const totalKey = `usage-total:${username}`;
    const dayKey = `usage-day:${parisDayKey(now)}:${username}`;

    const [currentTotal, currentDay] = await Promise.all([
      this.state.storage.get(totalKey),
      this.state.storage.get(dayKey)
    ]);

    const template = usageTemplate(username);
    const total = {
      ...template,
      ...(currentTotal || {})
    };
    const day = {
      ...template,
      ...(currentDay || {})
    };

    let changed = false;
    for (const [metric, raw] of Object.entries(metrics || {})) {
      const value = Number(raw || 0);
      if (
        !Number.isFinite(value) ||
        value === 0 ||
        !Object.hasOwn(template, metric) ||
        metric === "username" ||
        metric === "last_activity"
      ) continue;

      total[metric] = Number(total[metric] || 0) + value;
      day[metric] = Number(day[metric] || 0) + value;
      changed = true;
    }

    if (!changed && !log?.key) return total;
    const iso = new Date(now).toISOString();
    total.last_activity = iso;
    day.last_activity = iso;

    await this.state.storage.put({
      [totalKey]: total,
      [dayKey]: day,
      ...(log?.key ? { [log.key]: log.value } : {})
    });

    return total;
  }

  async recordTabAccess(username, tab, now = Date.now()) {
    username = normalizeUsername(username);
    tab = String(tab || "").trim().toLowerCase();
    if (!isAllowedUser(username, this.env) || !Object.prototype.hasOwnProperty.call(TAB_ACCESS_FIELDS, tab)) return false;

    const totalKey = "tab-access-total:" + username;
    const dayKey = "tab-access-day:" + parisDayKey(now) + ":" + username;
    await this.state.storage.transaction(async txn => {
      const [storedTotal, storedDay] = await Promise.all([
        txn.get(totalKey),
        txn.get(dayKey)
      ]);
      const total = { ...tabAccessTemplate(username), ...(storedTotal || {}) };
      const day = { ...tabAccessTemplate(username), ...(storedDay || {}) };
      total[tab] = Number(total[tab] || 0) + 1;
      day[tab] = Number(day[tab] || 0) + 1;
      const log = this.usageLogEntry(username, "tab_" + tab, null, now);
      await txn.put({ [totalKey]: total, [dayKey]: day, ...(log ? { [log.key]: log.value } : {}) });
    });
    return true;
  }

  async tabAccessStats(period, now = Date.now()) {
    if (!["today", "7", "30", "all"].includes(String(period))) {
      throw new Error("Unsupported statistics period.");
    }

    const readKeys = async keys => {
      const result = new Map();
      for (let i = 0; i < keys.length; i += 128) {
        for (const [key, value] of await this.state.storage.get(keys.slice(i, i + 128))) result.set(key, value);
      }
      return result;
    };
    const users = Array.from(getAllowedUsers(this.env));
    const rows = new Map(users.map(username => [username, tabAccessTemplate(username)]));
    const tabs = Object.keys(TAB_ACCESS_FIELDS);

    if (period === "all") {
      const stored = await readKeys(users.map(username => "tab-access-total:" + username));
      for (const username of users) {
        const value = stored.get("tab-access-total:" + username);
        if (!value) continue;
        const row = rows.get(username);
        for (const tab of tabs) row[tab] = Number(value[tab] || 0);
      }
    } else {
      const days = period === "today" ? 1 : Number(period);
      const keys = [];
      for (let offset = 0; offset < days; offset++) {
        const day = parisDayKey(now - offset * 86400000);
        for (const username of users) keys.push("tab-access-day:" + day + ":" + username);
      }

      for (const [key, value] of (await readKeys(keys)).entries()) {
        if (!value) continue;
        const username = normalizeUsername(String(key).split(":").pop());
        const row = rows.get(username);
        if (!row) continue;
        for (const tab of tabs) row[tab] += Number(value[tab] || 0);
      }
    }

    const periodLabel =
      period === "today" ? "Today · Europe/Paris" :
      period === "7" ? "Last 7 days · Europe/Paris" :
      period === "30" ? "Last 30 days · Europe/Paris" :
      "All time";

    return {
      period,
      period_label: periodLabel,
      users: users.map(username => withAdminDisplayName(rows.get(username)))
    };
  }

  async usageStats(period) {
    const readKeys = async keys => {
      const result = new Map();
      for (let i=0; i<keys.length; i+=128) {
        for (const [k,v] of await this.state.storage.get(keys.slice(i,i+128))) result.set(k,v);
      }
      return result;
    };
    const users = Array.from(getAllowedUsers(this.env));
    const rowsByUser = new Map(
      users.map(username => [username, usageTemplate(username)])
    );

    if (period === "all") {
      const keys = users.map(username => `usage-total:${username}`);
      const stored = await readKeys(keys);

      for (const username of users) {
        const value = stored.get(`usage-total:${username}`);
        if (value) {
          rowsByUser.set(username, {
            ...usageTemplate(username),
            ...value,
            username
          });
        }
      }
    } else {
      const days = period === "today" ? 1 : Number(period);
      const keys = [];

      for (let offset = 0; offset < days; offset++) {
        const day = parisDayKey(Date.now() - offset * 86400000);
        for (const username of users) {
          keys.push(`usage-day:${day}:${username}`);
        }
      }

      const stored = await readKeys(keys);

      for (const [key, value] of stored.entries()) {
        if (!value) continue;

        const username = normalizeUsername(String(key).split(":").pop());
        if (!rowsByUser.has(username)) continue;

        const row = rowsByUser.get(username);

        for (const metric of [
          "logins",
          "searches",
          "map_searches",
          "event_list_searches",
          "report_requests",
          "report_generator_requests",
          "deep_search_requests",
          "reports_generated",
          "cached_reports",
          "blocked_report_requests",
          "quick_ask_requests",
          "blockchain_searches",
          "facial_extractions",
          "facial_searches",
          "darkweb_searches",
          "ip_lookups",
          "feedback_submissions",
          "quiz_answers",
          "quiz_correct",
          "quiz_incorrect"
        ]) {
          row[metric] =
            Number(row[metric] || 0) +
            Number(value[metric] || 0);
        }

        const candidate = String(value.last_activity || "");
        if (candidate && (!row.last_activity || candidate > row.last_activity)) {
          row.last_activity = candidate;
        }
      }
    }

    const rows = users.map(username => rowsByUser.get(username));
    // Legacy totals may still contain the retired Social counter.
    for (const row of rows) delete row.social_intel_requests;

    const summary = {
      active_users: rows.filter(row =>
        ["logins", "searches", "report_requests", "report_generator_requests", "deep_search_requests", "reports_generated", "cached_reports", "quick_ask_requests", "blockchain_searches", "facial_extractions", "facial_searches", "darkweb_searches", "ip_lookups", "feedback_submissions", "quiz_answers"]
          .some(metric => Number(row[metric] || 0) > 0)
      ).length,
      logins: 0,
      searches: 0,
      map_searches: 0,
      event_list_searches: 0,
      report_requests: 0,
      report_generator_requests: 0,
      deep_search_requests: 0,
      reports_generated: 0,
      cached_reports: 0,
      blocked_report_requests: 0,
      quick_ask_requests: 0,
      blockchain_searches: 0,
      facial_extractions: 0,
      facial_searches: 0,
      darkweb_searches: 0,
      ip_lookups: 0,
      feedback_submissions: 0,
      quiz_answers: 0,
      quiz_correct: 0,
      quiz_incorrect: 0
    };

    for (const row of rows) {
      for (const metric of [
        "logins",
        "searches",
        "map_searches",
        "event_list_searches",
        "report_requests",
        "report_generator_requests",
        "deep_search_requests",
        "reports_generated",
        "cached_reports",
        "blocked_report_requests",
        "quick_ask_requests",
        "blockchain_searches",
        "facial_extractions",
        "facial_searches",
        "darkweb_searches",
        "ip_lookups",
        "feedback_submissions",
        "quiz_answers",
        "quiz_correct",
        "quiz_incorrect"
      ]) {
        summary[metric] += Number(row[metric] || 0);
      }
    }

    const periodLabel =
      period === "today" ? "Today · Europe/Paris" :
      period === "7" ? "Last 7 days · Europe/Paris" :
      period === "30" ? "Last 30 days · Europe/Paris" :
      "All time";

    return {
      period,
      period_label: periodLabel,
      generated_at: new Date().toISOString(),
      summary,
      users: rows.map(withAdminDisplayName)
    };
  }

  async quizHistory(period) {
    const dateKeys = new Set();
    if (period !== "all") {
      const days = period === "today" ? 1 : Number(period);
      for (let offset = 0; offset < days; offset++) {
        dateKeys.add(parisDayKey(Date.now() - offset * 86400000));
      }
    }

    const rows = [];
    let startAfter = "";
    for (let page = 0; page < 100; page++) {
      const options = { prefix: "quiz-answer:", limit: 1000 };
      if (startAfter) options.startAfter = startAfter;
      const batch = await this.state.storage.list(options);
      if (!batch || !batch.size) break;

      for (const [key, value] of batch.entries()) {
        if (!value || typeof value !== "object") continue;
        const parts = String(key).split(":");
        const quizDate = String(value.quiz_date || parts[1] || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(quizDate)) continue;
        if (dateKeys.size && !dateKeys.has(quizDate)) continue;

        const username = normalizeUsername(value.username || parts.slice(2).join(":"));
        if (!isAllowedUser(username, this.env)) continue;

        const selectedIndex = Number.isInteger(value.selected_index)
          ? value.selected_index
          : Number(value.selected_index);
        const correctIndex = Number.isInteger(value.correct_index)
          ? value.correct_index
          : Number(value.correct_index);
        const optionsList = Array.isArray(value.options)
          ? value.options.map(item => cleanText(item, 160)).slice(0, 3)
          : [];
        const answerLabel = (index, fallback) =>
          Number.isInteger(index) && index >= 0
            ? (optionsList[index] || fallback)
            : fallback;
        const sourceUrl = /^https:\/\//i.test(String(value.source_url || ""))
          ? cleanText(value.source_url, 1200)
          : "";

        rows.push({
          username,
          quiz_date: quizDate,
          category: cleanText(value.category, 120),
          question: cleanText(value.question, 500),
          options: optionsList,
          selected_index: Number.isInteger(selectedIndex) ? selectedIndex : null,
          selected_answer: cleanText(value.selected_answer, 160) || answerLabel(selectedIndex, "—"),
          correct_index: Number.isInteger(correctIndex) ? correctIndex : null,
          correct_answer: cleanText(value.correct_answer, 160) || answerLabel(correctIndex, "—"),
          correct: value.correct === true,
          quiz_id: cleanText(value.quiz_id, 128),
          explanation: cleanText(value.explanation, 700),
          source_url: sourceUrl,
          source_checked_at: cleanText(value.source_checked_at, 64),
          answered_at: cleanText(value.answered_at, 64)
        });
      }

      const keys = Array.from(batch.keys());
      const lastKey = keys[keys.length - 1];
      if (batch.size < 1000 || !lastKey || lastKey === startAfter) break;
      startAfter = lastKey;
    }

    rows.sort((a, b) =>
      String(b.answered_at || b.quiz_date).localeCompare(String(a.answered_at || a.quiz_date))
    );
    const periodLabel =
      period === "today" ? "Today · Europe/Paris" :
      period === "7" ? "Last 7 days · Europe/Paris" :
      period === "30" ? "Last 30 days · Europe/Paris" :
      "All time";

    return {
      period,
      period_label: periodLabel,
      generated_at: new Date().toISOString(),
      total: rows.length,
      answers: rows.map(withAdminDisplayName)
    };
  }


  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(()=>({}));
    const now = Date.now();

    if (url.pathname === "/ip-intelligence-limit") {
      if (!isAllowedUser(body.username, this.env)) return Response.json({ error: "Unknown user." }, { status: 403 });
      // The first slot of an analyst's lookup carries the target: once granted, it is
      // counted and kept in the admin search history (the domain's own IPs are not).
      const response = await this.state.storage.transaction(async tx => {
        const key = "ip-intelligence:limit:" + body.username;
        let counter = await tx.get(key);
        if (!counter || counter.until <= now) counter = { count: 0, until: now + 60000 };
        if (counter.count >= 6) return Response.json({ error: "Rate limit." }, { status: 429 });
        counter.count++;
        await tx.put(key, counter);
        if (body.keyed !== true) return Response.json({ ok: true });
        // Shared daily budget for the keyed VPN-detection providers (Proxycheck,
        // ipapi.is: about 1,000 free requests a day each), so one analyst cannot
        // use up the quota every other analyst relies on.
        const day = new Date(now).toISOString().slice(0, 10);
        const dayKey = "ip-intelligence:keyed-day";
        const previous = await tx.get(dayKey);
        if (previous !== day) {
          if (previous) {
            const stale = await tx.list({ prefix: "ip-intelligence:keyed:" + previous });
            if (stale.size) await tx.delete([...stale.keys()]);
          }
          await tx.put(dayKey, day);
        }
        const globalKey = "ip-intelligence:keyed:" + day, userKey = globalKey + ":" + body.username;
        const used = await tx.get(globalKey) || 0, usedByUser = await tx.get(userKey) || 0;
        if (used >= 800 || usedByUser >= 300) return Response.json({ ok: true, keyed: false });
        await tx.put(globalKey, used + 1);
        await tx.put(userKey, usedByUser + 1);
        return Response.json({ ok: true, keyed: true });
      });
      if (body.log && response.ok) {
        await this.incrementUsage(body.username, { ip_lookups: 1 }, now,
          this.usageLogEntry(body.username, "ip_lookup", body.log, now));
      }
      return response;
    }

    // One-time, user-requested removal of the pre-selection feed. Keep outlet
    // settings and known-URL history so rescans do not manufacture new alerts.
    if (url.pathname.startsWith("/darkweb-")) {
      await this.state.storage.transaction(async tx => {
        const marker = "darkweb:publication-selection-migration:1";
        if (await tx.get(marker)) return;
        const rows = await tx.list({ prefix: "darkweb:item:", limit: 1000 });
        let removed = 0;
        for (const [key, item] of rows) {
          if (item.selection_version !== 1) { await tx.delete(key); removed++; }
        }
        await tx.put(marker, { removed, completed_at: new Date(now).toISOString() });
      });
    }

    if (url.pathname.startsWith("/darkweb-")) {
      await this.state.storage.transaction(async tx => {
        if (await tx.get("darkweb:controlled-collection:2")) return;
        const rows = await tx.list({ prefix: "darkweb:item:", limit: 1000 });
        for (const [key] of rows) await tx.delete(key);
        const outlets = await tx.get("darkweb:outlets") || [];
        for (const outlet of outlets) {
          delete outlet.initialized_at;
          outlet.collection_phase = "backfill";
          outlet.pages_scanned = outlet.pending_pages = outlet.failed_pages = outlet.undated_count = 0;
          outlet.last_scan = outlet.last_success = ""; outlet.scan_ok = outlet.crawl_complete = outlet.truncated = false;
        }
        await tx.put("darkweb:outlets", outlets);
        await tx.put("darkweb:policy", { epoch: 2, from: "2025-01-01", through: "2026-12-31", pages_per_scan: 10, paused: false, previews: true });
        await tx.delete("darkweb:summary");
        await tx.put("darkweb:controlled-collection:2", true);
      });
    }
    if (url.pathname === "/darkweb-files-info") {
      const files = {};
      for (const hash of (Array.isArray(body.hashes) ? body.hashes : []).slice(0,600)) {
        if (/^[a-f0-9]{64}$/.test(hash)) {
          const file = await this.state.storage.get("darkweb:file:" + hash);
          if (file) files[hash] = file;
        }
      }
      const usage = await this.state.storage.get("darkweb:files-usage") || { stored_bytes: 0, reserved_bytes: 0, files: 0 };
      const policy = await this.state.storage.get("darkweb:files-policy") || { limit_bytes: 8000000000 };
      return Response.json({ files, usage: { ...usage, ...policy } });
    }
    if (url.pathname === "/darkweb-files-policy") {
      if (!Number.isSafeInteger(body.limit_bytes) || body.limit_bytes < 1000000 || body.limit_bytes > 10000000000) return Response.json({ error: "Storage limit must be between 1 MB and 10 GB." }, { status: 400 });
      await this.state.storage.put("darkweb:files-policy", { limit_bytes: body.limit_bytes });
      return Response.json({ ok: true });
    }
    if (["/darkweb-file-check", "/darkweb-file-commit"].includes(url.pathname)) {
      return this.state.storage.transaction(async tx => {
        const reject = (error, status=409) => Response.json({ error }, { status });
        if (!/^[a-f0-9]{64}$/.test(body.id || "") || !/^[a-f0-9]{64}$/.test(body.sha256 || "")) return reject("Invalid PDF reference.", 400);
        const policy = await tx.get("darkweb:policy");
        const item = await tx.get(`darkweb:publication:${policy.epoch}:${body.id}`);
        const file = item?.attachments?.find(a => a.type === "pdf" && a.acquired && a.sha256 === body.sha256);
        if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 5) return reject("PDF attachment is not registered in this collection.", 404);
        if (body.upload_access) {
          const outlets = await tx.get("darkweb:outlets") || [];
          if (policy.paused || body.epoch !== policy.epoch || item.outlet_id !== body.outlet_id || !outlets.some(o => o.id === body.outlet_id && o.enabled)) return reject("Reload collection configuration.");
        }
        const key = "darkweb:file:" + body.sha256;
        let stored = await tx.get(key);
        if (stored && stored.bytes !== file.bytes) return reject("PDF size conflicts with its recorded hash.");
        const usage = await tx.get("darkweb:files-usage") || { stored_bytes: 0, reserved_bytes: 0, files: 0 };
        if (url.pathname === "/darkweb-file-commit") {
          if (!body.upload_access || !stored || body.bytes !== file.bytes) return reject("No matching PDF reservation.");
          if (stored.status !== "ready") {
            stored = { ...stored, status: "ready", stored_at: new Date(now).toISOString() };
            usage.reserved_bytes -= file.bytes; usage.stored_bytes += file.bytes; usage.files++;
            await tx.put(key, stored); await tx.put("darkweb:files-usage", usage);
          }
          return Response.json({ ok: true, stored: true, stored_at: stored.stored_at });
        }
        if (body.reserve && body.upload_access && !stored) {
          const config = await tx.get("darkweb:files-policy") || { limit_bytes: 8000000000 };
          if (usage.stored_bytes + usage.reserved_bytes + file.bytes > config.limit_bytes) return reject("Private PDF storage limit reached. Local files are preserved.", 507);
          stored = { status: "reserved", bytes: file.bytes, reserved_at: new Date(now).toISOString() };
          usage.reserved_bytes += file.bytes;
          await tx.put(key, stored); await tx.put("darkweb:files-usage", usage);
        }
        return Response.json({ file, stored: stored?.status === "ready" });
      });
    }
    if (url.pathname === "/darkweb-policy") {
      const result = await this.state.storage.transaction(async tx => {
        const prior = await tx.get("darkweb:policy");
        const policy = { ...prior, ...body.policy };
        let recrawl = false;
        if (body.reset) {
          policy.epoch = prior.epoch + 1;
          const rows = await tx.list({ prefix: "darkweb:item:", limit: 1000 });
          for (const [key] of rows) await tx.delete(key);
          // Delete structured archives in bounded batches, independently of feed retention.
          for (const prefix of ["darkweb:publication:", "darkweb:publication-index:", "darkweb:publication-pending:"]) {
            while (true) {
              const archived = await tx.list({ prefix, limit: 128 });
              if (!archived.size) break;
              await tx.delete([...archived.keys()]);
            }
          }
          const outlets = await tx.get("darkweb:outlets") || [];
          for (const outlet of outlets) { delete outlet.initialized_at; delete outlet.period_backfill; Object.assign(outlet, { collection_phase: "backfill", pages_scanned: 0, pending_pages: 0, failed_pages: 0, undated_count: 0, last_scan: "", last_success: "", scan_ok: false, crawl_complete: false, truncated: false }); }
          await tx.put("darkweb:outlets", outlets);
          await tx.delete("darkweb:summary");
        } else if (policy.from > prior.from || policy.through < prior.through) {
          return { error: "Narrowing the period requires Reset & collect." };
        } else if (policy.from < prior.from || (policy.through > prior.through && prior.through < new Date(now).toISOString().slice(0, 10))) {
          // Widening keeps the epoch and every stored record. Outlets re-crawl in
          // backfill for the newly covered past dates; /darkweb-ingest ends it.
          const outlets = await tx.get("darkweb:outlets") || [];
          for (const outlet of outlets) {
            outlet.period_backfill = { requested_at: new Date(now).toISOString(), after_watch: outlet.collection_phase === "watch", reports: 0, last_pages: Number(outlet.pages_scanned) || 0, fresh: false };
            outlet.collection_phase = "backfill";
          }
          await tx.put("darkweb:outlets", outlets);
          recrawl = outlets.length > 0;
        }
        await tx.put("darkweb:policy", policy);
        return { ok: true, policy, recrawl };
      });
      return Response.json(result, { status: result.error ? 400 : 200 });
    }
    if (url.pathname === "/darkweb-preview") {
      const policy = await this.state.storage.get("darkweb:policy");
      const item = await this.state.storage.get(`darkweb:publication:${policy.epoch}:${body.id}`) || await this.state.storage.get("darkweb:item:" + body.id);
      return Response.json({ preview: item?.preview || "" });
    }
    if (url.pathname === "/darkweb-item") {
      const policy = await this.state.storage.get("darkweb:policy");
      const item = await this.state.storage.get(`darkweb:publication:${policy.epoch}:${body.id}`) || await this.state.storage.get("darkweb:item:" + body.id);
      if (!item) return Response.json({ error: "Publication unavailable in this collection." }, { status: 404 });
      const { preview, ...record } = item;
      return Response.json({ item: { ...record, has_preview: !!preview } });
    }
    if (url.pathname === "/darkweb-archive") {
      const policy = await this.state.storage.get("darkweb:policy"), prefix = `darkweb:publication-index:${policy.epoch}:`;
      const rows = await this.state.storage.list({ prefix, reverse: true, limit: 51, ...(body.cursor ? { end: prefix + body.cursor } : {}) });
      const page = [...rows.entries()].slice(0,50), items = [];
      for (const [, id] of page) {
        const record = await this.state.storage.get(`darkweb:publication:${policy.epoch}:${id}`);
        if (record) { const { preview, original_text, ...item } = record; items.push({ ...item, has_preview: !!preview }); }
      }
      return Response.json({ items, next_cursor: rows.size > 50 ? page.at(-1)[0].slice(prefix.length) : "", epoch: policy.epoch });
    }
    if (url.pathname === "/darkweb-enrich-candidates") {
      const policy = await this.state.storage.get("darkweb:policy");
      // Requeue already-enriched archive records once for faithful translations.
      // This migration never resets publication text, files or collection progress.
      const migrationKey = `darkweb:title-translation-cursor:${policy.epoch}`;
      const cursor = await this.state.storage.get(migrationKey) || "";
      if (cursor !== "done") {
        const prefix = `darkweb:publication-index:${policy.epoch}:`;
        const page = await this.state.storage.list({ prefix, reverse: true, limit: 100, ...(cursor ? { end: cursor } : {}) });
        for (const id of page.values()) {
          const item = await this.state.storage.get(`darkweb:publication:${policy.epoch}:${id}`);
          if (item && item.title_en_kind !== "translation") await this.state.storage.put(`darkweb:publication-pending:${policy.epoch}:${id}`, id);
        }
        await this.state.storage.put(migrationKey, page.size === 100 ? [...page.keys()].at(-1) : "done");
      }
      // Records that failed three attempts stay queued but no longer hold the batch.
      const items = [];
      let startAfter = "";
      for (let page = 0; page < 5 && items.length < 10; page++) {
        const pending = await this.state.storage.list({ prefix: `darkweb:publication-pending:${policy.epoch}:`, limit: 128, ...(startAfter ? { startAfter } : {}) });
        for (const [key, id] of pending) {
          startAfter = key;
          const record = await this.state.storage.get(`darkweb:publication:${policy.epoch}:${id}`);
          if (record && !(record.enrich_attempts >= 3)) items.push(record);
          if (items.length >= 10) break;
        }
        if (pending.size < 128) break;
      }
      return Response.json({ items, summary_attempt: await this.state.storage.get("darkweb:summary-attempt") || null });
    }
    if (url.pathname === "/darkweb-enrich-lock") {
      return Response.json(await this.state.storage.transaction(async tx => {
        const until = await tx.get("darkweb:enrich-until") || 0;
        if (until > now) return { ok: false, reason: "lock", retry_at: new Date(until).toISOString() };
        const backoff = await tx.get("darkweb:enrich-backoff");
        if (backoff?.until > now) return { ok: false, reason: "backoff", retry_at: new Date(backoff.until).toISOString() };
        // Daily ledger per Pacific day, the reset day of the Gemini free quota.
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
        const day = `${parts.year}-${parts.month}-${parts.day}`;
        const ledger = await tx.get("darkweb:enrich-ledger");
        const used = ledger?.day === day ? ledger.count : 0;
        const limit = Number.isSafeInteger(body.daily_limit) && body.daily_limit >= 0 ? body.daily_limit : 40;
        if (used >= limit) return { ok: false, reason: "daily_limit", used, limit };
        await tx.put("darkweb:enrich-ledger", { day, count: used + 1 });
        await tx.put("darkweb:enrich-until", now + 60000);
        return { ok: true, used: used + 1, limit };
      }));
    }
    if (url.pathname === "/darkweb-enrich-save") {
      return Response.json(await this.state.storage.transaction(async tx => {
        const policy = await tx.get("darkweb:policy");
        if (body.epoch !== policy.epoch) return { ok: false };
        let saved = 0;
        for (const title of body.titles || []) {
          const key = "darkweb:item:" + title.id, archiveKey = `darkweb:publication:${policy.epoch}:${title.id}`;
          const item = await tx.get(archiveKey) || await tx.get(key);
          if (item && item.title === title.original && item.excerpt === title.excerpt && (!item.publication_version || item.content_hash === title.content_hash)) {
            const updated = { ...item, title_en: title.title, title_en_kind: title.title_en_kind === "translation" ? "translation" : "generated", overview_en: title.overview_en || "", title_en_generated_at: new Date(now).toISOString() };
            if (item.publication_version) {
              await tx.put(archiveKey, updated);
              if (updated.overview_en) await tx.delete(`darkweb:publication-pending:${policy.epoch}:${title.id}`);
            }
            if (await tx.get(key)) { const { original_text, ...card } = updated; await tx.put(key, card); }
            saved++;
          }
        }
        if (body.summary) await tx.put("darkweb:summary", body.summary);
        // Count unfinished attempts on the record itself; a source change resets it at ingest.
        for (const entry of (Array.isArray(body.attempted) ? body.attempted : []).slice(0, 10)) {
          const key = "darkweb:item:" + entry.id, archiveKey = `darkweb:publication:${policy.epoch}:${entry.id}`;
          const archived = await tx.get(archiveKey), card = await tx.get(key), item = archived || card;
          if (!item || item.title !== entry.original || item.excerpt !== entry.excerpt || (item.publication_version && item.content_hash !== entry.content_hash)) continue;
          if (item.title_en_kind === "translation" && (!item.publication_version || item.overview_en)) continue;
          const enrich_attempts = (item.enrich_attempts || 0) + 1;
          if (archived) await tx.put(archiveKey, { ...archived, enrich_attempts });
          if (card) await tx.put(key, { ...card, enrich_attempts });
        }
        if (/^[a-f0-9]{64}$/.test(body.summary_fingerprint || "")) await tx.put("darkweb:summary-attempt", { fingerprint: body.summary_fingerprint, at: new Date(now).toISOString() });
        // After a failed or useless call, back off 15 min doubling up to 6 h; any saved result resets it.
        if (saved || body.summary) await tx.delete("darkweb:enrich-backoff");
        else {
          const failures = Math.min(((await tx.get("darkweb:enrich-backoff"))?.failures || 0) + 1, 16);
          await tx.put("darkweb:enrich-backoff", { failures, until: now + Math.min(900000 * 2 ** (failures - 1), 21600000) });
        }
        return { ok: true, saved };
      }));
    }

    // Curated outlet watch: private metadata only, bounded to 500 retained items.
    // Serialize read/modify/write with storage transactions so collector retries
    // and parallel outlet saves cannot lose records or duplicate alerts.
    if (url.pathname === "/darkweb-state") {
      const outlets = (await this.state.storage.get("darkweb:outlets")) || [];
      const rows = await this.state.storage.list({ prefix: "darkweb:item:", limit: 500 });
      const items = [...rows.values()].map(({ preview, ...item }) => ({ ...item, has_preview: !!preview })).sort((a, b) => b.first_seen.localeCompare(a.first_seen));
      const seen = body.username ? await this.state.storage.get("darkweb:seen:" + body.username) : "";
      const unread = items.filter(i => !i.baseline && i.first_seen > (seen || ""));
      return Response.json({ policy: await this.state.storage.get("darkweb:policy"), summary: await this.state.storage.get("darkweb:summary") || null, outlets, items, unread_count: unread.length,
        keyword_alert_count: unread.filter(i => i.keyword_matches?.length).length,
        seen_through: seen || "", generated_at: new Date(now).toISOString(), retention_limit: 500 });
    }
    if (url.pathname === "/darkweb-seen") {
      await this.state.storage.transaction(async tx => {
        const key = "darkweb:seen:" + body.username;
        const previous = await tx.get(key) || "";
        await tx.put(key, String(body.through) > previous ? body.through : previous);
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/darkweb-outlet-save") {
      const result = await this.state.storage.transaction(async tx => {
        const outlets = await tx.get("darkweb:outlets") || [];
        const prior = outlets.find(o => o.id === body.outlet.id);
        if (!prior && outlets.length >= 20) return { error: "Outlet limit reached (20)." };
        const outlet = { ...prior, ...body.outlet, updated_at: new Date(now).toISOString() };
        const next = outlets.filter(o => o.id !== outlet.id).concat(outlet);
        await tx.put("darkweb:outlets", next);
        return { ok: true, outlet };
      });
      return Response.json(result, { status: result.error ? 400 : 200 });
    }
    if (url.pathname === "/darkweb-ingest") {
      const result = await this.state.storage.transaction(async tx => {
        const policy = await tx.get("darkweb:policy");
        if (policy.paused || body.collection_epoch !== policy.epoch) return { error: "Collection policy changed; reload configuration." };
        const outlets = await tx.get("darkweb:outlets") || [];
        const outlet = outlets.find(o => o.id === body.outlet_id && o.enabled);
        if (!outlet) return { error: "Unknown or disabled outlet." };
        const timestamp = new Date(now).toISOString();
        let added = 0;
        const knownBuckets = new Map();
        // Only a completed, non-truncated first inventory establishes the baseline.
        const baseline = !outlet.initialized_at || body.inventory_phase === "backfill";
        // Received items are stored even when the pass failed; scan_ok only sets outlet status and the baseline.
        for (const item of body.items) {
          const key = "darkweb:item:" + item.id;
          // Keep small URL-history shards independently from the 500-row feed.
          // Otherwise listing pages larger than the retained feed would create
          // the same "new" discoveries every time evicted links are scanned.
          const bucketKey = "darkweb:known:" + outlet.id + ":" + item.id.slice(0, 2);
          if (!knownBuckets.has(bucketKey)) knownBuckets.set(bucketKey, await tx.get(bucketKey) || {});
          const bucket = knownBuckets.get(bucketKey);
          const archiveKey = `darkweb:publication:${policy.epoch}:${item.id}`;
          const stored = await tx.get(archiveKey) || await tx.get(key);
          const prior = stored || bucket[item.id];
          // A legacy collector or a revisited listing cannot replace complete source text.
          if (prior?.publication_version && (!item.publication_version || (prior.text_status !== "listing" && item.text_status === "listing"))) continue;
          if (!prior) added++;
          const sameContent = prior?.title === item.title && prior?.excerpt === item.excerpt && prior?.content_hash === item.content_hash;
          // A backfill revisit (such as after a period widening) keeps an alert already stored in this collection.
          const record = { ...prior, ...item, title_en: sameContent ? prior?.title_en || "" : "", title_en_kind: sameContent ? prior?.title_en_kind || "" : "", overview_en: sameContent ? prior?.overview_en || "" : "", ...(sameContent ? {} : { enrich_attempts: 0 }), first_seen: prior?.first_seen || timestamp,
            preview: item.preview || prior?.preview || "", last_seen: timestamp, baseline: baseline ? stored?.baseline !== false : prior ? prior.baseline : false,
            sha256: item.sha256 || prior?.sha256 || "", acquired: item.acquired || prior?.acquired || false,
            bytes: item.bytes ?? prior?.bytes ?? null };
          if (item.publication_version) {
            const oldFiles = new Map((prior?.attachments || []).map(a => [a.url,a]));
            record.attachments = item.attachments.map(a => a.acquired || !oldFiles.get(a.url)?.acquired ? a : { ...a, ...oldFiles.get(a.url) });
            if (prior?.published_at && prior.published_at !== item.published_at) await tx.delete(`darkweb:publication-index:${policy.epoch}:${prior.published_at}:${item.id}`);
            await tx.put(archiveKey, record);
            await tx.put(`darkweb:publication-index:${policy.epoch}:${item.published_at}:${item.id}`, item.id);
            if (!record.title_en || record.title_en_kind !== "translation" || !record.overview_en) await tx.put(`darkweb:publication-pending:${policy.epoch}:${item.id}`, item.id);
          }
          const { original_text, ...card } = record;
          await tx.put(key, card);
          bucket[item.id] = { first_seen: record.first_seen, baseline: record.baseline,
            sha256: record.sha256, acquired: record.acquired, bytes: record.bytes };
        }
        // 256 shards × 128 records per outlet; each value stays below the
        // Durable Object value-size limit. This is still a bounded history.
        for (const [key, bucket] of knownBuckets) {
          const entries = Object.entries(bucket).sort((a, b) => b[1].first_seen.localeCompare(a[1].first_seen)).slice(0, 128);
          await tx.put(key, Object.fromEntries(entries));
        }
        const widening = outlet.period_backfill;
        if (widening) {
          // A pass that read the configuration before a widening may still report, so
          // only a crawl restarted afterwards (fewer pages in its run) covers the new dates.
          const pages = body.pages_scanned || 0;
          if ((widening.after_watch ? body.inventory_phase === "backfill" : widening.reports > 0) && pages < widening.last_pages) widening.fresh = true;
          widening.reports++; widening.last_pages = pages;
        }
        outlet.undated_count = body.undated_count || 0;
        outlet.last_out_of_period = body.out_of_period || 0;
        outlet.last_scan = timestamp;
        if (body.inventory_phase === "backfill") outlet.collection_phase = "backfill";
        outlet.scan_ok = body.scan_ok === true;
        outlet.error = body.error;
        outlet.truncated = body.truncated === true;
        outlet.pages_scanned = body.pages_scanned || 0;
        outlet.pending_pages = body.pending_pages || 0;
        outlet.failed_pages = body.failed_pages || 0;
        outlet.crawl_complete = body.scan_complete === true && !body.truncated;
        if (body.scan_ok && body.scan_complete) {
          outlet.last_success = timestamp;
          if (!body.truncated) {
            outlet.initialized_at ||= timestamp;
            // A crawl begun before a widening ends; the collector then restarts from the start page.
            if (!widening || widening.fresh) { delete outlet.period_backfill; outlet.collection_phase = "watch"; }
            else widening.fresh = true;
          }
        }
        outlet.last_added = added;
        await tx.put("darkweb:outlets", outlets);
        const rows = await tx.list({ prefix: "darkweb:item:", limit: 1000 });
        // Publication cards keep their archive record, so they leave the feed before legacy cards.
        const oldest = [...rows.entries()].sort((a, b) => (b[1].publication_version ? 1 : 0) - (a[1].publication_version ? 1 : 0) || a[1].first_seen.localeCompare(b[1].first_seen));
        for (const [key] of oldest.slice(0, Math.max(0, oldest.length - 500))) await tx.delete(key);
        return { ok: true, added, baseline, retained_limit: 500, out_of_period: body.out_of_period || 0 };
      });
      return Response.json(result, { status: result.error ? 400 : 200 });
    }

    if (url.pathname === "/migration-status") {
      return Response.json({
        ok: true,
        migrated: Boolean(await this.state.storage.get("__eu_migration_complete")),
        jurisdiction: this.state?.id?.jurisdiction || null
      });
    }

    if (url.pathname === "/migration-export") {
      const startAfter = cleanText(body.start_after, 1000);
      const options = { limit: MIGRATION_PAGE_SIZE };
      if (startAfter) options.startAfter = startAfter;
      const batch = await this.state.storage.list(options);
      const entries = Array.from(batch.entries())
        .filter(([key]) => key !== "__eu_migration_complete")
        .map(([key, value]) => [key, value]);
      const lastKey = entries.length ? entries[entries.length - 1][0] : "";
      return Response.json({
        ok: true,
        entries,
        last_key: lastKey,
        has_more: batch.size >= MIGRATION_PAGE_SIZE
      });
    }

    if (url.pathname === "/migration-import") {
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, MIGRATION_PAGE_SIZE) : [];
      const writes = {};
      for (const item of entries) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const key = cleanText(item[0], 1200);
        if (!key || key === "__eu_migration_complete") continue;
        writes[key] = item[1];
      }
      if (Object.keys(writes).length) await this.state.storage.put(writes);
      return Response.json({ ok: true, imported: Object.keys(writes).length });
    }

    if (url.pathname === "/migration-finalize") {
      await this.state.storage.put("__eu_migration_complete", {
        completed_at: new Date(now).toISOString(),
        source: "legacy-global",
        jurisdiction: this.state?.id?.jurisdiction || "eu"
      });
      const nextExpiry = await this.purgeExpired(now);
      if (nextExpiry != null) await this.state.storage.setAlarm(nextExpiry);
      return Response.json({ ok: true, migrated: true });
    }

    if (url.pathname === "/migration-retire") {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, retired: true });
    }

    if (url.pathname === "/source-image-token-put") {
      const imageUrl = cleanText(body.image_url, 1500);
      if (!imageUrl) return Response.json({ error: "Missing image URL." }, { status: 400 });
      const token = crypto.randomUUID();
      const expiresAt = Math.min(
        Number(body.expires_at || (now + 86400000)),
        now + 86400000
      );
      await this.state.storage.put("source-image-token:" + token, {
        image_url: imageUrl,
        source_id: cleanText(body.source_id, 40),
        title: cleanText(body.title, 300),
        source: cleanText(body.source, 160),
        article_url: cleanText(body.article_url, 1500),
        expires_at: expiresAt
      });
      await this.scheduleExpiry(expiresAt);
      return Response.json({ ok: true, token, expires_at: expiresAt });
    }

    if (url.pathname === "/source-image-token-get") {
      const token = cleanText(body.token, 100);
      const key = "source-image-token:" + token;
      const value = token ? await this.state.storage.get(key) : null;
      if (!value || Number(value.expires_at || 0) < now) {
        if (value) await this.state.storage.delete(key);
        return Response.json({ error: "Preview token expired or not found." }, { status: 404 });
      }
      return Response.json({ ok: true, ...value });
    }

    if (url.pathname === "/crypto-monitor-targets") {
      const limit = Math.max(1, Math.min(8, Number(body.limit || 8)));
      const stored = await this.state.storage.list({ prefix: "crypto-workspace:" });
      const targets = [];
      const sensitive = new Set(["CT WATCHLIST","SANCTIONS","DARKNET","MIXER"]);

      for (const [key, workspace] of stored.entries()) {
        const username = normalizeUsername(workspace?.username || String(key).slice("crypto-workspace:".length));
        if (!isAllowedUser(username, this.env)) continue;
        const labels = Array.isArray(workspace?.labels) ? workspace.labels : [];
        for (const watch of Array.isArray(workspace?.watchlist) ? workspace.watchlist : []) {
          if (watch?.enabled === false || !watch?.chain || !watch?.address || !watch?.id) continue;
          const sensitiveLabels = labels
            .filter(label => label?.chain === watch.chain && sensitive.has(String(label?.category || "").toUpperCase()))
            .slice(0, 500)
            .map(label => ({
              address: cleanText(label.address, 180),
              name: cleanText(label.name, 120),
              category: cleanText(label.category, 48).toUpperCase(),
              confidence: cleanText(label.confidence, 16).toUpperCase(),
              source_title: cleanText(label.source_title, 240)
            }));
          targets.push({
            username,
            watch: {
              id: cleanText(watch.id, 80),
              chain: cleanText(watch.chain, 24).toLowerCase(),
              address: cleanText(watch.address, 180),
              label: cleanText(watch.label, 120),
              thresholds: watch.thresholds || {},
              last_snapshot: watch.last_snapshot || null
            },
            sensitive_labels: sensitiveLabels
          });
        }
      }

      targets.sort((a,b) => (a.username + ":" + a.watch.id).localeCompare(b.username + ":" + b.watch.id));
      if (!targets.length) return Response.json({ ok: true, targets: [], total: 0 });

      const cursorRaw = Number((await this.state.storage.get("crypto-monitor-cursor")) || 0);
      const cursor = ((cursorRaw % targets.length) + targets.length) % targets.length;
      const selected = [];
      for (let i = 0; i < Math.min(limit, targets.length); i++) {
        selected.push(targets[(cursor + i) % targets.length]);
      }
      await this.state.storage.put("crypto-monitor-cursor", (cursor + selected.length) % targets.length);
      return Response.json({ ok: true, targets: selected, total: targets.length, cursor });
    }

    if (url.pathname === "/crypto-monitor-update") {
      const username = normalizeUsername(body.username);
      const watchId = cleanText(body.watch_id, 80);
      if (!isAllowedUser(username, this.env) || !watchId) {
        return Response.json({ error: "Invalid monitoring update." }, { status: 400 });
      }
      const key = `crypto-workspace:${username}`;
      const workspace = await this.state.storage.get(key);
      if (!workspace || !Array.isArray(workspace.watchlist)) {
        return Response.json({ error: "Crypto workspace not found." }, { status: 404 });
      }
      const watch = workspace.watchlist.find(item => item?.id === watchId);
      if (!watch) return Response.json({ error: "Monitored wallet not found." }, { status: 404 });

      const snapshot = body.snapshot && typeof body.snapshot === "object" ? body.snapshot : null;
      if (snapshot) {
        watch.last_snapshot = {
          checked_at: cleanText(snapshot.checked_at, 64),
          newest_tx_id: cleanText(snapshot.newest_tx_id, 180),
          newest_tx_time: cleanText(snapshot.newest_tx_time, 64),
          tx_count: Number(snapshot.tx_count || 0),
          aggregate_value: Number(snapshot.aggregate_value || 0)
        };
        watch.updated_at = new Date(now).toISOString();
      }

      workspace.alerts = Array.isArray(workspace.alerts) ? workspace.alerts : [];
      const signatures = new Set(workspace.alerts.map(item =>
        [item?.watch_id, item?.type, item?.tx_id || "", item?.title].join("|")
      ));
      let added = 0;
      for (const raw of Array.isArray(body.alerts) ? body.alerts.slice(0, 40) : []) {
        const alert = {
          id: cleanText(raw?.id || crypto.randomUUID(), 80),
          watch_id: watchId,
          chain: cleanText(raw?.chain || watch.chain, 24).toLowerCase(),
          address: cleanText(raw?.address || watch.address, 180),
          type: cleanText(raw?.type, 64).toUpperCase(),
          severity: ["HIGH","MEDIUM","LOW"].includes(cleanText(raw?.severity, 16).toUpperCase())
            ? cleanText(raw.severity, 16).toUpperCase()
            : "LOW",
          title: cleanText(raw?.title, 180),
          detail: cleanText(raw?.detail, 1200),
          tx_id: cleanText(raw?.tx_id, 180),
          created_at: cleanText(raw?.created_at, 64) || new Date(now).toISOString(),
          acknowledged: false
        };
        const signature = [alert.watch_id, alert.type, alert.tx_id || "", alert.title].join("|");
        if (!alert.type || !alert.title || signatures.has(signature)) continue;
        signatures.add(signature);
        workspace.alerts.unshift(alert);
        added++;
      }
      workspace.alerts = workspace.alerts.slice(0, 1000);
      workspace.updated_at = new Date(now).toISOString();
      await this.state.storage.put(key, workspace);
      return Response.json({ ok: true, alerts_added: added });
    }

    if (url.pathname === "/social-workspace-get") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      const key = `social-workspace:${username}`;
      let workspace = (await this.readSocialWorkspace(key)) || {
        version: "socmint-v1-public-web-report",
        username,
        reports: [],
        updated_at: new Date(now).toISOString()
      };
      const pruned = await this.pruneSocialWorkspace(workspace, now);
      workspace = pruned.workspace;
      if (pruned.changed) await this.writeSocialWorkspace(key, workspace);
      if (pruned.nextExpiry != null) await this.scheduleExpiry(pruned.nextExpiry);
      return Response.json({ ok: true, workspace });
    }

    if (url.pathname === "/social-workspace-put") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      const workspace = body.workspace && typeof body.workspace === "object" ? body.workspace : null;
      if (!workspace) {
        return Response.json({ error: "Missing social workspace." }, { status: 400 });
      }
      let safeWorkspace = {
        version: cleanText(workspace.version || "socmint-v1-public-web-report", 80),
        username,
        reports: Array.isArray(workspace.reports) ? workspace.reports.slice(0, 50) : [],
        updated_at: new Date(now).toISOString()
      };
      const pruned = await this.pruneSocialWorkspace(safeWorkspace, now);
      safeWorkspace = pruned.workspace;
      await this.writeSocialWorkspace(`social-workspace:${username}`, safeWorkspace);
      if (pruned.nextExpiry != null) await this.scheduleExpiry(pruned.nextExpiry);
      return Response.json({ ok: true, workspace: safeWorkspace });
    }

    if (url.pathname === "/social-report-delete") {
      const username = normalizeUsername(body.username);
      const reportId = cleanText(body.report_id, 80);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      const key = `social-workspace:${username}`;
      const workspace = (await this.readSocialWorkspace(key)) || {
        version: "socmint-v1-public-web-report",
        username,
        reports: []
      };
      workspace.reports = Array.isArray(workspace.reports)
        ? workspace.reports.filter(item => cleanText(item?.id, 80) !== reportId).slice(0, 50)
        : [];
      workspace.updated_at = new Date(now).toISOString();
      await this.writeSocialWorkspace(key, workspace);
      return Response.json({ ok: true, workspace });
    }

    if (url.pathname === "/crypto-exchange-labels-lookup") {
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 100) : [];
      const labels = [];
      const cachedLabels = [];
      for (const entry of entries) {
        const addressKey = exchangeAddressKey(entry?.chain, entry?.address);
        if (!addressKey) continue;
        const approved = await this.state.storage.get(`crypto-exchange-label:${addressKey}`);
        if (approved) labels.push(approved);
        const cacheKey = `crypto-provider-label:${addressKey}`;
        const cached = await this.state.storage.get(cacheKey);
        if (cached && Number(cached.expires_at || 0) > now && cached.label) cachedLabels.push(cached.label);
        else if (cached) await this.state.storage.delete(cacheKey);
      }
      return Response.json({ ok: true, labels, cached_labels: cachedLabels });
    }

    if (url.pathname === "/crypto-exchange-provider-put") {
      const writes = {};
      let nextExpiry = null;
      for (const item of Array.isArray(body.entries) ? body.entries.slice(0, 100) : []) {
        const addressKey = exchangeAddressKey(item?.entry?.chain, item?.entry?.address);
        if (!addressKey || !item?.label || item.label.category !== "EXCHANGE") continue;
        const expiresAt = Math.min(Number(item.expires_at || 0), now + 30 * 24 * 60 * 60 * 1000);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
        writes[`crypto-provider-label:${addressKey}`] = { label: item.label, expires_at: expiresAt };
        if (nextExpiry == null || expiresAt < nextExpiry) nextExpiry = expiresAt;
      }
      if (Object.keys(writes).length) await this.state.storage.put(writes);
      if (nextExpiry != null) await this.scheduleExpiry(nextExpiry);
      return Response.json({ ok: true, cached: Object.keys(writes).length });
    }

    if (url.pathname === "/crypto-exchange-proposal-create") {
      const proposal = body.proposal && typeof body.proposal === "object" ? body.proposal : null;
      const addressKey = exchangeAddressKey(proposal?.chain, proposal?.address);
      if (!addressKey || !cleanText(proposal?.name, 120) || proposal?.category !== "EXCHANGE") {
        return Response.json({ error: "Invalid exchange label proposal." }, { status: 400 });
      }
      const approved = await this.state.storage.get(`crypto-exchange-label:${addressKey}`);
      if (approved) return Response.json({ ok: true, already_approved: true, label: approved });
      const key = `crypto-exchange-proposal:${addressKey}`;
      const existing = await this.state.storage.get(key);
      if (existing?.status === "PENDING") return Response.json({ ok: true, already_pending: true, proposal: existing });
      const safeProposal = {
        ...proposal,
        id: cleanText(proposal.id || crypto.randomUUID(), 80),
        address: addressKey.slice(addressKey.indexOf(":") + 1),
        category: "EXCHANGE",
        status: "PENDING",
        created_by: cleanText(proposal.created_by, 80),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        reviewed_by: "",
        reviewed_at: ""
      };
      await this.state.storage.put(key, safeProposal);
      return Response.json({ ok: true, proposal: safeProposal });
    }

    if (url.pathname === "/crypto-exchange-proposals-list") {
      const batch = await this.state.storage.list({ prefix: "crypto-exchange-proposal:", limit: 1000 });
      const proposals = Array.from(batch.values())
        .filter(item => item?.status === "PENDING")
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
        .slice(0, 300);
      return Response.json({ ok: true, proposals });
    }

    if (url.pathname === "/crypto-exchange-proposal-review") {
      const proposalId = cleanText(body.proposal_id, 240);
      const decision = cleanText(body.decision, 16).toLowerCase();
      if (!proposalId || !["approve", "reject"].includes(decision)) {
        return Response.json({ error: "Invalid exchange proposal decision." }, { status: 400 });
      }
      const batch = await this.state.storage.list({ prefix: "crypto-exchange-proposal:", limit: 1000 });
      const match = Array.from(batch.entries()).find(([, item]) => item?.id === proposalId);
      if (!match || match[1]?.status !== "PENDING") return Response.json({ error: "Pending proposal not found." }, { status: 404 });
      const [key, proposal] = match;
      const reviewed = {
        ...proposal,
        status: decision === "approve" ? "APPROVED" : "REJECTED",
        reviewed_by: cleanText(body.reviewed_by, 80),
        reviewed_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
      };
      await this.state.storage.put(key, reviewed);
      if (decision === "approve") {
        const addressKey = exchangeAddressKey(reviewed.chain, reviewed.address);
        const approved = { ...reviewed, status: "APPROVED" };
        delete approved.id;
        await this.state.storage.put(`crypto-exchange-label:${addressKey}`, approved);
      }
      return Response.json({ ok: true, proposal: reviewed });
    }

    if (url.pathname === "/crypto-exchange-labels-import") {
      const writes = {};
      const importedBy = cleanText(body.imported_by, 80);
      let importedCount = 0;
      let skippedCount = 0;
      for (const label of Array.isArray(body.labels) ? body.labels.slice(0, 100) : []) {
        const addressKey = exchangeAddressKey(label?.chain, label?.address);
        if (!addressKey || label?.category !== "EXCHANGE" || !cleanText(label?.name, 120)) continue;
        const sourceUrl = cleanText(label?.source_url, 1200);
        const sourceTitle = cleanText(label?.source_title, 240);
        const sourceType = cleanText(label?.source_type, 60);
        if (!sourceUrl && !sourceTitle && !sourceType) continue;
        if (body.skip_existing === true && await this.state.storage.get(`crypto-exchange-label:${addressKey}`)) {
          skippedCount++;
          continue;
        }
        writes[`crypto-exchange-label:${addressKey}`] = {
          ...label,
          address: addressKey.slice(addressKey.indexOf(":") + 1),
          category: "EXCHANGE",
          status: "APPROVED",
          reviewed_by: importedBy,
          reviewed_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString()
        };
        importedCount++;
        const proposalKey = `crypto-exchange-proposal:${addressKey}`;
        const pending = await this.state.storage.get(proposalKey);
        if (pending?.status === "PENDING") {
          writes[proposalKey] = {
            ...pending,
            status: "APPROVED",
            reviewed_by: importedBy,
            reviewed_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
            resolved_by_import: true
          };
        }
      }
      if (Object.keys(writes).length) await this.state.storage.put(writes);
      return Response.json({ ok: true, imported: importedCount, skipped: skippedCount });
    }

    if (url.pathname === "/crypto-exchange-proposals-migrate") {
      let startAfter = "";
      let reviewed = 0;
      let skipped = 0;
      for (let page = 0; page < 100; page++) {
        const options = { prefix: "crypto-workspace:", limit: 250 };
        if (startAfter) options.startAfter = startAfter;
        const batch = await this.state.storage.list(options);
        if (!batch?.size) break;
        for (const [key, workspace] of batch.entries()) {
          const username = normalizeUsername(workspace?.username || key.slice("crypto-workspace:".length));
          if (!isAllowedUser(username, this.env)) continue;
          for (const label of Array.isArray(workspace?.labels) ? workspace.labels : []) {
            if (String(label?.category || "").toUpperCase() !== "EXCHANGE") continue;
            const addressKey = exchangeAddressKey(label?.chain, label?.address);
            if (!addressKey || !cleanText(label?.name, 120)) { skipped++; continue; }
            const proposalKey = `crypto-exchange-proposal:${addressKey}`;
            const [approved, pending] = await Promise.all([
              this.state.storage.get(`crypto-exchange-label:${addressKey}`),
              this.state.storage.get(proposalKey)
            ]);
            if (approved || pending?.status === "PENDING") { skipped++; continue; }
            const sourceTitle = cleanText(label?.source_title, 240);
            const sourceType = cleanText(label?.source_type, 60);
            const sourceUrl = cleanText(label?.source_url, 1200);
            if (!sourceTitle && !sourceType && !/^https:\/\//i.test(sourceUrl)) { skipped++; continue; }
            await this.state.storage.put(proposalKey, {
              ...label,
              id: crypto.randomUUID(),
              address: addressKey.slice(addressKey.indexOf(":") + 1),
              category: "EXCHANGE",
              status: "PENDING",
              created_by: username,
              created_at: new Date(now).toISOString(),
              updated_at: new Date(now).toISOString(),
              reviewed_by: "",
              reviewed_at: "",
              migration_source: "private-workspace"
            });
            reviewed++;
          }
        }
        const keys = Array.from(batch.keys());
        const lastKey = keys[keys.length - 1];
        if (batch.size < 250 || !lastKey || lastKey === startAfter) break;
        startAfter = lastKey;
      }
      return Response.json({ ok: true, proposals_added: reviewed, skipped });
    }

    if (url.pathname === "/crypto-workspace-get") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      const key = `crypto-workspace:${username}`;
      const workspace = (await this.state.storage.get(key)) || {
        version: "crypto-workspace-v1",
        username,
        labels: [],
        watchlist: [],
        cases: [],
        alerts: [],
        updated_at: new Date(now).toISOString()
      };
      return Response.json({ ok: true, workspace });
    }

    if (url.pathname === "/crypto-workspace-put") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      const workspace = body.workspace && typeof body.workspace === "object" ? body.workspace : null;
      if (!workspace) {
        return Response.json({ error: "Missing crypto workspace." }, { status: 400 });
      }
      const key = `crypto-workspace:${username}`;
      await this.state.storage.put(key, {
        ...workspace,
        username,
        updated_at: new Date(now).toISOString()
      });
      return Response.json({ ok: true, workspace: { ...workspace, username, updated_at: new Date(now).toISOString() } });
    }

    if (url.pathname === "/cache-get") {
      const entry = await this.state.storage.get("cache:" + body.cacheKey);

      if (!entry || entry.expires_at < now) {
        if (entry) {
          await this.state.storage.delete("cache:" + body.cacheKey);
        }
        return Response.json({ hit: false });
      }

      return Response.json({
        hit: true,
        report: entry.report
      });
    }

    if (url.pathname === "/cache-put") {
      const expiresAt = Number(body.expires_at || 0);
      await this.state.storage.put("cache:" + body.cacheKey, {
        report: body.report,
        expires_at: expiresAt
      });
      await this.scheduleExpiry(expiresAt);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/commit-report") {
      const permitId = String(body.permitId || "");
      const username = normalizeUsername(body.username);
      const active = (await this.state.storage.get("active")) || {};
      const permit = active[permitId];

      if (!permit || normalizeUsername(permit.user_id) !== username) {
        return Response.json({
          error: "Report permit expired before completion."
        }, { status: 409 });
      }

      if (permit.counted === true) {
        return Response.json({ ok: true, already_counted: true });
      }

      const dayBucket = parisDayKey(now);
      const globalDayKey = `global-day:${dayBucket}`;
      const globalDay = Number((await this.state.storage.get(globalDayKey)) || 0);
      const writes = {
        [globalDayKey]: globalDay + 1
      };

      let dailyUsed = null;
      if (username !== "admin") {
        const userDayKey = `report-day:${dayBucket}:${username}`;
        const userDay = Number((await this.state.storage.get(userDayKey)) || 0);
        dailyUsed = userDay + 1;
        writes[userDayKey] = dailyUsed;
        writes[`report-last:${username}`] = now;
      }

      permit.counted = true;
      permit.completed_at = now;
      active[permitId] = permit;
      writes.active = active;

      await this.state.storage.put(writes);

      return Response.json({
        ok: true,
        daily_used: dailyUsed,
        daily_limit: username === "admin" ? null : 5
      });
    }

    if (url.pathname === "/release") {
      const active = (await this.state.storage.get("active")) || {};

      if (body.permitId && active[body.permitId]) {
        delete active[body.permitId];
        await this.state.storage.put("active", active);
      }

      return Response.json({ ok: true });
    }

    if (url.pathname === "/session-create") {
      const username = normalizeUsername(body.username);

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      const ttl = Math.min(
        SESSION_TTL_MS,
        Math.max(5 * 60 * 1000, Number(body.ttl_ms || SESSION_TTL_MS))
      );

      const sessionToken =
        crypto.randomUUID() +
        crypto.randomUUID().replace(/-/g, "");

      const expiresAt = now + ttl;

      await this.state.storage.put(`session:${sessionToken}`, {
        username,
        created_at: new Date(now).toISOString(),
        expires_at: expiresAt
      });
      await this.scheduleExpiry(expiresAt);

      return Response.json({
        session_token: sessionToken,
        username,
        expires_at: new Date(expiresAt).toISOString()
      });
    }

    if (url.pathname === "/session-get") {
      const token = String(body.session_token || "");

      if (!token) {
        return Response.json({ error: "Missing session." }, { status: 401 });
      }

      const key = `session:${token}`;
      const session = await this.state.storage.get(key);

      if (!session || Number(session.expires_at || 0) <= now) {
        if (session) await this.state.storage.delete(key);
        return Response.json({ error: "Session expired." }, { status: 401 });
      }

      return Response.json({
        ok: true,
        username: normalizeUsername(session.username),
        expires_at: new Date(Number(session.expires_at)).toISOString()
      });
    }

    if (url.pathname === "/session-revoke") {
      const token = cleanText(body.session_token, 160);
      if (token) await this.state.storage.delete("session:" + token);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/login-record") {
      const username = normalizeUsername(body.username);

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      const logs = (await this.state.storage.get("login-logs")) || [];
      logs.unshift({
        username,
        server_time: new Date(now).toISOString(),
        client_time: String(body.client_time || ""),
        user_agent: String(body.user_agent || "").slice(0, 320),
        country: String(body.country || "").slice(0, 16),
        ip_hash: String(body.ip_hash || "").slice(0, 64)
      });

      await this.state.storage.put("login-logs", logs.slice(0, 500));

      const counts = (await this.state.storage.get("login-counts")) || {};
      counts[username] = Number(counts[username] || 0) + 1;
      await this.state.storage.put("login-counts", counts);

      await this.incrementUsage(username, { logins: 1 }, now);

      return Response.json({ ok: true });
    }

    if (url.pathname === "/login-stats") {
      const logs = (await this.state.storage.get("login-logs")) || [];
      const counts = (await this.state.storage.get("login-counts")) || {};

      return Response.json({
        counts,
        recent_logins: logs.slice(0, 100)
      });
    }

    if (url.pathname === "/usage-record") {
      const username = normalizeUsername(body.username);
      const action = String(body.action || "");

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      if (action === "tab_access") {
        const recorded = await this.recordTabAccess(username, body.tab, now);
        if (!recorded) return Response.json({ error: "Unsupported workspace tab." }, { status: 400 });
      } else if (action === "map_search") {
        await this.incrementUsage(username, {
          searches: 1,
          map_searches: 1
        }, now);
      } else if (action === "event_list_search") {
        await this.incrementUsage(username, {
          searches: 1,
          event_list_searches: 1
        }, now, body.details ? this.usageLogEntry(username, "event_list", body.details, now) : null);
      } else if (action === "facial_search") {
        await this.incrementUsage(username, { facial_searches: 1 }, now,
          body.details ? this.usageLogEntry(username, "facial_search", body.details, now) : null);
      } else if (action === "darkweb_search") {
        await this.incrementUsage(username, { darkweb_searches: 1 }, now,
          this.usageLogEntry(username, "darkweb_search", body.details, now));
      } else {
        return Response.json({ error: "Unsupported action." }, { status: 400 });
      }

      return Response.json({ ok: true });
    }

    if (url.pathname === "/quiz-history") {
      const username = normalizeUsername(body.username);
      if (username !== "admin") {
        return Response.json({ error: "Admin access required." }, { status: 403 });
      }
      const period = String(body.period || "today");
      if (!["today", "7", "30", "all"].includes(period)) {
        return Response.json({ error: "Unsupported history period." }, { status: 400 });
      }
      return Response.json(await this.quizHistory(period));
    }

    if (url.pathname === "/quiz-answer-record") {
      const username = normalizeUsername(body.username);
      const quizDate = String(body.quiz_date || "");
      const correct = body.correct === true;

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(quizDate)) {
        return Response.json({ error: "Invalid quiz date." }, { status: 400 });
      }

      const answerKey = `quiz-answer:${quizDate}:${username}`;
      return this.state.storage.transaction(async txn => {
      const existing = await txn.get(answerKey);
      if (existing) {
        return Response.json({ ok: true, already_recorded: true, ...existing });
      }

      const quizOptions = Array.isArray(body.options)
        ? body.options.map(item => cleanText(item, 160)).slice(0, 3)
        : [];

      const answer = {
        username,
        quiz_date: quizDate,
        correct,
        selected_index: body.selected_index,
        quiz_id: body.quiz_id,
        correct_index: body.correct_index,
        category: cleanText(body.category, 120),
        question: cleanText(body.question, 500),
        options: quizOptions,
        selected_answer: Number.isInteger(body.selected_index)
          ? cleanText(quizOptions[body.selected_index], 160)
          : "",
        correct_answer: Number.isInteger(body.correct_index)
          ? cleanText(quizOptions[body.correct_index], 160)
          : "",
        source_checked_at: cleanText(body.source_checked_at, 64),
        explanation: cleanText(body.explanation, 700),
        source_url: /^https:\/\//i.test(String(body.source_url || ""))
          ? cleanText(body.source_url, 1200)
          : "",
        answered_at: new Date(now).toISOString()
      };
      for (const key of [`usage-total:${username}`, `usage-day:${parisDayKey(now)}:${username}`]) {
        const row = {...usageTemplate(username), ...await txn.get(key)};
        row.quiz_answers = Number(row.quiz_answers || 0) + 1;
        row.quiz_correct = Number(row.quiz_correct || 0) + (correct ? 1 : 0);
        row.quiz_incorrect = Number(row.quiz_incorrect || 0) + (correct ? 0 : 1);
        row.last_activity = answer.answered_at;
        await txn.put(key, row);
      }
      await txn.put(answerKey, answer);
      return Response.json({ ok: true, already_recorded: false, ...answer });
      });
    }

    if (url.pathname === "/quiz-state") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.quiz_date || ""))) {
        return Response.json({error: "Invalid quiz state request."}, {status: 400});
      }
      const answer = await this.state.storage.get(`quiz-answer:${body.quiz_date}:${username}`);
      return Response.json({ok: true, answered: Boolean(answer), answer: answer || null});
    }

    if (url.pathname === "/usage-increment") {
      const username = normalizeUsername(body.username);

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      // Worker modules may attach the request behind the counter (log) and the
      // outcome of an earlier logged request (log_update).
      const feature = String(body.log?.feature || "");
      const log = feature && !feature.startsWith("tab_") ? this.usageLogEntry(username, feature, body.log.details, now) : null;
      await this.incrementUsage(username, body.metrics || {}, now, log);
      if (body.log_update) await this.updateUsageLog(username, body.log_update);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/usage-log-update") {
      const username = normalizeUsername(body.username);
      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      return Response.json({ ok: true, updated: await this.updateUsageLog(username, body.log_update) });
    }

    if (url.pathname === "/usage-history") {
      if (normalizeUsername(body.username) !== "admin") {
        return Response.json({ error: "Admin access required." }, { status: 403 });
      }
      const period = String(body.period || "today");
      if (!["today", "7", "30", "all"].includes(period)) {
        return Response.json({ error: "Unsupported history period." }, { status: 400 });
      }
      const metric = String(body.metric || "");
      if (!Object.hasOwn(USAGE_HISTORY_METRICS, metric)) {
        return Response.json({ error: "Unsupported history metric." }, { status: 400 });
      }
      const target = normalizeUsername(body.target_username);
      if (!isAllowedUser(target, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }
      return Response.json(await this.usageHistory(target, metric, period, now));
    }

    if (url.pathname === "/tab-access-stats") {
      const username = normalizeUsername(body.username);
      if (username !== "admin") return Response.json({ error: "Admin access required." }, { status: 403 });
      const period = String(body.period || "today");
      if (!["today", "7", "30", "all"].includes(period)) return Response.json({ error: "Unsupported statistics period." }, { status: 400 });
      return Response.json(await this.tabAccessStats(period, now));
    }

    if (url.pathname === "/usage-stats") {
      const period = String(body.period || "today");

      if (!["today", "7", "30", "all"].includes(period)) {
        return Response.json({ error: "Unsupported period." }, { status: 400 });
      }

      return Response.json(await this.usageStats(period));
    }


    if (url.pathname === "/quota-commit" || url.pathname === "/quota-release") {
      const username = normalizeUsername(body.username);
      const reservationId = cleanText(body.reservation_id, 100);
      const kind = cleanText(body.kind, 40);
      const metricByKind = {
        quick_ask: "quick_ask_requests",
        feedback: "feedback_submissions"
      };
      const metric = metricByKind[kind];
      const reservationKey = `quota-reservation:${reservationId}`;
      const reservation = reservationId ? await this.state.storage.get(reservationKey) : null;

      if (!metric || !reservation || reservation.username !== username || reservation.kind !== kind) {
        return Response.json({ error: "Invalid or expired quota reservation." }, { status: 409 });
      }

      if (url.pathname === "/quota-release") {
        const restore = reservation.restore || {};
        if (Object.keys(restore).length) await this.state.storage.put(restore);
        await this.state.storage.delete(reservationKey);
        return Response.json({ ok: true, released: true });
      }

      await this.incrementUsage(username, { [metric]: 1 }, now);
      await this.state.storage.delete(reservationKey);
      return Response.json({ ok: true, committed: true });
    }

    if (url.pathname === "/quick-ask-acquire") {
      const username = normalizeUsername(body.username);
      const reservationId = crypto.randomUUID();

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      const restore = {};
      if (username !== "admin") {
        const dayBucket = parisDayKey(now);
        const lastKey = `quick-ask-last:${username}`;
        const userDayKey = `quick-ask-day:${dayBucket}:${username}`;
        const globalDayKey = `quick-ask-global-day:${dayBucket}`;
        const [last, userDay, globalDay] = await Promise.all([
          this.state.storage.get(lastKey),
          this.state.storage.get(userDayKey),
          this.state.storage.get(globalDayKey)
        ]);
        const lastValue = Number(last || 0);
        const userDayValue = Number(userDay || 0);
        const globalDayValue = Number(globalDay || 0);
        const elapsed = now - lastValue;

        if (lastValue && elapsed < QUICK_ASK_COOLDOWN_MS) {
          return Response.json({
            error: "Please wait a few seconds between quick questions.",
            retry_after_seconds: Math.ceil((QUICK_ASK_COOLDOWN_MS - elapsed) / 1000)
          }, { status: 429 });
        }
        if (userDayValue >= QUICK_ASK_DAILY_LIMIT) {
          return Response.json({
            error: `Temporary test-phase limit: maximum ${QUICK_ASK_DAILY_LIMIT} quick questions per user per day. Admin is exempt.`,
            daily_limit: QUICK_ASK_DAILY_LIMIT
          }, { status: 429 });
        }
        if (globalDayValue >= QUICK_ASK_GLOBAL_DAILY_LIMIT) {
          return Response.json({
            error: "Daily quick-question limit reached for all users.",
            retry_after_seconds: 3600
          }, { status: 429 });
        }

        restore[lastKey] = lastValue;
        restore[userDayKey] = userDayValue;
        restore[globalDayKey] = globalDayValue;
        await this.state.storage.put({
          [lastKey]: now,
          [userDayKey]: userDayValue + 1,
          [globalDayKey]: globalDayValue + 1
        });
      }

      await this.state.storage.put(`quota-reservation:${reservationId}`, {
        kind: "quick_ask",
        username,
        created_at: now,
        restore
      });
      return Response.json({ ok: true, reservation_id: reservationId });
    }

    if (url.pathname === "/feedback-acquire") {
      const username = normalizeUsername(body.username);
      const reservationId = crypto.randomUUID();

      if (!isAllowedUser(username, this.env)) {
        return Response.json({ error: "Unknown user." }, { status: 400 });
      }

      const restore = {};
      if (username !== "admin") {
        const dayBucket = parisDayKey(now);
        const lastKey = `feedback-last:${username}`;
        const userDayKey = `feedback-day:${dayBucket}:${username}`;
        const globalDayKey = `feedback-global-day:${dayBucket}`;
        const [last, userDay, globalDay] = await Promise.all([
          this.state.storage.get(lastKey),
          this.state.storage.get(userDayKey),
          this.state.storage.get(globalDayKey)
        ]);
        const lastValue = Number(last || 0);
        const userDayValue = Number(userDay || 0);
        const globalDayValue = Number(globalDay || 0);
        const elapsed = now - lastValue;

        if (lastValue && elapsed < FEEDBACK_COOLDOWN_MS) {
          return Response.json({
            error: "Please wait a moment before sending more feedback.",
            retry_after_seconds: Math.ceil((FEEDBACK_COOLDOWN_MS - elapsed) / 1000)
          }, { status: 429 });
        }
        if (userDayValue >= FEEDBACK_DAILY_LIMIT) {
          return Response.json({
            error: `Maximum ${FEEDBACK_DAILY_LIMIT} feedback submissions per user per day. Admin is exempt.`,
            daily_limit: FEEDBACK_DAILY_LIMIT
          }, { status: 429 });
        }
        if (globalDayValue >= FEEDBACK_GLOBAL_DAILY_LIMIT) {
          return Response.json({
            error: "Daily feedback limit reached for all users.",
            retry_after_seconds: 3600
          }, { status: 429 });
        }

        restore[lastKey] = lastValue;
        restore[userDayKey] = userDayValue;
        restore[globalDayKey] = globalDayValue;
        await this.state.storage.put({
          [lastKey]: now,
          [userDayKey]: userDayValue + 1,
          [globalDayKey]: globalDayValue + 1
        });
      }

      await this.state.storage.put(`quota-reservation:${reservationId}`, {
        kind: "feedback",
        username,
        created_at: now,
        restore
      });
      return Response.json({ ok: true, reservation_id: reservationId });
    }

    if (url.pathname !== "/acquire") {
      return new Response("Not found", { status: 404 });
    }

    const username = normalizeUsername(body.username);
    // Both Report Generator and Deep Search use this shared gate. The kind
    // selects the dedicated usage counter while report_requests remains the
    // backwards-compatible aggregate total.
    const requestKind = cleanText(body.kind, 40) === "deep_search"
      ? "deep_search"
      : "report_generator";
    const requestMetric = requestKind === "deep_search"
      ? "deep_search_requests"
      : "report_generator_requests";

    if (!isAllowedUser(username, this.env)) {
      return Response.json({ error: "Unknown user." }, { status: 400 });
    }

    const active = (await this.state.storage.get("active")) || {};

    // Remove stale generation permits after three minutes.
    for (const [id, item] of Object.entries(active)) {
      if (!item?.started_at || now - item.started_at > 180000) {
        delete active[id];
      }
    }

    if (Object.keys(active).length >= 4) {
      await this.state.storage.put("active", active);
      return Response.json({
        error: "Four reports are already being generated. Please retry shortly.",
        retry_after_seconds: 20
      }, { status: 429 });
    }

    if (Object.values(active).some(item => item.user_id === username)) {
      await this.state.storage.put("active", active);
      return Response.json({
        error: "You already have one report being generated.",
        retry_after_seconds: 15
      }, { status: 429 });
    }

    const dayBucket = parisDayKey(now);
    const globalDayKey = `global-day:${dayBucket}`;
    const globalDay = Number(
      (await this.state.storage.get(globalDayKey)) || 0
    );

    let userDay = 0;

    if (username !== "admin") {
      const userDayKey = `report-day:${dayBucket}:${username}`;
      userDay = Number(
        (await this.state.storage.get(userDayKey)) || 0
      );

      if (userDay >= 5) {
        await this.incrementUsage(username, {
          blocked_report_requests: 1
        }, now);

        return Response.json({
          error: "Temporary test-phase limit: maximum 5 reports per user per day. Admin is exempt.",
          limit_type: "daily",
          daily_limit: 5
        }, { status: 429 });
      }

      const lastKey = `report-last:${username}`;
      const last = Number((await this.state.storage.get(lastKey)) || 0);
      const elapsed = now - last;

      if (last && elapsed < REPORT_COOLDOWN_MS) {
        const remaining = Math.ceil(
          (REPORT_COOLDOWN_MS - elapsed) / 1000
        );

        await this.incrementUsage(username, {
          blocked_report_requests: 1
        }, now);

        return Response.json({
          error: "Temporary test-phase limit: one report every 20 minutes per user, maximum 5 reports per day. Admin is exempt.",
          limit_type: "cooldown",
          retry_after_seconds: remaining,
          daily_limit: 5
        }, { status: 429 });
      }
    }

    if (globalDay + Object.keys(active).length >= 100) {
      return Response.json({
        error: "Daily report generation limit reached (100/day).",
        retry_after_seconds: 3600
      }, { status: 429 });
    }

    const permitId = crypto.randomUUID();
    active[permitId] = {
      user_id: username,
      started_at: now,
      counted: false
    };

    await this.state.storage.put("active", active);

    const log = this.usageLogEntry(username, requestKind, body.details, now);
    await this.incrementUsage(username, {
      report_requests: 1,
      [requestMetric]: 1
    }, now, log);

    return Response.json({
      permit_id: permitId,
      log_id: log?.key || ""
    });
  }
}
