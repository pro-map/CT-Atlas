// The real ReportGate crypto routes on in-memory storage.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const source=fs.readFileSync("cloudflare-worker/report-gate.js","utf8")
  .replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,"")
  .replace("export class ReportGate","class ReportGate")+"\nglobalThis.__ReportGate=ReportGate;";

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

// failPut(keys) returns the error a write of those keys throws, as an over-size value would, or null.
// clock() is the gate's Date.now, when a test moves time on.
function harness(users=["analyst"],{failPut=null,clock=null}={}){
  const values=new Map();
  // The keys of each write, one entry per put call.
  const puts=[];
  const storage={
    async get(key){return structuredClone(values.get(key));},
    async put(key,value){
      const entries=key&&typeof key==="object"?Object.entries(key):[[key,value]];
      const refused=failPut&&failPut(entries.map(([name])=>name));
      if(refused)throw refused;
      puts.push(entries.map(([name])=>name));
      for(const [name,item] of entries)values.set(name,structuredClone(item));
    },
    async delete(key){return values.delete(key);},
    async list({prefix=""}={}){return new Map([...values].filter(([key])=>key.startsWith(prefix)));},
    async getAlarm(){return null;},
    async setAlarm(){}
  };
  const context=vm.createContext({
    cleanText,Response,Request,URL,console,crypto:globalThis.crypto,
    getAllowedUsers:env=>new Set(env.users),
    normalizeUsername:value=>String(value||"").trim().toLowerCase(),
    isAllowedUser:(username,env)=>env.users.includes(username),
    parisDayKey:value=>new Date(value).toISOString().slice(0,10),
    usageTemplate:username=>({username})
  });
  if(clock){context.__clock=clock;vm.runInContext("Date.now=()=>__clock();",context);}
  vm.runInContext(source,context);
  const gate=new context.__ReportGate({storage},{users});
  const call=async(path,body)=>{
    const response=await gate.fetch(new Request("https://gate.invalid"+path,{method:"POST",body:JSON.stringify(body)}));
    return {status:response.status,body:await response.json()};
  };
  return {call,values,puts};
}

const WATCH={id:"w1",chain:"ethereum",address:"0x"+"1".repeat(40),enabled:true,thresholds:{},last_snapshot:null};
const empty={version:"crypto-workspace-v1",labels:[],watchlist:[],cases:[],alerts:[]};
const put=(call,workspace,revision)=>call("/crypto-workspace-put",{username:"analyst",workspace,revision});
const get=async call=>(await call("/crypto-workspace-get",{username:"analyst"})).body;
// What the monitor sends for one wallet of analyst's.
const monitorUpdate=(call,update)=>call("/crypto-monitor-update",{updates:[{username:"analyst",watch_id:"w1",...update}]});

test("a new workspace starts at revision 0 and each save moves it on",async()=>{
  const {call}=harness();
  const first=await get(call);
  assert.equal(first.revision,0);
  assert.equal(first.workspace.revision,0);
  const saved=await put(call,{...empty,watchlist:[WATCH]},0);
  assert.equal(saved.status,200);
  assert.equal(saved.body.revision,1);
  assert.equal((await get(call)).revision,1);
});

test("a stale revision gets 409 and the current workspace, and changes nothing",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const stale=await put(call,{...empty,cases:[{id:"c1",name:"Other tab"}]},0);
  assert.equal(stale.status,409);
  assert.equal(stale.body.code,"stale_revision");
  assert.equal(stale.body.revision,1);
  assert.equal(stale.body.workspace.watchlist[0].id,"w1");
  const now=await get(call);
  assert.equal(now.revision,1);
  assert.equal(now.workspace.cases.length,0);
});

test("a page whose load failed cannot wipe the workspace: no revision means stale",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH],labels:[{id:"l1"}],cases:[{id:"c1",name:"Case"}]},0);
  for(const revision of [undefined,null]){
    const wiped=await put(call,{...empty,cases:[{id:"c2",name:"New"}]},revision);
    assert.equal(wiped.status,409);
  }
  const now=await get(call);
  assert.equal(now.workspace.labels.length,1);
  assert.equal(now.workspace.cases[0].id,"c1");
});

