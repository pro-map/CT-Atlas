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
    // The real one is exercised end to end in crypto-monitor-reliability.test.cjs.
    sanitizeProviderMessage:text=>cleanText(text,120),
    crypto:{randomUUID:()=> "uuid-monitor"},
    Date,Number,String,Array,Object,Set,Map,console,
    // The pause before a save is sent again changes no call, so it is cut to nothing.
    setTimeout:callback=>setTimeout(callback,0),
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

test("an empty baseline with no check time treats every row as new, and no baseline at all treats none as new",()=>{
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

const updates=calls=>calls.filter(call=>call.path==="/crypto-monitor-update");
// Each wallet result sent to the gate, in order, whichever call carried it.
const records=calls=>updates(calls).flatMap(call=>Array.from(call.payload.updates));

test("CHECK NOW runs one wallet through the shared alert builder and saves through the gate",async()=>{
  const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET]},"/crypto-monitor-update":{ok:true,alerts_added:1,missing:0}});
  const response=await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"w1"}),{});
  assert.equal(response.status,200);
  assert.equal(response.value.alerts_added,1);
  const [record]=records(calls);
  assert.equal(record.username,"analyst");
  assert.equal(record.alerts[0].type,"NEW_TRANSACTION");
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

test("CHECK NOW on a wallet deleted while it was read says so instead of reporting a check",async()=>{
  const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET]},"/crypto-monitor-update":{ok:true,alerts_added:0,missing:1}});
  const response=await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"w1"}),{});
  assert.equal(response.status,503);
  assert.equal(response.value.error,"Monitored wallet not found.");
  assert.equal(calls.some(call=>call.path==="/usage-increment"),false);
});

const PARTIAL={coverage:{partial:true,failed_sources:["Blockstream older transactions"]}};

test("a partial read with a sanctions hit still alerts, says the read was partial, and leaves the baseline alone",async()=>{
  const {h,calls}=monitorRoute({
    "/crypto-monitor-targets":{ok:true,targets:[TARGET],total:1},
    analysis:async()=>({transactions:[eth({id:"new",amount:1})],sanctions_screening:HIT,...PARTIAL})
  });
  const result=await h.runCryptoMonitor({});
  assert.equal(result.partial,1);
  assert.equal(result.checked,0);
  const [record]=records(calls);
  assert.equal(record.snapshot,null,"a partial read never becomes the baseline");
  assert.deepEqual(Array.from(record.alerts,alert=>alert.type),["SANCTIONS_EXPOSURE","SANCTIONS_EXPOSURE"],"no new-activity alert from it");
  for(const alert of record.alerts){
    assert.match(alert.detail,/EXAMPLE FINANCIER \[SDGT\]/);
    assert.match(alert.detail,/Partial read: Blockstream older transactions could not be read\. Other records may be missing from this check\.$/);
  }
  assert.deepEqual({...record.check},{ok:false,error:"Partial read: Blockstream older transactions could not be read."});
});

test("an empty answer, or one older than the baseline, is a failed check that changes no baseline and raises no alert",async()=>{
  const answers=[
    [{transactions:[],coverage:{partial:false}},/no history for a wallet with saved activity/],
    [{transactions:[eth({id:"stale",amount:9,time:"2026-09-21T10:00:00Z"})],coverage:{partial:false}},/only history older than the saved baseline/]
  ];
  for(const [analysis,reason] of answers){
    const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET],total:1},analysis:async()=>analysis});
    const result=await h.runCryptoMonitor({});
    assert.equal(result.failed,1);
    const [record]=records(calls);
    assert.equal(record.snapshot,null);
    assert.deepEqual(Array.from(record.alerts),[]);
    assert.equal(record.check.ok,false);
    assert.match(record.check.error,reason);
  }
});

test("an empty answer for a wallet with no saved activity is a real empty wallet, and becomes its baseline",async()=>{
  const fresh={...TARGET,watch:{...TARGET.watch,last_snapshot:{newest_tx_id:"",newest_tx_time:""}}};
  for(const coverage of [{partial:false},{partial:false,lifetime_tx_count:0}]){
    const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[fresh],total:1},analysis:async()=>({transactions:[],coverage})});
    assert.equal((await h.runCryptoMonitor({})).checked,1);
    const [record]=records(calls);
    assert.equal(record.snapshot.newest_tx_id,"");
    assert.equal(record.check.ok,true);
  }
});

test("an empty answer the provider's own count contradicts is a failed check, even before the wallet has a baseline",async()=>{
  for(const last_snapshot of [null,{newest_tx_id:"",newest_tx_time:""}]){
    const fresh={...TARGET,watch:{...TARGET.watch,last_snapshot}};
    const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[fresh],total:1},analysis:async()=>({transactions:[],coverage:{partial:false,lifetime_tx_count:60}})});
    assert.equal((await h.runCryptoMonitor({})).failed,1);
    const [record]=records(calls);
    assert.equal(record.snapshot,null,"an empty baseline here would turn the whole history into alerts at the next full read");
    assert.deepEqual({...record.check},{ok:false,error:"The provider returned no history although it counts 60 transactions for this wallet."});
  }
});

