// The 6-hour monitor on the real Worker and the real gate, with every upstream call and every gate
// call recorded: what a run spends, and what a bad read may and may not change.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");

const entry=import("../cloudflare-worker/index.js");
const monitor=import("../cloudflare-worker/crypto-monitor.js");
const sanctions=import("../cloudflare-worker/sanctions.js");
const healthStatus=import("../cloudflare-worker/health-status.js");

const USERS=JSON.stringify({analyst:"0".repeat(64)});
const SANCTIONS_URL="https://sanctions.test/sanctions-crypto.json";
const KEY="crypto-workspace:analyst";
const HOUR=3600000;
const NOW=Date.now();
const LISTED="1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const LIST={
  version:"sanctions-crypto-v1",retrieved_at:new Date(NOW).toISOString(),
  sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-11-01"}],
  entities:[{id:"1",name:"SYNTHETIC FINANCIER",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],
  addresses:[{a:LISTED,c:"XBT",f:"bitcoin",e:[0]}]
};

// A well-formed P2PKH address per seed: the Worker checks the checksum before any provider call.
const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function p2pkh(seed){
  const sha=bytes=>createHash("sha256").update(bytes).digest();
  const payload=Buffer.concat([Buffer.from([0]),sha(String(seed)).subarray(0,20)]);
  const bytes=Buffer.concat([payload,sha(sha(payload)).subarray(0,4)]);
  let n=BigInt("0x"+bytes.toString("hex")),text="";
  while(n>0n){text=B58[Number(n%58n)]+text;n/=58n;}
  return "1".repeat(bytes.findIndex(byte=>byte!==0))+text;
}
const SENDER=p2pkh("sender");

class Storage{
  constructor(){this.values=new Map();}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){
    if(key&&typeof key==="object"){for(const [k,v] of Object.entries(key))this.values.set(k,structuredClone(v));return;}
    this.values.set(key,structuredClone(value));
  }
  async delete(key){for(const k of Array.isArray(key)?key:[key])this.values.delete(k);}
  async list({prefix=""}={}){
    return new Map([...this.values.keys()].sort().filter(k=>k.startsWith(prefix)).map(k=>[k,structuredClone(this.values.get(k))]));
  }
  async getAlarm(){return null;}
  async setAlarm(){}
}

// Cloudflare refuses a run's subrequests past its allowance, provider and gate calls alike.
function allowance(limit){
  let spent=0;
  return ()=>{if(++spent>limit)throw new Error("Too many subrequests.");};
}

// intercept(path,forward) may answer a gate call itself, after or instead of forward() to the gate.
async function rig(extra={},spend=()=>{},intercept=null){
  const {ReportGate}=await entry;
  const storage=new Storage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:USERS});
  const gateCalls=[];
  const env={
    AUTH_USERS_JSON:USERS,SANCTIONS_URL,...extra,
    REPORT_GATE:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      spend();
      const path=new URL(url).pathname;
      gateCalls.push({path,body:JSON.parse(init.body)});
      const forward=()=>gate.fetch(new Request(url,init));
      return (intercept&&await intercept(path,forward))||forward();
    }})}
  };
  return {env,storage,gateCalls,gate};
}

const json=(value,status=200)=>Response.json(value,{status});

// One confirmed payment of 1 BTC into `wallet`, `hoursAgo` old.
function payment(wallet,index,hoursAgo,from=SENDER){
  return {
    txid:createHash("sha256").update(wallet+":"+index).digest("hex"),fee:200,
    status:{confirmed:true,block_height:900000-index,block_time:Math.floor((NOW-hoursAgo*HOUR)/1000)},
    vin:[{prevout:{scriptpubkey_address:from,value:100000200}}],
    vout:[{scriptpubkey_address:wallet,value:100000000}]
  };
}
// `count` payments, newest first, the newest `newestHoursAgo` old and one more each hour before.
const history=(wallet,count,newestHoursAgo=48)=>Array.from({length:count},(_,index)=>payment(wallet,index,newestHoursAgo+index));
const info=count=>({chain_stats:{tx_count:count,funded_txo_sum:count*100000000,spent_txo_sum:0},mempool_stats:{tx_count:0,funded_txo_sum:0,spent_txo_sum:0}});