test("saving a legacy workspace with no stored revision works from revision 0",async()=>{
  const {call,values}=harness();
  values.set("crypto-workspace:analyst",{...empty,username:"analyst",labels:[{id:"l1"}]});
  const loaded=await get(call);
  assert.equal(loaded.revision,0);
  assert.equal((await put(call,loaded.workspace,loaded.revision)).status,200);
  assert.equal((await get(call)).workspace.labels.length,1);
});

test("a page save keeps scheduled alerts and the monitor baseline, and takes only edits",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const page=await get(call);
  await monitorUpdate(call,{
    snapshot:{checked_at:"t",newest_tx_id:"new",newest_tx_time:"2026-11-05T00:00:00Z",tx_count:1,aggregate_value:1,risk_label:"HIGH"},
    alerts:[{type:"SANCTIONS_EXPOSURE",severity:"HIGH",title:"Direct exposure",detail:"d",tx_id:"tx1"}]});

  const edited=structuredClone(page.workspace);
  edited.watchlist[0].label="Renamed";
  edited.watchlist[0].last_snapshot={newest_tx_id:"rolled-back"};
  edited.alerts=[{id:"forged",type:"X",title:"Forged"}];
  edited.cases=[{id:"c1",name:"Note"}];
  const saved=await put(call,edited,page.revision);
  assert.equal(saved.status,200,"the monitor does not bump the revision, so a page is not sent back to reload every 6 hours");

  const now=(await get(call)).workspace;
  assert.equal(now.watchlist[0].label,"Renamed");
  assert.equal(now.watchlist[0].last_snapshot.newest_tx_id,"new");
  assert.equal(now.watchlist[0].last_snapshot.risk_label,"HIGH");
  assert.deepEqual(now.alerts.map(alert=>alert.type),["SANCTIONS_EXPOSURE"]);
  assert.equal(now.cases[0].id,"c1");
});

test("an acknowledgement is the one alert edit a page can make",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  await monitorUpdate(call,{alerts:[
    {id:"a1",type:"VELOCITY_24H",severity:"MEDIUM",title:"First",detail:"original"},
    {id:"a2",type:"NEW_TRANSACTION",severity:"LOW",title:"Second",detail:"original"}
  ]});
  const page=await get(call);
  const acknowledged=page.workspace.alerts.map(alert=>alert.id==="a1"?{...alert,acknowledged:true,detail:"edited"}:alert);
  await put(call,{...page.workspace,alerts:acknowledged},page.revision);
  const alerts=(await get(call)).workspace.alerts;
  assert.equal(alerts.find(alert=>alert.id==="a1").acknowledged,true);
  assert.equal(alerts.find(alert=>alert.id==="a1").detail,"original");
  assert.equal(alerts.find(alert=>alert.id==="a2").acknowledged,false);
});

test("a windowed alert fires once per day bucket, and an alert with no bucket still fires once",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const alert={type:"AGGREGATE_24H",severity:"MEDIUM",title:"24h aggregate threshold crossed",detail:"d"};
  const send=async extra=>(await monitorUpdate(call,{alerts:[{...alert,...extra}]})).body.alerts_added;
  assert.equal(await send({day_bucket:"2026-11-01"}),1);
  assert.equal(await send({day_bucket:"2026-11-01"}),0);
  assert.equal(await send({day_bucket:"2026-11-02"}),1);
  const sanctions={type:"SANCTIONED_ADDRESS",tx_id:"",day_bucket:""};
  assert.equal(await send(sanctions),1);
  assert.equal(await send(sanctions),0);
});

test("a watch added by the page starts with no baseline, because the page cannot set one",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[{...WATCH,last_snapshot:{newest_tx_id:"from-page"}}]},0);
  assert.equal((await get(call)).workspace.watchlist[0].last_snapshot,null);
});

test("asking for one monitored wallet is scoped to its owner and leaves the rotation alone",async()=>{
  const {call,values}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const one=await call("/crypto-monitor-targets",{username:"analyst",watch_id:"w1"});
  assert.equal(one.body.targets.length,1);
  assert.equal(values.has("crypto-monitor-cursor"),false);
  const other=await call("/crypto-monitor-targets",{username:"someone-else",watch_id:"w1"});
  assert.equal(other.body.targets.length,0);
});

