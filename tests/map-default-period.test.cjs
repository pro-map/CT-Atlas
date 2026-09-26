const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const html=fs.readFileSync("index.html","utf8");

function timeButtons(){
  return [...html.matchAll(/<button\s+class="time-button( active)?"\s+data-days="(\d+)"\s*>/g)]
    .map(match=>({days:Number(match[2]),active:Boolean(match[1])}));
}

test("the map opens on 7 days: exactly one active period button, and it is 7D",()=>{
  const buttons=timeButtons();
  assert.deepEqual(buttons.map(button=>button.days),[1,7,30,90,180],"the period buttons changed");
  const active=buttons.filter(button=>button.active);
  assert.equal(active.length,1,"exactly one period button must be active");
  assert.equal(active[0].days,7);
});

test("the initial selectedDays matches the active button, so the first render and the highlighted button agree",()=>{
  const match=html.match(/let selectedDays\s*=\s*(\d+);/);
  assert.ok(match,"selectedDays initialisation not found");
  const active=timeButtons().find(button=>button.active);
  assert.equal(Number(match[1]),active.days);
  assert.equal(Number(match[1]),7);
});

test("the fixed 30-day widgets (KPI, timeline, trends) are untouched by the default period",()=>{
  // These are deliberately independent of the period selector.
  assert.ok(html.includes("Top trends — 30 days"));
  assert.ok(html.includes("Events over time · 30 days"));
  assert.ok(html.includes('id="kpi30"'));
  assert.match(html,/for\s*\(\s*let offset = 29;\s*offset >= 0;/);
});

test("the CI pins agree with the new default so the deploy and smoke checks do not fail on it",()=>{
  const ui=fs.readFileSync(".github/workflows/deploy-current-ct-atlas-ui.yml","utf8");
  const smoke=fs.readFileSync(".github/workflows/live-smoke.yml","utf8");
  assert.ok(ui.includes("grep -q 'data-days=\"7\"' index.html"));
  assert.ok(ui.includes("grep -q '    7;' index.html"));
  assert.ok(!ui.includes("grep -q '    30;' index.html"));
  assert.ok(smoke.includes('MAP default is not 7 days'));
});

test("the 6-month rolling retention already exists: the collector prunes events older than RETENTION_DAYS at every save",()=>{
  const collector=fs.readFileSync("collector.py","utf8");
  assert.match(collector,/^RETENTION_DAYS = 180$/m);
  assert.match(collector,/def prune_old\(events\):[\s\S]{0,400}timedelta\(\s*days=RETENTION_DAYS/);
  assert.match(collector,/events = prune_old\(/);
  const runtime=JSON.parse(fs.readFileSync("ct-atlas-runtime.json","utf8"));
  assert.equal(runtime.retention_days,180);
  // The stored database must actually respect it (a stale file would show accumulation).
  const db=JSON.parse(fs.readFileSync("events.json","utf8"));
  const oldest=db.events.map(event=>Date.parse(event.published)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  const slackDays=3; // updates run twice a day; allow for a missed run or two
  assert.ok(Date.now()-oldest<=(180+slackDays)*86400000,"events.json holds data older than the retention window");
});
