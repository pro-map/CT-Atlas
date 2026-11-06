// The real probe, the real ReportGate and the real Worker entry on in-memory storage, with each
// provider answering as it really does. These load through import(), like retired-tools.test.cjs,
// because the point is how the modules fit together.
//
// Where the answers come from, all read on 2026-11-06: Etherscan's are verbatim from
// docs.etherscan.io/common-error-messages and from live keyless calls; TronGrid's rate-limit bodies
// are verbatim from developers.tron.network/reference/rate-limits. TronGrid documents no body for
// an invalid key, so that case rests on the HTTP status alone.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const entry=import("../cloudflare-worker/index.js");
const health=import("../cloudflare-worker/crypto-provider-health.js");
const analysis=import("../cloudflare-worker/crypto.js");

const KEYS={ETHERSCAN_API_KEY:"ETHERSCANKEYETHERSCANKEY1234567890",TRONGRID_API_KEY:"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"};
const TRONSCAN={TRONSCAN_TAG_LOOKUP_ENABLED:"true",TRONSCAN_API_KEY:"TRONSCANKEY-7f3e9a1c5b2d"};
const SECRETS=[...Object.values(KEYS),TRONSCAN.TRONSCAN_API_KEY];
const FAST={etherscanSpacingMs:0};
const CHAINS=["ethereum","bsc","polygon","arbitrum","base"];
const CHAIN_IDS={1:"ethereum",56:"bsc",137:"polygon",42161:"arbitrum",8453:"base"};
const SEVEN=["blockstream",...CHAINS.map(chain=>"etherscan_"+chain),"trongrid"];
const HOUR=3600000;
const at=iso=>Date.parse(iso);

const json=(value,status=200)=>()=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const html=(status=200)=>()=>new Response("<html><body>Attention required</body></html>",{status,headers:{"content-type":"text/html"}});
const notok=result=>json({status:"0",message:"NOTOK",result});

const HEALTHY={
  blockstream:json({address:"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",chain_stats:{funded_txo_count:83360,funded_txo_sum:5770674218,spent_txo_count:0,spent_txo_sum:0,tx_count:67384},mempool_stats:{funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0}}),
  etherscan:json({status:"1",message:"OK",result:"172774397764084972158218"}),
  trongrid:json({data:[{transaction_id:"a".repeat(64),type:"Transfer",value:"1"}],success:true,meta:{at:1,page_size:1}}),
  tronscan:json({blueTag:"",greyTag:"",redTag:"",publicTag:"Binance-Hot 2"})
};

function providerOf(url){
  const parsed=new URL(String(url));
  if(parsed.hostname==="blockstream.info")return "blockstream";
  if(parsed.hostname==="api.etherscan.io")return "etherscan_"+CHAIN_IDS[parsed.searchParams.get("chainid")];
  if(parsed.hostname==="api.trongrid.io")return "trongrid";
  if(parsed.hostname==="apilist.tronscanapi.com")return "tronscan";
  return parsed.hostname;
}

// `answers` maps a provider id, or "etherscan" for all five chains, to a function giving a Response.
function providers(answers={}){
  const calls=[];
  const fetcher=async(url,init={})=>{
    const id=providerOf(url);
    calls.push({id,url:String(url),init});
    const answer=answers[id]??(id.startsWith("etherscan_")?answers.etherscan:undefined)??HEALTHY[id]??HEALTHY[id.split("_")[0]];
    return answer(url,init);
  };
  return {fetcher,calls};
}

class Storage{
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){
    if(key&&typeof key==="object"){for(const [k,v] of Object.entries(key))this.values.set(k,structuredClone(v));return;}
    this.values.set(key,structuredClone(value));
  }
  async delete(key){for(const k of Array.isArray(key)?key:[key])this.values.delete(k);}
  async list({prefix="",startAfter,end,limit=Infinity}={}){
    const keys=[...this.values.keys()].sort().filter(k=>k.startsWith(prefix)&&(startAfter===undefined||k>startAfter)&&(end===undefined||k<end));
    return new Map(keys.slice(0,limit).map(k=>[k,structuredClone(this.values.get(k))]));
  }
  async transaction(fn){return fn(this);}
  async getAlarm(){return this.alarm;}
  async setAlarm(when){this.alarm=when;}
  async deleteAlarm(){this.alarm=null;}
}

// A Worker env whose REPORT_GATE is the real object. `intercept` can fail or hang a gate path.
async function rig(extra=KEYS,{intercept}={}){
  const {ReportGate}=await entry;
  const storage=new Storage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:"{}"});
  const gatePaths=[];
  // A Durable Object delivers no other event during a storage call, and the gate's routes await
  // nothing else. Plain async storage has no such input gate, so requests take turns here.
  let turn=Promise.resolve();
  const inTurn=run=>{
    const result=turn.then(run,run);
    turn=result.catch(()=>{});
    return result;
  };
  const env={
    ...extra,
    REPORT_GATE:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      const path=new URL(url).pathname;
      gatePaths.push(path);
      const stopped=intercept?.(path);
      if(stopped)return stopped;
      return inTurn(()=>gate.fetch(new Request(url,init)));
    }})}
  };
  return {env,gate,storage,gatePaths};
}

const stored=async({storage})=>storage.get("crypto-provider-status");

async function probeOnce(answers,extra=KEYS,time=at("2026-11-06T22:27:00Z")){
  const {runCryptoProviderProbe}=await health;
  const setup=await rig(extra);
  const {fetcher,calls}=providers(answers);
  assert.equal(await runCryptoProviderProbe(setup.env,time,{fetcher,...FAST}),true);
  return {...setup,calls,record:await stored(setup)};
}