test("stored blank thresholds are repaired on read, for the page and for the monitor",async()=>{
  const {call,values}=harness();
  const legacy={min_amount:0,aggregate_24h:0,velocity_24h:1,dormant_days:1};
  values.set("crypto-workspace:analyst",{...empty,username:"analyst",watchlist:[
    {...WATCH,thresholds:legacy},
    {...WATCH,id:"w2",thresholds:{min_amount:500,aggregate_24h:0,velocity_24h:25,dormant_days:90}},
    {...WATCH,id:"w3",thresholds:{velocity_24h:1,dormant_days:1},thresholds_version:2}
  ]});
  const watches=(await get(call)).workspace.watchlist;
  assert.deepEqual({...watches[0].thresholds},{min_amount:null,aggregate_24h:null,velocity_24h:null,dormant_days:null});
  assert.deepEqual({...watches[1].thresholds},{min_amount:500,aggregate_24h:null,velocity_24h:25,dormant_days:90});
  assert.equal(watches[2].thresholds.velocity_24h,1,"a value saved after the fix is a deliberate choice");
  const {targets}=(await call("/crypto-monitor-targets",{limit:8})).body;
  assert.equal(targets.find(target=>target.watch.id==="w1").watch.thresholds.velocity_24h,null);
});

// ---------------------------------------------------------------- check records and the run record

const check=(call,ok,update={},run)=>call("/crypto-monitor-update",{
  updates:[{username:"analyst",watch_id:"w1",check:{ok,error:ok?"":"Blockstream transaction history: HTTP 503"},...update}],
  ...(run?{run}:{})
});
const watchNow=async call=>(await get(call)).workspace.watchlist[0];
const failingAlerts=async call=>(await get(call)).workspace.alerts.filter(alert=>alert.type==="CHECK_FAILING");

test("three failed checks in a row raise one alert, not one per check, and a success clears the record",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  for(let run=1;run<=2;run++)await check(call,false);
  assert.equal((await failingAlerts(call)).length,0,"two failures are not yet an alert");
  assert.equal((await check(call,false)).body.alerts_added,1);
  for(let run=4;run<=6;run++)assert.equal((await check(call,false)).body.alerts_added,0);
  const alerts=await failingAlerts(call);
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].severity,"MEDIUM");
  assert.match(alerts[0].detail,/^The last 3 checks of this wallet failed \(since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\), so new activity on it may be missed\. Latest reason: Blockstream transaction history: HTTP 503$/);
  const failing=(await watchNow(call)).monitor;
  assert.equal(failing.failures,6);
  assert.equal(failing.last_error,"Blockstream transaction history: HTTP 503");
  assert.match(failing.failing_since,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(failing.last_success_at,"","never read in full");
  assert.equal((await watchNow(call)).last_snapshot,null,"a failed check never touches the baseline");

  await check(call,true,{snapshot:{checked_at:"t",newest_tx_id:"new",newest_tx_time:"2026-11-05T00:00:00Z"}});
  const cleared=(await watchNow(call)).monitor;
  assert.deepEqual({...cleared,last_attempt_at:"",last_success_at:""},{last_attempt_at:"",last_success_at:"",last_error:"",failures:0,failing_since:""});
  assert.equal(cleared.last_success_at,cleared.last_attempt_at);
});

test("a second run of failures raises its own alert, even on the same day",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  for(let run=1;run<=3;run++)await check(call,false);
  await check(call,true);
  for(let run=1;run<=2;run++)assert.equal((await check(call,false)).body.alerts_added,0);
  assert.equal((await check(call,false)).body.alerts_added,1);
  assert.equal((await failingAlerts(call)).length,2);
});

test("a watch saved before check records existed keeps working, and its first failure keeps its last real check",async()=>{
  const {call,values}=harness();
  values.set("crypto-workspace:analyst",{...empty,username:"analyst",watchlist:[{...WATCH,last_snapshot:{checked_at:"2026-11-01T06:17:00.000Z",newest_tx_id:"old"}}]});
  assert.equal((await call("/crypto-monitor-targets",{limit:8})).body.targets.length,1);
  assert.equal((await watchNow(call)).monitor,undefined);
  await check(call,false);
  const record=(await watchNow(call)).monitor;
  assert.equal(record.failures,1);
  assert.equal(record.last_success_at,"2026-11-01T06:17:00.000Z");
  assert.equal((await watchNow(call)).last_snapshot.newest_tx_id,"old");
});

