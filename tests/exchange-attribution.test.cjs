// AI-assessed exchange operator (cloudflare-worker/exchange-attribution.js) and
// the automatic trace that stops at exchanges (crypto.js). No network.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

function load(){
  const source=fs.readFileSync("cloudflare-worker/exchange-attribution.js","utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,"")
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,"");
  const gate=[];let geminiCalls=0;
  const c=vm.createContext({
    cleanText:(v,n=10000)=>String(v??"").replace(/\s+/g," ").trim().slice(0,n),
    jsonResponse:(payload,status=200)=>new Response(JSON.stringify(payload),{status}),
    gateCall:async(env,path,body)=>{gate.push(path);return new Response(JSON.stringify(path==="/session-get"?{username:"analyst"}:{hit:false}),{status:200});},
    normalizeUsername:v=>String(v||"").trim().toLowerCase(),
    isAllowedUser:name=>name==="analyst",
    GEMINI_URL:"https://gemini.test",GEMINI_SECOND_FALLBACK_MODEL:"m2",
    geminiModelRotation:models=>({next:()=>models[0],spent(){}}),
    waitBeforeGeminiRetry:async()=>{},
    extractGeminiText:async payload=>payload.text,
    fetch:async(url,init)=>{geminiCalls++;const input=JSON.parse(init.body).input;
      return new Response(JSON.stringify({text:JSON.stringify({wallets:[{address:"TExch",service_type:"exchange_hot_wallet",likely_exchange:"OKX",confidence:"MODERATE",basis:["two OKX neighbours"],alternatives:["HTX"],echo:input.length}]})}),{status:200});},
    Response,Request,JSON,Map,Set,Array,Object,Math,Number,String,Date,Promise,TextEncoder,crypto:globalThis.crypto,Uint8Array
  });
  vm.runInContext(source,c);
  return {api:vm.runInContext("({parseWallets,sanitizeAttribution,handleExchangeAttribution,MAX_WALLETS})",c),gate,calls:()=>geminiCalls};
}

const request=(body,token="tok")=>new Request("https://w.test/crypto-exchange-attribution",{method:"POST",headers:token?{"X-Session-Token":token}:{},body:JSON.stringify(body)});

test("only bounded, cleaned wallet facts reach the prompt",()=>{
  const {api}=load();
  const wallets=api.parseWallets([
    {address:"TExch",hop:4,score:86,evidence:["a","b"],metrics:{unique_counterparties:63},assets:["USDT"],
     labelled_neighbours:[{address:"TOkx1",name:"OKX",category:"EXCHANGE"},{address:"",name:"no address"}],extra:"ignored"},
    {address:"texch"},
    ...Array.from({length:20},(_,i)=>({address:"T"+i}))
  ],"tron");
  assert.equal(wallets.length,api.MAX_WALLETS);
  assert.equal(wallets[0].labelled_neighbours.length,1);
  assert.ok(!("extra" in wallets[0]));
  assert.equal(wallets.filter(w=>w.address.toLowerCase()==="texch").length,1,"one entry per address");
});

test("the model's answer is normalised: known confidence levels only, Unknown when nothing is named",()=>{
  const {api}=load();
  const out=api.sanitizeAttribution({wallets:[{address:"A",likely_exchange:"Binance",confidence:"certain",basis:["x"]}]},[{address:"A"},{address:"B"}]);
  assert.equal(out[0].confidence,"low","an unknown level falls back to low");
  assert.equal(out[1].likely_exchange,"Unknown");
  assert.ok(out.every(item=>item.assessed===true));
});

test("the endpoint needs a session, a supported chain, and answers with the assessed operator",async()=>{
  const {api,calls}=load();
  assert.equal((await api.handleExchangeAttribution(request({user_id:"analyst",chain:"tron",wallets:[{address:"TExch"}]},""),{GEMINI_API_KEY:"k"})).status,401);
  assert.equal((await api.handleExchangeAttribution(request({user_id:"analyst",chain:"dogecoin",wallets:[{address:"x"}]}),{GEMINI_API_KEY:"k"})).status,400);
  const ok=await (await api.handleExchangeAttribution(request({user_id:"analyst",chain:"tron",wallets:[{address:"TExch",score:86,labelled_neighbours:[{address:"TOkx",name:"OKX",category:"EXCHANGE",source:"Published wallet list"}]}]}),{GEMINI_API_KEY:"k"})).json();
  assert.equal(ok.attributions[0].likely_exchange,"OKX");
  assert.equal(ok.attributions[0].confidence,"moderate");
  assert.match(ok.note,/Not a sourced attribution/);
  assert.equal(calls(),1);
});

test("the automatic trace follows branches to exchanges, then asks for the operators, and the report reads it",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  assert.match(index,/url\.pathname === "\/crypto-exchange-attribution" && request\.method === "POST"/);
  assert.match(client,/const AUTO_TRACE_MAX_DEPTH=6;/);
  assert.match(client,/!exchangeKeys\.has\(node\.key\)&&!reachedOnlyThroughExchanges\(model,node,exchangeKeys\)/,"a branch ends at an exchange");
  assert.match(client,/expandTraceNode\(node\.id,\{quiet:true,limit:100\}\)/);
  assert.match(client,/await requestExchangeAttributions\(model,run\.exchanges\)/);
  assert.match(client,/autoTrace:autoTraceRun\?\{/,"the report model carries the trace reached");
  assert.match(fs.readFileSync("crypto.html","utf8"),/<option value="6" selected>H6<\/option>/);
});

test("operator hypotheses need a matching sourced neighbour and never become high confidence",()=>{
  const {api}=load();
  const raw={wallets:[{address:"A",likely_exchange:"Binance",confidence:"high",alternatives:["Invented exchange"]}]};
  for(const neighbours of [[],[{name:"Binance",category:"EXCHANGE"}],[{name:"OKX",category:"EXCHANGE",source:"Published list"}]]){
    const out=api.sanitizeAttribution(raw,[{address:"A",labelled_neighbours:neighbours}])[0];
    assert.equal(out.likely_exchange,"Unknown");
    assert.equal(out.confidence,"low");
    assert.equal(out.alternatives.length,0);
  }
  const supported=api.sanitizeAttribution(raw,[{address:"A",labelled_neighbours:[{name:"Binance",category:"EXCHANGE",source:"Published list"}]}])[0];
  assert.equal(supported.likely_exchange,"Binance");
  assert.equal(supported.confidence,"moderate");
});

test("no Etherscan Pro Plus name-tag lookup: TronScan is the only exchange-tag provider",()=>{
  const worker=fs.readFileSync("cloudflare-worker/exchange-addresses.js","utf8");
  assert.ok(!/getaddresstag|ETHERSCAN_NAME_TAGS_ENABLED/.test(worker));
  assert.match(worker,/const providerLabels = await lookupTronScan\(env, missing\);/);
  assert.ok(!/ETHERSCAN PRO PLUS/.test(fs.readFileSync("crypto.js","utf8")));
  assert.ok(!/etherscan_enabled/.test(fs.readFileSync("cloudflare-worker/index.js","utf8")));
});
