// BNB Smart Chain and Base left the tool on 2026-11-07, after the Worker's own probe found Etherscan's
// free plan refusing both. The real Worker and gate through import(), and the real page in a vm, with
// every provider call recorded. Two things must hold on each path: a request naming one of these
// chains is refused by name and never read on Ethereum, and saved work naming one stays whole.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const Report=require("../crypto-report.js");

const entry=import("../cloudflare-worker/index.js");
const worker=import("../cloudflare-worker/crypto.js");
const monitor=import("../cloudflare-worker/crypto-monitor.js");
const health=import("../cloudflare-worker/crypto-provider-health.js");
const exchangeLabels=import("../cloudflare-worker/exchange-addresses.js");
const risk=import("../cloudflare-worker/crypto-risk.mjs");
const sanctions=import("../cloudflare-worker/sanctions.js");

const RETIRED=[["bsc","BNB Smart Chain","https://bscscan.com"],["base","Base","https://basescan.org"]];
const WALLET="0x"+"a".repeat(40);
const LIVE_WALLET="0x"+"c".repeat(40);
const TX="0x"+"b".repeat(64);
const USERS=JSON.stringify({analyst:"0".repeat(64)});
const WHEN="2026-11-01T00:00:00.000Z";
const refusal=name=>new RegExp("^"+name+" is no longer supported by CT Atlas, so nothing was analysed\\.");

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

// A Worker env whose REPORT_GATE is the real object. `intercept` can answer for a gate path.
async function rig({intercept,...extra}={}){
  const {ReportGate}=await entry;
  const storage=new Storage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:USERS});
  const gatePaths=[];
  const env={
    AUTH_USERS_JSON:USERS,ETHERSCAN_API_KEY:"test-etherscan-key",TRONGRID_API_KEY:"test-trongrid-key",
    ...extra,
    REPORT_GATE:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      const path=new URL(url).pathname;
      gatePaths.push(path);
      if(path==="/session-get")return Response.json({username:"analyst"});
      return intercept?.(path)||gate.fetch(new Request(url,init));
    }})}
  };
  return {env,storage,gatePaths};
}