test("an update that carries no check leaves the check record alone",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  await check(call,false);
  await monitorUpdate(call,{alerts:[]});
  assert.equal((await watchNow(call)).monitor.failures,1);
});

test("a page save can neither replace nor forge a check record",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH,{...WATCH,id:"w2"}]},0);
  await check(call,false);
  const page=await get(call);
  const edited=structuredClone(page.workspace);
  edited.watchlist[0].monitor={failures:0,last_error:""};
  edited.watchlist[1].monitor={failures:9,last_error:"forged"};
  edited.watchlist[0].label="Renamed";
  assert.equal((await put(call,edited,page.revision)).status,200);
  const [first,second]=(await get(call)).workspace.watchlist;
  assert.equal(first.label,"Renamed");
  assert.equal(first.monitor.failures,1);
  assert.equal("monitor" in second,false);
});

test("a run's one update saves every wallet of every analyst, writing each workspace once, and a deleted wallet stops nothing",async()=>{
  const {call,values,puts}=harness(["analyst","other"]);
  values.set("crypto-workspace:analyst",{...empty,username:"analyst",watchlist:[WATCH,{...WATCH,id:"w2"}]});
  values.set("crypto-workspace:other",{...empty,username:"other",watchlist:[{...WATCH,id:"o1"}]});
  puts.length=0;
  const sanctions={type:"SANCTIONS_EXPOSURE",severity:"HIGH",title:"Direct exposure to a sanctioned address",detail:"d",tx_id:"tx9"};
  const {status,body}=await call("/crypto-monitor-update",{
    updates:[
      {username:"analyst",watch_id:"w1",snapshot:{checked_at:"t",newest_tx_id:"new"},alerts:[],check:{ok:true,error:""}},
      {username:"analyst",watch_id:"deleted",alerts:[],check:{ok:false,error:"x"}},
      {username:"analyst",watch_id:"w2",snapshot:null,alerts:[sanctions],check:{ok:false,error:"Partial read: Blockstream older transactions could not be read."}},
      {username:"other",watch_id:"o1",snapshot:null,alerts:[],check:{ok:false,error:"Blockstream transaction history: HTTP 503"}}
    ],
    run:{selected:4,checked:1,partial:1,failed:2}
  });
  assert.equal(status,200);
  assert.deepEqual(body,{ok:true,alerts_added:1,missing:1});
  assert.deepEqual(puts,[["crypto-workspace:analyst"],["crypto-workspace:other"],["crypto-monitor-run"]],"each workspace written once and on its own, then the run");
  const analyst=values.get("crypto-workspace:analyst");
  assert.equal(analyst.watchlist[0].last_snapshot.newest_tx_id,"new");
  assert.equal(analyst.watchlist[1].last_snapshot,null);
  assert.equal(analyst.watchlist[1].monitor.failures,1);
  assert.deepEqual(analyst.alerts.map(alert=>[alert.watch_id,alert.type]),[["w2","SANCTIONS_EXPOSURE"]]);
  assert.equal(values.get("crypto-workspace:other").watchlist[0].monitor.last_error,"Blockstream transaction history: HTTP 503");
  assert.equal(values.get("crypto-monitor-run").partial,1);
});

test("an update must be a batch no larger than a run, and the run alone is enough when no wallet could be tried",async()=>{
  const {call,values}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const one={username:"analyst",watch_id:"w1",alerts:[]};
  for(const body of [one,{updates:[]},{updates:Array(9).fill(one)}]){
    assert.equal((await call("/crypto-monitor-update",body)).status,400,JSON.stringify(body).slice(0,40));
  }
  assert.equal(values.has("crypto-monitor-run"),false);
  assert.equal((await call("/crypto-monitor-update",{updates:[],run:{selected:2,checked:0,partial:0,failed:0}})).status,200);
  assert.match((await call("/crypto-monitor-run-get",{})).body.run.summary,/ UTC · FAILED: 0 of 2 wallets read · 2 not checked$/);
});

