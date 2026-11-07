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

async function rig(extra={}){
  const {ReportGate}=await entry;
  const storage=new Storage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:USERS});
  const gateCalls=[];
  const env={
    AUTH_USERS_JSON:USERS,SANCTIONS_URL,...extra,
    REPORT_GATE:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      gateCalls.push({path:new URL(url).pathname,body:JSON.parse(init.body)});
      return gate.fetch(new Request(url,init));
    }})}
  };
  return {env,storage,gateCalls};
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

// Blockstream as `answer(wallet,page)` describes it, page being "info", "txs" or "older"; null is an outage.
async function withBlockstream(answer,run){
  const calls=[],saved=globalThis.fetch,log=console.log,warn=console.warn,error=console.error;
  globalThis.fetch=async url=>{
    const parsed=new URL(String(url));
    calls.push(parsed.hostname+parsed.pathname);
    if(parsed.hostname==="sanctions.test")return json(LIST);
    const parts=parsed.pathname.split("/");
    if(parsed.hostname!=="blockstream.info"||parts[2]!=="address")return json({error:"not stubbed"},503);
    const body=answer(parts[3],parts[4]?parts[5]?"older":"txs":"info");
    return body===null?json({error:"unavailable"},503):json(body);
  };
  console.log=console.warn=console.error=()=>{};
  try{return {result:await run(),calls};}
  finally{globalThis.fetch=saved;console.log=log;console.warn=warn;console.error=error;}
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
async function budgetRun(page){
  (await sanctions).resetSanctionsCache();
  const setup=await rig();
  const wallets=Array.from({length:8},(_,index)=>p2pkh("budget"+index));
  const rows=new Map(wallets.map(wallet=>[wallet,history(wallet,60)]));
  await seed(setup,wallets.map((wallet,index)=>watch("w"+index,wallet,baselineOf(rows.get(wallet)))));
  const {runCryptoMonitor}=await monitor;
  const {result,calls}=await withBlockstream((wallet,kind)=>page(kind,rows.get(wallet)),()=>runCryptoMonitor(setup.env));
  return {result,calls,setup};
}

const FULL=(kind,rows)=>kind==="info"?info(rows.length):kind==="txs"?rows.slice(0,25):rows.slice(25,50);
const PARTIAL=(kind,rows)=>kind==="older"?null:FULL(kind,rows);
const DOWN=()=>null;

test("a run spends the same 42 subrequests as before at most, whatever the providers answer, and recording costs no call",async()=>{
  // Where each call goes: 1 target read, 1 sanctions list, and per wallet 3 Blockstream reads, 1 label
  // lookup and 1 update. With Blockstream down a wallet stops after 2 reads and still sends its update.
  for(const [name,page,expected,status] of [["full",FULL,42,"ok"],["partial",PARTIAL,42,"failed"],["down",DOWN,25,"failed"]]){
    const {result,calls,setup}=await budgetRun(page);
    const updates=setup.gateCalls.filter(call=>call.path==="/crypto-monitor-update");
    assert.equal(updates.length,8,name+": every wallet reports, whatever its read");
    assert.equal(updates.filter(call=>call.body.run).length,1,name+": the run's outcome rides on an update already made");
    assert.ok(updates.at(-1).body.run,name);
    assert.deepEqual([...new Set(setup.gateCalls.map(call=>call.path))].sort(),
      (name==="down"?["/crypto-monitor-targets","/crypto-monitor-update"]:["/crypto-exchange-labels-lookup","/crypto-monitor-targets","/crypto-monitor-update"]),name);
    const total=calls.length+setup.gateCalls.length;
    assert.equal(total,expected,name+" spent "+total);
    assert.ok(total<=42,name);
    assert.equal(result.status,status,name);
  }
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

// The workspace route checks the session with the gate first.
function withSession(binding){
  return {idFromName:binding.idFromName,get:id=>{
    const stub=binding.get(id);
    return {fetch:async(url,init)=>new URL(url).pathname==="/session-get"?json({username:"analyst"}):stub.fetch(url,init)};
  }};
}