async function call(setup,method,path,body){
  const {default:app}=await entry;
  const init={method,headers:{"X-Session-Token":"session","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})};
  const response=await app.fetch(new Request("https://worker.test"+path,init),setup.env,{waitUntil(){}});
  return {status:response.status,body:await response.json()};
}

// Every upstream call `run` makes. Etherscan answers with an empty wallet, anything else with a 404.
async function providerCalls(run){
  const calls=[],saved=globalThis.fetch,log=console.log;
  globalThis.fetch=async url=>{
    const parsed=new URL(String(url));
    calls.push(parsed);
    return parsed.hostname==="api.etherscan.io"
      ?Response.json({status:"0",message:"No transactions found",result:[]})
      :Response.json({},{status:404});
  };
  console.log=()=>{};
  try{await run();}finally{globalThis.fetch=saved;console.log=log;}
  return calls;
}

const stable=value=>JSON.parse(JSON.stringify(value,(key,item)=>["updated_at","revision"].includes(key)?undefined:item));

const SNAPSHOT={checked_at:"2026-11-06T18:17:00.000Z",newest_tx_id:TX,newest_tx_time:"2026-11-06T10:00:00.000Z",tx_count:2,aggregate_value:3.5,risk_label:"ELEVATED"};

function watch(id,chain,address=WALLET){
  return {id,chain,address,label:"Watched "+id,enabled:true,categories:["EXCHANGE"],
    thresholds:{min_amount:1,aggregate_24h:null,velocity_24h:null,dormant_days:null,asset:""},thresholds_version:2,
    last_snapshot:SNAPSHOT,created_at:WHEN};
}
function label(id,chain){
  return {id,chain,address:WALLET,name:"Label "+id,category:"EXCHANGE",wallet_role:"HOT_WALLET",confidence:"MEDIUM",
    source_type:"Official",source_title:"Disclosure",source_url:"https://example.com/source",notes:"",created_at:WHEN};
}
function link(id,fromChain,fromAddress,toChain,toAddress){
  return {id,from_chain:fromChain,from_address:fromAddress,to_chain:toChain,to_address:toAddress,service:"Stargate",confidence:"MEDIUM",
    source_url:"https://example.com/bridge",notes:"",created_at:WHEN};
}
const CASE={
  id:"c1",name:"Bridge case",description:"Scope",status:"OPEN",chain:"bsc",seed_addresses:[WALLET],
  saved_paths:[{id:"p1",name:"Path",nodes:[WALLET,LIVE_WALLET],created_at:WHEN}],
  notes:[{id:"n1",text:"Note",created_at:WHEN}],
  offchain_nodes:[{id:"o1",type:"OTHER",label:"Alias",linked_address:WALLET,source_url:"",notes:"",created_at:WHEN}],
  crosschain_links:[link("x1","bsc",WALLET,"ethereum",LIVE_WALLET),link("x2","ethereum",LIVE_WALLET,"base",WALLET)],
  created_at:WHEN
};
const ALERT={id:"a1",watch_id:"w-bsc",chain:"bsc",address:WALLET,type:"NEW_TRANSACTION",severity:"LOW",title:"New transaction observed",
  detail:"A transaction newer than the saved baseline.",tx_id:TX,day_bucket:"",created_at:WHEN,acknowledged:false};
const savedWorkspace=(extra={})=>structuredClone({
  version:"crypto-workspace-v1",username:"analyst",revision:4,
  labels:[label("l-bsc","bsc"),label("l-base","base")],
  watchlist:[watch("w-bsc","bsc"),watch("w-base","base")],
  cases:[CASE],alerts:[ALERT],...extra
});
const KEY="crypto-workspace:analyst";

// ---------------------------------------------------------------- the hint

test("a retired hint is refused by name, for a wallet and a transaction, however it is written",async()=>{
  const {detectCryptoInput}=await worker;
  for(const [hint,name,explorer] of RETIRED){
    for(const written of [hint,hint.toUpperCase()," "+hint+" "]){
      for(const query of [WALLET,TX,""]){
        const target=detectCryptoInput(query,written);
        assert.match(target.error,refusal(name),written);
        assert.ok(target.error.includes(explorer));
        assert.equal(target.chain,undefined);
      }
    }
  }
});

test("a chain the tool does not know is refused too: only Auto detect reads a 0x address as Ethereum",async()=>{
  const {detectCryptoInput}=await worker;
  for(const hint of ["bnb","binance","56",56,8453,"base-mainnet","dogecoin","constructor","__proto__"]){
    const target=detectCryptoInput(WALLET,hint);
    assert.equal(target.chain,undefined,hint);
    assert.match(target.error,/not supported by CT Atlas/,hint);
  }
  for(const hint of ["auto","",undefined])assert.equal(detectCryptoInput(WALLET,hint).chain,"ethereum");
  assert.equal(detectCryptoInput(WALLET,"eth").chain,"ethereum");
  assert.equal(detectCryptoInput(WALLET,"polygon").chain,"polygon");
  assert.equal(detectCryptoInput(WALLET,"arbitrum").chain,"arbitrum");
});

test("an ambiguous hash names only the chains that are left",async()=>{
  const {detectCryptoInput}=await worker;
  const {error}=detectCryptoInput(TX,"auto");
  assert.match(error,/Select Ethereum, Polygon or Arbitrum\./);
  assert.doesNotMatch(error,/BNB|Base/);
});

test("wallet search, transaction lookup, a trace and an old page all get a 400 and reach no provider",async()=>{
  for(const [chain,name] of RETIRED){
    const setup=await rig();
    const calls=await providerCalls(async()=>{
      for(const [query,origin] of [[WALLET,"search"],[TX,"search"],[WALLET,"url"],[WALLET,"trace"],[WALLET,"monitor"]]){
        const {status,body}=await call(setup,"POST","/crypto-analyze",{user_id:"analyst",query,chain,limit:100,origin});
        assert.equal(status,400,origin);
        assert.match(body.error,refusal(name),origin);
        assert.equal(body.chain,undefined);
      }
    });
    assert.deepEqual(calls,[]);
    assert.equal(setup.gatePaths.includes("/usage-increment"),false,"a refused request is not a search");
  }
});

test("the AI attribution of a trace is refused by name and costs no Gemini call",async()=>{
  for(const [chain,name] of RETIRED){
    const setup=await rig({GEMINI_API_KEY:"test-gemini-key"});
    const calls=await providerCalls(async()=>{
      const {status,body}=await call(setup,"POST","/crypto-exchange-attribution",{user_id:"analyst",chain,wallets:[{address:WALLET,score:90}]});
      assert.equal(status,400);
      assert.match(body.error,refusal(name));
    });
    assert.deepEqual(calls,[]);
  }
});

// ---------------------------------------------------------------- the monitor

test("CHECK NOW on a retired watch answers why, and leaves its baseline and alerts alone",async()=>{
  for(const [chain,name] of RETIRED){
    const setup=await rig();
    const saved=savedWorkspace();
    await setup.storage.put(KEY,saved);
    const calls=await providerCalls(async()=>{
      const {status,body}=await call(setup,"POST","/crypto-monitor-check",{user_id:"analyst",watch_id:"w-"+chain});
      assert.equal(status,400);
      assert.match(body.error,refusal(name));
    });
    assert.deepEqual(calls,[]);
    assert.equal(setup.gatePaths.includes("/crypto-monitor-update"),false);
    assert.equal(setup.gatePaths.includes("/usage-increment"),false);
    assert.deepEqual(await setup.storage.get(KEY),saved);
  }
});

test("the 6-hour monitor checks the live wallet behind nine retired watches, and touches none of them",async()=>{
  const {runCryptoMonitor}=await monitor;
  const setup=await rig();
  const retired=Array.from({length:9},(_,index)=>watch("a-retired-"+index,index%2?"bsc":"base"));
  const saved=savedWorkspace({watchlist:[...retired,watch("z-live","ethereum",LIVE_WALLET)]});
  await setup.storage.put(KEY,saved);
  let result;
  const calls=await providerCalls(async()=>{result=await runCryptoMonitor(setup.env);});
  assert.equal(result.checked,1,"the batch of 8 must not fill up with wallets nobody can read");
  assert.equal(result.skipped,9);
  assert.equal(result.failed,0);
  assert.equal(result.alerts_added,0);
  const etherscan=calls.filter(url=>url.hostname==="api.etherscan.io");
  assert.ok(etherscan.length>0);
  for(const url of etherscan){
    assert.equal(url.searchParams.get("address"),LIVE_WALLET);
    assert.equal(url.searchParams.get("chainid"),"1");
  }
  const after=await setup.storage.get(KEY);
  assert.deepEqual(after.watchlist.slice(0,9),retired,"no baseline blanked or moved");
  assert.deepEqual(after.alerts,saved.alerts,"no false alert");
});

test("a list holding only retired watches is a quiet run with an honest count",async()=>{
  const {runCryptoMonitor}=await monitor;
  const setup=await rig();
  const saved=savedWorkspace();
  await setup.storage.put(KEY,saved);
  let result;
  const calls=await providerCalls(async()=>{result=await runCryptoMonitor(setup.env);});
  assert.deepEqual(calls,[]);
  assert.equal(result.checked,0);
  assert.equal(result.skipped,2);
  assert.equal(result.failed,0);
  assert.deepEqual(await setup.storage.get(KEY),saved);
});

test("a retired watch that does reach the Worker is skipped there: no analysis, no failure, no update",async()=>{
  const {runCryptoMonitor}=await monitor;
  const target={username:"analyst",watch:{...watch("w-bsc","bsc")},sensitive_labels:[]};
  const setup=await rig({intercept:path=>path==="/crypto-monitor-targets"?Response.json({ok:true,targets:[target],total:1}):null});
  let result;
  const calls=await providerCalls(async()=>{result=await runCryptoMonitor(setup.env);});
  assert.deepEqual(calls,[]);
  assert.equal(result.skipped,1);
  assert.equal(result.failed,0);
  assert.equal(setup.gatePaths.includes("/crypto-monitor-update"),false);
});

// ---------------------------------------------------------------- the provider probe and /health

const OLD_RECORD=()=>{
  const entry=status=>({status,checked_at:"2026-11-07T00:47:00.000Z",message:""});
  return {
    checked_at:"2026-11-07T00:47:00.000Z",claimed_at:Date.parse("2026-11-07T00:47:00Z"),
    providers:{
      blockstream:entry("ok"),tronscan:entry("not_configured"),trongrid:entry("ok"),etherscan_ethereum:entry("ok"),
      etherscan_bsc:{...entry("plan_restricted"),message:"Free API access is not supported for this chain."},
      etherscan_polygon:entry("ok"),etherscan_arbitrum:entry("ok"),
      etherscan_base:{...entry("plan_restricted"),message:"Free API access is not supported for this chain."}
    }
  };
};

test("a record stored before the change does not bring the chains back on /health",async()=>{
  const {resetCryptoProviderStatusCache}=await health;
  const {default:app}=await entry;
  resetCryptoProviderStatusCache();
  const setup=await rig();
  await setup.storage.put("crypto-provider-status",OLD_RECORD());
  const response=await app.fetch(new Request("https://worker.test/health"),setup.env,{waitUntil(){}});
  const body=await response.json();
  assert.equal(body.version,"5.43");
  assert.deepEqual(Object.keys(body.crypto_provider_status.providers).sort(),
    ["blockstream","etherscan_arbitrum","etherscan_ethereum","etherscan_polygon","tronscan","trongrid"].sort());
  assert.equal(body.crypto_provider_status.providers.etherscan_ethereum.status,"ok");
  resetCryptoProviderStatusCache();
});

test("the probe asks Etherscan about the three chains left, and its record drops the old entries",async()=>{
  const {runCryptoProviderProbe}=await health;
  const setup=await rig();
  await setup.storage.put("crypto-provider-status",OLD_RECORD());
  const asked=[];
  const fetcher=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="api.etherscan.io"){
      asked.push(parsed.searchParams.get("chainid"));
      return Response.json({status:"1",message:"OK",result:"1"});
    }
    return Response.json({chain_stats:{},data:[]});
  };
  assert.equal(await runCryptoProviderProbe(setup.env,Date.parse("2026-11-07T02:07:00Z"),{fetcher,etherscanSpacingMs:0}),true);
  assert.deepEqual(asked,["1","137","42161"]);
  const {providers}=await setup.storage.get("crypto-provider-status");
  assert.deepEqual(Object.keys(providers).filter(id=>id.startsWith("etherscan_")).sort(),["etherscan_arbitrum","etherscan_ethereum","etherscan_polygon"]);
});