// Blockstream as `answer(wallet,page,attempt)` describes it: page is "info", "txs" or "older", attempt
// counts the asks for that same URL from 1, null is an outage and a number is that HTTP status.
// The Worker's pause before a rate-limit retry is cut to nothing: it changes no call.
async function withBlockstream(answer,run,spend=()=>{}){
  const calls=[],attempts=new Map(),saved=globalThis.fetch,wait=globalThis.setTimeout,log=console.log,warn=console.warn,error=console.error;
  globalThis.fetch=async url=>{
    spend();
    const parsed=new URL(String(url));
    calls.push(parsed.hostname+parsed.pathname);
    if(parsed.hostname==="sanctions.test")return json(LIST);
    const parts=parsed.pathname.split("/");
    if(parsed.hostname!=="blockstream.info"||parts[2]!=="address")return json({error:"not stubbed"},503);
    const attempt=(attempts.get(String(url))||0)+1;
    attempts.set(String(url),attempt);
    const body=answer(parts[3],parts[4]?parts[5]?"older":"txs":"info",attempt);
    return body===null?json({error:"unavailable"},503):typeof body==="number"?json({error:"rate limited"},body):json(body);
  };
  globalThis.setTimeout=(callback,_ms,...args)=>wait(callback,0,...args);
  console.log=console.warn=console.error=()=>{};
  try{return {result:await run(),calls};}
  finally{globalThis.fetch=saved;globalThis.setTimeout=wait;console.log=log;console.warn=warn;console.error=error;}
}

function watch(id,address,lastSnapshot,thresholds={}){
  return {id,chain:"bitcoin",address,label:"Watch "+id,enabled:true,categories:[],
    thresholds:{min_amount:null,aggregate_24h:null,velocity_24h:null,dormant_days:null,asset:"",...thresholds},thresholds_version:2,
    last_snapshot:lastSnapshot,created_at:"2026-11-01T00:00:00.000Z"};
}
// The baseline a full read of `rows` leaves behind.
function baselineOf(rows){
  return {checked_at:"2026-11-06T18:17:00.000Z",newest_tx_id:rows[0].txid,
    newest_tx_time:new Date(rows[0].status.block_time*1000).toISOString(),tx_count:0,aggregate_value:0,risk_label:"LOW"};
}
async function seed(setup,watchlist){
  await setup.storage.put(KEY,{version:"crypto-workspace-v1",username:"analyst",revision:1,labels:[],watchlist,cases:[],alerts:[]});
}
const saved=async setup=>setup.storage.get(KEY);

// ---------------------------------------------------------------- the subrequest budget

// A full batch of Bitcoin wallets, the dearest chain: an address read and two pages of 25 each.
async function budgetSetup(spend){
  (await sanctions).resetSanctionsCache();
  const setup=await rig({},spend);
  const wallets=Array.from({length:8},(_,index)=>p2pkh("budget"+index));
  const rows=new Map(wallets.map(wallet=>[wallet,history(wallet,60)]));
  await seed(setup,wallets.map((wallet,index)=>watch("w"+index,wallet,baselineOf(rows.get(wallet)))));
  return {setup,wallets,rows};
}
async function budgetRun(page,spend){
  const {setup,wallets,rows}=await budgetSetup(spend);
  const {runCryptoMonitor}=await monitor;
  const {result,calls}=await withBlockstream((wallet,kind,attempt)=>page(kind,rows.get(wallet),attempt,wallets.indexOf(wallet)),()=>runCryptoMonitor(setup.env),spend);
  return {result,calls,setup};
}

const FULL=(kind,rows)=>kind==="info"?info(rows.length):kind==="txs"?rows.slice(0,25):rows.slice(25,50);
const PARTIAL=(kind,rows)=>kind==="older"?null:FULL(kind,rows);
// Every ask for an older page is rate-limited: the Worker retries once, then keeps what it has.
const LIMITED=(kind,rows)=>kind==="older"?429:FULL(kind,rows);
// Every first ask is rate-limited and the retry is served.
const RETRIED=(kind,rows,attempt)=>attempt===1?429:FULL(kind,rows);
const DOWN=()=>null;
const MIXED=(kind,rows,attempt,index)=>(index<4?FULL:LIMITED)(kind,rows,attempt);