// Everything printed while `run` works, and the global fetch restored after it.
async function captured(run){
  const lines=[],saved={};
  for(const name of ["log","warn","error","info"]){
    saved[name]=console[name];
    console[name]=(...args)=>lines.push(args.map(String).join(" "));
  }
  try{await run();}finally{Object.assign(console,saved);}
  return lines.join("\n");
}

async function withGlobalFetch(fetchImpl,run){
  const saved=globalThis.fetch;
  globalThis.fetch=fetchImpl;
  try{return await run();}finally{globalThis.fetch=saved;}
}

const getHealth=async env=>{
  const {default:app}=await entry;
  return app.fetch(new Request("https://worker.test/health",{headers:{Origin:"https://ct-atlas.com"}}),{...env,ALLOWED_ORIGIN:"https://ct-atlas.com"},{waitUntil(){}});
};

// Classification, one answer each.
const ETHERSCAN_ANSWERS=[
  ["a balance","ok",HEALTHY.etherscan],
  ["HTTP 200, status 0, NOTOK with an unknown reason","unavailable",notok("Error! Invalid address format")],
  ["HTTP 200, status 0, NOTOK and nothing else","unavailable",json({status:"0",message:"NOTOK",result:""})],
  ["Max rate limit","rate_limited",notok("Max rate limit reached, please use API Key for higher rate limit")],
  ["the per-second limit","rate_limited",notok("Max calls per sec rate limit reached (5/sec)")],
  ["the shared free pool, which also says upgrade","rate_limited",notok("Community Free API limit reached. Resets 2026-06-24 12:00:00 UTC. For higher, uninterrupted limits, please upgrade to API Pro: https://etherscan.io/apis")],
  ["Invalid API Key","auth_failed",notok("Invalid API Key")],
  ["Missing/Invalid API Key","auth_failed",notok("Missing/Invalid API Key")],
  ["the 30-second throttle on the IP after repeated bad keys, which proves nothing about this key","rate_limited",notok("Too many invalid api key attempts, please try again later")],
  ["status 1 that still reports a bad key","auth_failed",json({status:"1",message:"OK-Missing/Invalid API Key, rate limit of 1/5sec applied",result:"0"})],
  ["Free API access","plan_restricted",notok("Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis")],
  ["a chain Etherscan no longer serves, which no plan fixes","unavailable",notok("Missing or unsupported chainid parameter (required for v2 api), please see chainlist for the list of supported chainids")],
  ["the retired V1 notice","unavailable",notok("You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration")],
  ["a busy server","unavailable",notok("Unexpected err, timeout occurred or server too busy. Please try again later")],
  ["status 1 without a number","unavailable",json({status:"1",message:"OK",result:"soon"})],
  ["an HTTP 429","rate_limited",json({},429)],
  ["an HTTP 401","auth_failed",json({},401)],
  ["an HTTP 403 in JSON","auth_failed",json({message:"Forbidden"},403)],
  ["a firewall's 403 page, which is no verdict on the key","unavailable",html(403)],
  ["an HTTP 402","plan_restricted",json({},402)],
  ["an HTTP 503","unavailable",html(503)],
  ["a 200 page that is not JSON","unavailable",html()]
];

for(const [name,expected,answer] of ETHERSCAN_ANSWERS){
  test(`Etherscan, ${name}: ${expected}`,async()=>{
    const {record}=await probeOnce({etherscan_bsc:answer});
    assert.equal(record.providers.etherscan_bsc.status,expected);
    assert.equal(record.providers.etherscan_ethereum.status,"ok","one chain's answer stays that chain's");
  });
}

const OTHER_ANSWERS=[
  ["trongrid","TRC-20 history","ok",HEALTHY.trongrid],
  ["trongrid","an empty history","ok",json({data:[],success:true,meta:{at:1,page_size:0}})],
  ["trongrid","the V1 frequency limit","rate_limited",json({success:false,error:"The key exceeds the frequency limit",statusCode:429},429)],
  ["trongrid","the proxy API's frequency limit under a 403","rate_limited",json({Error:"The key exceeds the frequency limit"},403)],
  ["trongrid","the frequency limit under an older 503","rate_limited",json({Error:"The key exceeds the frequency limit"},503)],
  ["trongrid","an HTTP 401","auth_failed",json({},401)],
  ["trongrid","a 200 without data","unavailable",json({success:false})],
  ["blockstream","an address","ok",HEALTHY.blockstream],
  ["blockstream","an HTTP 429","rate_limited",html(429)],
  ["blockstream","an HTTP 403, with no key to blame","unavailable",json({message:"Forbidden"},403)],
  ["blockstream","an HTTP 401, with no key to blame","unavailable",json({},401)],
  ["blockstream","a 200 without chain_stats","unavailable",json({})],
  ["blockstream","a maintenance page","unavailable",html()]
];

for(const [id,name,expected,answer] of OTHER_ANSWERS){
  test(`${id}, ${name}: ${expected}`,async()=>{
    const {record}=await probeOnce({[id]:answer});
    assert.equal(record.providers[id].status,expected);
  });
}

test("every provider that fails to answer is unavailable, with fixed words and not the error's",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const fetcher=async url=>{throw new Error("network down at "+url);};
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,...FAST}),true);
  const {providers:result}=await stored(setup);
  for(const id of SEVEN){
    assert.equal(result[id].status,"unavailable",id);
    assert.equal(result[id].message,"The provider could not be reached.",id);
  }
});