test("after an empty baseline, history from before its check is not new, and a first payment after it is",()=>{
  const h=harness();
  const emptyAt={newest_tx_id:"",newest_tx_time:"",checked_at:"2026-09-23T06:00:00Z"};
  const old=[eth({id:"old1",amount:50,time:"2026-09-22T10:00:00Z"}),eth({id:"old2",amount:50,time:"2026-09-21T10:00:00Z"})];
  assert.deepEqual(types(h.buildMonitorAlerts(watchWith({min_amount:10},emptyAt),{transactions:old},NOW)),[],
    "an empty read that missed the history must not turn it into alerts");
  const first=h.buildMonitorAlerts(watchWith({min_amount:10},emptyAt),{transactions:[eth({id:"first",amount:50}),...old]},NOW);
  assert.deepEqual(types(first),["NEW_TRANSACTION","LARGE_TRANSFER"]);
  assert.deepEqual(Array.from(first.alerts,alert=>alert.tx_id),["first","first"]);
  // A block time can trail the clock, so a payment stamped an hour before the empty check is still new.
  const early=h.buildMonitorAlerts(watchWith({min_amount:10},emptyAt),{transactions:[eth({id:"early",amount:50,time:"2026-09-23T05:00:00Z"})]},NOW);
  assert.deepEqual(types(early),["NEW_TRANSACTION","LARGE_TRANSFER"]);
  const unconfirmed=h.buildMonitorAlerts(watchWith({},emptyAt),{transactions:[eth({id:"mempool",amount:50,time:""})]},NOW);
  assert.deepEqual(types(unconfirmed),["NEW_TRANSACTION"],"a payment not yet in a block is recent by definition");
});

test("a run saves every wallet, whatever its read, and its outcome, in one call",async()=>{
  const targets=["ok","down","partial"].map(id=>({...TARGET,watch:{...TARGET.watch,id,address:"bc1q"+id}}));
  const {h,calls}=monitorRoute({
    "/crypto-monitor-targets":{ok:true,targets,total:3},
    analysis:async address=>{
      if(address==="bc1qdown")throw new Error("Blockstream transaction history: HTTP 503");
      return address==="bc1qpartial"?{transactions:[eth({id:"new",amount:1})],...PARTIAL}:{transactions:[eth({id:"new",amount:1})],coverage:{partial:false}};
    }
  });
  const result=await h.runCryptoMonitor({});
  assert.deepEqual(Array.from(calls,call=>call.path),["/crypto-monitor-targets","/crypto-monitor-update"],"one update for the whole run and no other call");
  assert.deepEqual(Array.from(records(calls),record=>record.watch_id),["ok","down","partial"]);
  assert.deepEqual(Array.from(records(calls),record=>record.check.ok),[true,false,false]);
  assert.equal(records(calls)[1].check.error,"Blockstream transaction history: HTTP 503");
  assert.deepEqual({...updates(calls)[0].payload.run},{selected:3,checked:1,partial:1,failed:1});
  assert.equal(result.status,"degraded");
  assert.equal(result.ok,true);
});

test("a run in which every wallet failed is not ok",async()=>{
  const targets=["a","b"].map(id=>({...TARGET,watch:{...TARGET.watch,id}}));
  const {h,calls}=monitorRoute({
    "/crypto-monitor-targets":{ok:true,targets,total:2},
    analysis:async()=>{throw new Error("Blockstream transaction history: the provider did not answer in time.");}
  });
  const result=await h.runCryptoMonitor({});
  assert.equal(result.ok,false);
  assert.equal(result.status,"failed");
  assert.equal(result.failed,2);
  assert.deepEqual({...updates(calls)[0].payload.run},{selected:2,checked:0,partial:0,failed:2});
});

test("a run with wallets to check but no provider to read them is not ok, and still reports",async()=>{
  const tron={...TARGET,watch:{...TARGET.watch,chain:"tron",address:"T"+"1".repeat(33)}};
  const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[tron],total:1}});
  const result=await h.runCryptoMonitor({});
  assert.equal(result.ok,false);
  assert.equal(result.status,"failed");
  assert.equal(result.checked,0);
  assert.equal(result.skipped,1);
  const [update]=updates(calls);
  assert.deepEqual(Array.from(update.payload.updates),[]);
  assert.deepEqual({...update.payload.run},{selected:1,checked:0,partial:0,failed:0});
});

const quiet={log(){},error(){}};

