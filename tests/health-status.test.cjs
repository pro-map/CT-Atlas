const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const stripModuleSyntax=file=>fs.readFileSync(file,"utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");
const sources=["address-utils","sanctions","health-status"].map(name=>stripModuleSyntax("cloudflare-worker/"+name+".js"));

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}
function jsonResponse(body,status){return {body,status};}

const SECRETS={etherscan:"ETHERSCAN-SECRET-KEY-123",tron:"TRONGRID-SECRET-KEY-456",agent:"AGENT-SHARED-SECRET-789",visual:"VISUAL-SHARED-SECRET-012",brave:"BRAVE-SECRET-345",gemini:"GEMINI-SECRET-678"};
const FULL_ENV={
  ETHERSCAN_API_KEY:SECRETS.etherscan,TRONGRID_API_KEY:SECRETS.tron,
  SOCMINT_AGENT_URL:"https://agent.example.run.app",SOCMINT_AGENT_SHARED_SECRET:SECRETS.agent,
  VISUAL_INTEL_URL:"https://visual.example.run.app",VISUAL_INTEL_SHARED_SECRET:SECRETS.visual,
  BRAVE_SEARCH_API_KEY:SECRETS.brave,GEMINI_API_KEY:SECRETS.gemini,
  SANCTIONS_URL:"https://example.test/sanctions-crypto.json"
};

const SANCTIONS_PAYLOAD={
  version:"sanctions-crypto-v1",retrieved_at:new Date().toISOString(),
  sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-09-23"}],
  entities:[{id:"1",name:"X",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],
  addresses:[{a:"TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz",c:"USDT",f:"tron",e:[0]}]
};

const ok=(body,kind="json")=>({ok:true,status:200,json:async()=>body,text:async()=>String(body)});

// Routes each dependency URL to a canned answer; `overrides` maps a URL fragment to a function.
function router(overrides={}){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    url=String(url);
    calls.push(url);
    for(const [fragment,handler] of Object.entries(overrides)){
      if(url.includes(fragment))return handler(url,init);
    }
    if(url.includes("blockstream.info"))return ok("850123");
    if(url.includes("etherscan.io"))return ok({status:"1",result:"0x1a2b3c"});
    if(url.includes("trongrid.io"))return ok({block_header:{raw_data:{number:70000001}}});
    if(url.includes("agent.example"))return ok({ok:true,version:"ct-atlas-socmint-adk-v1",model:"gemini-x",search_provider:"brave",
      social_sources:{telegram_channel_reader:true,reddit_oauth:false,search_provider:"brave",notes:"free text that must not be forwarded"}});
    if(url.includes("visual.example"))return ok({ok:true,version:"visual-intel-v1",face_detection:"opencv_haar",ocr:"tesseract",identity_recognition:false});
    if(url.includes("example.test/sanctions"))return ok(SANCTIONS_PAYLOAD);
    throw new Error("unexpected URL "+url);
  };
  return {fetchImpl,calls};
}

function harness(fetchImpl,extra={}){
  const context=vm.createContext({
    cleanText,jsonResponse,fetch:fetchImpl,AbortSignal,URL,URLSearchParams,console,...extra
  });
  for(const source of sources)vm.runInContext(source,context);
  return vm.runInContext("({handleHealthStatus,buildHealthStatus,resetHealthStatusCache,HEALTH_STATUS_VERSION})",context);
}

test("healthy dependencies are reported operational with versions, latency and boolean collector flags only",async()=>{
  const {fetchImpl}=router();
  const h=harness(fetchImpl);
  const {body,status}=await h.handleHealthStatus(FULL_ENV,{crypto:"crypto-v3",social:"socmint-v5"});
  assert.equal(status,200);
  assert.equal(body.ok,true);
  assert.equal(body.versions.crypto,"crypto-v3");
  const c=body.components;
  for(const name of ["worker","bitcoin","evm","tron","sanctions","agent","visual"])assert.equal(c[name].status,"operational",name);
  assert.equal(c.bitcoin.block_height,850123);
  assert.equal(c.evm.block_height,0x1a2b3c);
  assert.equal(c.tron.block_height,70000001);
  assert.equal(c.sanctions.address_count,1);
  assert.equal(c.agent.version,"ct-atlas-socmint-adk-v1");
  assert.deepEqual(JSON.parse(JSON.stringify(c.agent.collectors)),{telegram_channel_reader:true,reddit_oauth:false},"only boolean flags may be forwarded");
  assert.equal(c.visual.identity_recognition,false);
  assert.equal(typeof c.bitcoin.latency_ms,"number");
  // Credentials that are only present are 'configured', never 'operational' (not probed).
  assert.equal(c.brave.status,"configured");
  assert.equal(c.gemini.status,"configured");
});