test("the run record holds what the run's update carried, read back with a status and a one-line summary, never a wallet",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  await check(call,false,{},{selected:8,checked:0,partial:0,failed:8,username:"analyst",address:WATCH.address});
  const {run}=(await call("/crypto-monitor-run-get",{})).body;
  assert.equal(run.status,"failed");
  assert.equal(run.stale,false);
  assert.match(run.summary,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · FAILED: 0 of 8 wallets read · 8 failed$/);
  assert.ok(!JSON.stringify(run).includes(WATCH.address)&&!JSON.stringify(run).includes("analyst"));
  assert.deepEqual((await get(call)).monitor_run,run,"the page reads the same summary with its workspace");

  await check(call,true,{},{selected:8,checked:5,partial:1,failed:1});
  const degraded=(await call("/crypto-monitor-run-get",{})).body.run;
  assert.equal(degraded.status,"degraded");
  assert.match(degraded.summary,/ · 5 of 8 wallets read · 1 partial · 1 failed · 1 not checked$/);
  await check(call,true,{},{selected:8,checked:7,partial:0,failed:0});
  assert.equal((await call("/crypto-monitor-run-get",{})).body.run.status,"degraded","a wallet left unchecked is not a clean run");
  await check(call,true,{},{selected:8,checked:8,partial:0,failed:0});
  assert.equal((await call("/crypto-monitor-run-get",{})).body.run.status,"ok");
});

test("a run's start replaces the last result, and a run that never reports reads as failed, not as the run before it",async()=>{
  const {call,values,puts}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  values.set("crypto-monitor-run",{finished_at:new Date(Date.now()-6*3600000).toISOString(),selected:8,checked:8,partial:0,failed:0});
  puts.length=0;
  await call("/crypto-monitor-targets",{limit:8});
  assert.deepEqual(puts,[["crypto-monitor-cursor","crypto-monitor-run","crypto-monitor-pending"]],"the start, and the wallets it owes a result for, cost no write of their own");
  const running=(await call("/crypto-monitor-run-get",{})).body.run;
  assert.equal(running.status,"running");
  assert.match(running.summary,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · Running: 1 wallets to read$/);

  values.set("crypto-monitor-run",{started_at:new Date(Date.now()-16*60000).toISOString(),selected:8});
  const lost=(await call("/crypto-monitor-run-get",{})).body.run;
  assert.equal(lost.status,"failed");
  assert.equal(lost.finished_at,"");
  assert.match(lost.summary,/ UTC · FAILED: the run never reported a result for its 8 wallets$/);
  values.set("crypto-monitor-run",{started_at:new Date(Date.now()-13*3600000).toISOString(),selected:8});
  assert.match((await call("/crypto-monitor-run-get",{})).body.run.summary,/its 8 wallets · OVERDUE: no later run has reported$/);
});

test("no run yet reads as none, and a run older than two missed runs is overdue",async()=>{
  const {call,values}=harness();
  assert.equal((await call("/crypto-monitor-run-get",{})).body.run,null);
  assert.equal((await get(call)).monitor_run,null);
  values.set("crypto-monitor-run",{finished_at:new Date(Date.now()-13*3600000).toISOString(),selected:8,checked:8,partial:0,failed:0});
  const {run}=(await call("/crypto-monitor-run-get",{})).body;
  assert.equal(run.stale,true);
  assert.match(run.summary,/8 of 8 wallets read · OVERDUE: no later run has reported$/);
});

test("an empty baseline keeps the time the wallet was first found empty, and a baseline with activity has none",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const save=snapshot=>monitorUpdate(call,{snapshot,alerts:[],check:{ok:true,error:""}});
  await save({checked_at:"2026-11-03T00:00:00.000Z",newest_tx_id:"",newest_tx_time:"",empty_since:"2026-11-01T00:00:00.000Z"});
  assert.equal((await watchNow(call)).last_snapshot.empty_since,"2026-11-01T00:00:00.000Z");
  const page=await get(call);
  assert.equal((await put(call,page.workspace,page.revision)).status,200);
  assert.equal((await watchNow(call)).last_snapshot.empty_since,"2026-11-01T00:00:00.000Z","a page save keeps it");
  await save({checked_at:"2026-11-04T00:00:00.000Z",newest_tx_id:"",newest_tx_time:""});
  assert.equal((await watchNow(call)).last_snapshot.empty_since,"2026-11-04T00:00:00.000Z","with no time of its own, an empty read was first found empty when it was taken");
  await save({checked_at:"2026-11-05T00:00:00.000Z",newest_tx_id:"tx1",newest_tx_time:"2026-11-04T12:00:00.000Z",empty_since:"2026-11-01T00:00:00.000Z"});
  assert.equal("empty_since" in (await watchNow(call)).last_snapshot,false);
});

