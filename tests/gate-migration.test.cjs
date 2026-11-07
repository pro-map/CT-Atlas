// What one request can do to the next through the EU gate migration. The other Worker tests give
// the gate no jurisdiction(), so ensureEuGateMigrated returns at once there and none of this runs.
//
// The answer depends on an isolate's module state, so isolate() loads a fresh copy of the Worker,
// over real ReportGates in memory that outlive it, as Durable Objects outlive an isolate. A call
// that never returns stands for what the runtime does when a request ends: it drops that request's
// pending calls, and whatever was awaiting them never settles.
const {test,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {pathToFileURL}=require("node:url");

const READ="/crypto-provider-status-get";
const COMPLETE="__eu_migration_complete";
const never=new Promise(()=>{});

const copies=fs.mkdtempSync(path.join(os.tmpdir(),"ct-atlas-isolate-"));
after(()=>fs.rmSync(copies,{recursive:true,force:true}));
let isolates=0;

async function isolate(){
  const dir=path.join(copies,String(++isolates));
  fs.cpSync(path.join(__dirname,"../cloudflare-worker"),dir,{recursive:true});
  const load=file=>import(pathToFileURL(path.join(dir,file)).href);
  const [shared,health,worker]=await Promise.all([load("shared.js"),load("crypto-provider-health.js"),load("index.js")]);
  return {gateCall:shared.gateCall,runCryptoProviderProbe:health.runCryptoProviderProbe,app:worker.default,ReportGate:worker.ReportGate};
}

class Storage{
  constructor(entries={}){this.values=new Map(Object.entries(entries));this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){
    if(key&&typeof key==="object"){for(const [k,v] of Object.entries(key))this.values.set(k,structuredClone(v));return;}
    this.values.set(key,structuredClone(value));
  }
  async delete(key){for(const k of Array.isArray(key)?key:[key])this.values.delete(k);}
  async deleteAll(){this.values.clear();}
  async list({prefix="",startAfter,end,limit=Infinity}={}){
    const keys=[...this.values.keys()].sort().filter(k=>k.startsWith(prefix)&&(startAfter===undefined||k>startAfter)&&(end===undefined||k<end));
    return new Map(keys.slice(0,limit).map(k=>[k,structuredClone(this.values.get(k))]));
  }
  async transaction(fn){return fn(this);}
  async getAlarm(){return this.alarm;}
  async setAlarm(when){this.alarm=when;}
  async deleteAlarm(){this.alarm=null;}
}

// One real ReportGate. Requests take turns, as a Durable Object's input gate makes them do.
function durableObject(ReportGate,name,entries,calls,before){
  const storage=new Storage(entries);
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:"{}"});
  let turn=Promise.resolve();
  const inTurn=run=>{
    const result=turn.then(run,run);
    turn=result.catch(()=>{});
    return result;
  };
  const stub={fetch:async(url,init)=>{
    const gatePath=new URL(url).pathname;
    calls.push(name+" "+gatePath);
    const answer=await before?.(gatePath);
    return answer||inTurn(()=>gate.fetch(new Request(url,init)));
  }};
  return {storage,stub};
}

// `before` runs ahead of each gate call, and can hold it, drop it, fail it or answer it.
function gates(ReportGate,{migrated=true,legacy={},eu={},before}={}){
  const calls=[];
  const euObject=durableObject(ReportGate,"eu",migrated?{[COMPLETE]:{completed_at:"2026-09-25T00:00:00.000Z"},...eu}:eu,calls,before);
  const legacyObject=durableObject(ReportGate,"legacy",legacy,calls,before);
  const namespace=object=>({idFromName:name=>name,get:()=>object.stub});
  const env={ALLOWED_ORIGIN:"https://ct-atlas.com",REPORT_GATE:{...namespace(legacyObject),jurisdiction:()=>namespace(euObject)}};
  return {env,calls,eu:euObject.storage,legacy:legacyObject.storage,count:call=>calls.filter(entry=>entry===call).length};
}

// A hang has to fail the test, not stall it.
async function within(work,ms=2000){
  let timer;
  const hung=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("still waiting after "+ms+" ms")),ms);});
  try{return await Promise.race([work,hung]);}finally{clearTimeout(timer);}
}

const get=(app,env,route,headers={})=>app.fetch(new Request("https://worker.test"+route,{headers}),env,{waitUntil(){}});
const sessionCheck=(app,env)=>get(app,env,"/session-check",{"X-Session-Token":"nobody"});

function legacySessions(count){
  return Object.fromEntries(Array.from({length:count},(_,i)=>["session:"+String(i).padStart(4,"0"),{from:"legacy",i}]));
}

async function quietly(run){
  const saved=console.error;
  console.error=()=>{};
  try{return await run();}finally{console.error=saved;}
}