test("a missing key is not_configured, costs no call, and nothing else changes",async()=>{
  const {record,calls}=await probeOnce({},{});
  assert.deepEqual(calls.map(call=>call.id),["blockstream"]);
  assert.equal(record.providers.blockstream.status,"ok");
  for(const id of [...CHAINS.map(chain=>"etherscan_"+chain),"trongrid","tronscan"])assert.equal(record.providers[id].status,"not_configured",id);
});

test("Tronscan needs both its flag and its key",async()=>{
  for(const env of [KEYS,{...KEYS,TRONSCAN_API_KEY:"x"},{...KEYS,TRONSCAN_TAG_LOOKUP_ENABLED:"true"},{...KEYS,...TRONSCAN,TRONSCAN_TAG_LOOKUP_ENABLED:"false"}]){
    const {record,calls}=await probeOnce({},env);
    assert.equal(record.providers.tronscan.status,"not_configured");
    assert.equal(calls.some(call=>call.id==="tronscan"),false);
  }
});

// The published text.
test("a provider's message keeps its meaning and loses its URL",async()=>{
  const {record}=await probeOnce({etherscan_bsc:notok("Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis")});
  assert.equal(record.providers.etherscan_bsc.message,"Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.");
});

test("an ok provider publishes no message, and a silent failure publishes the plain reason",async()=>{
  const {record}=await probeOnce({blockstream:html(),trongrid:html(503)});
  assert.equal(record.providers.etherscan_ethereum.message,"");
  assert.equal(record.providers.blockstream.message,"The provider did not return JSON.");
  assert.equal(record.providers.trongrid.message,"HTTP 503");
});

test("the sanitiser removes URLs, query strings, headers and keys, however they are written",async()=>{
  const {sanitizeProviderMessage}=await health;
  const key=KEYS.ETHERSCAN_API_KEY;
  const tron=KEYS.TRONGRID_API_KEY;
  const shaped=["a key/with+symbols=1",encodeURIComponent("a key/with+symbols=1")];
  const cases=[
    "Invalid API Key "+key,
    "Invalid API Key: "+key,
    "bad key "+key.toLowerCase(),
    "https://api.etherscan.io/v2/api?chainid=1&module=account&apikey="+key,
    "api.etherscan.io/v2/api?chainid=1&apikey="+key,
    "?chainid=1&module=account&action=balance&apikey="+key+"&tag=latest",
    "chainid=1&apikey="+key,
    "apikey="+key,
    "TRON-PRO-API-KEY: "+tron,
    "{\"TRON-PRO-API-KEY\":\""+tron+"\",\"Content-Type\":\"application/json\"}",
    "Authorization: Bearer "+tron,
    "request failed for "+tron,
    "prefix only "+key.slice(0,12),
    "suffix only "+tron.slice(-12),
    "x".repeat(100)+" "+key,
    "y ".repeat(55)+key,
    "first\n"+key+"\nlast",
    ...shaped.map(text=>"echo "+text)
  ];
  for(const text of cases){
    const clean=sanitizeProviderMessage(text,[key,tron,shaped[0]]);
    assert.ok(clean.length<=120,text);
    for(const secret of [key,tron,shaped[0],shaped[1]])assert.equal(clean.toLowerCase().includes(secret.toLowerCase()),false,text);
    assert.doesNotMatch(clean,/https?:|etherscan\.io|apikey|\?\w+=|\w+=\w+|Bearer/i,text);
    assert.equal(clean.includes(key.slice(0,12)),false,text);
    assert.equal(clean.includes(tron.slice(-12)),false,text);
  }
});

test("a URL with no scheme goes whatever its TLD, and so does an IP address",async()=>{
  const {sanitizeProviderMessage}=await health;
  assert.equal(sanitizeProviderMessage("see api.etherscan.xyz/v2/api and www.example.co.uk/path?x=1 and 10.0.0.1:8080/v1"),"see and and");
  const hosts=["api.etherscan.xyz","api.etherscan.xyz:8443","api.etherscan.xyz:8443/v2/api","www.example.co.uk","www.example.co.uk/path?x=1","node.example.xn--p1ai/rpc","API.ETHERSCAN.XYZ/V2","10.0.0.1","10.0.0.1:8080","10.0.0.1:8080/v1","192.168.1.20/rpc#top"];
  for(const host of hosts)assert.equal(sanitizeProviderMessage("failed at "+host+" today"),"failed at today",host);
});

test("broadening the host rule leaves a provider's ordinary sentences alone",async()=>{
  const {sanitizeProviderMessage}=await health;
  for(const text of [
    "Max calls per sec rate limit reached (3/sec)",
    "Community Free API limit reached. Resets 2026-06-24 12:00:00 UTC.",
    "Error! Invalid address format.",
    "Free API access is not supported for this chain. Please upgrade your api plan.",
    "Rate 3.5 per second on v1.2, e.g. now"
  ])assert.equal(sanitizeProviderMessage(text),text);
});

// The layers overlap on purpose, so each of these is a case only that layer can catch.
test("a key of any shape goes, even one too short and too odd to look like a key",async()=>{
  const {sanitizeProviderMessage}=await health;
  assert.equal(sanitizeProviderMessage("bad key k!y7 here",["k!y7"]).includes("k!y7"),false);
  assert.equal(sanitizeProviderMessage("bad key K!Y7 here",["k!y7"]).includes("K!Y7"),false,"whatever its case");
  assert.equal(sanitizeProviderMessage("bad key k%21y7 here",["k!y7"]).includes("k%21y7"),false,"or as etherscanUrl() encodes it");
  assert.equal(sanitizeProviderMessage("bad key a%20b here",["a b"]).includes("a%20b"),false,"or as encodeURIComponent does");
});