// ---------------------------------------------------------------- saves that fail, and runs that never report

const SANCTIONS_ALERT={type:"SANCTIONS_EXPOSURE",severity:"HIGH",title:"Direct exposure to a sanctioned address",detail:"d",tx_id:"tx9"};

test("an update sent again under the same id saves nothing twice: failures, alerts and the check-failing alert count once",async()=>{
  const {call}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const send=(id,alerts=[])=>call("/crypto-monitor-update",{update_id:id,updates:[
    {username:"analyst",watch_id:"w1",snapshot:null,alerts,check:{ok:false,error:"Blockstream transaction history: HTTP 503"}}
  ]});
  assert.deepEqual((await send("run-1",[SANCTIONS_ALERT])).body,{ok:true,alerts_added:1,missing:0});
  // The retry of an attempt whose answer was lost gets the same answer.
  assert.deepEqual((await send("run-1",[SANCTIONS_ALERT])).body,{ok:true,alerts_added:1,missing:0});
  assert.equal((await watchNow(call)).monitor.failures,1);
  await send("run-2");
  assert.equal((await send("run-3")).body.alerts_added,1,"the third failure in a row raises CHECK_FAILING");
  assert.equal((await send("run-3")).body.alerts_added,1);
  const {workspace}=await get(call);
  assert.equal(workspace.watchlist[0].monitor.failures,3);
  assert.deepEqual(workspace.alerts.map(alert=>alert.type),["CHECK_FAILING","SANCTIONS_EXPOSURE"]);
});

test("a run that never reports leaves each wallet it owed a result a failed check when the next run starts",async()=>{
  let offset=0;
  const {call,values}=harness(["analyst"],{clock:()=>Date.now()+offset});
  const tron={...WATCH,id:"t1",chain:"tron",address:"T"+"1".repeat(33)};
  // Three wallets, so every run selects all of them, as it does for any rotation of 8 or fewer.
  await put(call,{...empty,watchlist:[WATCH,{...WATCH,id:"w2"},tron]},0);
  const start=async()=>(await call("/crypto-monitor-targets",{limit:8,readable_chains:["bitcoin","ethereum"]})).body;
  const byId=async()=>new Map((await get(call)).workspace.watchlist.map(item=>[item.id,item]));
  const first=await start();
  assert.match(first.run_id,/^[0-9a-f-]{36}$/);
  assert.equal(values.get("crypto-monitor-run").run_id,first.run_id);
  const lost=values.get("crypto-monitor-pending");
  assert.deepEqual(lost.watches.map(item=>item.watch_id),["w1","w2"],"nothing is owed for a wallet on a chain the run cannot read");
  // The run never reports, and a CHECK NOW reads w2 while it is out.
  offset=60000;
  await call("/crypto-monitor-update",{update_id:"check-now",updates:[{username:"analyst",watch_id:"w2",snapshot:null,alerts:[],check:{ok:true,error:""}}]});
  // Ten minutes in, the run may still be running: a start then (a schedule firing twice) marks nothing.
  offset=10*60000;
  await start();
  assert.equal((await byId()).get("w1").monitor,undefined);
  values.set("crypto-monitor-pending",lost);

  offset=6*3600000;
  const second=await start();
  let watches=await byId();
  assert.equal(watches.get("w1").monitor.failures,1);
  assert.match(watches.get("w1").monitor.last_error,/^The automatic run that selected this wallet at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC never reported a result\.$/);
  assert.equal(watches.get("w2").monitor.failures,0,"checked since the run started");
  assert.equal(watches.get("t1").monitor,undefined);
  assert.equal(values.get("crypto-monitor-pending").run_id,second.run_id);
  // The same lost run seen again marks nothing twice.
  const current=values.get("crypto-monitor-pending");
  values.set("crypto-monitor-pending",lost);
  offset+=60000;
  await start();
  assert.equal((await byId()).get("w1").monitor.failures,1);
  values.set("crypto-monitor-pending",current);
  // The next two runs lose the same wallets: the third failure in a row raises the one CHECK_FAILING alert.
  for(let run=0;run<2;run++){offset+=6*3600000;await start();}
  watches=await byId();
  assert.equal(watches.get("w1").monitor.failures,3);
  assert.equal(watches.get("w2").monitor.failures,2,"w2 was lost by the two runs after its CHECK NOW");
  const failing=(await get(call)).workspace.alerts.filter(alert=>alert.type==="CHECK_FAILING");
  assert.deepEqual(failing.map(alert=>alert.watch_id),["w1"]);
  assert.match(failing[0].detail,/never reported a result\.$/);
});