test("a run whose results the gate refuses twice fails, instead of reading as a quiet run",async()=>{
  const saves=[];
  const h=harness({
    console:quiet,
    gateCall:async(_env,path,payload)=>{
      if(path==="/crypto-monitor-targets")return {ok:true,json:async()=>({ok:true,targets:[TARGET],total:1,run_id:"run-7"})};
      saves.push(payload);
      return {ok:false,json:async()=>({error:"Gate unavailable."})};
    },
    analyzeCryptoAddress:async()=>({transactions:[eth({id:"new",amount:1})],coverage:{partial:false}})
  });
  await assert.rejects(()=>h.runCryptoMonitor({}),/^Error: Gate unavailable\.$/);
  assert.equal(saves.length,2,"the refused save is sent once more");
  assert.deepEqual(saves.map(payload=>payload.update_id),["run-7","run-7"],"under the run's id, so the gate saves nothing twice");
});

test("a save lost on the way is sent once more, and a run saved by the retry is ok",async()=>{
  const saves=[];
  const h=harness({
    console:quiet,
    gateCall:async(_env,path,payload)=>{
      if(path==="/crypto-monitor-targets")return {ok:true,json:async()=>({ok:true,targets:[TARGET],total:1,run_id:"run-8"})};
      saves.push(payload);
      if(saves.length===1)throw new Error("Network connection lost.");
      return {ok:true,json:async()=>({ok:true,alerts_added:1,missing:0})};
    },
    analyzeCryptoAddress:async()=>({transactions:[eth({id:"new",amount:1})],coverage:{partial:false}})
  });
  const result=await h.runCryptoMonitor({});
  assert.equal(result.status,"ok");
  assert.equal(result.alerts_added,1);
  assert.equal(saves.length,2);
  assert.equal(JSON.stringify(saves[1]),JSON.stringify(saves[0]),"the same results under the same id");
});

test("a run tells the gate which chains it can read and saves under the run's id; a CHECK NOW saves under its own",async()=>{
  const {h,calls}=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET],total:1,run_id:"run-9"}});
  await h.runCryptoMonitor({ETHERSCAN_API_KEY:"k"});
  assert.deepEqual(Array.from(calls[0].payload.readable_chains),["bitcoin","ethereum","polygon","arbitrum"],"no TronGrid key, so no TRON wallet is owed a result");
  assert.equal(updates(calls)[0].payload.update_id,"run-9");
  const single=monitorRoute({"/crypto-monitor-targets":{ok:true,targets:[TARGET]}});
  await single.h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"w1"}),{});
  assert.equal(updates(single.calls)[0].payload.update_id,"uuid-monitor");
});

test("a wallet that reads empty again keeps the time it was first found empty, so a payment the second read missed still alerts",()=>{
  const h=harness();
  const first=h.buildMonitorAlerts(watchWith({min_amount:10},null),{transactions:[]},Date.parse("2026-09-20T06:00:00Z")).snapshot;
  assert.equal(first.empty_since,"2026-09-20T06:00:00.000Z");
  // A 50 ETH payment on the 21st, which the empty read of the 22nd missed.
  const again=h.buildMonitorAlerts(watchWith({min_amount:10},first),{transactions:[]},Date.parse("2026-09-22T06:00:00Z")).snapshot;
  assert.equal(again.checked_at,"2026-09-22T06:00:00.000Z");
  assert.equal(again.empty_since,"2026-09-20T06:00:00.000Z");
  const missed=eth({id:"missed",amount:50,time:"2026-09-21T10:00:00Z"});
  const full=h.buildMonitorAlerts(watchWith({min_amount:10},again),{transactions:[missed]},NOW);
  assert.deepEqual(types(full),["NEW_TRANSACTION","LARGE_TRANSFER"]);
  assert.equal("empty_since" in full.snapshot,false,"a baseline with activity has a time of its own");
  // A snapshot saved before the field existed was first found empty at its own check.
  const legacy={newest_tx_id:"",newest_tx_time:"",checked_at:"2026-09-20T06:00:00Z"};
  assert.equal(h.buildMonitorAlerts(watchWith({},legacy),{transactions:[]},NOW).snapshot.empty_since,"2026-09-20T06:00:00.000Z");
});

test("CHECK NOW records a failed read and answers with its reason",async()=>{
  const {h,calls}=monitorRoute({
    "/crypto-monitor-targets":{ok:true,targets:[TARGET]},
    analysis:async()=>({transactions:[],coverage:{partial:false}})
  });
  const response=await h.handleCryptoMonitorCheck(checkRequest({user_id:"analyst",watch_id:"w1"}),{});
  assert.equal(response.status,503);
  assert.match(response.value.error,/no history for a wallet with saved activity/);
  assert.equal(records(calls)[0].check.ok,false);
  assert.equal(updates(calls)[0].payload.run,undefined,"a single check is not a run");
  assert.equal(calls.some(call=>call.path==="/usage-increment"),false);
});
