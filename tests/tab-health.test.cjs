const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const read=file=>fs.readFileSync(file,"utf8");

test("Crypto, Social and Facial each load the shared health component with their own scope",()=>{
  for(const [page,scope] of [["crypto","crypto"],["social","social"],["facial","facial"]]){
    const html=read(page+".html");
    assert.ok(html.includes('href="tab-health.css'),page+" must load tab-health.css");
    assert.match(html,new RegExp('<script src="tab-health\\.js\\?v=\\d+" data-health-scope="'+scope+'"></script>'),page+" scope");
    // The component must load after the page's own script so it never delays start-up.
    assert.ok(html.indexOf("tab-health.js")>html.indexOf(page+".js"),page+": tab-health.js should come last");
  }
});

test("the health component reads the live status endpoint and covers every scope",()=>{
  const js=read("tab-health.js");
  assert.ok(js.includes('"/health/status"'));
  for(const scope of ["crypto","social","facial"])assert.match(js,new RegExp("\\n  "+scope+":\\{"),"missing scope "+scope);
  for(const key of ["bitcoin","evm","tron","sanctions","agent","visual"])assert.ok(js.includes('key:"'+key+'"'),"missing component "+key);
  // Honest wording: credentials that are not exercised must not read as healthy.
  assert.ok(js.includes("Configured · not probed"));
  assert.ok(js.includes("Status unavailable"));
  // Keyboard/outside-click dismissal and dialog semantics.
  assert.ok(js.includes('event.key==="Escape"'));
  assert.ok(js.includes('setAttribute("role","dialog")'));
  assert.ok(js.includes('setAttribute("aria-expanded"'));
});

test("the health component escapes everything it renders and never uses eval-like APIs",()=>{
  const js=read("tab-health.js");
  assert.ok(js.includes("const esc="));
  assert.ok(!/\beval\(|new Function\(|document\.write\(/.test(js));
  // Values that come from the API always pass through esc() before innerHTML.
  assert.ok(!/innerHTML\s*\+?=\s*[^;]*state\.data\./.test(js),"raw API data must not be concatenated into innerHTML");
});

test("the panel styles exist and keep the status colours distinct",()=>{
  const css=read("tab-health.css");
  for(const selector of [".th-button",".th-panel",".th-banner-operational",".th-banner-degraded",".th-banner-down",".th-operational",".th-down",".th-not_configured",".th-configured"]){
    assert.ok(css.includes(selector),"missing "+selector);
  }
});

test("the static mirror and the Pages workflow ship the health component",()=>{
  const mirror=read("tools/deploy_mirror.sh");
  assert.ok(mirror.includes("tab-health.js tab-health.css"));
  const ui=read(".github/workflows/deploy-current-ct-atlas-ui.yml");
  assert.ok(ui.includes('"tab-health.js"')&&ui.includes('"tab-health.css"'));
  const smoke=read(".github/workflows/live-smoke.yml");
  assert.ok(smoke.includes("/health/status"));
  assert.ok(smoke.includes('data-health-scope="facial"'));
});
