const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const read=file=>fs.readFileSync(file,"utf8").replace(/\r\n/g,"\n");
const plain=value=>JSON.parse(JSON.stringify(value));

const logged=[];
const context=vm.createContext({
  URLSearchParams,AbortSignal,
  console:{log:(...a)=>logged.push(a.join(" ")),error:(...a)=>logged.push(a.join(" "))}
});
vm.runInContext(read("cloudflare-worker/schedule-dispatcher.js").replace(/export \{[\s\S]*?\};\s*$/,""),context);
const {DISPATCH_CRON,SCHEDULE_SLOTS,dueSlots,parisMinuteOfDay,runScheduleDispatcher,slotExpression,slotTitle}=
  vm.runInContext("({DISPATCH_CRON,SCHEDULE_SLOTS,dueSlots,parisMinuteOfDay,runScheduleDispatcher,slotExpression,slotTitle})",context);

const ON={GITHUB_DISPATCH_TOKEN:"test-value-not-a-token",SCHEDULE_DISPATCH_ENABLED:"true"};
const SIX_HOUR_CRON="17 */6 * * *";
const at=iso=>Date.parse(iso);
const posts=calls=>calls.filter(call=>call.init.method==="POST");
const morningMap=()=>SCHEDULE_SLOTS.find(slot=>slot.workflow==="update-map.yml"&&slot.hour===10);

function github(runs=[],{listStatus=200,postStatus=204}={}){
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url:String(url),init});
    if(init.method==="POST")return {ok:postStatus<300,status:postStatus};
    return {ok:listStatus<300,status:listStatus,json:async()=>({workflow_runs:runs})};
  };
  return {calls,fetcher};
}

// The real scheduled() from index.js, with its two jobs replaced by recorders.
function scheduledHandler({crypto=async()=>{}}={}){
  const source=read("cloudflare-worker/index.js").match(/async scheduled\(controller, env, ctx\) \{[\s\S]*?\n\}(?=\n\};)/)[0];
  const calls=[],errors=[],waits=[];
  const sandbox=vm.createContext({
    DISPATCH_CRON,
    console:{error:message=>errors.push(message)},
    runCryptoMonitor:env=>{calls.push({job:"crypto",env});return crypto();},
    runScheduleDispatcher:async(env,time)=>{calls.push({job:"dispatch",env,time});return [];}
  });
  const {scheduled}=vm.runInContext(`({${source}})`,sandbox);
  const fire=async(controller,env)=>{
    await scheduled(controller,env,{waitUntil:promise=>waits.push(promise)});
    await Promise.all(waits);
  };
  return {calls,errors,waits,fire};
}

// The input names under `workflow_dispatch: inputs:`.
function dispatchInputs(yaml){
  const block=yaml.match(/^ {2}workflow_dispatch:\n((?:(?: {4}.*)?\n)+)/m)?.[1]||"";
  return [...block.matchAll(/^ {6}([a-z_]+):$/gm)].map(match=>match[1]);
}

test("without the secret or without the switch nothing is contacted",async()=>{
  for(const env of [{},undefined,{GITHUB_DISPATCH_TOKEN:"   ",SCHEDULE_DISPATCH_ENABLED:"true"},
    {GITHUB_DISPATCH_TOKEN:"x"},{GITHUB_DISPATCH_TOKEN:"x",SCHEDULE_DISPATCH_ENABLED:"false"},{SCHEDULE_DISPATCH_ENABLED:"true"}]){
    const {calls,fetcher}=github();
    assert.deepEqual(plain(await runScheduleDispatcher(env,at("2026-11-05T09:17:00Z"),fetcher)),[]);
    assert.equal(calls.length,0);
  }
});

test("as shipped, a token added early starts nothing",async()=>{
  const shipped=read("cloudflare-worker/wrangler.toml").match(/^SCHEDULE_DISPATCH_ENABLED = "(.*)"$/m)[1];
  assert.equal(shipped,"false");
  const {calls,fetcher}=github();
  await runScheduleDispatcher({GITHUB_DISPATCH_TOKEN:"x",SCHEDULE_DISPATCH_ENABLED:shipped},at("2026-11-05T09:17:00Z"),fetcher);
  assert.equal(calls.length,0);
});

test("a quiet tick makes no request",async()=>{
  const {calls,fetcher}=github();
  assert.deepEqual(plain(await runScheduleDispatcher(ON,at("2026-11-05T12:17:00Z"),fetcher)),[]);
  assert.equal(calls.length,0);
});

