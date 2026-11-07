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

function harness(overrides={}){
  const context=vm.createContext({
    cleanText,gateCall,analyzeCryptoAddress,retiredChainError:()=>"",
    crypto:{randomUUID:()=> "uuid-monitor"},
    Date,Number,String,Array,Object,Set,Map,console,
    ...overrides
  });
  vm.runInContext(source,context);
  return vm.runInContext("({snapshotFromAnalysis,buildMonitorAlerts,buildSanctionsAlerts,handleCryptoMonitorCheck,runCryptoMonitor,CRYPTO_MONITOR_VERSION,MONITOR_BATCH_LIMIT})",context);
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

const NOW=Date.parse("2026-09-23T12:00:00Z");
const watchWith=(thresholds,last_snapshot={newest_tx_id:"old",newest_tx_time:"2026-09-22T10:00:00Z"})=>({
  watch:{id:"w1",chain:"ethereum",address:"0x1111111111111111111111111111111111111111",thresholds,last_snapshot},
  sensitive_labels:[]
});
const types=result=>Array.from(result.alerts,alert=>alert.type);
const eth=overrides=>tx({asset:"ETH",asset_key:"native",time:"2026-09-23T11:00:00Z",...overrides});
const shib=overrides=>tx({asset:"SHIB",asset_key:"0xshib",token_contract:"0xshib",time:"2026-09-23T11:00:00Z",...overrides});
const usdt=overrides=>tx({asset:"USDT",asset_key:"0xusdt",token_contract:"0xusdt",stable:true,time:"2026-09-23T11:00:00Z",...overrides});

test("a threshold meant for the native asset does not fire on an unknown token",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(watchWith({min_amount:100,aggregate_24h:100}),{transactions:[
    eth({id:"a",amount:0.4}),shib({id:"b",amount:5000000})
  ]},NOW);
  assert.deepEqual(types(result),["NEW_TRANSACTION"]);
  assert.equal(result.snapshot.aggregate_value,0.4);
});

test("the 24h aggregate compares one asset at a time and never sums across assets",()=>{
  const h=harness();
  const rows=[eth({id:"a",amount:60}),usdt({id:"b",amount:60})];
  assert.ok(!types(h.buildMonitorAlerts(watchWith({aggregate_24h:100}),{transactions:rows},NOW)).includes("AGGREGATE_24H"));
  const crossing=h.buildMonitorAlerts(watchWith({aggregate_24h:100}),{transactions:[...rows,usdt({id:"c",amount:50})]},NOW);
  const alert=crossing.alerts.find(item=>item.type==="AGGREGATE_24H");
  assert.match(alert.detail,/^110 USDT /);
});

test("choosing an asset scopes every amount threshold to it",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(watchWith({min_amount:100,asset:"SHIB"}),{transactions:[
    eth({id:"a",amount:500}),shib({id:"b",amount:5000000})
  ]},NOW);
  const large=result.alerts.filter(item=>item.type==="LARGE_TRANSFER");
  assert.equal(large.length,1);
  assert.equal(large[0].tx_id,"b");
});

test("windowed alerts carry a UTC day bucket so they can fire again on a later day",()=>{
  const h=harness();
  const rows=[eth({id:"a",amount:500})];
  const target=watchWith({aggregate_24h:100,velocity_24h:1});
  const dayOne=h.buildMonitorAlerts(target,{transactions:rows},NOW);
  for(const type of ["AGGREGATE_24H","VELOCITY_24H"]){
    assert.equal(dayOne.alerts.find(item=>item.type===type).day_bucket,"2026-09-23");
  }
  assert.equal(dayOne.alerts.find(item=>item.type==="NEW_TRANSACTION").day_bucket,"","a per-transaction alert stays once-only");
});

test("a late check does not read a wallet active every day as a dormant one",()=>{
  const h=harness();
  const daily=Array.from({length:10},(_,index)=>eth({id:"d"+index,amount:1,time:new Date(Date.parse("2026-09-13T10:00:00Z")+(index+1)*86400000).toISOString()}));
  const result=h.buildMonitorAlerts(
    watchWith({dormant_days:5},{newest_tx_id:"old",newest_tx_time:"2026-09-13T10:00:00Z"}),
    {transactions:daily},NOW
  );
  assert.ok(!types(result).includes("REACTIVATION"));
});

test("real dormancy alerts on the row that ended the gap",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(
    watchWith({dormant_days:5},{newest_tx_id:"old",newest_tx_time:"2026-09-01T10:00:00Z"}),
    {transactions:[eth({id:"later",amount:1}),eth({id:"first",amount:1,time:"2026-09-22T10:00:00Z"})]},NOW
  );
  const alert=result.alerts.find(item=>item.type==="REACTIVATION");
  assert.ok(alert);
  assert.equal(alert.tx_id,"first");
});

test("an empty baseline treats every row as new, and no baseline at all treats none as new",()=>{
  const h=harness();
  const rows=[eth({id:"a",amount:50})];
  const empty=h.buildMonitorAlerts(watchWith({min_amount:10},{newest_tx_id:"",newest_tx_time:""}),{transactions:rows},NOW);
  assert.ok(types(empty).includes("LARGE_TRANSFER"));
  const none=h.buildMonitorAlerts(watchWith({min_amount:10},null),{transactions:rows},NOW);
  assert.deepEqual(types(none),[]);
});

test("failed, spam and self rows do not cross a value threshold",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(watchWith({min_amount:10,aggregate_24h:10,velocity_24h:1}),{transactions:[
    eth({id:"a",amount:50,failed:true}),
    usdt({id:"b",amount:50,spam:true}),
    eth({id:"c",amount:50,direction:"SELF"})
  ]},NOW);
  assert.ok(!types(result).includes("LARGE_TRANSFER"));
  assert.ok(!types(result).includes("AGGREGATE_24H"));
  assert.equal(result.snapshot.tx_count,1,"the self-transfer moved value, so it still counts as activity");
});