test("a long token goes even when it is no key the Worker knows: encoded, or someone else's",async()=>{
  const {sanitizeProviderMessage}=await health;
  const encoded=Buffer.from(KEYS.ETHERSCAN_API_KEY).toString("base64");
  assert.equal(sanitizeProviderMessage("echo "+encoded,[KEYS.ETHERSCAN_API_KEY]).includes(encoded),false);
  const stranger="Zk9xQ2Lm".repeat(5);
  assert.equal(sanitizeProviderMessage("trace "+stranger+" failed"),"trace [redacted] failed");
});

test("the sanitiser cuts at 120 characters only after redacting, and handles what is not text",async()=>{
  const {sanitizeProviderMessage}=await health;
  const key=KEYS.ETHERSCAN_API_KEY;
  // A cut at 120 would leave the key's first four characters, too short for any later layer to know.
  const clean=sanitizeProviderMessage("z ".repeat(58)+key+" tail",[key]);
  assert.ok(clean.length<=120);
  assert.equal(clean.includes(key.slice(0,4)),false,"a key cut in two must not leave its first half");
  assert.equal(sanitizeProviderMessage(undefined),"");
  assert.equal(sanitizeProviderMessage(null,[undefined,""]),"");
  assert.equal(sanitizeProviderMessage("Invalid API Key",["",null]),"Invalid API Key");
});

test("no key reaches the record, /health or the logs, even when every provider echoes the request",async()=>{
  const {runCryptoProviderProbe,resetCryptoProviderStatusCache}=await health;
  const echo=(url,init)=>[String(url),JSON.stringify(init?.headers||{}),"apikey="+new URL(String(url)).searchParams.get("apikey")].join(" ");
  for(const answer of [
    (url,init)=>json({status:"0",message:"NOTOK",result:"Invalid API Key "+echo(url,init)})(),
    (url,init)=>json({status:"0",message:echo(url,init),result:null})(),
    (url,init)=>json({Error:echo(url,init)},403)(),
    (url,init)=>json({error:echo(url,init),success:false,statusCode:429},429)(),
    (url,init)=>json({message:echo(url,init)},500)(),
    (url,init)=>new Response(echo(url,init),{status:502})
  ]){
    resetCryptoProviderStatusCache();
    const setup=await rig({...KEYS,...TRONSCAN});
    const {fetcher}=providers({blockstream:answer,etherscan:answer,trongrid:answer,tronscan:answer});
    let published="";
    const logs=await captured(async()=>{
      await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,...FAST});
      await runCryptoProviderProbe(setup.env,at("2026-11-06T23:27:00Z"),{fetcher,...FAST});
      published=await (await getHealth(setup.env)).text();
    });
    const saved=JSON.stringify(await stored(setup));
    assert.equal(Object.keys(JSON.parse(published).crypto_provider_status.providers).length,8);
    for(const text of [saved,published,logs]){
      for(const secret of SECRETS)assert.equal(text.includes(secret),false);
      assert.doesNotMatch(text,/apikey=|TRON-PRO-API-KEY|api\.etherscan\.io|api\.trongrid\.io/);
    }
  }
});

// The same call as a real analysis.
test("each probe is the very request a real analysis makes, with the key handled the same way",async()=>{
  const {PROBE_BITCOIN_ADDRESS,PROBE_EVM_ADDRESS,PROBE_TRON_ADDRESS}=await health;
  const {analyzeCryptoAddress}=await analysis;
  const seen=[];
  const realFetch=async(url,init={})=>{
    seen.push({id:providerOf(url),url:String(url),headers:init.headers});
    if(String(url).includes("blockstream.info"))return String(url).endsWith("/txs")?json([])():HEALTHY.blockstream();
    if(String(url).includes("api.etherscan.io"))return json({status:"0",message:"No transactions found",result:[]})();
    return HEALTHY[providerOf(url)]?.()||json({})();
  };
  const {env}=await rig({...KEYS,...TRONSCAN});
  await withGlobalFetch(realFetch,async()=>{
    await analyzeCryptoAddress(PROBE_BITCOIN_ADDRESS,"bitcoin",10,env).catch(()=>{});
    await analyzeCryptoAddress(PROBE_EVM_ADDRESS,"ethereum",10,env).catch(()=>{});
    await analyzeCryptoAddress(PROBE_EVM_ADDRESS,"bsc",10,env).catch(()=>{});
    await analyzeCryptoAddress(PROBE_TRON_ADDRESS,"tron",10,env).catch(()=>{});
  });
  const {calls:first}=await probeOnce({},{...KEYS,...TRONSCAN});
  const {runCryptoProviderProbe}=await health;
  const turns=await rig({...KEYS,...TRONSCAN});
  const {fetcher,calls:both}=providers();
  await runCryptoProviderProbe(turns.env,at("2026-11-06T22:27:00Z"),{fetcher,...FAST});
  await runCryptoProviderProbe(turns.env,at("2026-11-06T23:27:00Z"),{fetcher,...FAST});

  const sameRequest=(id,normalise=url=>url)=>{
    const probe=[...first,...both].find(call=>call.id===id);
    const real=seen.find(call=>call.id===id&&normalise(call.url)===normalise(probe.url));
    assert.ok(real,id+" asked "+probe.url+", which no real analysis asks");
    assert.deepEqual(probe.init.headers,real.headers,id);
  };
  sameRequest("blockstream");
  sameRequest("etherscan_ethereum");
  sameRequest("etherscan_bsc");
  sameRequest("trongrid",url=>url.replace(/limit=\d+/,"limit=N"));
  sameRequest("tronscan");
  assert.match(both.find(call=>call.id==="etherscan_bsc").url,new RegExp("apikey="+KEYS.ETHERSCAN_API_KEY));
  assert.equal(both.find(call=>call.id==="trongrid").init.headers["TRON-PRO-API-KEY"],KEYS.TRONGRID_API_KEY);
  assert.equal(both.find(call=>call.id==="tronscan").init.headers["TRON-PRO-API-KEY"],TRONSCAN.TRONSCAN_API_KEY);
});