test("10:17 Paris dispatches update-map with daily mode, its slot and a User-Agent",async()=>{
  const {calls,fetcher}=github();
  const result=await runScheduleDispatcher(ON,at("2026-11-05T09:17:00Z"),fetcher); // CET
  assert.deepEqual(plain(result),[{slot:"update-map.yml 17 10 * * *",outcome:"dispatched"}]);
  assert.equal(calls.length,2);
  assert.match(calls[0].url,/pro-map\/CT-Atlas\/actions\/workflows\/update-map\.yml\/runs\?event=workflow_dispatch&per_page=100&created=%3E%3D2026-11-05T09%3A17%3A00Z$/);
  assert.equal(calls[1].init.method,"POST");
  assert.match(calls[1].url,/pro-map\/CT-Atlas\/actions\/workflows\/update-map\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(calls[1].init.body),{ref:"main",inputs:{mode:"daily",slot:"17 10 * * *"}});
  for(const call of calls){
    assert.equal(call.init.headers["User-Agent"],"CT-Atlas-Schedule-Dispatcher/1.0");
    assert.equal(call.init.headers.Authorization,"Bearer test-value-not-a-token");
  }
});

test("the same slot in summer falls one hour earlier in UTC",async()=>{
  const {calls,fetcher}=github();
  const result=await runScheduleDispatcher(ON,at("2027-07-05T08:17:00Z"),fetcher); // CEST
  assert.equal(result[0].outcome,"dispatched");
  assert.equal(JSON.parse(calls[1].init.body).inputs.slot,"17 10 * * *");
});

test("a slot that already started is not dispatched again, on any later tick",async()=>{
  const {calls,fetcher}=github([{display_title:slotTitle(morningMap()),conclusion:null}]);
  const result=await runScheduleDispatcher(ON,at("2026-11-05T09:17:00Z"),fetcher);
  assert.deepEqual(plain(result),[{slot:"update-map.yml 17 10 * * *",outcome:"already_started"}]);
  assert.equal(posts(calls).length,0);
});

test("a manual run with another title does not count as the slot; a cancelled one neither",async()=>{
  const {calls,fetcher}=github([{display_title:"Daily CT Intelligence Map Update",conclusion:"success"},
    {display_title:slotTitle(morningMap()),conclusion:"cancelled"}]);
  await runScheduleDispatcher(ON,at("2026-11-05T09:17:00Z"),fetcher);
  assert.equal(posts(calls).length,1);
});

test("GitHub failures neither throw nor POST blind, and never print the token",async()=>{
  logged.length=0;
  for(const options of [{listStatus:503},{listStatus:401},{postStatus:401},{postStatus:422},{postStatus:500}]){
    const {calls,fetcher}=github([],options);
    const result=await runScheduleDispatcher(ON,at("2026-11-05T09:17:00Z"),fetcher);
    assert.equal(result[0].outcome,"failed");
    if(options.listStatus)assert.equal(posts(calls).length,0);
  }
  const unreachable=async()=>{throw new Error("network down");};
  assert.equal((await runScheduleDispatcher(ON,at("2026-11-05T09:17:00Z"),unreachable))[0].outcome,"failed");
  assert.ok(logged.length>0);
  assert.ok(!logged.join("\n").includes("test-value-not-a-token"));
});