test("the response never contains a key, secret or backend URL",async()=>{
  const {fetchImpl}=router();
  const h=harness(fetchImpl);
  const {body}=await h.handleHealthStatus(FULL_ENV);
  const text=JSON.stringify(body);
  for(const secret of Object.values(SECRETS))assert.ok(!text.includes(secret),"leaked "+secret);
  assert.ok(!text.includes("agent.example")&&!text.includes("visual.example"),"backend URLs must not be exposed");
});

test("unconfigured services are 'not_configured' (not down); Bitcoin is keyless and still probed",async()=>{
  const {fetchImpl,calls}=router();
  const h=harness(fetchImpl);
  const {body}=await h.handleHealthStatus({});
  const c=body.components;
  for(const name of ["evm","tron","agent","visual","brave","gemini"])assert.equal(c[name].status,"not_configured",name);
  assert.equal(c.bitcoin.status,"operational");
  assert.equal(c.sanctions.status,"down","no SANCTIONS_URL means the list cannot be loaded");
  assert.ok(!calls.some(url=>url.includes("etherscan")||url.includes("trongrid")||url.includes("agent.example")),"unconfigured services must not be called");
});

test("a failing dependency is 'down' with a short reason, and secrets are redacted from it",async()=>{
  const {fetchImpl}=router({
    "etherscan.io":async()=>{throw new Error("connect failed for apikey="+SECRETS.etherscan);},
    "trongrid.io":async()=>({ok:false,status:503,json:async()=>({})}),
    "agent.example":async()=>{const error=new Error("ignored");error.name="TimeoutError";throw error;}
  });
  const h=harness(fetchImpl);
  const {body}=await h.handleHealthStatus(FULL_ENV);
  const c=body.components;
  assert.equal(c.evm.status,"down");
  assert.ok(c.evm.error.includes("[redacted]"));
  assert.ok(!JSON.stringify(body).includes(SECRETS.etherscan));
  assert.equal(c.tron.status,"down");
  assert.equal(c.tron.error,"HTTP 503");
  assert.equal(c.agent.status,"down");
  assert.equal(c.agent.error,"Timed out after 25s","the agent gets the long Cloud Run timeout, and the message says how long");
  assert.equal(c.bitcoin.status,"operational","one failing dependency must not affect the others");
});

test("an unexpected or error-shaped payload counts as down, not operational",async()=>{
  const {fetchImpl}=router({
    "etherscan.io":async()=>ok({status:"0",message:"NOTOK",result:"Invalid API Key"}),
    "blockstream.info":async()=>ok("<html>captcha</html>"),
    "agent.example":async()=>ok({ok:false})
  });
  const h=harness(fetchImpl);
  const {body}=await h.handleHealthStatus(FULL_ENV);
  assert.equal(body.components.evm.status,"down");
  assert.match(body.components.evm.error,/Invalid API Key/);
  assert.equal(body.components.bitcoin.status,"down");
  assert.equal(body.components.agent.status,"down");
});

test("a slow dependency (e.g. a Cloud Run cold start) is 'degraded'",async()=>{
  let clock=1_000_000;
  class SlowDate extends Date{static now(){clock+=4000;return clock;}}
  const {fetchImpl}=router();
  const h=harness(fetchImpl,{Date:SlowDate});
  const {body}=await h.handleHealthStatus(FULL_ENV);
  assert.equal(body.components.agent.status,"degraded");
  assert.ok(body.components.agent.latency_ms>3500);
});

test("a stale sanctions list is 'degraded'; results are cached for 60s and then refreshed",async()=>{
  const old=new Date(Date.now()-9*24*3600*1000).toISOString();
  const {fetchImpl,calls}=router({"example.test/sanctions":async()=>ok({...SANCTIONS_PAYLOAD,retrieved_at:old})});
  const h=harness(fetchImpl);
  const t0=Date.now();
  const first=await h.handleHealthStatus(FULL_ENV,{},t0);
  assert.equal(first.body.components.sanctions.status,"degraded");
  assert.equal(first.body.cached,false);
  const bitcoinCalls=()=>calls.filter(url=>url.includes("blockstream")).length;
  assert.equal(bitcoinCalls(),1);

  const second=await h.handleHealthStatus(FULL_ENV,{},t0+30_000);
  assert.equal(second.body.cached,true);
  assert.equal(second.body.age_seconds,30);
  assert.equal(bitcoinCalls(),1,"a cached answer must not probe the providers again");

  const third=await h.handleHealthStatus(FULL_ENV,{},t0+61_000);
  assert.equal(third.body.cached,false);
  assert.equal(bitcoinCalls(),2);
});

