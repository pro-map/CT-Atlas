// Real provider response shapes through the real Worker code, with fetch stubbed.
// Sources run in a vm like the other Worker tests, because CI's Node may not load
// .js files with ESM syntax through import().
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const stripped=file=>fs.readFileSync(file,"utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

// Own function scope: these modules reuse top-level names such as EVM_CHAINS.
function moduleExports(context,file,names){
  return vm.runInContext("(function(){"+stripped(file)+"\nreturn {"+names.join(",")+"};})()",context);
}

function harness(fetchImpl){
  const context=vm.createContext({
    cleanText,URLSearchParams,URL,AbortSignal,console,setTimeout,
    fetch:fetchImpl,
    resolveExchangeLabels:async()=>[]
  });
  vm.runInContext(stripped("cloudflare-worker/address-utils.js"),context);
  vm.runInContext(stripped("cloudflare-worker/sanctions.js"),context);
  Object.assign(context,moduleExports(context,"cloudflare-worker/exchange-behavior.mjs",["detectExchangeBehavior","EXCHANGE_BEHAVIOR_VERSION"]));
  vm.runInContext(stripped("cloudflare-worker/crypto.js"),context);
  return vm.runInContext("({detectCryptoInput,analyzeCryptoAddress,resetSanctionsCache})",context);
}

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const html=(status=200)=>new Response("<html><body>Maintenance</body></html>",{status,headers:{"content-type":"text/html"}});

const ENV={ETHERSCAN_API_KEY:"stub",TRONGRID_API_KEY:"stub",SANCTIONS_URL:"https://sanctions.test/list.json"};
const SANCTIONS={retrieved_at:new Date().toISOString(),sources:[],entities:[],addresses:[]};
const BC1="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const ETH="0x1111111111111111111111111111111111111111";
const OTHER="0x2222222222222222222222222222222222222222";
const EMPTY={status:"0",message:"No transactions found",result:[]};
const RATE_LIMIT={status:"0",message:"NOTOK",result:"Max calls per sec rate limit reached (5/sec)"};
const seconds=hoursAgo=>Math.floor(Date.now()/1000)-hoursAgo*3600;

const nativeTx=(over={})=>({
  blockNumber:"19000000",timeStamp:String(seconds(1)),hash:"0x"+"a".repeat(64),nonce:"7",from:OTHER,to:ETH,
  value:"1000000000000000000",gasUsed:"21000",gasPrice:"1000000000",isError:"0",confirmations:"10",
  input:"0x",methodId:"0x",functionName:"",...over
});

// Answers Etherscan V2 by action; a function answer gets the call count for that action.
function etherscan(handlers,sanctions=SANCTIONS){
  const calls={};
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(sanctions);
    const action=parsed.searchParams.get("action");
    calls[action]=(calls[action]||0)+1;
    const answer=handlers[action];
    if(answer===undefined)return json(EMPTY);
    return json(typeof answer==="function"?answer(calls[action]):answer);
  };
  return {fetchImpl,calls};
}

// Answers Blockstream Esplora: `pages` maps the path after /api to a body.
function esplora(pages,sanctions=SANCTIONS){
  const paths=[];
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(sanctions);
    const path=parsed.pathname.replace(/^\/api/,"");
    paths.push(path);
    const answer=pages[path];
    if(answer===undefined)return json({error:"not stubbed"},404);
    return answer instanceof Response?answer:json(answer);
  };
  return {fetchImpl,paths};
}

const btcInfo=(txCount=1)=>({chain_stats:{funded_txo_sum:100000,spent_txo_sum:0,tx_count:txCount},mempool_stats:{funded_txo_sum:0,spent_txo_sum:0,tx_count:0}});
const btcTx=(txid,over={})=>({
  txid,fee:200,status:{confirmed:true,block_height:900000,block_time:seconds(2)},
  vin:[{prevout:{scriptpubkey_address:"1BoatSLRHtKNngkdXEeobR76b53LETtpyT",value:100200}}],
  vout:[{scriptpubkey_address:BC1,value:100000}],...over
});

test("Etherscan's empty token list no longer fails a wallet that has native history",async()=>{
  const {fetchImpl}=etherscan({balance:{status:"1",message:"OK",result:"1000"},txlist:{status:"1",message:"OK",result:[nativeTx()]},tokentx:EMPTY});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.transactions.length,1);
  assert.equal(result.transactions[0].direction,"IN");
});

test("a brand-new EVM wallet reads as empty, not as a provider error",async()=>{
  const {fetchImpl}=etherscan({balance:{status:"1",message:"OK",result:"0"},txlist:EMPTY,tokentx:EMPTY});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.transactions.length,0);
});

test("an Etherscan rate-limit answer is retried once and the retry's data is used",async()=>{
  const {fetchImpl,calls}=etherscan({
    balance:{status:"1",message:"OK",result:"0"},
    txlist:count=>count===1?RATE_LIMIT:{status:"1",message:"OK",result:[nativeTx()]},
    tokentx:EMPTY
  });
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(calls.txlist,2);
  assert.equal(result.transactions.length,1);
});

test("an HTTP 429 is retried once",async()=>{
  let history=0;
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(SANCTIONS);
    if(parsed.pathname.endsWith("/txs"))return ++history===1?json({error:"slow down"},429):json([btcTx("c".repeat(64))]);
    return json(btcInfo());
  };
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(history,2);
  assert.equal(result.transactions.length,1);
});

test("a 200 that is not JSON fails instead of reading as an empty, clean wallet",async()=>{
  const {fetchImpl}=esplora({["/address/"+BC1]:html(),["/address/"+BC1+"/txs"]:html()});
  await assert.rejects(harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV),/did not return JSON/);
});

test("a hung provider reports a timeout, and every provider call carries a deadline",async()=>{
  const signals=[];
  const fetchImpl=async(url,options)=>{
    signals.push(options?.signal);
    throw new DOMException("The operation was aborted due to timeout","TimeoutError");
  };
  await assert.rejects(harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV),/did not answer in time/);
  assert.ok(signals.length>0&&signals.every(Boolean));
});

test("uppercase bech32 is normalised, so rows match the seed instead of reading as SELF",async()=>{
  const h=harness(async()=>{throw new Error("network not used");});
  assert.equal(h.detectCryptoInput(BC1.toUpperCase(),"auto").value,BC1);
  assert.equal(h.detectCryptoInput(BC1.toUpperCase(),"bitcoin").value,BC1);
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:[btcTx("c".repeat(64))]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1.toUpperCase(),"bitcoin",50,ENV);
  assert.equal(result.query,BC1);
  assert.equal(result.transactions[0].direction,"IN");
  assert.equal(result.transactions[0].amount,0.001);
});

test("forbidden base58 characters, bad checksums and mixed-case bech32 stop before any provider call",()=>{
  const h=harness(async()=>{throw new Error("network not used");});
  for(const value of [
    "1lIOlIOlIOlIOlIOlIOlIOlIOlIOlIO",
    "1BoatSLRHtKNngkdXEeobR76b53LETtpyU",
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlj",
    "bc1QXY2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJN"
  ]){
    assert.ok(h.detectCryptoInput(value,"auto").error,value);
  }
  assert.equal(h.detectCryptoInput("1BoatSLRHtKNngkdXEeobR76b53LETtpyT","auto").chain,"bitcoin");
});
