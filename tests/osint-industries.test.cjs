const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const source=fs.readFileSync("cloudflare-worker/osint-industries.js","utf8").replace(/^import[^\n]+\n/,"").replace(/export /g,"");
const id="00000000-0000-4000-8000-000000000001";
const fixture=[{module:"example",status:"found",query:"analyst@example.com",from:"User supplied email.",reliable_source:true,
  front_schemas:[{module:"Example Platform",body:{}}],spec_format:[
    {registered:{value:true},username:{proper_key:"Username",value:"example_one"},profile_url:{value:"https://example.com/one"},platform_variables:[{key:"followers",proper_key:"Followers",value:0}]},
    {registered:{value:true},username:{proper_key:"Username",value:"example_two"},profile_url:{value:"javascript:alert(1)"},private:{proper_key:"Private",value:false}}
  ]},{module:"no-match",status:"not_found",data:{registered:false}},{module:"slow-module",status:"timeout"}];
function harness({fetchImpl,gateImpl}={}){
  const calls=[];
  const gate=gateImpl|| (async(env,path,body)=>{calls.push({path,body});return Response.json(path==="/session-get"?{username:"group-i-1"}:{ok:true});});
  const context=vm.createContext({fetch:fetchImpl||(async()=>Response.json(fixture)),gateCall:gate,isAllowedUser:name=>name==="group-i-1",cleanText:(x,max=700)=>String(x||"").replace(/\s+/g," ").trim().slice(0,max),corsHeaders:()=>({"Content-Type":"application/json"}),Response,Request,AbortSignal,TextDecoder,Uint8Array,URL,console});
  vm.runInContext(source+"\nglobalThis.api={parseSearch,normalizeResults,handleOSINTIndustries};",context);
  return {...context.api,calls};
}
const env={OSINT_INDUSTRIES_API_KEY:"server-only-key"};
const request=(body={},path="search",token="session")=>new Request("https://worker.test/social-osint/"+path,{method:path==="status"?"GET":"POST",headers:{"Content-Type":"application/json",...(token?{"X-Session-Token":token}:{})},...(path==="status"?{}:{body:JSON.stringify({type:"email",query:"analyst@example.com",request_id:id,...body})})});