test("every call of a run carries its own deadline",async()=>{
  const {calls}=await probeOnce({});
  for(const call of calls)assert.ok(call.init.signal instanceof AbortSignal,call.id);
});

test("the probe's Etherscan call is cheap on every chain: one balance, nothing paged",async()=>{
  const {calls}=await probeOnce({});
  const etherscan=calls.filter(call=>call.id.startsWith("etherscan_"));
  assert.deepEqual(etherscan.map(call=>call.id).sort(),CHAINS.map(chain=>"etherscan_"+chain).sort());
  for(const call of etherscan)assert.equal(new URL(call.url).searchParams.get("action"),"balance");
});

// Quota.
test("a run makes exactly one call per provider, seven in all, none of them Gemini",async()=>{
  const {calls}=await probeOnce({});
  assert.deepEqual(calls.map(call=>call.id).sort(),[...SEVEN].sort());
  assert.ok(calls.every(call=>!/google|gemini/i.test(call.url)));
});

test("rate limits and failures are never retried: seven stays seven",async()=>{
  const limited=await probeOnce({blockstream:html(429),etherscan:notok("Max calls per sec rate limit reached (5/sec)"),trongrid:json({error:"The key exceeds the frequency limit"},429)});
  assert.equal(limited.calls.length,7);
  assert.equal(limited.record.providers.etherscan_base.status,"rate_limited");
  const down=await probeOnce({blockstream:html(503),etherscan:html(503),trongrid:html(503)});
  assert.equal(down.calls.length,7);
});

test("with Tronscan on, a run still makes seven calls: it takes turns with Blockstream",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig({...KEYS,...TRONSCAN});
  const seen=[];
  for(let hour=0;hour<4;hour++){
    const {fetcher,calls}=providers();
    await runCryptoProviderProbe(setup.env,at("2026-11-06T01:27:00Z")+hour*HOUR,{fetcher,...FAST});
    assert.equal(calls.length,7,"hour "+hour);
    seen.push(calls.find(call=>["blockstream","tronscan"].includes(call.id)).id);
  }
  assert.deepEqual(seen,["blockstream","tronscan","blockstream","tronscan"]);
  const {providers:result}=await stored(setup);
  assert.equal(result.blockstream.status,"ok");
  assert.equal(result.tronscan.status,"ok");
  assert.ok(result.blockstream.checked_at<=result.tronscan.checked_at,"the one waiting keeps its own last check");
});

test("a Tronscan turned on later goes first, and turned off it costs nothing",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  await runCryptoProviderProbe(setup.env,at("2026-11-06T01:27:00Z"),{fetcher:providers().fetcher,...FAST});
  const on={...setup.env,...TRONSCAN};
  const later=providers();
  await runCryptoProviderProbe(on,at("2026-11-06T02:27:00Z"),{fetcher:later.fetcher,...FAST});
  assert.equal(later.calls.some(call=>call.id==="tronscan"),true);
  const off=providers();
  await runCryptoProviderProbe(setup.env,at("2026-11-06T03:27:00Z"),{fetcher:off.fetcher,...FAST});
  assert.equal(off.calls.some(call=>call.id==="tronscan"),false);
  assert.equal((await stored(setup)).providers.tronscan.status,"not_configured");
});

test("Etherscan's five calls run one at a time, spaced, so the run cannot trip the limit it measures",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  let inFlight=0,most=0;
  const starts=[];
  const fetcher=async url=>{
    if(!providerOf(url).startsWith("etherscan_"))return (HEALTHY[providerOf(url)])();
    starts.push(Date.now());
    most=Math.max(most,++inFlight);
    await new Promise(resolve=>setTimeout(resolve,5));
    inFlight--;
    return HEALTHY.etherscan();
  };
  await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,etherscanSpacingMs:30});
  assert.equal(most,1);
  assert.equal(starts.length,5);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=30,"gap "+i);
});

test("the default spacing keeps under Etherscan's Free tier of 3 calls a second, and the budget is one line",()=>{
  const source=fs.readFileSync("cloudflare-worker/crypto-provider-health.js","utf8");
  assert.ok(Number(source.match(/etherscanSpacingMs: (\d+)/)[1])>=334);
  assert.equal(source.match(/^\/\/ Quota: .*$/gm).length,1);
  assert.match(source,/^\/\/ Quota: at most 7 upstream calls an hour .*none of them Gemini\.$/m);
});

// The schedule.
test("the first tick after a deploy fills the record in, even the monitor's",async()=>{
  const {runCryptoProviderProbe,monitorRunsAt}=await health;
  assert.equal(monitorRunsAt(at("2026-11-06T12:17:00Z")),true);
  for(const iso of ["2026-11-06T22:27:00Z","2026-11-06T12:17:00Z"]){
    const setup=await rig();
    const {fetcher,calls}=providers();
    assert.equal(await runCryptoProviderProbe(setup.env,at(iso),{fetcher,...FAST}),true,iso);
    assert.equal(calls.length,7);
    assert.ok((await stored(setup)).checked_at);
  }
});