test("a run spends fewer subrequests than before, and one more only to record a run in which no wallet could be read",async()=>{
  // Each wallet costs 3 Blockstream reads and a label lookup, or 2 reads when Blockstream is down; a
  // run adds the target read and the sanctions list. Before, every wallet read in full sent an update
  // of its own: the "before" column is what the monitor spent at c23dc9d, measured with these same
  // answers. In production a fresh isolate adds one gate call (/migration-status) to both.
  for(const [name,page,spent,before,status] of [
    ["full",FULL,35,42,"ok"],
    ["partial",PARTIAL,35,34,"failed"],
    ["rate-limited older pages",LIMITED,43,42,"failed"],
    ["every first ask rate-limited",RETRIED,59,66,"ok"],
    ["Blockstream down",DOWN,18,17,"failed"],
    ["mixed",MIXED,39,42,"degraded"]
  ]){
    const {result,calls,setup}=await budgetRun(page);
    const updates=setup.gateCalls.filter(call=>call.path==="/crypto-monitor-update");
    assert.equal(updates.length,1,name+": one update saves the whole run");
    assert.equal(updates[0].body.updates.length,8,name+": every wallet reports, whatever its read");
    assert.deepEqual(updates[0].body.run,{selected:8,checked:result.checked,partial:result.partial,failed:result.failed},name);
    const total=calls.length+setup.gateCalls.length;
    assert.equal(total,spent,name+" spent "+total);
    // What it used to cost, less the updates of the wallets read in full, plus the one update.
    assert.equal(total,before-result.checked+1,name);
    assert.equal(result.status,status,name);
  }
});

test("a run that runs out of subrequests leaves a record that says so, not the clean run before it",async()=>{
  const spend=allowance(50);
  const {setup,wallets,rows}=await budgetSetup(spend);
  await setup.storage.put("crypto-monitor-run",{finished_at:new Date(NOW-6*HOUR).toISOString(),selected:8,checked:8,partial:0,failed:0});
  const {runCryptoMonitor}=await monitor;
  await assert.rejects(
    ()=>withBlockstream((wallet,kind,attempt)=>RETRIED(kind,rows.get(wallet),attempt),()=>runCryptoMonitor(setup.env),spend),
    /Too many subrequests/
  );
  // The start the gate recorded with the targets: 15 minutes on, it reads as a failed run (crypto-gate.test.cjs).
  const {run}=await (await setup.gate.fetch(new Request("https://gate.internal/crypto-monitor-run-get",{method:"POST",body:"{}"}))).json();
  assert.equal(run.status,"running");
  assert.match(run.summary,/ UTC · Running: 8 wallets to read$/,"the earlier 8 of 8 wallets read is gone");
  const workspace=await saved(setup);
  assert.deepEqual(workspace.watchlist.map(item=>item.last_snapshot),wallets.map(wallet=>baselineOf(rows.get(wallet))),"a run that was not saved moved no baseline");
});

// ---------------------------------------------------------------- what a bad read may change

test("a partial read with a sanctions hit raises its alert, marked partial, and leaves the baseline alone",async()=>{
  (await sanctions).resetSanctionsCache();
  const setup=await rig();
  const wallet=p2pkh("partial");
  const rows=history(wallet,60);
  rows[3]=payment(wallet,3,51,LISTED);
  const before=watch("w1",wallet,baselineOf(rows),{min_amount:0.5});
  await seed(setup,[before]);
  const {runCryptoMonitor}=await monitor;
  const {result}=await withBlockstream((_,kind)=>PARTIAL(kind,rows),()=>runCryptoMonitor(setup.env));
  assert.equal(result.partial,1);
  const workspace=await saved(setup);
  const exposure=workspace.alerts.filter(alert=>alert.type==="SANCTIONS_EXPOSURE");
  assert.equal(exposure.length,1);
  assert.equal(exposure[0].severity,"HIGH");
  assert.equal(exposure[0].tx_id,rows[3].txid);
  assert.match(exposure[0].detail,/SYNTHETIC FINANCIER/);
  assert.match(exposure[0].detail,/Partial read: Blockstream older transactions could not be read\. Other records may be missing from this check\.$/);
  assert.equal(workspace.alerts.length,1,"nothing else: a partial read raises no new-activity alert");
  assert.deepEqual(workspace.watchlist[0].last_snapshot,before.last_snapshot);
  assert.equal(workspace.watchlist[0].monitor.failures,1);
  assert.match(workspace.watchlist[0].monitor.last_error,/^Partial read: Blockstream older transactions/);
});