// ---------------------------------------------------------------- saved work, on the server

test("a saved workspace naming the chains loads unchanged and survives a save",async()=>{
  const setup=await rig();
  const saved=savedWorkspace();
  await setup.storage.put(KEY,saved);
  const loaded=await call(setup,"GET","/crypto-workspace?user_id=analyst");
  assert.equal(loaded.status,200);
  assert.deepEqual(stable(loaded.body.workspace),stable(saved));

  const put=await call(setup,"POST","/crypto-workspace",{user_id:"analyst",workspace:loaded.body.workspace,revision:loaded.body.revision});
  assert.equal(put.status,200);
  const again=await call(setup,"GET","/crypto-workspace?user_id=analyst");
  assert.equal(again.body.revision,saved.revision+1);
  assert.deepEqual(stable(again.body.workspace),stable(saved),"no label, watch, link or alert dropped; no chain blanked");
});

test("screening and labels keep both chains: they are reference data, not chain APIs",async()=>{
  const {sanitizeExchangeLabel}=await exchangeLabels;
  const {isStablecoin}=await risk;
  const {chainFamily}=await sanctions;
  for(const [chain] of RETIRED){
    assert.equal(chainFamily(chain),"evm");
    assert.equal(sanitizeExchangeLabel({chain,address:WALLET,name:"Binance",source_title:"Disclosure"}).chain,chain);
  }
  assert.equal(isStablecoin("base","0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),true);
});

test("the Worker, the gate and the page retire the same chains",async()=>{
  const {RETIRED_CHAINS}=await worker;
  const gate=fs.readFileSync("cloudflare-worker/report-gate.js","utf8").match(/RETIRED_CRYPTO_CHAINS = new Set\((\[.*?\])\)/)[1];
  assert.deepEqual(JSON.parse(gate),Object.keys(RETIRED_CHAINS));
  const h=page();
  assert.deepEqual(plain(h.api.retired()),plain(RETIRED_CHAINS));
  assert.deepEqual(Object.keys(RETIRED_CHAINS),RETIRED.map(([chain])=>chain));
});

// ---------------------------------------------------------------- the page

const plain=value=>JSON.parse(JSON.stringify(value));

// The real crypto.js in a vm, with the real chain select, a fake DOM and a scripted fetch.
function page({search="",respond}={}){
  const nodes=new Map();
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:"",innerHTML:"",textContent:"",className:"",hidden:false,disabled:false,dataset:{},options:[],
      classList:{toggle(){},add(){},remove(){},contains(){return false;}},querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},addEventListener(){},focus(){}});
    return nodes.get(id);
  };
  for(const id of ["filterDirection","filterAsset","filterType","filterStatus"])el(id).value="all";
  el("filterGraphMinLinks").value="1";el("filterGraphNodes").value="80";el("traceMaxDepth").value="6";el("traceBranch").value="8";
  const select=fs.readFileSync("crypto.html","utf8").match(/<select id="cryptoChain">([\s\S]*?)<\/select>/)[1];
  el("cryptoChain").options=[...select.matchAll(/<option value="([^"]+)"/g)].map(match=>({value:match[1]}));
  el("cryptoChain").value="auto";
  const calls=[],opened=[];
  const context=vm.createContext({
    console:{warn(){},log(){}},
    document:{readyState:"loading",addEventListener(){},getElementById:el,body:{classList:{add(){},remove(){}}}},
    sessionStorage:{getItem:()=>"analyst"},
    window:{location:{href:"https://example.invalid/crypto.html",search},CTAtlasCryptoReport:Report,open:url=>{opened.push(String(url));return {};}},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,1)),clearTimeout,URL,URLSearchParams,
    fetch:async(url,options={})=>{
      const entry={url:String(url),method:options.method||"GET",body:options.body?JSON.parse(options.body):null};
      calls.push(entry);
      const result=await (respond||(()=>({status:200,json:{}})))(entry);
      const status=result.status??200;
      return {status,ok:status>=200&&status<300,json:async()=>result.json??{}};
    }
  });
  const source=fs.readFileSync("crypto.js","utf8").replace(/\}\)\(\);\s*$/,`
    globalThis.api={
      applyUrlQuery,run,providerHealth,loadCryptoWorkspace,saveCryptoWorkspace,renderWorkspaceUi,checkMonitored,openCryptoSearch,
      autoTrace,expandTraceNode,buildNetworkModel,exportCasePdf,crossChainFindings,renderCaseUi,
      reportModel:()=>collectReportModel(),
      retired:()=>RETIRED_CHAINS,
      live(){return cryptoWorkspace;},
      seed(payload){lastPayload=payload;resetTraceState(payload);currentNetworkModel=buildNetworkModel(payload);},
      selectCase(id){activeCaseId=id;}
    };
  })();`);
  vm.runInContext(source,context);
  return {api:context.api,calls,opened,el,context};
}