// A request that ends.
test("a request that ends during the migration check cannot hang the next one",async()=>{
  const {gateCall,ReportGate}=await isolate();
  let dropped=false;
  const {env}=gates(ReportGate,{before:gatePath=>{
    if(gatePath==="/migration-status"&&!dropped){dropped=true;return never;}
  }});
  gateCall(env,READ,{});
  assert.equal((await within(gateCall(env,READ,{}))).status,200);
});

test("/health outliving its bound on a cold isolate leaves session checks working",async()=>{
  const {app,ReportGate}=await isolate();
  let cold=true;
  const {env}=gates(ReportGate,{before:()=>cold?never:undefined});
  const started=Date.now();
  const response=await get(app,env,"/health");
  const took=Date.now()-started;
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.ok,true);
  assert.equal(body.crypto_provider_status.read_failed,true);
  assert.ok(took<1500,"took "+took+" ms");
  cold=false;
  assert.equal((await within(sessionCheck(app,env))).status,401,"answered, and nobody is signed in");
});

test("a session check sent while /health is still waiting is not held up by it",async()=>{
  const {app,ReportGate}=await isolate();
  let healthOver=false;
  const {env}=gates(ReportGate,{before:gatePath=>!healthOver&&(gatePath===READ||gatePath==="/migration-status")?never:undefined});
  const health=get(app,env,"/health");
  healthOver=true;
  assert.equal((await within(sessionCheck(app,env))).status,401);
  assert.equal((await health).status,200);
});

test("the probe's claim outliving its bound leaves later gate calls working",async()=>{
  const {gateCall,runCryptoProviderProbe,ReportGate}=await isolate();
  let cold=true;
  const {env}=gates(ReportGate,{before:()=>cold?never:undefined});
  let upstream=0;
  const finished=await quietly(()=>runCryptoProviderProbe(env,Date.parse("2026-11-06T22:27:00Z"),{fetcher:async()=>{upstream++;},gateTimeoutMs:30}));
  assert.equal(finished,false);
  assert.equal(upstream,0);
  cold=false;
  assert.equal((await within(gateCall(env,READ,{}))).status,200);
});

test("a pass cut off halfway is finished by the next request, with nothing lost",async()=>{
  const {gateCall,ReportGate}=await isolate();
  let imports=0;
  let stopped;
  const cutOff=new Promise(resolve=>{stopped=resolve;});
  const setup=gates(ReportGate,{migrated:false,legacy:legacySessions(600),before:gatePath=>{
    if(gatePath==="/migration-import"&&++imports===2){stopped();return never;}
  }});
  gateCall(setup.env,READ,{});
  await within(cutOff);
  assert.equal(await setup.eu.get(COMPLETE),undefined);
  assert.equal(setup.legacy.values.size,600,"an unfinished pass retires nothing");
  assert.equal((await within(gateCall(setup.env,READ,{}))).status,200);
  assert.equal(setup.eu.values.size,601,"600 sessions and the mark");
  assert.equal(setup.legacy.values.size,0);
});

// What the flag costs.
test("the steady path pays for one check per isolate and no more",async()=>{
  const {gateCall,ReportGate}=await isolate();
  const {env,calls}=gates(ReportGate);
  for(let i=0;i<6;i++)await gateCall(env,READ,{});
  assert.deepEqual(calls,["eu /migration-status",...Array(6).fill("eu "+READ)]);
});

test("a check that fails is not remembered as a success",async()=>{
  const {gateCall,ReportGate}=await isolate();
  let down=true;
  const setup=gates(ReportGate,{before:gatePath=>{
    if(down&&gatePath==="/migration-status")throw new Error("gate down");
  }});
  await assert.rejects(gateCall(setup.env,READ,{}),/gate down/);
  down=false;
  assert.equal((await gateCall(setup.env,READ,{})).status,200);
  assert.equal((await gateCall(setup.env,READ,{})).status,200);
  assert.equal(setup.count("eu /migration-status"),2);
});

// A status nobody can read says nothing, so it must not count as migrated: that would strand
// every session in the legacy object.
for(const [failure,answer] of [["a 500",()=>new Response("gate error",{status:500})],
  ["a 200 that is not JSON",()=>new Response("<html>proxy</html>")]]){
  test("a status check answering "+failure+" still moves an unmigrated gate",async()=>{
    const {gateCall,ReportGate}=await isolate();
    const setup=gates(ReportGate,{migrated:false,legacy:legacySessions(3),
      before:gatePath=>gatePath==="/migration-status"?answer():undefined});
    await within(gateCall(setup.env,READ,{}));
    assert.equal(setup.eu.values.size,4);
    assert.deepEqual(await setup.eu.get("session:0002"),{from:"legacy",i:2});
    assert.equal(setup.legacy.values.size,0);
  });
}