test("on the ten-minute ticks it runs once an hour, exactly on the hour, with no slip",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const ran=[];
  const start=at("2026-11-06T01:27:00Z");
  for(let tick=0;tick<30;tick++){
    const when=start+tick*600000;
    if(await runCryptoProviderProbe(setup.env,when,{fetcher:providers().fetcher,...FAST}))ran.push(when);
  }
  assert.deepEqual(ran.map(when=>(when-start)/HOUR),[0,1,2,3,4]);
});

test("a tick delivered a few seconds late still lands on its own minute",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const options={fetcher:providers().fetcher,...FAST};
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T01:27:04Z"),options),true);
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T02:27:01Z"),options),true);
});

test("two runs are never less than an hour apart, across a month of ticks",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig({});
  const fetcher=providers().fetcher;
  const start=at("2026-11-06T00:07:00Z");
  let last=null;
  for(let tick=0;tick<6*24*30;tick++){
    const when=start+tick*600000;
    if(await runCryptoProviderProbe(setup.env,when,{fetcher,...FAST})){
      if(last!==null)assert.ok(when-last>=HOUR,new Date(when).toISOString());
      last=when;
    }
  }
});

test("a run that would land on the monitor's tick waits for the next one",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const options={fetcher:providers().fetcher,...FAST};
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T11:17:00Z"),options),true);
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T12:17:00Z"),options),false);
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T12:27:00Z"),options),true);
});

test("the monitor's tick here is the one wrangler.toml schedules, and a plain :17 is not",async()=>{
  const {monitorRunsAt}=await health;
  const toml=fs.readFileSync("cloudflare-worker/wrangler.toml","utf8");
  assert.ok(JSON.parse(toml.match(/^crons = (\[.*\])$/m)[1]).includes("17 */6 * * *"));
  const hits=[];
  for(let minute=0;minute<1440;minute++){
    const when=at("2026-11-06T00:00:00Z")+minute*60000;
    if(monitorRunsAt(when))hits.push(new Date(when).toISOString().slice(11,16));
  }
  assert.deepEqual(hits,["00:17","06:17","12:17","18:17"]);
});

test("two ticks racing for the same hour make one run",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const {fetcher,calls}=providers();
  const time=at("2026-11-06T22:27:00Z");
  const results=await Promise.all([runCryptoProviderProbe(setup.env,time,{fetcher,...FAST}),runCryptoProviderProbe(setup.env,time,{fetcher,...FAST})]);
  assert.deepEqual(results.sort(),[false,true]);
  assert.equal(calls.length,7);
});

test("a run that died after its claim still counts: the next tick stays quiet",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig(KEYS,{intercept:path=>path==="/crypto-provider-status-put"?new Response("{}",{status:500}):null});
  const first=providers();
  await captured(()=>runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher:first.fetcher,...FAST}));
  assert.equal(first.calls.length,7);
  const second=providers();
  assert.equal(await runCryptoProviderProbe(setup.env,at("2026-11-06T22:37:00Z"),{fetcher:second.fetcher,...FAST}),false);
  assert.equal(second.calls.length,0);
});

// Containment.
test("a gate that fails or hangs at the claim stops the run before any upstream call",async()=>{
  const {runCryptoProviderProbe}=await health;
  for(const intercept of [
    path=>path.endsWith("-claim")?new Response("{}",{status:503}):null,
    path=>{if(path.endsWith("-claim"))throw new Error("gate down");},
    path=>path.endsWith("-claim")?new Promise(()=>{}):null,
    path=>path.endsWith("-claim")?new Response("not json"):null
  ]){
    const setup=await rig(KEYS,{intercept});
    const {fetcher,calls}=providers();
    let result;
    await captured(async()=>{result=await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,...FAST,gateTimeoutMs:30});});
    assert.equal(result,false);
    assert.equal(calls.length,0);
  }
});

test("a broken env, a missing gate or a bad time never rejects",async()=>{
  const {runCryptoProviderProbe}=await health;
  const {fetcher,calls}=providers();
  await captured(async()=>{
    assert.equal(await runCryptoProviderProbe({},at("2026-11-06T22:27:00Z"),{fetcher}),false);
    assert.equal(await runCryptoProviderProbe(undefined,at("2026-11-06T22:27:00Z"),{fetcher}),false);
    const setup=await rig();
    assert.equal(await runCryptoProviderProbe(setup.env,undefined,{fetcher}),false);
  });
  assert.equal(calls.length,0);
});

test("the whole run has a total time bound, even when calls ignore their abort signal",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const fetcher=()=>new Promise(()=>{});
  const started=Date.now();
  const finished=await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,etherscanSpacingMs:0,budgetMs:150,callTimeoutMs:60});
  assert.ok(Date.now()-started<1500);
  assert.equal(finished,true,"what is known is still written");
  const {providers:result}=await stored(setup);
  for(const id of SEVEN)assert.equal(result[id].status,"unavailable",id);
  assert.equal(result.etherscan_ethereum.message,"The provider did not answer in time.");
  assert.equal(result.etherscan_base.message,"Not checked: the run ran out of time.");
});

test("a body that never finishes is bounded like a call that never answers",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  const fetcher=async()=>({status:200,text:()=>new Promise(()=>{})});
  await runCryptoProviderProbe(setup.env,at("2026-11-06T22:27:00Z"),{fetcher,...FAST,budgetMs:400,callTimeoutMs:30});
  assert.equal((await stored(setup)).providers.blockstream.status,"unavailable");
});