test("an empty answer keeps a baseline with activity, and the next good read raises no false alert",async()=>{
  (await sanctions).resetSanctionsCache();
  const setup=await rig();
  const wallet=p2pkh("empty");
  const rows=history(wallet,6);
  const before=watch("w1",wallet,baselineOf(rows),{min_amount:0.5});
  await seed(setup,[before]);
  const {runCryptoMonitor}=await monitor;
  await withBlockstream((_,kind)=>kind==="info"?info(6):[],()=>runCryptoMonitor(setup.env));
  let workspace=await saved(setup);
  assert.deepEqual(workspace.watchlist[0].last_snapshot,before.last_snapshot,"an empty answer never replaces a baseline with activity");
  assert.deepEqual(workspace.alerts,[]);
  assert.match(workspace.watchlist[0].monitor.last_error,/no history for a wallet with saved activity/);

  await withBlockstream((_,kind)=>kind==="info"?info(6):rows,()=>runCryptoMonitor(setup.env));
  workspace=await saved(setup);
  assert.deepEqual(workspace.alerts,[],"the six old payments are not new activity");
  assert.equal(workspace.watchlist[0].last_snapshot.newest_tx_id,rows[0].txid);
  assert.equal(workspace.watchlist[0].monitor.failures,0);
});

test("a new watch is not given an empty baseline its provider contradicts, nor one that turns its history into alerts later",async()=>{
  (await sanctions).resetSanctionsCache();
  const {runCryptoMonitor}=await monitor;
  // The page cannot set a baseline, so every new watch reaches the monitor without one.
  for(const [name,firstInfo,expectedFirst] of [
    ["the address read counts 60 transactions",()=>info(60),"failed"],
    ["the address read is down, so nothing contradicts the empty list",()=>null,"checked"]
  ]){
    const setup=await rig();
    const wallet=p2pkh("new-"+name);
    const rows=history(wallet,60);
    await seed(setup,[watch("w1",wallet,null,{min_amount:0.5})]);
    const first=await withBlockstream((_,kind)=>kind==="info"?firstInfo():[],()=>runCryptoMonitor(setup.env));
    assert.equal(first.result[expectedFirst],1,name);
    let workspace=await saved(setup);
    if(expectedFirst==="failed"){
      assert.equal(workspace.watchlist[0].last_snapshot,null,name+": no baseline from a read its provider contradicts");
      assert.equal(workspace.watchlist[0].monitor.last_error,"The provider returned no history although it counts 60 transactions for this wallet.");
    }else{
      assert.equal(workspace.watchlist[0].last_snapshot.newest_tx_id,"",name+": an empty wallet, as far as anything shows");
    }
    await withBlockstream((_,kind)=>FULL(kind,rows),()=>runCryptoMonitor(setup.env));
    workspace=await saved(setup);
    assert.deepEqual(workspace.alerts,[],name+": payments 48 to 107 hours old are not new activity");
    assert.equal(workspace.watchlist[0].last_snapshot.newest_tx_id,rows[0].txid,name);
  }
});