const withLabel=(label,reasons=[])=>({transactions:[eth({id:"new",amount:1})],risk_assessment:{label,reasons}});
const baseline=riskLabel=>watchWith({},{newest_tx_id:"old",newest_tx_time:"2026-09-22T10:00:00Z",...(riskLabel?{risk_label:riskLabel}:{})});
const riskAlert=result=>result.alerts.find(alert=>alert.type==="RISK_LABEL_RAISED");

test("a label rising to HIGH raises a HIGH alert with a day bucket and the reasons",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(baseline("LOW"),withLabel("HIGH",["Direct transfer with a listed address"]),NOW);
  const alert=riskAlert(result);
  assert.equal(alert.severity,"HIGH");
  assert.equal(alert.day_bucket,"2026-09-23");
  assert.match(alert.title,/raised to HIGH/);
  assert.match(alert.detail,/from LOW to HIGH: Direct transfer with a listed address/);
  assert.match(alert.detail,/Indicator, not proof/);
  assert.equal(result.snapshot.risk_label,"HIGH");
});

test("a label rising to ELEVATED raises a MEDIUM alert, and sanctions alerts still come first",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(baseline("LOW"),{...withLabel("ELEVATED"),sanctions_screening:HIT},NOW);
  assert.equal(riskAlert(result).severity,"MEDIUM");
  assert.equal(result.alerts[0].type,"SANCTIONS_EXPOSURE");
});

test("a label that holds or falls raises nothing and the baseline follows it down",()=>{
  const h=harness();
  assert.equal(riskAlert(h.buildMonitorAlerts(baseline("HIGH"),withLabel("HIGH"),NOW)),undefined);
  const fell=h.buildMonitorAlerts(baseline("HIGH"),withLabel("LOW"),NOW);
  assert.equal(riskAlert(fell),undefined);
  assert.equal(fell.snapshot.risk_label,"LOW");
});

test("the first labelled check sets a baseline without alerting",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(baseline(""),withLabel("HIGH"),NOW);
  assert.equal(riskAlert(result),undefined);
  assert.equal(result.snapshot.risk_label,"HIGH");
});

test("NOT_ASSESSED neither alerts nor loses the last real label, so recovery is not a rise",()=>{
  const h=harness();
  const outage=h.buildMonitorAlerts(baseline("HIGH"),withLabel("NOT_ASSESSED"),NOW);
  assert.equal(riskAlert(outage),undefined);
  assert.equal(outage.snapshot.risk_label,"HIGH");
  const recovered=h.buildMonitorAlerts(baseline(outage.snapshot.risk_label),withLabel("HIGH"),NOW);
  assert.equal(riskAlert(recovered),undefined);
});

test("a monitor run on an older analysis with no assessment keeps working",()=>{
  const h=harness();
  const result=h.buildMonitorAlerts(baseline("LOW"),{transactions:[eth({id:"new",amount:1})]},NOW);
  assert.equal(riskAlert(result),undefined);
  assert.equal(result.snapshot.risk_label,"LOW");
});

function monitorRoute(answers={}){
  const calls=[];
  const gate=async(_env,path,payload)=>{
    calls.push({path,payload});
    const body=answers[path]||{ok:true};
    return {ok:true,json:async()=>body};
  };
  const h=harness({
    gateCall:gate,
    normalizeUsername:value=>cleanText(value,80).toLowerCase(),
    isAllowedUser:()=>true,
    jsonResponse:(value,status=200)=>({value,status}),
    authenticate:async()=>({ok:true}),
    analyzeCryptoAddress:answers.analysis||(async()=>({transactions:[eth({id:"new",amount:1})],coverage:{partial:false}}))
  });
  return {h,calls};
}
const checkRequest=body=>({json:async()=>body});
const TARGET={username:"analyst",watch:{id:"w1",chain:"bitcoin",address:"bc1qseed",thresholds:{},last_snapshot:{newest_tx_id:"old",newest_tx_time:"2026-09-22T10:00:00Z"}},sensitive_labels:[]};

test("CHECK NOW runs one wallet through the shared alert builder and saves through the gate",async()=>{
  const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET]},"/crypto-monitor-update":{ok:true,alerts_added:1}});
  const response=await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"w1"}),{});
  assert.equal(response.status,200);
  assert.equal(response.value.alerts_added,1);
  const update=calls.find(call=>call.path==="/crypto-monitor-update");
  assert.equal(update.payload.username,"analyst");
  assert.equal(update.payload.alerts[0].type,"NEW_TRANSACTION");
  assert.equal(calls.find(call=>call.path==="/usage-increment").payload.log.details.origin,"monitor");
});

test("CHECK NOW refuses a blank wallet id instead of reaching the scheduled rotation",async()=>{
  const {h,calls}=monitorRoute();
  const response=await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst"}),{});
  assert.equal(response.status,400);
  assert.equal(calls.length,0);
});

test("CHECK NOW answers 404 for a wallet the gate does not return for this user",async()=>{
  const {h}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[]}});
  assert.equal((await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"other"}),{})).status,404);
});

test("a partial provider read leaves the baseline alone and counts as a failed check",async()=>{
  const {h,calls}=monitorRoute({
    "/crypto-monitor-targets":{ok:true,targets:[TARGET],total:1},
    analysis:async()=>({transactions:[],coverage:{partial:true}})
  });
  const result=await h.runCryptoMonitor({});
  assert.equal(result.failed,1);
  assert.equal(result.checked,0);
  assert.equal(calls.some(call=>call.path==="/crypto-monitor-update"),false);
});
