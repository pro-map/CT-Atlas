const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const read=file=>fs.readFileSync(file,"utf8");

test("Crypto loads its health component after its own script",()=>{
  const html=read("crypto.html");
  assert.ok(html.includes('href="tab-health.css'),"crypto must load tab-health.css");
  assert.match(html,/<script src="tab-health\.js\?v=\d+" data-health-scope="crypto"><\/script>/);
  // The component must load after the page's own script so it never delays start-up.
  assert.ok(html.indexOf("tab-health.js")>html.indexOf("crypto.js"),"tab-health.js should come last");
});

test("the health component reads the live status endpoint and covers the Crypto tab only",()=>{
  const js=read("tab-health.js");
  assert.ok(js.includes('"/health/status"'));
  assert.match(js,/\n  crypto:\{/);
  assert.doesNotMatch(js,/\n  (?:social|facial):\{|COLLECTORS|agent_search/,"the retired scopes are gone");
  for(const key of ["bitcoin","evm","tron","sanctions"])assert.ok(js.includes('key:"'+key+'"'),"missing component "+key);
  // Honest wording: credentials that are not exercised must not read as healthy.
  assert.ok(js.includes("Configured · not probed"));
  assert.ok(js.includes("Status unavailable"));
  // Keyboard/outside-click dismissal and dialog semantics.
  assert.ok(js.includes('event.key==="Escape"'));
  assert.ok(js.includes('setAttribute("role","dialog")'));
  assert.ok(js.includes('setAttribute("aria-expanded"'));
});

test("the panel's details show the monitor's last run as /health/status summarises it",()=>{
  const js=read("tab-health.js");
  assert.ok(js.includes('["Last monitor run",data.monitor_run&&data.monitor_run.summary]'));
  assert.ok(js.includes("config.facts(versions,state.data)"));
  assert.match(read("crypto.html"),/<script src="tab-health\.js\?v=4" /,"a cached copy without the monitor verdict is replaced");
});

// The component on a minimal page, fed one /health/status answer: the colour its button takes.
async function verdict(data){
  const made=[];
  const element=()=>{
    const item={dataset:{},hidden:false,innerHTML:"",setAttribute(){},append(){},appendChild(){},addEventListener(){},
      contains:()=>false,querySelector:()=>element()};
    made.push(item);
    return item;
  };
  const timers=[];
  const document={readyState:"complete",currentScript:{dataset:{healthScope:"crypto"}},body:element(),
    createElement:element,querySelector:()=>null,addEventListener(){}};
  vm.runInContext(read("tab-health.js"),vm.createContext({
    document,AbortController,Date,
    setTimeout:callback=>timers.push(callback),clearTimeout(){},setInterval(){},clearInterval(){},
    fetch:async()=>({ok:true,json:async()=>data})
  }));
  await timers.shift()();
  return made.find(item=>item.id==="tabHealthButton").dataset.state;
}
const up={bitcoin:{status:"operational"},evm:{status:"operational"},tron:{status:"operational"},sanctions:{status:"operational"}};

test("a monitor run that failed, in full or in part, or is overdue turns the Health button to degraded",async()=>{
  assert.equal(await verdict({components:up,monitor_run:{status:"ok",stale:false}}),"operational");
  for(const run of [{status:"failed",stale:false},{status:"degraded",stale:false},{status:"ok",stale:true}]){
    assert.equal(await verdict({components:up,monitor_run:run}),"degraded",JSON.stringify(run));
  }
  for(const run of [{status:"running",stale:false},{status:"none"},{status:"unavailable"},undefined]){
    assert.equal(await verdict({components:up,monitor_run:run}),"operational","nothing known against it: "+JSON.stringify(run));
  }
  const allDown={...up,bitcoin:{status:"down"},evm:{status:"down"},tron:{status:"down"}};
  assert.equal(await verdict({components:allDown,monitor_run:{status:"failed"}}),"down","no provider is still an outage");
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
  assert.ok(smoke.includes('data-health-scope="crypto"'));
});