test("a failed tick is retried on the next ones, and stops once started",async()=>{
  let posted=0,up=false;
  const started=new Map();
  const workflowOf=url=>String(url).match(/workflows\/([^/]+)\//)[1];
  const fetcher=async(url,init={})=>{
    if(init.method==="POST"){
      if(!up)return {ok:false,status:502};
      posted++;
      started.set(workflowOf(url),`Slot ${JSON.parse(init.body).inputs.slot}`);
      return {ok:true,status:204};
    }
    const title=started.get(workflowOf(url));
    return {ok:true,status:200,json:async()=>({workflow_runs:title?[{display_title:title,conclusion:null}]:[]})};
  };
  const first=await runScheduleDispatcher(ON,at("2026-11-05T17:17:00Z"),fetcher);
  up=true;
  const second=await runScheduleDispatcher(ON,at("2026-11-05T17:27:00Z"),fetcher);
  const third=await runScheduleDispatcher(ON,at("2026-11-05T17:37:00Z"),fetcher);
  assert.equal(first[0].outcome,"failed");
  assert.equal(second.find(r=>r.slot.startsWith("update-map")).outcome,"dispatched");
  assert.equal(third.find(r=>r.slot.startsWith("update-map")).outcome,"already_started");
  assert.equal(third.find(r=>r.slot.startsWith("daily-radnuc")).outcome,"already_started");
  assert.equal(posted,2); // update-map once, RadNuc 18:27 once
});

test("every slot has three ticks in its window on all 366 days, across both clock changes",()=>{
  const cronMinutes=DISPATCH_CRON.split(" ")[0].split(",").map(Number);
  const parisDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Paris"});
  const start=at("2026-11-01T00:00:00Z"),end=at("2027-11-02T00:00:00Z");
  const hits=new Map();
  for(let ms=start;ms<end;ms+=60000){
    if(!cronMinutes.includes(new Date(ms).getUTCMinutes()))continue;
    for(const slot of dueSlots(ms)){
      const key=`${parisDay.format(new Date(ms))}|${slot.workflow}|${slotExpression(slot)}`;
      hits.set(key,[...(hits.get(key)||[]),{ms,startedAt:slot.startedAt}]);
    }
  }
  assert.equal(hits.size,((end-start)/86400000)*SCHEDULE_SLOTS.length,"every slot on every day");
  for(const [key,list] of hits){
    assert.equal(list.length,3,key);
    assert.equal(new Set(list.map(hit=>hit.startedAt)).size,1,`one start time for ${key}`);
    assert.equal(list[0].ms,list[0].startedAt,`first tick is exactly on the slot ${key}`);
    const [minute,hour]=key.split("|")[2].split(" ").map(Number);
    assert.equal(parisMinuteOfDay(list[0].startedAt),hour*60+minute,key);
  }
});

test("the six-hour cron runs the crypto monitor as before and never the dispatcher",async()=>{
  const env={marker:"env"};
  const handler=scheduledHandler();
  await handler.fire({cron:SIX_HOUR_CRON,scheduledTime:at("2026-11-05T12:17:00Z")},env);
  assert.equal(handler.calls.length,1);
  assert.equal(handler.calls[0].job,"crypto");
  assert.equal(handler.calls[0].env,env);
  assert.equal(handler.waits.length,1);
});

test("a trigger without a cron string still means the crypto monitor",async()=>{
  const handler=scheduledHandler();
  await handler.fire({},{});
  assert.deepEqual(handler.calls.map(call=>call.job),["crypto"]);
});

test("a crypto monitor failure stays logged and contained",async()=>{
  const handler=scheduledHandler({crypto:async()=>{throw new Error("explorer down");}});
  await handler.fire({cron:SIX_HOUR_CRON},{});
  assert.deepEqual(handler.errors,["Scheduled Crypto monitoring failed"]);
});

test("the ten-minute cron runs the dispatcher with its scheduled time and never the crypto monitor",async()=>{
  const env={marker:"env"};
  const time=at("2026-11-05T09:17:00Z");
  const handler=scheduledHandler();
  await handler.fire({cron:DISPATCH_CRON,scheduledTime:time},env);
  assert.equal(handler.calls.length,1);
  assert.equal(handler.calls[0].job,"dispatch");
  assert.equal(handler.calls[0].env,env);
  assert.equal(handler.calls[0].time,time);
  assert.equal(handler.waits.length,1);
});

test("wrangler.toml keeps the six-hour cron, adds the dispatcher's and holds no token",()=>{
  const toml=read("cloudflare-worker/wrangler.toml");
  assert.deepEqual(JSON.parse(toml.match(/^crons = (\[.*\])$/m)[1]),[SIX_HOUR_CRON,DISPATCH_CRON]);
  assert.doesNotMatch(toml,/^GITHUB_DISPATCH_TOKEN\s*=/m);
});

test("index.js wires the module, and /health says whether the token is set, never its value",()=>{
  const index=read("cloudflare-worker/index.js");
  assert.match(index,/import \{ DISPATCH_CRON, runScheduleDispatcher \} from "\.\/schedule-dispatcher\.js";/);
  assert.ok(index.includes("schedule_dispatcher_configured: Boolean(env.GITHUB_DISPATCH_TOKEN)"));
  assert.equal(index.match(/GITHUB_DISPATCH_TOKEN/g).length,1);
});

test("every dispatched workflow declares what the dispatcher sends: GitHub answers 422 otherwise",()=>{
  for(const slot of SCHEDULE_SLOTS){
    const declared=dispatchInputs(read(`.github/workflows/${slot.workflow}`));
    for(const input of [...Object.keys(slot.inputs||{}),"slot"]){
      assert.ok(declared.includes(input),`${slot.workflow} lacks input ${input}`);
    }
  }
});

test("every dispatched workflow titles a slot run the way the dispatcher looks for it",()=>{
  assert.equal(slotTitle(SCHEDULE_SLOTS[0]),"Slot 37 7 * * *");
  for(const slot of SCHEDULE_SLOTS){
    const yaml=read(`.github/workflows/${slot.workflow}`);
    assert.ok(yaml.includes("\nrun-name: ${{ inputs.slot && format('Slot {0}', inputs.slot) || github.workflow }}\n"),slot.workflow);
  }
});

test("update-map treats a dispatched slot like the schedule and keeps the schedule path for a rollback",()=>{
  const yaml=read(".github/workflows/update-map.yml");
  assert.ok(yaml.includes("CT_ATLAS_SCHEDULE: ${{ github.event.schedule || inputs.slot || '' }}"));
  assert.ok(yaml.includes("(github.event.schedule == '17 10 * * *' || inputs.slot == '17 10 * * *' || (github.event_name == 'workflow_dispatch' && inputs.slot == ''))"));
});

test("update-map's slots are the ones the daily ledger accepts",()=>{
  const ledger=read("daily_reliability.py").match(/^SLOTS = \((.*)\)$/m)[1].match(/'[^']+'/g).map(text=>text.slice(1,-1));
  assert.deepEqual(plain(SCHEDULE_SLOTS.filter(slot=>slot.workflow==="update-map.yml").map(slot=>slotExpression(slot))),ledger);
});