test("a run with every provider down is not ok, changes no baseline, and three failed runs raise one alert",async()=>{
  const {resetHealthStatusCache}=await healthStatus;
  const {default:app}=await entry;
  (await sanctions).resetSanctionsCache();
  const key="test-etherscan-key-1234567890";
  const setup=await rig({ETHERSCAN_API_KEY:key});
  const address="0x"+"7".repeat(40);
  const before={...watch("w1",address,{checked_at:"2026-11-06T18:17:00.000Z",newest_tx_id:"0x"+"a".repeat(64),newest_tx_time:"2026-11-06T10:00:00.000Z",tx_count:0,aggregate_value:0,risk_label:"LOW"}),chain:"ethereum"};
  await seed(setup,[before]);
  const {runCryptoMonitor}=await monitor;
  const saved_=globalThis.fetch,error=console.error,log=console.log;
  // A network error can quote the URL it failed on, and Etherscan's carries the key.
  globalThis.fetch=async url=>{throw new TypeError("fetch failed: "+String(url));};
  console.error=()=>{};console.log=()=>{};
  const results=[];
  try{for(let run=0;run<4;run++)results.push(await runCryptoMonitor(setup.env));}
  finally{globalThis.fetch=saved_;console.error=error;console.log=log;}

  assert.ok(results.every(result=>result.ok===false&&result.status==="failed"&&result.failed===1));
  const workspace=await saved(setup);
  assert.deepEqual(workspace.watchlist[0].last_snapshot,before.last_snapshot);
  const record=workspace.watchlist[0].monitor;
  assert.equal(record.failures,4);
  assert.equal(record.last_success_at,"2026-11-06T18:17:00.000Z");
  assert.ok(record.last_error.length>0);
  for(const secret of [key,"etherscan.io","apikey","https://"])assert.ok(!record.last_error.includes(secret),record.last_error);
  assert.deepEqual(workspace.alerts.map(alert=>alert.type),["CHECK_FAILING"],"one alert for the run of failures, not one per run");

  const page=await (await app.fetch(new Request("https://worker.test/crypto-workspace?user_id=analyst",{headers:{"X-Session-Token":"s"}}),{...setup.env,REPORT_GATE:withSession(setup.env.REPORT_GATE)},{waitUntil(){}})).json();
  assert.match(page.monitor_run.summary,/ UTC · FAILED: 0 of 1 wallets read · 1 failed$/);

  resetHealthStatusCache();
  globalThis.fetch=async()=>json({},503);
  let health;
  try{health=await (await app.fetch(new Request("https://worker.test/health/status"),setup.env,{waitUntil(){}})).json();}
  finally{globalThis.fetch=saved_;resetHealthStatusCache();}
  assert.equal(health.monitor_run.status,"failed");
  assert.equal(health.monitor_run.summary,page.monitor_run.summary);
  assert.ok(!JSON.stringify(health).includes(address),"the public summary names no wallet");
});

// ---------------------------------------------------------------- over time, and when the save fails

// A run as if the clock read `offset` ms after now.
async function runAt(setup,answer,offset){
  const {runCryptoMonitor}=await monitor;
  (await sanctions).resetSanctionsCache();
  const real=Date.now;
  Date.now=()=>real()+offset;
  try{return await withBlockstream(answer,()=>runCryptoMonitor(setup.env));}
  finally{Date.now=real;}
}
const runRecord=async setup=>(await (await setup.gate.fetch(new Request("https://gate.internal/crypto-monitor-run-get",{method:"POST",body:"{}"}))).json()).run;

test("a new wallet that reads empty twice still alerts on the payment the second empty read missed",async()=>{
  const setup=await rig();
  const wallet=p2pkh("donation");
  // A newly advertised donation wallet, empty when added. Blockstream's address read is down, so
  // nothing contradicts an empty list.
  await seed(setup,[watch("w1",wallet,null,{min_amount:0.5})]);
  const emptyRead=(_,kind)=>kind==="info"?null:[];
  const paid=payment(wallet,0,-24);
  await runAt(setup,emptyRead,0);
  const firstCheck=(await saved(setup)).watchlist[0].last_snapshot.checked_at;
  // The payment arrives a day later; two days after that the provider answers empty again.
  await runAt(setup,emptyRead,72*HOUR);
  let workspace=await saved(setup);
  assert.equal(workspace.watchlist[0].last_snapshot.empty_since,firstCheck,"the second empty read keeps the first one's time");
  await runAt(setup,(_,kind)=>kind==="info"?info(1):kind==="txs"?[paid]:[],78*HOUR);
  workspace=await saved(setup);
  assert.deepEqual(workspace.alerts.map(alert=>alert.type+" "+alert.tx_id).sort(),["LARGE_TRANSFER "+paid.txid,"NEW_TRANSACTION "+paid.txid]);
  assert.equal(workspace.watchlist[0].last_snapshot.newest_tx_id,paid.txid);
});

// Three wallets read in full, the second with a payment from a listed address in its history.
async function threeWallets(intercept){
  (await sanctions).resetSanctionsCache();
  const setup=await rig({},()=>{},intercept);
  const wallets=["save0","save1","save2"].map(p2pkh);
  const rows=new Map(wallets.map(wallet=>[wallet,history(wallet,30)]));
  rows.get(wallets[1])[2]=payment(wallets[1],2,50,LISTED);
  await seed(setup,wallets.map((wallet,index)=>watch("w"+index,wallet,baselineOf(rows.get(wallet)))));
  return {setup,wallets,rows};
}
const saves=setup=>setup.gateCalls.filter(call=>call.path==="/crypto-monitor-update");

