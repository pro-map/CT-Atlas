const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const html=fs.readFileSync("index.html","utf8");

function timeButtons(){
  return [...html.matchAll(/<button\s+class="time-button( active)?"\s+data-days="(\d+)"\s*>/g)]
    .map(match=>({days:Number(match[2]),active:Boolean(match[1])}));
}

test("the attacks map offers 24 hours (default) and 7 days, nothing else",()=>{
  const buttons=timeButtons();
  assert.deepEqual(buttons.map(button=>button.days),[1,7],"the map period buttons changed");
  const active=buttons.filter(button=>button.active);
  assert.equal(active.length,1,"exactly one period button must be active");
  assert.equal(active[0].days,1);
});

test("the initial selectedDays matches the active button, so the first render and the highlighted button agree",()=>{
  const match=html.match(/let selectedDays\s*=\s*(\d+);/);
  assert.ok(match,"selectedDays initialisation not found");
  const active=timeButtons().find(button=>button.active);
  assert.equal(Number(match[1]),active.days);
  assert.equal(Number(match[1]),1);
});

test("the fixed 30-day widgets (KPI, timeline, trends) are untouched by the map period; the timeline counts attacks",()=>{
  assert.ok(html.includes("Top trends — 30 days"));
  assert.ok(html.includes("Attacks over time · 30 days"));
  assert.ok(!html.includes("Events over time"));
  assert.ok(html.includes('id="kpi30"'));
  assert.match(html,/for\s*\(\s*let offset = 29;\s*offset >= 0;/);
});

test("the CI pins agree with the new default so the deploy and smoke checks do not fail on it",()=>{
  const ui=fs.readFileSync(".github/workflows/deploy-current-ct-atlas-ui.yml","utf8");
  const smoke=fs.readFileSync(".github/workflows/live-smoke.yml","utf8");
  assert.ok(ui.includes("grep -q 'data-days=\"7\"' index.html"));
  assert.ok(ui.includes("grep -q 'let selectedDays = 1;' index.html"));
  assert.ok(!ui.includes("grep -q '    7;' index.html"));
  assert.ok(!ui.includes("OUR OFFICES"),"the offices button no longer exists");
  assert.ok(smoke.includes("MAP default is not 24 hours"));
  assert.ok(html.includes("let selectedDays = 1;"),"the deploy grep needs this exact line");
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

test("heat zones and the offices layer are always on (no toggles), and a missing heat plugin cannot break the map",()=>{
  assert.match(html,/let showHeat\s*=\s*true;/);
  assert.ok(!html.includes('id="heatToggle"'),"the heat toggle was removed: heat is always on");
  assert.ok(!html.includes('id="officesToggle"'),"the offices toggle was removed: offices are always shown");
  assert.match(html,/let showInterpolOffices\s*=\s*true;/);
  // Both the render guard and the start-up fallback must tolerate the CDN plugin not loading.
  assert.match(html,/showHeat\s*&&\s*typeof L\.heatLayer === "function"/);
  assert.match(html,/typeof L\.heatLayer !== "function"[\s\S]{0,200}showHeat\s*=\s*false;/);
  const activeLayers=[...html.matchAll(/<button class="layer-button( active)?" id="(\w+)"/g)].filter(match=>match[1]).map(match=>match[2]);
  assert.ok(activeLayers.includes("markersToggle"));
});

test("the live smoke test waits for GitHub Pages to publish the new map before validating it",()=>{
  // Pages and the smoke test start at the same push. Without this wait the strict node checks
  // below could read the OLD index.html and fail a perfectly good deploy.
  const smoke=fs.readFileSync(".github/workflows/live-smoke.yml","utf8");
  const loop=smoke.slice(smoke.indexOf("for attempt in {1..18}"),smoke.indexOf("Updated PDF assets did not become available"));
  assert.match(loop,/time-button active.*data-days="1"/,"the retry loop must wait for the 24-hour default");
  assert.ok(loop.includes('id="attackTickerList"'),"the retry loop must wait for the attacks ticker");
});