const workspaceAnswer=(workspace,revision=4)=>call=>call.method==="GET"
  ?{json:{ok:true,workspace,revision}}
  :{json:{ok:true,workspace:call.body?.workspace||workspace,revision:revision+1}};
const analyses=calls=>calls.filter(call=>call.url.endsWith("/crypto-analyze"));
const liveWallet=(extra={})=>({chain:"ethereum",chain_name:"Ethereum",kind:"address",query:LIVE_WALLET,provider:"Etherscan API V2",
  generated_at:WHEN,transactions:[],flows:[],observations:[],...extra});

test("crypto.html offers neither chain anywhere, and says what happened to them",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  assert.equal(/<option value="(?:bsc|base)"/.test(html),false);
  for(const id of ["cryptoChain","crosschainFromChain","crosschainToChain","labelChain"]){
    const select=html.match(new RegExp('<select id="'+id+'">([\\s\\S]*?)</select>'))[1];
    const chains=[...select.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]).filter(chain=>chain!=="auto");
    assert.deepEqual(chains,["bitcoin","ethereum","polygon","arbitrum","tron"],id);
  }
  assert.match(html,/BNB Smart Chain and Base are no longer supported/);
});

test("a link naming a retired chain is refused, and leaves nothing that could run on Auto detect",()=>{
  for(const [chain,name,explorer] of RETIRED){
    for(const written of [chain,chain.toUpperCase()]){
      const h=page({search:"?q="+WALLET+"&chain="+written+"&autorun=1"});
      assert.equal(h.api.applyUrlQuery(),false,"no autorun");
      assert.equal(h.el("cryptoQuery").value,"","an ANALYSE press would read it on Ethereum");
      assert.equal(h.el("cryptoChain").value,"auto");
      assert.match(h.el("cryptoStatus").textContent,refusal(name));
      assert.ok(h.el("cryptoStatus").textContent.includes(explorer+"/address/"+WALLET));
      assert.match(h.el("cryptoStatus").className,/error/);
    }
  }
});