test("a run's report clears what it owed, and a run a later one replaced can overwrite neither record",async()=>{
  const {call,values}=harness();
  await put(call,{...empty,watchlist:[WATCH]},0);
  const report=runId=>call("/crypto-monitor-update",{update_id:runId,updates:[
    {username:"analyst",watch_id:"w1",snapshot:null,alerts:[],check:{ok:true,error:""}}
  ],run:{selected:1,checked:1,partial:0,failed:0}});
  const older=(await call("/crypto-monitor-targets",{limit:8})).body.run_id;
  const newer=(await call("/crypto-monitor-targets",{limit:8})).body.run_id;
  await report(older);
  assert.equal((await call("/crypto-monitor-run-get",{})).body.run.status,"running");
  assert.equal(values.get("crypto-monitor-pending").run_id,newer);
  assert.equal(values.get("crypto-monitor-pending").watches.length,1);
  await report(newer);
  assert.equal((await call("/crypto-monitor-run-get",{})).body.run.status,"ok");
  assert.deepEqual(values.get("crypto-monitor-pending").watches,[]);
});

test("a workspace that cannot be written loses only its analyst's results, and the answer and the run record say so",async()=>{
  let refuse=true;
  const {call,values}=harness(["analyst","other"],{
    failPut:keys=>refuse&&keys.includes("crypto-workspace:other")?new RangeError("string or blob too big: SQLITE_TOOBIG"):null
  });
  values.set("crypto-workspace:analyst",{...empty,username:"analyst",watchlist:[WATCH]});
  values.set("crypto-workspace:other",{...empty,username:"other",watchlist:[{...WATCH,id:"o1"}]});
  const {run_id}=(await call("/crypto-monitor-targets",{limit:8})).body;
  const snapshot={checked_at:"t",newest_tx_id:"new",newest_tx_time:"2026-11-05T00:00:00Z"};
  const body={update_id:run_id,updates:[
    {username:"analyst",watch_id:"w1",snapshot,alerts:[SANCTIONS_ALERT],check:{ok:true,error:""}},
    {username:"other",watch_id:"o1",snapshot,alerts:[],check:{ok:true,error:""}}
  ],run:{selected:2,checked:2,partial:0,failed:0}};
  const error=console.error;
  console.error=()=>{};
  let first;
  try{first=await call("/crypto-monitor-update",body);}
  finally{console.error=error;}
  assert.equal(first.status,503);
  assert.deepEqual(first.body,{error:"1 monitoring result(s) could not be saved.",alerts_added:1,missing:0,unsaved:1});
  const analyst=values.get("crypto-workspace:analyst");
  assert.equal(analyst.watchlist[0].last_snapshot.newest_tx_id,"new");
  assert.deepEqual(analyst.alerts.map(alert=>alert.type),["SANCTIONS_EXPOSURE"],"the other analyst's workspace does not hold up this one");
  assert.equal(values.get("crypto-workspace:other").watchlist[0].last_snapshot,null);
  let run=(await call("/crypto-monitor-run-get",{})).body.run;
  assert.equal(run.status,"degraded");
  assert.match(run.summary,/ UTC · 2 of 2 wallets read · 1 not saved$/);
  assert.deepEqual(values.get("crypto-monitor-pending").watches,[{username:"other",watch_id:"o1"}]);

  // The Worker's retry, once the workspace can be written: the rest is saved, and nothing twice.
  refuse=false;
  const retry=await call("/crypto-monitor-update",body);
  assert.deepEqual(retry.body,{ok:true,alerts_added:1,missing:0});
  assert.equal(values.get("crypto-workspace:analyst").alerts.length,1);
  assert.equal(values.get("crypto-workspace:other").watchlist[0].last_snapshot.newest_tx_id,"new");
  run=(await call("/crypto-monitor-run-get",{})).body.run;
  assert.equal(run.status,"ok");
  assert.match(run.summary,/ UTC · 2 of 2 wallets read$/);
  assert.deepEqual(values.get("crypto-monitor-pending").watches,[]);
});