test("validates all five selectors, phone country codes, and refuses oversized or multiline searches",()=>{
  const h=harness(),search=(type,query)=>h.parseSearch({type,query,request_id:id,premium:true});
  assert.equal(search("phone","+33 (1) 23-45-67-89").query,"+33123456789");
  assert.equal(search("phone","0123456789"),null);assert.equal(search("email","not-email"),null);
  assert.equal(search("username","@user_one").query,"user_one");assert.equal(search("username","https://example.com/x"),null);
  assert.ok(search("name","Example Person"));assert.ok(search("wallet","0x"+"a".repeat(40)));
  assert.equal(search("email","a@example.com\nother@example.com"),null);assert.equal(search("email","a".repeat(321)),null);
  assert.equal(search("unsupported","x"),null);assert.equal(search("email","x@example.com").premium,false);
});
test("provider spec-format preserves multiple profiles, booleans and zeros without inferring a match from arbitrary data",()=>{
  const normalized=harness().normalizeResults([...fixture,{module:"unknown",data:{count:1}}]);
  assert.equal(normalized.cards.length,5);assert.equal(normalized.matches,2);assert.equal(normalized.unavailable,1);
  assert.equal(normalized.cards[0].fields.find(f=>f.label==="Followers").value,0);
  assert.equal(normalized.cards[1].fields.find(f=>f.label==="Private").value,false);
  assert.equal(normalized.cards[1].profile_url,"");assert.equal(normalized.cards[4].status,"unknown");
});
test("source responses and exports never receive the API key even if echoed by a provider",()=>{
  const value=harness().normalizeResults([{module:"test",status:"found",data:{"api-key":env.OSINT_INDUSTRIES_API_KEY,note:"key="+env.OSINT_INDUSTRIES_API_KEY}}],env.OSINT_INDUSTRIES_API_KEY);
  assert.ok(!JSON.stringify(value).includes(env.OSINT_INDUSTRIES_API_KEY));
});
test("rejects missing or expired authentication before any provider call",async()=>{
  let fetched=0;const h=harness({fetchImpl:async()=>{fetched++;throw Error();}});
  assert.equal((await h.handleOSINTIndustries(request({},"search",""),env)).status,401);assert.equal(fetched,0);
  const expired=harness({gateImpl:async()=>Response.json({error:"expired"},{status:401}),fetchImpl:async()=>{fetched++;}});
  assert.equal((await expired.handleOSINTIndustries(request(),env)).status,401);assert.equal(fetched,0);
});
test("unconfigured status stays honest and consumes no provider calls",async()=>{
  const h=harness({fetchImpl:async()=>{throw Error("must not fetch");}});
  const status=await (await h.handleOSINTIndustries(request({},"status"),{})).json();
  assert.equal(status.configured,false);assert.equal(status.credits,null);
  assert.equal((await h.handleOSINTIndustries(request(),{})).status,503);
});
test("credits use the documented endpoint and remain unknown when the provider cannot be verified",async()=>{
  const h=harness({fetchImpl:async(url,options)=>{assert.equal(url,"https://api.osint.industries/misc/credits");assert.equal(options.headers["api-key"],env.OSINT_INDUSTRIES_API_KEY);return Response.json({credits:150});}});
  const body=await (await h.handleOSINTIndustries(request({},"status"),env)).json();assert.equal(body.credits,150);assert.equal(body.connection,"verified");
  const failed=harness({fetchImpl:async()=>Response.json({error:env.OSINT_INDUSTRIES_API_KEY},{status:401})});
  const rejected=await (await failed.handleOSINTIndustries(request({},"status"),env)).json();assert.equal(rejected.connection,"rejected");assert.equal(rejected.credits,null);
});
test("invalid input never reserves a credit-consuming search",async()=>{
  const h=harness({fetchImpl:async()=>{throw Error("must not fetch");}});
  assert.equal((await h.handleOSINTIndustries(request({query:"bad"}),env)).status,400);
  assert.ok(h.calls.every(call=>call.path==="/session-get"));
});
test("search uses one POST, server-only auth, nonpremium exact matching, and releases its reservation",async()=>{
  let submitted=0;
  const h=harness({fetchImpl:async(url,options)=>{submitted++;assert.equal(url,"https://api.osint.industries/v2/request");assert.equal(options.method,"POST");assert.equal(options.redirect,"error");assert.equal(options.headers["api-key"],env.OSINT_INDUSTRIES_API_KEY);const body=JSON.parse(options.body);assert.equal(body.timeout,60);assert.equal(body.premium,false);assert.equal(body.exact_match,true);assert.ok(!body.request_id);return Response.json(fixture);}});
  const response=await h.handleOSINTIndustries(request({user_id:"admin",premium:true}),env),body=await response.json();
  assert.equal(response.status,200);assert.equal(submitted,1);assert.equal(body.matches,2);assert.equal(body.modules_returned,3);
  assert.match(response.headers.get("Cache-Control"),/no-store/);assert.equal(h.calls.at(-1).body.release,true);
  assert.ok(h.calls.every(call=>!call.body.username||call.body.username==="group-i-1"));
});
test("duplicates or busy searches never reach the provider",async()=>{
  const h=harness({gateImpl:async(env,path)=>Response.json(path==="/session-get"?{username:"group-i-1"}:{error:"already submitted"},{status:path==="/session-get"?200:409}),fetchImpl:async()=>{throw Error("must not fetch");}});
  assert.equal((await h.handleOSINTIndustries(request(),env)).status,409);
});
test("provider errors are sanitized, never retried and always release the lease",async()=>{
  for(const [upstream,expected] of [[401,503],[402,402],[429,429],[500,502]]){
    let calls=0;const h=harness({fetchImpl:async()=>{calls++;return Response.json({error:env.OSINT_INDUSTRIES_API_KEY},{status:upstream});}});
    const response=await h.handleOSINTIndustries(request(),env);assert.equal(response.status,expected);assert.ok(!(await response.text()).includes(env.OSINT_INDUSTRIES_API_KEY));assert.equal(calls,1);assert.equal(h.calls.at(-1).body.release,true);
  }
});
test("empty module lists are valid; malformed provider responses fail rather than reporting fabricated absence",async()=>{
  assert.equal(harness().normalizeResults([]).matches,0);assert.throws(()=>harness().normalizeResults({error:"no data"}));
  const h=harness({fetchImpl:async()=>new Response("not-json")});assert.equal((await h.handleOSINTIndustries(request(),env)).status,502);assert.equal(h.calls.at(-1).body.release,true);
});
test("the client safely renders provider fields, provides downloads and uses the authenticated session",()=>{
  const client=fs.readFileSync("social.js","utf8"),html=fs.readFileSync("social.html","utf8");
  assert.ok(!client.includes("innerHTML"));assert.ok(!client.includes("localStorage"));assert.ok(!client.includes("api-key"));
  for(const type of ["email","phone","username","name","wallet"])assert.ok(html.includes('value="'+type+'"'));
  assert.ok(client.includes("ct_map_session_token"));assert.ok(client.includes("CTAtlasPdf.download"));assert.ok(client.includes("JSON.stringify(results,null,2)"));
});

test("Durable Object serializes search reservations, blocks replay and leaves other users' leases intact",async()=>{
  const sharedURL="data:text/javascript;base64,"+Buffer.from(fs.readFileSync("cloudflare-worker/shared.js","utf8")).toString("base64");
  const gateSource=fs.readFileSync("cloudflare-worker/report-gate.js","utf8").replace('from"./shared.js";','from"'+sharedURL+'";');
  const {ReportGate}=await import("data:text/javascript;base64,"+Buffer.from(gateSource).toString("base64"));
  class Storage{constructor(){this.values=new Map();this.queue=Promise.resolve();}async get(key){return structuredClone(this.values.get(key));}async put(key,value){this.values.set(key,structuredClone(value));}transaction(fn){const pending=this.queue.then(()=>fn(this));this.queue=pending.catch(()=>{});return pending;}}
  const storage=new Storage(),gate=new ReportGate({storage},{AUTH_USERS_JSON:JSON.stringify({"group-i-1":"a".repeat(64),"group-i-2":"b".repeat(64)})});
  const reserve=(username,request_id,release=false)=>gate.fetch(new Request("https://gate.internal/osint-industries-limit",{method:"POST",body:JSON.stringify({username,request_id,release})}));
  const id2=id.slice(0,-1)+"2",id3=id.slice(0,-1)+"3";
  assert.equal((await reserve("group-i-1",id)).status,200);
  assert.equal((await reserve("group-i-1",id)).status,409);
  assert.equal((await reserve("group-i-1",id2)).status,429);
  assert.equal((await reserve("group-i-2",id2)).status,200);
  await reserve("group-i-1",id3,true);assert.equal((await reserve("group-i-1",id3)).status,429);
  await reserve("group-i-1",id,true);assert.equal((await reserve("group-i-1",id3)).status,200);
  assert.equal((await reserve("group-i-2",id3)).status,429);
});