test("a link naming a chain the page has never had is refused the same way, and a good link still runs",()=>{
  const unknown=page({search:"?q="+WALLET+"&chain=dogecoin&autorun=1"});
  assert.equal(unknown.api.applyUrlQuery(),false);
  assert.equal(unknown.el("cryptoQuery").value,"");
  assert.match(unknown.el("cryptoStatus").textContent,/does not support, so nothing was analysed/);

  const good=page({search:"?q="+WALLET+"&chain=polygon&autorun=1"});
  assert.equal(good.api.applyUrlQuery(),true);
  assert.equal(good.el("cryptoQuery").value,WALLET);
  assert.equal(good.el("cryptoChain").value,"polygon");
  assert.equal(page({search:"?q="+WALLET+"&autorun=1"}).api.applyUrlQuery(),true,"no chain named: Auto detect is what was asked for");
});

test("the page shows the Worker's refusal, for a page or tab that still sends the old hint",async()=>{
  const h=page({respond:()=>({status:400,json:{error:"BNB Smart Chain is no longer supported by CT Atlas, so nothing was analysed."}})});
  h.el("cryptoQuery").value=WALLET;
  h.el("cryptoChain").value="bsc";
  await h.api.run();
  assert.equal(analyses(h.calls)[0].body.chain,"bsc","the hint is sent as chosen, never rewritten to Auto detect");
  assert.match(h.el("cryptoStatus").textContent,refusal("BNB Smart Chain"));
  assert.match(h.el("cryptoStatus").className,/error/);
});