// Concurrent first requests.
test("concurrent first requests on a migrated gate all answer, then the checks stop",async()=>{
  const {gateCall,ReportGate}=await isolate();
  const setup=gates(ReportGate);
  const answers=await within(Promise.all(Array.from({length:5},()=>gateCall(setup.env,READ,{}))));
  assert.deepEqual(answers.map(answer=>answer.status),[200,200,200,200,200]);
  assert.ok(setup.count("eu /migration-status")<=5,"at most one each, and only while the isolate is cold");
  assert.equal(setup.calls.some(call=>/migration-(export|import|finalize|retire)/.test(call)),false);
  const checks=setup.count("eu /migration-status");
  await gateCall(setup.env,READ,{});
  assert.equal(setup.count("eu /migration-status"),checks);
});

test("concurrent first requests on an unmigrated gate move everything, and none goes on before it is there",async()=>{
  const {gateCall,ReportGate}=await isolate();
  const setup=gates(ReportGate,{migrated:false,legacy:legacySessions(600)});
  await within(Promise.all(Array.from({length:5},()=>gateCall(setup.env,READ,{}))));
  assert.equal(setup.eu.values.size,601);
  assert.deepEqual(await setup.eu.get("session:0599"),{from:"legacy",i:599});
  assert.equal(setup.legacy.values.size,0);
  assert.ok(setup.calls.indexOf("eu "+READ)>setup.calls.indexOf("eu /migration-finalize"));
});

for(const shape of ["in one isolate","across two isolates"]){
  test("a pass that lags behind cannot put old data back over a user's change, "+shape,async()=>{
    const first=await isolate();
    const second=shape==="in one isolate"?first:await isolate();
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    let imports=0;
    const setup=gates(first.ReportGate,{migrated:false,legacy:legacySessions(1),before:gatePath=>{
      if(gatePath==="/migration-import"&&++imports===2)return held;
    }});
    const leading=first.gateCall(setup.env,READ,{});
    const lagging=second.gateCall(setup.env,READ,{});
    await within(leading);
    assert.ok(await setup.eu.get(COMPLETE));
    await setup.eu.put("session:0000",{from:"a user, after the migration"});
    release();
    await within(lagging);
    assert.deepEqual(await setup.eu.get("session:0000"),{from:"a user, after the migration"});
  });
}

test("the gate refuses an import once it is marked complete, and takes one before",async()=>{
  const {ReportGate}=await isolate();
  const post=(gate,route,body)=>gate.fetch(new Request("https://gate.internal"+route,{method:"POST",body:JSON.stringify(body)}));
  const storage=new Storage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:"{}"});
  assert.deepEqual(await (await post(gate,"/migration-import",{entries:[["session:a",1]]})).json(),{ok:true,imported:1});
  await post(gate,"/migration-finalize",{imported:1});
  assert.deepEqual(await (await post(gate,"/migration-import",{entries:[["session:a",2]]})).json(),{ok:true,imported:0});
  assert.equal(await storage.get("session:a"),1);
});

// /health stays out of it.
test("/health makes one gate call on a cold isolate, and it is the read",async()=>{
  const {app,ReportGate}=await isolate();
  const record={checked_at:new Date().toISOString(),providers:{blockstream:{status:"ok",checked_at:new Date().toISOString(),message:""}}};
  const {env,calls}=gates(ReportGate,{eu:{"crypto-provider-status":record}});
  const {crypto_provider_status:status}=await (await get(app,env,"/health")).json();
  assert.deepEqual(calls,["eu "+READ]);
  assert.equal(status.providers.blockstream.status,"ok");
  assert.equal(status.stale,false);
  assert.equal(status.read_failed,undefined);
});

test("/health cannot start the migration, and says no run has finished yet",async()=>{
  const {app,ReportGate}=await isolate();
  const setup=gates(ReportGate,{migrated:false,legacy:legacySessions(3)});
  const response=await get(app,setup.env,"/health");
  const body=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(body.crypto_provider_status,{checked_at:null,stale:false,providers:{}});
  assert.deepEqual(setup.calls,["eu "+READ]);
  assert.equal(setup.legacy.values.size,3,"the public route left the legacy object alone");
  assert.equal(await setup.eu.get(COMPLETE),undefined);
});

test("/health still answers on a jurisdiction gate when the read fails",async()=>{
  const {app,ReportGate}=await isolate();
  const {env}=gates(ReportGate,{before:()=>{throw new Error("gate down");}});
  const response=await within(get(app,env,"/health"));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.ok,true);
  assert.equal(body.crypto_provider_status.read_failed,true);
});
