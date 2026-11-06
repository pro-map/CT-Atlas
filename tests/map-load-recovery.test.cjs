// Audit, 6 Nov: when every map file failed, "Database unavailable" went to a hidden
// element and the page stayed on "Loading database..." with an empty map. A request
// that hung, or a response that sent 1 MB and stalled, timed out never, ran no
// fallback and blocked the refresh poll, so only a reload recovered.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");

function extract(name){
  const start=html.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  let depth=0,i=html.indexOf("{",start);
  for(;i<html.length;i++){
    if(html[i]==="{")depth++;
    else if(html[i]==="}"&&--depth===0)break;
  }
  return html.slice(start,i+1);
}

// A clock the test moves by hand, so a 30 s stall takes no real time.
function clockContext(extra={}){
  let now=0,nextId=1;
  const timers=new Map();
  const context=vm.createContext({AbortController,TransformStream,Response,console:{error(){},warn(){}},
    setTimeout:(callback,ms)=>{timers.set(nextId,{callback,at:now+ms});return nextId++;},
    clearTimeout:id=>timers.delete(id),...extra});
  vm.runInContext("const MAP_DOWNLOAD_STALL_MS = 30000;"+extract("guardMapDownload"),context);
  return {context,advance(ms){
    now+=ms;
    for(const [id,timer] of [...timers]){if(timer.at<=now){timers.delete(id);timer.callback();}}
  },pending:()=>timers.size};
}
const settled=promise=>promise.then(()=>"resolved",()=>"rejected");
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function hangingFetch(){
  return (url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")));
  });
}

test("a request that never answers is aborted after 30 s of silence",async()=>{
  const h=clockContext();
  const result=settled(h.context.guardMapDownload(signal=>hangingFetch()("x",{signal})));
  h.advance(29999);await tick();
  h.advance(1);
  assert.equal(await result,"rejected");
});

function stallingResponse(chunks){
  let controller;
  const body=new ReadableStream({start(c){controller=c;for(const chunk of chunks)c.enqueue(chunk);}});
  return {response:new Response(body),send:chunk=>controller.enqueue(chunk),end:()=>controller.close()};
}

test("a response that stalls midway is aborted, and the body read fails instead of hanging",async()=>{
  const h=clockContext();
  const {response}=stallingResponse([new Uint8Array(1024)]);
  const aborted=new Promise(resolve=>{h.context.onAbort=resolve;});
  const read=h.context.guardMapDownload((signal,watch)=>{
    signal.addEventListener("abort",()=>h.context.onAbort(true));
    return Promise.resolve(response).then(watch).then(answer=>new Promise((resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("aborted")));
      answer.arrayBuffer().then(resolve,reject);
    }));
  });
  await tick();
  h.advance(30000);
  assert.equal(await aborted,true);
  assert.equal(await settled(read),"rejected");
});

test("a slow link that keeps delivering is not cut off, however long it takes",async()=>{
  const h=clockContext();
  const {response,send,end}=stallingResponse([]);
  const read=h.context.guardMapDownload((signal,watch)=>Promise.resolve(response).then(watch).then(answer=>answer.arrayBuffer()));
  await tick();
  for(let chunk=0;chunk<10;chunk++){
    h.advance(25000);
    send(new Uint8Array(100));
    await tick();await tick();
  }
  end();
  assert.equal((await read).byteLength,1000,"250 s in total, never 30 s of silence");
  assert.equal(h.pending(),0,"the timer ends with the download");
});

test("the status of the answer survives the watchdog",async()=>{
  const h=clockContext();
  const answer=await h.context.guardMapDownload((signal,watch)=>Promise.resolve(new Response("gone",{status:404})).then(watch));
  assert.equal(answer.ok,false);
  assert.equal(answer.status,404);
});

test("a test double without a stream body passes through untouched",async()=>{
  const h=clockContext();
  const double={ok:true,json:async()=>({})};
  assert.equal(await h.context.guardMapDownload((signal,watch)=>Promise.resolve(double).then(watch)),double);
});