test("a cross-chain link to a retired chain opens its explorer, never a search",()=>{
  for(const [chain,name,explorer] of RETIRED){
    const h=page();
    h.api.openCryptoSearch(WALLET,chain);
    assert.deepEqual(h.opened,[explorer+"/address/"+WALLET]);
    assert.match(h.el("cryptoStatus").textContent,refusal(name));
  }
  const h=page();
  h.api.openCryptoSearch(WALLET,"polygon");
  assert.match(h.opened[0],/crypto\.html\?q=0x[a-f0-9]+&chain=polygon&autorun=1/);
});

test("a trace can never start from a retired chain: its wallets are not searchable",async()=>{
  for(const [chain] of RETIRED){
    const h=page();
    h.api.seed(liveWallet({chain,query:WALLET,transactions:[{id:TX,time:WHEN,direction:"OUT",asset:"ETH",amount:1,counterparties:[LIVE_WALLET]}]}));
    await h.api.autoTrace();
    assert.equal(await h.api.expandTraceNode(LIVE_WALLET),false);
    assert.deepEqual(analyses(h.calls),[]);
  }
});

test("a saved workspace naming the chains loads on the page and goes back whole on a save",async()=>{
  const saved=savedWorkspace();
  const h=page({respond:workspaceAnswer(saved)});
  assert.equal(await h.api.loadCryptoWorkspace(),true);
  assert.deepEqual(plain(h.api.live()),saved);
  assert.equal(await h.api.saveCryptoWorkspace(),true);
  assert.deepEqual(h.calls.find(call=>call.method==="POST").body.workspace,saved);
  assert.deepEqual(analyses(h.calls),[]);
});

