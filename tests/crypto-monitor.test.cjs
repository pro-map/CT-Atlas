const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/crypto-monitor.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/shared\.js";\s*/,"")
  .replace(/^import[\s\S]*?from "\.\/crypto\.js";\s*/,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}
async function gateCall(){throw new Error("network not used");}
async function analyzeCryptoAddress(){throw new Error("network not used");}

function harness(){
  const context=vm.createContext({
    cleanText,gateCall,analyzeCryptoAddress,
    crypto:{randomUUID:()=> "uuid-monitor"},
    Date,Number,String,Array,Object,Set,Map,console
  });
  vm.runInContext(source,context);
  return vm.runInContext("({snapshotFromAnalysis,buildMonitorAlerts,CRYPTO_MONITOR_VERSION,MONITOR_BATCH_LIMIT})",context);
}

function tx(overrides={}){
  return {
    id:"tx1",time:"2026-09-23T10:00:00Z",direction:"OUT",asset:"USDT",amount:100,
    counterparties:["0x2222222222222222222222222222222222222222"],
    ...overrides
  };
}

test("monitor snapshot calculates recent count and aggregate value",()=>{
  const h=harness();
  const now=Date.parse("2026-09-23T12:00:00Z");
  const snap=h.snapshotFromAnalysis({transactions:[
    tx({id:"a",amount:100,time:"2026-09-23T11:00:00Z"}),
    tx({id:"b",amount:50,time:"2026-09-22T13:00:00Z"}),
    tx({id:"old",amount:1000,time:"2026-09-21T12:00:00Z"})
  ]},now);
  assert.equal(snap.tx_count,2);
  assert.equal(snap.aggregate_value,150);
  assert.equal(snap.newest_tx_id,"a");
});

test("scheduled monitor generates new transaction and large-transfer alerts",()=>{
  const h=harness();
  const now=Date.parse("2026-09-23T12:00:00Z");
  const target={
    watch:{
      id:"w1",chain:"ethereum",address:"0x1111111111111111111111111111111111111111",
      thresholds:{min_amount:500},
      last_snapshot:{newest_tx_id:"old",newest_tx_time:"2026-09-22T10:00:00Z"}
    },
    sensitive_labels:[]
  };
  const result=h.buildMonitorAlerts(target,{transactions:[
    tx({id:"new",amount:750,time:"2026-09-23T11:00:00Z"})
  ]},now);
  assert.ok(result.alerts.some(a=>a.type==="NEW_TRANSACTION"));
  assert.ok(result.alerts.some(a=>a.type==="LARGE_TRANSFER"));
});

test("scheduled monitor detects sourced direct watchlist exposure",()=>{
  const h=harness();
  const now=Date.parse("2026-09-23T12:00:00Z");
  const target={
    watch:{
      id:"w1",chain:"ethereum",address:"0x1111111111111111111111111111111111111111",
      thresholds:{},
      last_snapshot:{newest_tx_id:"old",newest_tx_time:"2026-09-22T10:00:00Z"}
    },
    sensitive_labels:[{
      address:"0x2222222222222222222222222222222222222222",
      name:"Sourced entity",category:"CT WATCHLIST",source_title:"Analyst source"
    }]
  };
  const result=h.buildMonitorAlerts(target,{transactions:[
    tx({id:"new",time:"2026-09-23T11:00:00Z"})
  ]},now);
  const exposure=result.alerts.find(a=>a.type==="WATCHLIST_EXPOSURE");
  assert.ok(exposure);
  assert.equal(exposure.severity,"HIGH");
  assert.match(exposure.detail,/Sourced entity/);
});

test("monitor batch stays capped for Cloudflare subrequest safety",()=>{
  const h=harness();
  assert.equal(h.MONITOR_BATCH_LIMIT,8);
  assert.equal(typeof h.CRYPTO_MONITOR_VERSION,"string");
  assert.ok(h.CRYPTO_MONITOR_VERSION.includes("scheduled"));
});
