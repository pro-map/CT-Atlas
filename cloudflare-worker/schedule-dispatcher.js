// Starts CT Atlas's timed workflows on time through the GitHub API. GitHub's own
// `schedule` trigger starts them 3-10 hours late; Cloudflare's cron does not.
//
// Inert unless BOTH are present: the secret GITHUB_DISPATCH_TOKEN (a fine-grained
// token limited to Actions: read and write on this repository) and the variable
// SCHEDULE_DISPATCH_ENABLED="true". The variable stays "false" for as long as the
// workflows keep their own `schedule:` triggers, because with both every slot would
// run twice; adding the token early therefore changes nothing. Stateless: GitHub's
// run list is the record of what has started, read before each dispatch.
const GITHUB_REPOSITORY = "pro-map/CT-Atlas";
const SCHEDULE_TIME_ZONE = "Europe/Paris";
// Cloudflare cron is UTC only, so the Worker wakes every ten minutes on the slots'
// own minute and compares Paris wall-clock time: that follows daylight saving and
// gives each slot three attempts.
const DISPATCH_CRON = "7,17,27,37,47,57 * * * *";
const DISPATCH_WINDOW_MINUTES = 29;
const REQUEST_TIMEOUT_MS = 10000;
const SCHEDULE_SLOTS = Object.freeze([
  { workflow: "consolidate-incidents.yml", hour: 7, minute: 37 },
  { workflow: "update-map.yml", hour: 10, minute: 17, inputs: { mode: "daily" } },
  { workflow: "daily-radnuc-background.yml", hour: 10, minute: 27 },
  { workflow: "update-map.yml", hour: 18, minute: 17, inputs: { mode: "daily" } },
  { workflow: "daily-radnuc-background.yml", hour: 18, minute: 27 },
  { workflow: "sync-background-corpus.yml", hour: 20, minute: 47 }
]);

const slotExpression = slot => `${slot.minute} ${slot.hour} * * *`;
// The run list does not expose a dispatch's inputs; a workflow's run-name does.
const slotTitle = slot => `Slot ${slotExpression(slot)}`;

// Built on first use: this module loads on every cold start of a Worker that mostly
// answers requests, and an inert dispatcher never needs it.
let parisClock;

function parisMinuteOfDay(ms) {
  parisClock ||= new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHEDULE_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const parts = Object.fromEntries(parisClock.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function dueSlots(ms) {
  const now = parisMinuteOfDay(ms);
  const minuteStart = Math.floor(ms / 60000) * 60000;
  return SCHEDULE_SLOTS.flatMap(slot => {
    const elapsed = now - (slot.hour * 60 + slot.minute);
    if (elapsed < 0 || elapsed > DISPATCH_WINDOW_MINUTES) return [];
    return [{ ...slot, startedAt: minuteStart - elapsed * 60000 }];
  });
}

async function slotAlreadyStarted(slot, headers, fetcher) {
  const since = new Date(slot.startedAt).toISOString().replace(".000Z", "Z");
  const query = new URLSearchParams({ event: "workflow_dispatch", per_page: "100", created: `>=${since}` });
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${slot.workflow}/runs?${query}`;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`run list answered ${response.status}`);
  const payload = await response.json();
  return (payload.workflow_runs || []).some(run => run.display_title === slotTitle(slot) && run.conclusion !== "cancelled");
}

async function dispatchSlot(slot, headers, fetcher) {
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${slot.workflow}/dispatches`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { ...slot.inputs, slot: slotExpression(slot) } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`dispatch answered ${response.status}`);
}

// Never logs the token, and a GitHub failure is retried on the next tick.
async function runScheduleDispatcher(env, scheduledTime, fetcher = fetch) {
  const token = String(env?.GITHUB_DISPATCH_TOKEN || "").trim();
  if (!token || env?.SCHEDULE_DISPATCH_ENABLED !== "true") return [];
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "CT-Atlas-Schedule-Dispatcher/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const results = [];
  for (const slot of dueSlots(scheduledTime)) {
    const name = `${slot.workflow} ${slotExpression(slot)}`;
    try {
      if (await slotAlreadyStarted(slot, headers, fetcher)) {
        results.push({ slot: name, outcome: "already_started" });
        continue;
      }
      await dispatchSlot(slot, headers, fetcher);
      results.push({ slot: name, outcome: "dispatched" });
      console.log(`Schedule dispatcher started ${name}`);
    } catch (error) {
      results.push({ slot: name, outcome: "failed" });
      console.error(`Schedule dispatcher could not start ${name}: ${error?.message}`);
    }
  }
  return results;
}

export { DISPATCH_CRON, SCHEDULE_SLOTS, dueSlots, parisMinuteOfDay, runScheduleDispatcher, slotExpression, slotTitle };