test("worker wiring: /health/status is routed and the UI tabs load the shared health script",()=>{
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  assert.ok(index.includes('"/health/status"'));
  assert.ok(index.includes("handleHealthStatus"));
});

test("a Cloud Run cold start is reported as slow ('degraded' with a note), not as unavailable",async()=>{
  let clock=1_000_000;
  class SlowDate extends Date{static now(){clock+=4000;return clock;}}
  const {fetchImpl}=router();
  const h=harness(fetchImpl,{Date:SlowDate});
  const {body}=await h.handleHealthStatus(FULL_ENV);
  for(const name of ["agent","visual"]){
    assert.equal(body.components[name].status,"degraded",name);
    assert.match(body.components[name].note,/cold start/i,name);
    assert.equal(body.components[name].version.length>0,true,"a slow but successful probe must still carry its details");
  }
  assert.equal(body.components.bitcoin.note,undefined,"providers are not cold-start services");
});

test("Cloud Run services get a long timeout, ordinary providers keep the short one",async()=>{
  const timeouts=[];
  const spy={timeout:ms=>{timeouts.push(ms);return AbortSignal.timeout(ms);}};
  const {fetchImpl,calls}=router();
  const h=harness(fetchImpl,{AbortSignal:spy});
  await h.handleHealthStatus(FULL_ENV);
  assert.ok(timeouts.includes(25000),"agent/visual must allow a cold start");
  assert.ok(timeouts.includes(7000),"providers keep the short timeout");
  assert.equal(timeouts.filter(ms=>ms===25000).length,2,"exactly the two Cloud Run services");
  assert.ok(calls.some(url=>url.includes("agent.example"))&&calls.some(url=>url.includes("visual.example")));
});

test("a failure is cached for only 10s, so a service that just woke up is not shown as down for a minute",async()=>{
  let agentUp=false;
  const {fetchImpl}=router({
    "agent.example":async()=>{
      if(!agentUp){const error=new Error("x");error.name="TimeoutError";throw error;}
      return ok({ok:true,version:"v",model:"m",search_provider:"brave",social_sources:{}});
    }
  });
  const h=harness(fetchImpl);
  const t0=Date.now();
  const first=await h.handleHealthStatus(FULL_ENV,{},t0);
  assert.equal(first.body.components.agent.status,"down");
  agentUp=true;
  const within=await h.handleHealthStatus(FULL_ENV,{},t0+8_000);
  assert.equal(within.body.cached,true,"within 10s the failure is still cached");
  const after=await h.handleHealthStatus(FULL_ENV,{},t0+11_000);
  assert.equal(after.body.cached,false);
  assert.equal(after.body.components.agent.status,"operational");
});

test("a forced refresh bypasses the cache, but not more than once every 5s",async()=>{
  const {fetchImpl,calls}=router();
  const h=harness(fetchImpl);
  const t0=Date.now();
  await h.handleHealthStatus(FULL_ENV,{},t0);
  const bitcoin=()=>calls.filter(url=>url.includes("blockstream")).length;
  assert.equal(bitcoin(),1);
  const tooSoon=await h.handleHealthStatus(FULL_ENV,{},t0+2_000,{force:true});
  assert.equal(tooSoon.body.cached,true,"a spammed refresh must not hit the providers");
  assert.equal(bitcoin(),1);
  const allowed=await h.handleHealthStatus(FULL_ENV,{},t0+6_000,{force:true});
  assert.equal(allowed.body.cached,false);
  assert.equal(bitcoin(),2);
});

test("the panel's REFRESH asks for a fresh run and the browser waits long enough for a cold start",()=>{
  const js=fs.readFileSync("tab-health.js","utf8");
  assert.ok(js.includes('"?refresh=1"'));
  assert.match(js,/FETCH_TIMEOUT_MS=45000/);
  assert.ok(js.includes("component.note"),"the cold-start explanation must be shown");
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  assert.ok(index.includes('searchParams.get("refresh") === "1"'));
});