test("a retired watch reads as not checked, with its name, its explorer and the reason",async()=>{
  const h=page({respond:workspaceAnswer(savedWorkspace({watchlist:[watch("w-bsc","bsc"),watch("w-base","base"),watch("w-live","ethereum"),{...watch("w-off","polygon"),enabled:false}]}))});
  await h.api.loadCryptoWorkspace();
  const html=h.el("cryptoWatchlist").innerHTML;
  const items=html.split('<div class="intel-item">').slice(1);
  for(const [index,[,name,explorer]] of RETIRED.entries()){
    assert.match(items[index],new RegExp('intel-meta">'+name+" · "));
    assert.ok(items[index].includes('href="'+explorer+"/address/"+WALLET+'"'));
    assert.match(items[index],/intel-badge unscreened">NOT CHECKED</);
    assert.match(items[index],/no longer supported by CT Atlas: this wallet is skipped, and its saved baseline and alerts are kept/);
    assert.match(items[index],/data-watch-delete/,"the analyst can still remove it");
    assert.match(items[index],/last checked 06 Nov 2026/,"its last real check stays on show");
  }
  assert.match(items[2],/intel-meta">ethereum · /);
  assert.match(items[2],/intel-badge clear">ACTIVE</);
  assert.doesNotMatch(items[2],/NOT CHECKED|<a /);
  assert.match(items[3],/intel-badge unscreened">PAUSED</);
});

test("saved alerts, labels and cases show the chain's name and a working explorer link",async()=>{
  const h=page({respond:workspaceAnswer(savedWorkspace())});
  await h.api.loadCryptoWorkspace();
  const alerts=h.el("cryptoAlerts").innerHTML;
  assert.match(alerts,/intel-meta">BNB Smart Chain · NEW_TRANSACTION/);
  assert.ok(alerts.includes('href="https://bscscan.com/tx/'+TX+'"'));

  const labels=h.el("cryptoLabelList").innerHTML;
  assert.match(labels,/intel-meta">BNB Smart Chain · EXCHANGE/);
  assert.match(labels,/intel-meta">Base · EXCHANGE/);
  assert.ok(labels.includes('href="https://bscscan.com/address/'+WALLET+'"'));
  assert.ok(labels.includes('href="https://basescan.org/address/'+WALLET+'"'));

  h.api.selectCase("c1");
  h.api.renderCaseUi();
  const detail=h.el("caseDetail").innerHTML;
  assert.match(detail,/CHAIN · BNB Smart Chain · NO LONGER ANALYSED/);
  assert.ok(detail.includes('case-pill">'),"the seed");
  assert.ok(detail.includes('href="https://bscscan.com/address/'+WALLET+'"'));
  assert.ok(detail.includes('href="https://basescan.org/address/'+WALLET+'"'),"the link to Base");
  assert.match(detail,/BNB Smart Chain 0x[a-f0-9…]+ .*→ ethereum 0x/,"a link from a retired chain can appear on no graph");
  assert.match(detail,/ethereum 0x[a-f0-9…]+ +→ Base 0x/);
});

test("an explorer link is only ever a well-formed address or hash on a retired chain",async()=>{
  const odd='0x"><img src=x onerror=alert(1)>';
  const h=page({respond:workspaceAnswer(savedWorkspace({alerts:[{...ALERT,tx_id:"",address:odd}],
    watchlist:[watch("w-bsc","bsc","bc1qnotevm"),watch("w-live","ethereum")]}))});
  await h.api.loadCryptoWorkspace();
  assert.doesNotMatch(h.el("cryptoAlerts").innerHTML,/<a |<img/);
  const items=h.el("cryptoWatchlist").innerHTML.split('<div class="intel-item">').slice(1);
  assert.doesNotMatch(items[0],/<a /);
  assert.match(items[0],/NOT CHECKED/);
  assert.doesNotMatch(items[1],/<a /);
});

test("the graph and findings name a retired destination in full",async()=>{
  const h=page({respond:workspaceAnswer(savedWorkspace())});
  await h.api.loadCryptoWorkspace();
  h.api.selectCase("c1");
  h.api.seed(liveWallet());
  const finding=plain(h.api.crossChainFindings()).find(item=>item.destination_chain);
  assert.equal(finding.destination_chain,"Base");
});

test("the case PDF and the full report name the chains and carry their explorers, with no analysis",async()=>{
  const docs=[];
  const h=page({respond:workspaceAnswer(savedWorkspace())});
  h.context.window.CTAtlasPdf={download:async doc=>{docs.push(doc);return {};}};
  await h.api.loadCryptoWorkspace();
  h.api.selectCase("c1");

  await h.api.exportCasePdf();
  const pdf=plain(docs[0].blocks).map(block=>block.text||"").join("\n");
  assert.match(pdf,/CHAIN: BNB Smart Chain \(no longer analysed\)/);
  assert.ok(pdf.includes("BNB Smart Chain: "+WALLET+" · https://bscscan.com/address/"+WALLET),"the seed and the link");
  assert.ok(pdf.includes("→ Base: "+WALLET+" · https://basescan.org/address/"+WALLET));
  assert.ok(pdf.includes("→ ethereum: "+LIVE_WALLET),"a live chain reads as before");

  h.api.seed(liveWallet());
  const model=plain(h.api.reportModel());
  assert.equal(model.caseContext.chain,"BNB Smart Chain");
  assert.equal(model.caseContext.crosschain[0].from,"BNB Smart Chain: "+WALLET+" · https://bscscan.com/address/"+WALLET);
  assert.equal(model.caseContext.crosschain[1].to,"Base: "+WALLET+" · https://basescan.org/address/"+WALLET);
  const report=Report.build(model).blocks.map(block=>block.text||"").join("\n");
  assert.ok(report.includes("Bridge case · OPEN · BNB Smart Chain"));
  assert.ok(report.includes("https://bscscan.com/address/"+WALLET));
  assert.deepEqual(analyses(h.calls),[]);
});

for(const [title,revision] of [["CHECK MONITORED NOW",4],["the check against a Worker without revisions",null]]){
  test(title+" skips retired watches, says so, and reads the live wallet",async()=>{
    const watches=[watch("w-bsc","bsc"),watch("w-base","base"),watch("w-live","ethereum",LIVE_WALLET)];
    const answer=workspaceAnswer(savedWorkspace({watchlist:watches,revision:undefined}),revision);
    const h=page({respond:call=>{
      if(call.url.endsWith("/crypto-monitor-check"))return {json:{ok:true,alerts_added:0}};
      if(call.url.endsWith("/crypto-analyze"))return {json:liveWallet()};
      return answer(call);
    }});
    await h.api.loadCryptoWorkspace();
    await h.api.checkMonitored();
    const checks=h.calls.filter(call=>call.url.endsWith("/crypto-monitor-check")).map(call=>call.body.watch_id);
    const reads=analyses(h.calls).map(call=>call.body.chain);
    assert.deepEqual([...checks,...reads],revision===null?["ethereum"]:["w-live"]);
    assert.match(h.el("monitorStatus").textContent,/^Monitoring check complete · 1 wallet\(s\) checked · 0 new alert\(s\) · 2 on a chain no longer supported, not checked\./);
  });
}

test("retired watches cannot use up the 50-wallet check",async()=>{
  const watches=[...Array.from({length:50},(_,index)=>watch("a"+index,"bsc")),watch("z-live","ethereum",LIVE_WALLET)];
  const h=page({respond:call=>call.url.endsWith("/crypto-monitor-check")?{json:{ok:true,alerts_added:0}}:workspaceAnswer(savedWorkspace({watchlist:watches}))(call)});
  await h.api.loadCryptoWorkspace();
  await h.api.checkMonitored();
  assert.deepEqual(h.calls.filter(call=>call.url.endsWith("/crypto-monitor-check")).map(call=>call.body.watch_id),["z-live"]);
});

test("with only retired watches CHECK says why nothing ran, and asks nothing of the Worker",async()=>{
  const h=page({respond:workspaceAnswer(savedWorkspace())});
  await h.api.loadCryptoWorkspace();
  h.calls.length=0;
  await h.api.checkMonitored();
  assert.deepEqual(h.calls,[]);
  assert.equal(h.el("monitorStatus").textContent,"Nothing to check: 2 monitored wallet(s) on a chain no longer supported.");
});

test("the provider strip is unaffected by old entries in a stored record",async()=>{
  const h=page({respond:()=>({json:{crypto_providers:{bitcoin:true,evm:true,tron:true},crypto_exchange_label_providers:{},crypto_provider_status:OLD_RECORD()}})});
  await h.api.providerHealth();
  const strip=h.el("providerStrip").innerHTML;
  assert.match(strip,/EVM · ETHERSCAN · READY/);
  assert.doesNotMatch(strip,/BSC|BNB|BASE/);
});