test("a run whose save the gate refuses once is saved by the retry, its sanctions alert included",async()=>{
  let refused=0;
  const {setup,wallets,rows}=await threeWallets(path=>path==="/crypto-monitor-update"&&!refused++?json({error:"Durable Object is overloaded."},500):null);
  const {result}=await runAt(setup,(wallet,kind)=>FULL(kind,rows.get(wallet)),0);
  assert.equal(result.status,"ok");
  assert.equal(saves(setup).length,2);
  assert.equal(saves(setup)[1].body.update_id,saves(setup)[0].body.update_id);
  const workspace=await saved(setup);
  assert.deepEqual(workspace.watchlist.map(item=>item.monitor.failures),[0,0,0]);
  assert.deepEqual(workspace.watchlist.map(item=>item.last_snapshot.newest_tx_id),wallets.map(wallet=>rows.get(wallet)[0].txid));
  assert.deepEqual(workspace.alerts.filter(alert=>alert.type==="SANCTIONS_EXPOSURE").map(alert=>alert.watch_id),["w1"]);
  assert.equal(result.alerts_added,workspace.alerts.length);
  assert.match((await runRecord(setup)).summary,/ UTC · 3 of 3 wallets read$/);
});

test("a save whose answer is lost is sent once more, and the gate counts no failure or alert twice",async()=>{
  let lost=0;
  const {setup,wallets,rows}=await threeWallets(async(path,forward)=>{
    if(path!=="/crypto-monitor-update"||lost++)return null;
    await forward();
    return json({error:"Network connection lost."},500);
  });
  // The first wallet's provider is down: a failed check, counted once.
  const {result}=await runAt(setup,(wallet,kind)=>wallet===wallets[0]?null:FULL(kind,rows.get(wallet)),0);
  assert.equal(saves(setup).length,2);
  assert.equal(result.status,"degraded");
  const workspace=await saved(setup);
  assert.deepEqual(workspace.watchlist.map(item=>item.monitor.failures),[1,0,0]);
  assert.equal(workspace.alerts.filter(alert=>alert.type==="SANCTIONS_EXPOSURE").length,1);
  assert.equal(result.alerts_added,workspace.alerts.length,"the retry reports the alerts the first attempt saved");
  assert.match((await runRecord(setup)).summary,/ UTC · 2 of 3 wallets read · 1 failed$/);
});

test("the wallets of a run that never reported read CHECK FAILING once the next run starts, instead of as checked",async()=>{
  (await sanctions).resetSanctionsCache();
  let down=true;
  const setup=await rig({},()=>{},path=>down&&path==="/crypto-monitor-update"?json({error:"Durable Object is overloaded."},500):null);
  // Two batches of 8.
  const wallets=Array.from({length:16},(_,index)=>p2pkh("lost"+index));
  const rows=new Map(wallets.map(wallet=>[wallet,history(wallet,30)]));
  await seed(setup,wallets.map((wallet,index)=>watch("w"+String(index).padStart(2,"0"),wallet,baselineOf(rows.get(wallet)))));
  const answer=(wallet,kind)=>FULL(kind,rows.get(wallet));
  await assert.rejects(()=>runAt(setup,answer,0),/Durable Object is overloaded/);
  assert.equal(saves(setup).length,2,"the save was sent once more before the run gave up");
  down=false;
  const {result}=await runAt(setup,answer,6*HOUR);
  assert.equal(result.status,"ok");
  const workspace=await saved(setup);
  for(const item of workspace.watchlist.slice(0,8)){
    assert.equal(item.monitor.failures,1,item.id);
    assert.match(item.monitor.last_error,/^The automatic run that selected this wallet at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC never reported a result\.$/,item.id);
  }
  assert.deepEqual(workspace.watchlist.slice(8).map(item=>item.monitor.failures),[0,0,0,0,0,0,0,0]);
});

// The workspace route checks the session with the gate first.
function withSession(binding){
  return {idFromName:binding.idFromName,get:id=>{
    const stub=binding.get(id);
    return {fetch:async(url,init)=>new URL(url).pathname==="/session-get"?json({username:"analyst"}):stub.fetch(url,init)};
  }};
}