function element(id){
  return {id,textContent:"",children:[],replaceChildren(...items){this.children=items;this.textContent=items.filter(item=>typeof item==="string").join("");},
    append(...items){this.children.push(...items);this.textContent+=items.filter(item=>typeof item==="string").join("");},
    addEventListener(type,listener){this.listener=listener;}};
}
function pageHarness(loader){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
  const applied=[];
  const c=vm.createContext({document:{getElementById:node,createElement:element},console:{error(){}},
    loadMapDatabase:loader,renderCollectionStatus(){},applyMapDatabase:data=>applied.push(data),
    clearMapRefreshBackoff(){},mapInitialLoadComplete:false});
  vm.runInContext("let mapLoadFailed = false; let mapLoadPromise = null;"+extract("renderMapLoadFailure")+extract("startMapLoad"),c);
  return {c,node,applied};
}
const retryIn=node=>node.children.find(child=>typeof child!=="string");

test("a total failure is visible in the header, with a Retry that works",async()=>{
  let fail=true;
  const h=pageHarness(async()=>{if(fail)throw new Error("all three files failed");return {events:[]};});
  await h.c.startMapLoad();
  assert.equal(h.node("lastUpdated").textContent.trim(),"Database unavailable");
  const button=retryIn(h.node("lastUpdated"));
  assert.equal(button.textContent,"RETRY");
  assert.equal(h.c.mapInitialLoadComplete,true,"the refresh poll is released");
  assert.equal(vm.runInContext("mapLoadFailed",h.c),true);
  fail=false;
  const pending=button.listener();
  assert.equal(h.node("lastUpdated").textContent,"Loading database...");
  await pending;
  assert.equal(h.applied.length,1);
  assert.equal(vm.runInContext("mapLoadFailed",h.c),false);
});

test("two clicks on Retry share one attempt",async()=>{
  let loads=0,finish;
  const h=pageHarness(()=>{loads++;return new Promise(resolve=>{finish=resolve;});});
  const first=h.c.startMapLoad();
  assert.equal(h.c.startMapLoad(),first);
  assert.equal(loads,1);
  finish({events:[]});
  await first;
});

test("map files revalidate instead of downloading whole: every visit cost 3.8 MB for data that changes twice a day",()=>{
  assert.match(extract("loadMapDatabase"),/fetch\("events-map\.json", \{ cache: "no-cache", signal \}\)/);
  assert.match(extract("loadEventsDatabase"),/"events-lite\.json", \{ cache: "no-cache", signal \}/);
  assert.match(extract("loadEventsDatabase"),/"events\.json", \{ cache: "no-cache", signal \}/);
  assert.match(extract("refreshMapPublication"),/fetch\("publication-manifest\.json", \{ cache: "no-store" \}\)/);
  assert.match(extract("readMapSnapshotResponse"),/digest\("SHA-256", bytes\)/,"the integrity check stays on the received bytes");
});

test("the fallback chain runs after a stall: map hangs, lite answers",async()=>{
  const requests=[];
  const h=clockContext({window:{},Date,Number,Array,TextDecoder,crypto:globalThis.crypto,
    fetch:(url,options)=>{
      requests.push(url);
      if(url==="events-map.json")return hangingFetch()(url,options);
      return Promise.resolve({ok:true,json:async()=>({events:[{id:"a",category:"Attacks",published:new Date().toISOString()}]})});
    }});
  vm.runInContext(["isJudicialCategory","isRetiredJudicialEvent","isMapAttackEvent","removeRetiredJudicialData","eventMatchKey","readMapSnapshotResponse","loadEventsDatabase","loadMapDatabase"].map(extract).join("\n")+
    "const MAP_RECENT_EVENT_DAYS = 181;",h.context);
  const load=vm.runInContext("loadMapDatabase()",h.context);
  await tick();
  h.advance(30000);
  const data=await load;
  assert.deepEqual(requests,["events-map.json","events-lite.json"]);
  assert.equal(h.context.window.eventsDataSource,"events-lite.json");
  assert.equal(data.events.length,1);
});
