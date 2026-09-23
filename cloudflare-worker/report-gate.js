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
  "group-p-1":"Dritan",
  "group-p-2":"Allyson",
  "group-p-3":"Roberto",
  "group-p-4":"Daniele",
  "group-p-5":"Simon",
  "group-p-6":"Zaydoun",
  "group-p-7":"Saleh",
  "group-p-8":"Lasha",
  "group-p-9":"Saad",
  "group-p-10":"Alexandre",
  "group-s-1":"Maddy",
  "group-s-3":"Andreas",
  "group-s-5":"Liman",
  "group-s-6":"Juan",
  "group-s-7":"Thierry"
});

function withAdminDisplayName(row){
  const displayName=ADMIN_DISPLAY_NAMES[normalizeUsername(row?.username)]||"";
  return displayName?{...row,display_name:displayName}:row;
}
export class ReportGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async incrementUsage(username, metrics = {}, now = Date.now()) {
    username = normalizeUsername(username);
    if (!isAllowedUser(username, this.env)) return null;

    const totalKey = `usage-total:${username}`;
    const dayKey = `usage-day:${parisDayKey(now)}:${username}`;

    const [currentTotal, currentDay] = await Promise.all([
      this.state.storage.get(totalKey),
      this.state.storage.get(dayKey)
    ]);

    const total = {
      ...usageTemplate(username),
      ...(currentTotal || {})
    };
    const day = {
      ...usageTemplate(username),
      ...(currentDay || {})
    };

    for (const [metric, raw] of Object.entries(metrics || {})) {
      const value = Number(raw || 0);
      if (
        !Number.isFinite(value) ||
        value === 0 ||
        !(metric in total) ||
        metric === "username" ||
        metric === "last_activity"
      ) continue;

      total[metric] = Number(total[metric] || 0) + value;
      day[metric] = Number(day[metric] || 0) + value;
    }

    const iso = new Date(now).toISOString();
    total.last_activity = iso;
    day.last_activity = iso;

    await this.state.storage.put({
      [totalKey]: total,
      [dayKey]: day
    });

    return total;
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

    const summary = {
      active_users: rows.filter(row =>
        ["logins", "searches", "report_requests", "report_generator_requests", "deep_search_requests", "reports_generated", "cached_reports", "quick_ask_requests", "feedback_submissions", "quiz_answers"]
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
      await this.state.storage.put("cache:" + body.cacheKey, {
        report: body.report,
        expires_at: body.expires_at
      });
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

      if (action === "map_search") {
        await this.incrementUsage(username, {
          searches: 1,
          map_searches: 1
        }, now);
      } else if (action === "event_list_search") {
        await this.incrementUsage(username, {
          searches: 1,
          event_list_searches: 1
        }, now);
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

      await this.incrementUsage(username, body.metrics || {}, now);
      return Response.json({ ok: true });
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

    await this.incrementUsage(username, {
      report_requests: 1,
      [requestMetric]: 1
    }, now);

    return Response.json({
      permit_id: permitId
    });
  }
}
