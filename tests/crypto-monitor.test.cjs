const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/crypto-monitor.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
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
  return vm.runInContext("({snapshotFromAnalysis,buildMonitorAlerts,buildSanctionsAlerts,CRYPTO_MONITOR_VERSION,MONITOR_BATCH_LIMIT})",context);
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

const HIT={
  status:"ok",hit:true,
  seed_match:null,
  counterparty_matches:[{
    address:"0x2222222222222222222222222222222222222222",currency:"ETH",
    summary:"EXAMPLE FINANCIER [SDGT]",received_from_count:1,sent_to_count:0,tx_ids:["new","older"]
  }]
};

test("scheduled monitor alerts HIGH on direct sanctions exposure, once per transaction, and states the caveat",()=>{
  const h=harness();
  const now=Date.parse("2026-09-23T12:00:00Z");
  const target={watch:{id:"w1",chain:"ethereum",address:"0x1111111111111111111111111111111111111111",thresholds:{},last_snapshot:null},sensitive_labels:[]};
  const result=h.buildMonitorAlerts(target,{transactions:[tx({id:"new",time:"2026-09-23T11:00:00Z"})],sanctions_screening:HIT},now);
  const exposure=result.alerts.filter(a=>a.type==="SANCTIONS_EXPOSURE");
  assert.equal(exposure.length,2);
  assert.deepEqual(Array.from(exposure,a=>a.tx_id).sort(),["new","older"]);
  assert.ok(exposure.every(a=>a.severity==="HIGH"));
  assert.match(exposure[0].detail,/EXAMPLE FINANCIER \[SDGT\]/);
  assert.match(exposure[0].detail,/not a determination of ownership or intent/);
  assert.equal(result.alerts[0].type,"SANCTIONS_EXPOSURE","sanctions alerts must come first so the gate's 40-alert cap cannot drop them");
});

test("scheduled monitor flags a monitored wallet that is itself sanctioned, even with no new activity",()=>{
  const h=harness();
  const target={watch:{id:"w1",chain:"tron",address:"TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz",thresholds:{},last_snapshot:null},sensitive_labels:[]};
  const alerts=h.buildSanctionsAlerts(target.watch,{
    status:"ok",hit:true,seed_match:{address:target.watch.address,summary:"EXAMPLE [SDGT]"},counterparty_matches:[]
  });
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].type,"SANCTIONED_ADDRESS");
  assert.equal(alerts[0].tx_id,"");
});

test("monitor raises no sanctions alerts when screening found nothing or was unavailable, and caps a flood",()=>{
  const h=harness();
  const watch={id:"w1",chain:"ethereum",address:"0x1111111111111111111111111111111111111111"};
  assert.equal(h.buildSanctionsAlerts(watch,{status:"ok",hit:false}).length,0);
  assert.equal(h.buildSanctionsAlerts(watch,{status:"unavailable",hit:false}).length,0);
  assert.equal(h.buildSanctionsAlerts(watch,undefined).length,0);
  const many=Array.from({length:40},(_,i)=>({address:"0x"+String(i).padStart(40,"0"),summary:"X",tx_ids:["a"+i,"b"+i,"c"+i]}));
  assert.equal(h.buildSanctionsAlerts(watch,{hit:true,seed_match:null,counterparty_matches:many}).length,12);
});
