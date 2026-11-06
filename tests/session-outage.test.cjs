// Audit, 6 Nov: an aborted request or a 503 on /session-check removed a valid
// token and showed a login screen that needs the same Worker, even though the map
// data had loaded. Only the Worker's own refusal may end a session.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");
const main=fs.readFileSync("main.html","utf8");

function extract(source,name){
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  let depth=0,i=source.indexOf("{",start);
  for(;i<source.length;i++){
    if(source[i]==="{")depth++;
    else if(source[i]==="}"&&--depth===0)break;
  }
  return source.slice(start,i+1);
}
const storage=entries=>{
  const map=new Map(Object.entries(entries));
  return {getItem:key=>map.has(key)?map.get(key):null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};
};
const stored={ct_map_session_token:"token",ct_map_username:"analyst",ct_map_authorized:"yes",ct_map_session_expires:"2099-01-01T00:00:00Z"};

function mapPage(fetch){
  const state={locked:0,unlocked:[],redirects:[],timers:[],note:{hidden:true}};
  const sessionStorage=storage(stored);
  const c=vm.createContext({sessionStorage,fetch,console:{warn(){}},URLSearchParams,String,Error,
    window:{location:{search:"?workspace=map",replace:url=>state.redirects.push(url)}},
    document:{getElementById:id=>id==="sessionCheckNote"?state.note:null},
    setTimeout:(callback,ms)=>state.timers.push({callback,ms}),
    API_BASE:"https://worker",TOKEN_KEY:"ct_map_session_token",SESSION_USER_KEY:"ct_map_username",
    TOKEN_EXPIRY_KEY:"ct_map_session_expires",SESSION_RECHECK_MS:60000,
    lock(){state.locked++;},unlock(user){state.unlocked.push(user);}});
  vm.runInContext(extract(html,"showSessionCheckNote")+"async "+extract(html,"restoreSession"),c);
  return {c,state,sessionStorage};
}

for(const [label,fetch] of [
  ["an aborted request",async()=>{throw new TypeError("Failed to fetch");}],
  ["a 503 from the Worker",async()=>new Response("upstream failed",{status:503})],
  ["a 500 with a JSON error",async()=>Response.json({error:"boom"},{status:500})],
  ["a 200 that is not the Worker's answer",async()=>new Response("<html>proxy</html>",{status:200})],
]){
  test(`${label} keeps the token, the page and a visible note, and checks again`,async()=>{
    const h=mapPage(fetch);
    await h.c.restoreSession();
    assert.equal(h.state.locked,0,"signed out on an outage");
    assert.deepEqual(h.state.unlocked,["analyst"]);
    assert.equal(h.sessionStorage.getItem("ct_map_session_token"),"token");
    assert.equal(h.state.note.hidden,false);
    assert.equal(h.state.timers.length,1);
    assert.equal(h.state.timers[0].ms,60000);
  });
}

for(const status of [401,403]){
  test(`an explicit ${status} still signs the user out`,async()=>{
    const h=mapPage(async()=>Response.json({error:"Session expired."},{status}));
    await h.c.restoreSession();
    assert.equal(h.state.locked,1);
    assert.deepEqual(h.state.unlocked,[]);
    assert.equal(h.state.timers.length,0);
  });
}

test("the check that follows an outage ends it: a valid answer clears the note, a refusal signs out",async()=>{
  let answer=new Response("down",{status:503});
  const h=mapPage(async()=>answer);
  await h.c.restoreSession();
  answer=Response.json({ok:true,username:"analyst",expires_at:"2099-02-02T00:00:00Z"});
  await h.state.timers[0].callback();
  assert.equal(h.state.note.hidden,true);
  assert.equal(h.sessionStorage.getItem("ct_map_session_expires"),"2099-02-02T00:00:00Z");
  const expired=mapPage(async()=>answer);
  answer=new Response("down",{status:503});
  await expired.c.restoreSession();
  answer=Response.json({error:"Session expired."},{status:401});
  await expired.state.timers[0].callback();
  assert.equal(expired.state.locked,1);
});

function hub(fetch,entries=stored){
  const state={replaced:[],timers:[],user:{textContent:"VERIFYING SESSION…"}};
  const sessionStorage=storage(entries);
  const c=vm.createContext({sessionStorage,fetch,String,Error,location:{replace:url=>state.replaced.push(url)},
    document:{getElementById:()=>state.user},setTimeout:(callback,ms)=>state.timers.push({callback,ms}),
    API:"https://worker",TOKEN:"ct_map_session_token",USER:"ct_map_username",EXPIRY:"ct_map_session_expires",AUTHORIZED:"ct_map_authorized"});
  vm.runInContext(extract(main,"clear")+"async "+extract(main,"verify"),c);
  return {c,state,sessionStorage};
}

test("the hub keeps the session through the same outages and names what happened",async()=>{
  for(const fetch of [async()=>{throw new TypeError("Failed to fetch");},async()=>new Response("down",{status:503})]){
    const h=hub(fetch);
    await h.c.verify();
    assert.deepEqual(h.state.replaced,[]);
    assert.equal(h.sessionStorage.getItem("ct_map_session_token"),"token");
    assert.equal(h.state.user.textContent,"ANALYST · SESSION CHECK UNAVAILABLE");
    assert.equal(h.state.timers.length,1);
  }
});

test("the hub signs out on an explicit refusal, and when it cannot say who is signed in",async()=>{
  const refused=hub(async()=>Response.json({error:"Session expired."},{status:401}));
  await refused.c.verify();
  assert.deepEqual(refused.state.replaced,["index.html"]);
  assert.equal(refused.sessionStorage.getItem("ct_map_session_token"),null);
  const anonymous=hub(async()=>new Response("down",{status:503}),{ct_map_session_token:"token"});
  await anonymous.c.verify();
  assert.deepEqual(anonymous.state.replaced,["index.html"]);
});

test("the Worker reports a failing gate as an outage, not as an expired session",()=>{
  const worker=fs.readFileSync("cloudflare-worker/index.js","utf8");
  const route=worker.slice(worker.indexOf('url.pathname === "/session-check"'),worker.indexOf('url.pathname === "/session-revoke"'));
  assert.match(route,/sessionResponse\.status >= 500\) return jsonResponse\(\{ error: "Session check unavailable\." \}, 503, env\)/);
  assert.ok(route.indexOf("status >= 500")<route.indexOf('"Session expired." }, 401, env);\nreturn'),"checked before the 401");
});