test("the default limits keep a run well inside the cron's time, however slow every provider is",()=>{
  const source=fs.readFileSync("cloudflare-worker/crypto-provider-health.js","utf8");
  const limit=name=>Number(source.match(new RegExp(name+": (\\d+)"))[1]);
  assert.ok(limit("budgetMs")+2*limit("gateTimeoutMs")<=60000);
  assert.ok(limit("callTimeoutMs")<=limit("budgetMs"));
});

// The record.
test("the gate keeps one small record, overwritten, however many runs there are",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig({...KEYS,...TRONSCAN});
  const before=setup.storage.values.size;
  for(let hour=0;hour<24;hour++){
    await runCryptoProviderProbe(setup.env,at("2026-11-06T00:27:00Z")+hour*HOUR,{fetcher:providers({etherscan:notok("Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis")}).fetcher,...FAST});
  }
  assert.equal(setup.storage.values.size,before+1);
  assert.ok(JSON.stringify(await stored(setup)).length<2500);
});

test("retention and alarms leave the record alone, and it arms no alarm of its own",async()=>{
  const {record,gate,storage}=await probeOnce({});
  assert.equal("expires_at" in record,false);
  assert.equal(storage.alarm,null);
  const far=Date.now()+10*365*86400000;
  assert.equal(await gate.purgeExpired(far),null);
  await gate.alarm();
  assert.deepEqual(await storage.get("crypto-provider-status"),record);
  assert.equal(storage.alarm,null);
  for(const prefix of ["cache:","source-image-token:","session:","crypto-provider-label:","crypto-workspace:","usage-log:"]){
    assert.equal("crypto-provider-status".startsWith(prefix),false,prefix);
  }
});

test("the gate's read hands out the status, not its own claim",async()=>{
  const {gate,record}=await probeOnce({});
  assert.ok(record.claimed_at>0);
  const body=await (await gate.fetch(new Request("https://gate.internal/crypto-provider-status-get",{method:"POST",body:"{}"}))).json();
  assert.deepEqual(Object.keys(body).sort(),["checked_at","ok","providers"]);
});

test("the gate stores only what it recognises, whatever it is handed",async()=>{
  const setup=await rig();
  const put=body=>setup.gate.fetch(new Request("https://gate.internal/crypto-provider-status-put",{method:"POST",body:JSON.stringify(body)}));
  const many=Object.fromEntries(Array.from({length:40},(_,index)=>["provider_"+"abcdefghijklmnopqrstuvwxyzabcdefghijklmn"[index],{status:"ok",checked_at:"2026-11-06T22:27:00Z",message:""}]));
  await put({
    checked_at:"2026-11-06T22:27:00Z",extra:"x".repeat(100000),
    providers:{...many}
  });
  assert.equal(Object.keys((await stored(setup)).providers).length,12);
  await put({
    checked_at:"z".repeat(500),
    providers:{etherscan_base:{status:"ok",checked_at:"t".repeat(500),message:"m".repeat(5000),extra:"x"},"Bad Id":{status:"ok"},trongrid:{status:"fine"},blockstream:"ok"}
  });
  const record=await stored(setup);
  assert.deepEqual(Object.keys(record.providers),["etherscan_base"]);
  assert.deepEqual(Object.keys(record.providers.etherscan_base).sort(),["checked_at","message","status"]);
  assert.equal(record.providers.etherscan_base.message.length,120);
  assert.equal(record.checked_at.length,40);
  assert.equal(record.extra,undefined);
});

// /health.
test("/health publishes each provider's status, checked_at and message, and never the claim",async()=>{
  const {resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env}=await probeOnce({etherscan_bsc:notok("Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis")});
  const response=await getHealth(env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"https://ct-atlas.com");
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.crypto_providers.bitcoin,true,"the rest of /health is as it was");
  const status=body.crypto_provider_status;
  assert.deepEqual(Object.keys(status.providers).sort(),[...SEVEN,"tronscan"].sort());
  assert.equal(status.stale,false);
  assert.match(status.checked_at,/^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(status.providers.etherscan_bsc).sort(),["checked_at","message","status"]);
  assert.equal(status.providers.etherscan_bsc.status,"plan_restricted");
  assert.equal(status.providers.etherscan_ethereum.status,"ok");
  assert.equal(status.providers.tronscan.status,"not_configured");
  assert.equal(JSON.stringify(status).includes("claimed_at"),false);
});

test("/health before the first run says so, without pretending anything works",async()=>{
  const {resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env}=await rig();
  const {crypto_provider_status:status}=await (await getHealth(env)).json();
  assert.deepEqual(status,{checked_at:null,stale:false,providers:{}});
});

test("/health marks a result stale once the cron has missed two runs",async()=>{
  const {readCryptoProviderStatus,resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env}=await probeOnce({});
  const now=Date.now();
  assert.equal((await readCryptoProviderStatus(env,now+2*HOUR)).stale,false);
  resetCryptoProviderStatusCache();
  assert.equal((await readCryptoProviderStatus(env,now+3*HOUR)).stale,true);
});

test("/health wakes the gate once a minute at most, however often it is fetched",async()=>{
  const {readCryptoProviderStatus,resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env,gatePaths}=await probeOnce({});
  const reads=()=>gatePaths.filter(path=>path.endsWith("-get")).length;
  for(let i=0;i<20;i++)await getHealth(env);
  assert.equal(reads(),1);
  await readCryptoProviderStatus(env,Date.now()+59000);
  assert.equal(reads(),1);
  await readCryptoProviderStatus(env,Date.now()+61000);
  assert.equal(reads(),2);
});

test("/health still answers when the gate read fails, in every way it can",async()=>{
  const {resetCryptoProviderStatusCache}=await health;
  const interceptors=[
    path=>path.endsWith("-get")?new Response("{}",{status:500}):null,
    path=>{if(path.endsWith("-get"))throw new Error("gate down");},
    path=>path.endsWith("-get")?new Response("not json"):null
  ];
  for(const intercept of interceptors){
    resetCryptoProviderStatusCache();
    const {env}=await rig(KEYS,{intercept});
    const response=await getHealth(env);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.ok,true);
    assert.deepEqual(body.crypto_provider_status,{checked_at:null,stale:false,providers:{},read_failed:true});
  }
  resetCryptoProviderStatusCache();
  const body=await (await getHealth({...KEYS})).json();
  assert.equal(body.ok,true,"not even a binding is needed");
  assert.equal(body.crypto_provider_status.read_failed,true);
});

test("/health stays fast when the gate hangs, and does not ask it again straight away",async()=>{
  const {resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env,gatePaths}=await rig(KEYS,{intercept:path=>path.endsWith("-get")?new Promise(()=>{}):null});
  const started=Date.now();
  const body=await (await getHealth(env)).json();
  const took=Date.now()-started;
  assert.equal(body.ok,true);
  assert.equal(body.crypto_provider_status.read_failed,true);
  assert.ok(took<1500,"took "+took+" ms");
  await getHealth(env);
  assert.equal(gatePaths.filter(path=>path.endsWith("-get")).length,1,"the failure is remembered, so the next visitor does not wait");
});

test("a failed read is retried after a short wait, not after a full minute",async()=>{
  const {readCryptoProviderStatus,resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  let down=true;
  const {env}=await rig(KEYS,{intercept:path=>down&&path.endsWith("-get")?new Response("{}",{status:503}):null});
  assert.equal((await readCryptoProviderStatus(env)).read_failed,true);
  down=false;
  const later=await readCryptoProviderStatus(env,Date.now()+16000);
  assert.equal(later.read_failed,undefined);
});

// Nothing public starts a run.
test("reading /health and /session-check calls no crypto provider",async()=>{
  const {default:app}=await entry;
  const {resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const {env}=await rig();
  const hosts=[];
  await withGlobalFetch(async url=>{hosts.push(new URL(String(url)).hostname);return json({})();},async()=>{
    for(let i=0;i<5;i++)await getHealth(env);
    await app.fetch(new Request("https://worker.test/session-check"),env,{waitUntil(){}});
  });
  assert.deepEqual(hosts.filter(host=>/blockstream|etherscan|trongrid|tronscan/.test(host)),[]);
});

test("no public route reaches the probe or the gate's status paths",async()=>{
  const {default:app}=await entry;
  const {env,gatePaths}=await rig();
  for(const route of ["/crypto-provider-status-claim","/crypto-provider-status-put","/crypto-provider-status-get","/crypto-provider-probe","/health/crypto-providers"]){
    for(const method of ["GET","POST"]){
      const response=await app.fetch(new Request("https://worker.test"+route,{method}),env,{waitUntil(){}});
      assert.equal(response.status,404,method+" "+route);
    }
  }
  assert.deepEqual(gatePaths,[]);
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  assert.equal(index.match(/runCryptoProviderProbe\(/g).length,1,"called from scheduled() alone");
  assert.ok(index.indexOf("runCryptoProviderProbe(env")>index.indexOf("async scheduled("));
});

test("the Worker keeps every other route and the cron handler through the /health wrapper",async()=>{
  const {default:app}=await entry;
  assert.equal(typeof app.scheduled,"function");
  const preflight=await app.fetch(new Request("https://worker.test/health",{method:"OPTIONS"}),{},{waitUntil(){}});
  assert.equal(preflight.status,204);
  const {env,gatePaths}=await rig();
  const response=await app.fetch(new Request("https://worker.test/nothing-here"),env,{waitUntil(){}});
  assert.equal(response.status,404);
  assert.deepEqual(gatePaths,[]);
  const post=await app.fetch(new Request("https://worker.test/health",{method:"POST"}),env,{waitUntil(){}});
  assert.equal(post.status,404);
});

test("end to end: the real scheduled() fills the record that /health then publishes",async()=>{
  const {default:app}=await entry;
  const {resetCryptoProviderStatusCache}=await health;
  resetCryptoProviderStatusCache();
  const setup=await rig();
  const {fetcher,calls}=providers({etherscan_base:notok("Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis")});
  const waits=[];
  await withGlobalFetch(fetcher,async()=>{
    await app.scheduled({cron:"7,17,27,37,47,57 * * * *",scheduledTime:at("2026-11-06T22:27:00Z")},setup.env,{waitUntil:promise=>waits.push(promise)});
    await Promise.all(waits);
  });
  assert.equal(calls.length,7);
  const {crypto_provider_status:status}=await (await getHealth(setup.env)).json();
  assert.equal(status.providers.etherscan_base.status,"plan_restricted");
  assert.equal(status.providers.etherscan_ethereum.status,"ok");
  assert.equal(status.providers.blockstream.status,"ok");
  assert.equal(status.providers.trongrid.status,"ok");
});

test("the six-hour cron makes no probe call",async()=>{
  const {default:app}=await entry;
  const setup=await rig();
  const {fetcher,calls}=providers();
  const waits=[];
  await withGlobalFetch(fetcher,async()=>{
    await app.scheduled({cron:"17 */6 * * *",scheduledTime:at("2026-11-06T12:17:00Z")},setup.env,{waitUntil:promise=>waits.push(promise)});
    await Promise.allSettled(waits);
  });
  assert.equal(calls.length,0);
  assert.equal(setup.gatePaths.includes("/crypto-provider-status-claim"),false);
});
