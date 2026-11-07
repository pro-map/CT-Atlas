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

function harness(fetchImpl,overrides={}){
  const context=vm.createContext({
    cleanText,URLSearchParams,URL,AbortSignal,console,setTimeout,
    fetch:fetchImpl,
    resolveExchangeLabels:async()=>[],
    normalizeUsername:value=>cleanText(value,80).toLowerCase(),
    isAllowedUser:()=>true,
    jsonResponse:(value,status=200)=>({value,status}),
    gateCall:async(_env,path)=>({ok:true,json:async()=>path==="/session-get"?{username:"analyst"}:{ok:true}}),
    ...overrides
  });
  vm.runInContext(stripped("cloudflare-worker/address-utils.js"),context);
  vm.runInContext(stripped("cloudflare-worker/sanctions.js"),context);
  Object.assign(context,moduleExports(context,"cloudflare-worker/exchange-behavior.mjs",["detectExchangeBehavior","EXCHANGE_BEHAVIOR_VERSION"]));
  Object.assign(context,moduleExports(context,"cloudflare-worker/crypto-risk.mjs",["isStablecoin","stablecoinUnits","assessWallet","derivePatterns","deriveAlertSummary"]));
  vm.runInContext(stripped("cloudflare-worker/crypto.js"),context);
  return vm.runInContext("({detectCryptoInput,analyzeCryptoAddress,runAnalysis,aggregateFlows,buildObservations,handleCrypto,CRYPTO_VERSION})",context);
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

const LISTED="1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const LIST_WITH_LISTED={
  ...SANCTIONS,
  entities:[{id:"1",name:"SYNTHETIC ENTITY",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],
  addresses:[{a:LISTED,c:"XBT",f:"bitcoin",e:[0]}]
};
const manyOutputs=count=>Array.from({length:count},(_,index)=>({
  scriptpubkey_address:index===count-1?LISTED:"bc1qfiller"+index,value:1000
}));

test("a listed output past the 12-item display cap is still screened, and the cap stays in the response",async()=>{
  const spend=btcTx("d".repeat(64),{
    vin:[{prevout:{scriptpubkey_address:BC1,value:30000}}],
    vout:manyOutputs(21)
  });
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:[spend]},LIST_WITH_LISTED);
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  const row=result.transactions[0];
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].address,LISTED);
  assert.equal(result.sanctions_screening.counterparties_checked,21);
  assert.equal(row.counterparties.length,12);
  assert.equal(row.counterparties_total,21);
  assert.equal(row.counterparties_truncated,true);
  assert.equal("all_counterparties" in row,false,"the uncapped list must not leave the Worker");
});

test("no listed address past the cap reaches a wallet with 25 rows either",async()=>{
  const rows=Array.from({length:25},(_,index)=>btcTx(String(index).padStart(64,"0"),{
    vin:[{prevout:{scriptpubkey_address:BC1,value:30000}}],
    vout:index===24?manyOutputs(40):[{scriptpubkey_address:"bc1qother"+index,value:1000}]
  }));
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(25),["/address/"+BC1+"/txs"]:rows},LIST_WITH_LISTED);
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",100,ENV);
  assert.equal(result.transactions.length,25);
  assert.equal(result.sanctions_screening.counterparty_matches.length,1);
});

test("a listed address spent alongside the seed is screened, without counting as a recipient",async()=>{
  // The shape behind the demo address's four missed listings: one spend, many inputs, one output.
  const spend=btcTx("e".repeat(64),{
    vin:[{prevout:{scriptpubkey_address:BC1,value:30000}},{prevout:{scriptpubkey_address:LISTED,value:30000}}],
    vout:[{scriptpubkey_address:"bc1qdestination",value:59000}]
  });
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:[spend]},LIST_WITH_LISTED);
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  const match=result.sanctions_screening.counterparty_matches[0];
  assert.equal(match.address,LISTED);
  assert.equal(match.spent_with_count,1);
  assert.equal(match.sent_to_count,0);
  assert.equal(result.transactions[0].counterparties.includes(LISTED),false);
  assert.equal("co_inputs" in result.transactions[0],false);
});

test("a fellow payee of a batch payout is not a counterparty of the seed",async()=>{
  const payout=btcTx("f".repeat(64),{
    vin:[{prevout:{scriptpubkey_address:"bc1qexchange",value:500000}}],
    vout:[{scriptpubkey_address:BC1,value:100000},{scriptpubkey_address:LISTED,value:100000}]
  });
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:[payout]},LIST_WITH_LISTED);
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(result.sanctions_screening.hit,false);
  assert.deepEqual(Array.from(result.transactions[0].counterparties),["bc1qexchange"]);
});

test("the single-transaction view screens every party, not only the 30 it displays",async()=>{
  const txid="9".repeat(64);
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(LIST_WITH_LISTED);
    return json(btcTx(txid,{vout:manyOutputs(45)}));
  };
  const h=harness(fetchImpl);
  const result=await h.runAnalysis(h.detectCryptoInput(txid,"bitcoin"),50,ENV);
  assert.equal(result.transaction.output_addresses.length,30);
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal("all_addresses" in result.transaction,false);
});

const txidOf=index=>String(index).padStart(64,"0");
const btcPage=(from,count)=>Array.from({length:count},(_,index)=>btcTx(txidOf(from+index),{status:{confirmed:true,block_height:900000-from-index,block_time:seconds(from+index+1)}}));
const chainPath=index=>"/address/"+BC1+"/txs/chain/"+txidOf(index);

test("Bitcoin pages back to the limit and reports the real coverage",async()=>{
  const {fetchImpl,paths}=esplora({
    ["/address/"+BC1]:btcInfo(60),
    ["/address/"+BC1+"/txs"]:btcPage(0,25),
    [chainPath(24)]:btcPage(25,25),
    [chainPath(49)]:btcPage(50,10)
  });
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",100,ENV);
  assert.equal(result.transactions.length,60);
  assert.equal(result.coverage.rows,60);
  assert.equal(result.coverage.lifetime_tx_count,60);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.partial,false);
  assert.ok(result.coverage.oldest<result.coverage.newest);
  assert.match(result.sampling_note,/newest 60 records of 60/);
  assert.equal(paths.filter(path=>path.includes("/txs/chain/")).length,2,"a short page ends the walk");
});

test("Bitcoin stops at the limit and an unfinished sample is not complete",async()=>{
  const {fetchImpl,paths}=esplora({
    ["/address/"+BC1]:btcInfo(135),
    ["/address/"+BC1+"/txs"]:btcPage(0,25),
    [chainPath(24)]:btcPage(25,25),
    [chainPath(49)]:btcPage(50,25)
  });
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(result.transactions.length,50);
  assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.lifetime_tx_count,135);
  assert.equal(paths.filter(path=>path.includes("/txs/chain/")).length,1);
});

test("the next Bitcoin page is keyed on the last confirmed row, not a mempool row",async()=>{
  const mempool=btcTx("a".repeat(64),{status:{confirmed:false}});
  const {fetchImpl,paths}=esplora({
    ["/address/"+BC1]:btcInfo(30),
    ["/address/"+BC1+"/txs"]:[mempool,...btcPage(0,25)],
    [chainPath(24)]:btcPage(25,5)
  });
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",100,ENV);
  assert.ok(paths.includes(chainPath(24)));
  assert.equal(result.transactions.length,31);
  assert.equal(result.coverage.complete,true,"30 confirmed of 30: the mempool row must not count towards it");
});

test("a failed older page keeps what was read and says the sample is partial",async()=>{
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(135),["/address/"+BC1+"/txs"]:btcPage(0,25)});
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",100,ENV);
  assert.equal(result.transactions.length,25);
  assert.equal(result.coverage.partial,true);
  assert.equal(result.coverage.complete,false);
  assert.deepEqual(Array.from(result.coverage.failed_sources),["Blockstream older transactions"]);
  assert.ok(result.observations.some(note=>/Partial result/.test(note)));
});

test("a failed Bitcoin address read loses the balance, not the rows, and history failing still fails",async()=>{
  const noInfo=esplora({["/address/"+BC1]:json({error:"down"},500),["/address/"+BC1+"/txs"]:[btcTx("c".repeat(64))]});
  const result=await harness(noInfo.fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(result.balance,null);
  assert.equal(result.transactions.length,1);
  assert.equal(result.coverage.partial,false,"no transaction rows are missing");
  assert.equal(result.coverage.complete,false,"without a lifetime count completeness is unknown");
  assert.equal(result.coverage.lifetime_tx_count,null);
  const noHistory=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:json({error:"down"},500)});
  await assert.rejects(harness(noHistory.fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV),/down/);
});

test("a Bitcoin provider returning the wrong shape is a failure, not an empty wallet",async()=>{
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:{message:"maintenance"}});
  await assert.rejects(harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV),/unexpected response/);
});

const rowOf=async tx=>{
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(),["/address/"+BC1+"/txs"]:[tx]});
  return (await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV)).transactions[0];
};

test("a Bitcoin self-spend reads as SELF for what it moved, not OUT for its fee",async()=>{
  const row=await rowOf(btcTx("d".repeat(64),{
    fee:500,
    vin:[{prevout:{scriptpubkey_address:BC1,value:300000}},{prevout:{scriptpubkey_address:BC1,value:200000}}],
    vout:[{scriptpubkey_address:BC1,value:499500},{scriptpubkey_type:"op_return",value:0}]
  }));
  assert.equal(row.direction,"SELF");
  assert.equal(row.self_spend,true);
  assert.equal(row.amount,0.004995);
  assert.equal(row.fee,0.000005);
  assert.equal(row.counterparties.length,0);
});

test("a Bitcoin payment separates what was paid from the fee and the change",async()=>{
  const row=await rowOf(btcTx("d".repeat(64),{
    fee:1000,
    vin:[{prevout:{scriptpubkey_address:BC1,value:100000000}}],
    vout:[{scriptpubkey_address:"bc1qpayee",value:50000000},{scriptpubkey_address:BC1,value:49999000}]
  }));
  assert.equal(row.direction,"OUT");
  assert.equal(row.amount,0.50001,"a net amount includes the fee");
  assert.equal(row.payment_amount,0.5);
  assert.deepEqual(Array.from(row.out_values),[0.5]);
  assert.equal(row.self_spend,false);
  assert.equal(row.amount_raw,"50001000");
  assert.equal(row.asset_key,"native");
  assert.equal(row.inputs_count,1);
  assert.equal(row.outputs_count,2);
  assert.equal(row.block_height,900000);
});

test("an input from another wallet stops a spend reading as a self-spend",async()=>{
  const row=await rowOf(btcTx("d".repeat(64),{
    vin:[{prevout:{scriptpubkey_address:BC1,value:100000}},{prevout:{scriptpubkey_address:"bc1qother",value:900000}}],
    vout:[{scriptpubkey_address:BC1,value:999000}]
  }));
  assert.equal(row.self_spend,false);
  assert.equal(row.direction,"IN");
});

test("coinjoin_like needs both five inputs and five equal outputs, and coinbase is flagged",async()=>{
  const inputs=Array.from({length:5},(_,index)=>({prevout:{scriptpubkey_address:index?"bc1qp"+index:BC1,value:200000}}));
  const equal=count=>Array.from({length:count},(_,index)=>({scriptpubkey_address:"bc1qo"+index,value:100000}));
  assert.equal((await rowOf(btcTx("d".repeat(64),{vin:inputs,vout:equal(5)}))).coinjoin_like,true);
  assert.equal((await rowOf(btcTx("d".repeat(64),{vin:inputs,vout:equal(4)}))).coinjoin_like,false);
  assert.equal((await rowOf(btcTx("d".repeat(64),{vin:inputs.slice(0,4),vout:equal(5)}))).coinjoin_like,false);
  const coinbase=await rowOf(btcTx("d".repeat(64),{vin:[{is_coinbase:true}],vout:[{scriptpubkey_address:BC1,value:625000000}]}));
  assert.equal(coinbase.is_coinbase,true);
});

const USDT_ETH="0xdac17f958d2ee523a2206206994597c13d831ec7";
const internalTx=(over={})=>({blockNumber:"19000001",timeStamp:String(seconds(3)),hash:"0x"+"b".repeat(64),from:OTHER,to:ETH,value:"2000000000000000000",contractAddress:"",input:"",type:"call",isError:"0",errCode:"",...over});
const tokenTx=(over={})=>({blockNumber:"19000002",timeStamp:String(seconds(4)),hash:"0x"+"c".repeat(64),from:OTHER,to:ETH,value:"5000000",contractAddress:USDT_ETH,tokenName:"Tether USD",tokenSymbol:"USDT",tokenDecimal:"6",confirmations:"10",...over});
const OK=result=>({status:"1",message:"OK",result});

test("internal transactions become rows, so a contract payout is visible",async()=>{
  const {fetchImpl,calls}=etherscan({
    balance:OK("0"),txlist:EMPTY,tokentx:EMPTY,
    txlistinternal:OK([internalTx(),internalTx({hash:"0x"+"d".repeat(64),from:ETH,to:OTHER,value:"1000000000000000000"}),internalTx({hash:"0x"+"e".repeat(64),isError:"1"}),internalTx({hash:"0x"+"f".repeat(64),value:"0"})])
  });
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(calls.txlistinternal,1);
  assert.equal(result.transactions.length,3,"a zero-value trace moves nothing");
  const row=result.transactions.find(item=>item.id==="0x"+"b".repeat(64));
  assert.equal(row.internal,true);
  assert.equal(row.direction,"IN");
  assert.equal(row.amount,2);
  assert.deepEqual(Array.from(row.counterparties),[OTHER]);
  assert.equal(result.transactions.find(item=>item.id==="0x"+"d".repeat(64)).direction,"OUT");
  assert.equal(result.transactions.find(item=>item.id==="0x"+"e".repeat(64)).failed,true);
  assert.equal(result.activity.internal_records_found,4);
});

test("tokens are keyed by contract: only the allow-listed contract is a stablecoin",async()=>{
  const fake="0x9999999999999999999999999999999999999999";
  const {fetchImpl}=etherscan({balance:OK("0"),txlist:EMPTY,tokentx:OK([tokenTx(),tokenTx({hash:"0x"+"d".repeat(64),contractAddress:fake})])});
  const h=harness(fetchImpl);
  const result=await h.analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  const real=result.transactions.find(row=>row.token_contract===USDT_ETH);
  const copy=result.transactions.find(row=>row.token_contract===fake);
  assert.equal(real.stable,true);
  assert.equal(real.asset_key,USDT_ETH);
  assert.equal(real.amount,5);
  assert.equal(real.amount_raw,"5000000");
  assert.equal(copy.asset,"USDT","the symbol is the same");
  assert.equal(copy.stable,undefined);
  assert.equal(result.flows.length,2,"the two USDT contracts stay separate flows");
});

test("a token advertising itself in its name is flagged as spam, and a real one is not",async()=>{
  const {fetchImpl}=etherscan({balance:OK("0"),txlist:EMPTY,tokentx:OK([
    tokenTx({contractAddress:"0x"+"7".repeat(40),tokenName:"Visit usdt-bonus.xyz to claim",tokenSymbol:"$ FREE"}),
    tokenTx({hash:"0x"+"d".repeat(64)})
  ])});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.transactions.find(row=>row.token_contract!==USDT_ETH).spam,true);
  assert.equal(result.transactions.find(row=>row.token_contract===USDT_ETH).spam,undefined);
});

test("coverage on EVM is complete only when every list ended before its page size",async()=>{
  const short=etherscan({balance:OK("0"),txlist:OK([nativeTx()]),tokentx:EMPTY});
  assert.equal((await harness(short.fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV)).coverage.complete,true);
  const rows=Array.from({length:50},(_,index)=>nativeTx({hash:"0x"+String(index).padStart(64,"0")}));
  const full=etherscan({balance:OK("0"),txlist:OK(rows),tokentx:EMPTY});
  const result=await harness(full.fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.lifetime_tx_count,null,"Etherscan gives no lifetime count");
});

test("one failed EVM list gives a partial result rather than failing the wallet",async()=>{
  const {fetchImpl}=etherscan({balance:OK("0"),txlist:OK([nativeTx()]),tokentx:{status:"0",message:"NOTOK",result:"Query Timeout occurred"}});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.transactions.length,1);
  assert.equal(result.coverage.partial,true);
  assert.equal(result.coverage.complete,false);
  assert.deepEqual(Array.from(result.coverage.failed_sources),["Etherscan token transfers"]);
});

test("a rate limit that persists after the retry fails only that list",async()=>{
  const {fetchImpl,calls}=etherscan({balance:OK("0"),txlist:OK([nativeTx()]),tokentx:RATE_LIMIT});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(calls.tokentx,2);
  assert.equal(result.coverage.partial,true);
});

test("every EVM history list failing still fails the wallet, so it cannot read as clean",async()=>{
  const bad={status:"0",message:"NOTOK",result:"Invalid API Key"};
  const {fetchImpl}=etherscan({balance:bad,txlist:bad,tokentx:bad,txlistinternal:bad});
  await assert.rejects(harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV),/Invalid API Key/);
});

test("a failed balance loses the balance but not the rows, and the monitor can skip that call",async()=>{
  const failed=etherscan({balance:{status:"0",message:"NOTOK",result:"Query Timeout occurred"},txlist:OK([nativeTx()]),tokentx:EMPTY});
  const result=await harness(failed.fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.balance,null);
  assert.equal(result.coverage.partial,false);
  assert.ok(result.observations.some(note=>/balance is not shown/.test(note)));
  const skipped=etherscan({txlist:OK([nativeTx()]),tokentx:EMPTY});
  const quiet=await harness(skipped.fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV,{skipBalance:true});
  assert.equal(skipped.calls.balance,undefined);
  assert.equal(quiet.balance,null);
  assert.equal(quiet.observations.some(note=>/balance is not shown/.test(note)),false);
});

const TRON_SEED="TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz";
const TRON_SEED_HEX="4100be5e0c85be35948d97ad37f62d108243f89ae0";
const TRON_OTHER="TA39q3p75XRSWYAEaSF7dANtyksoa3sLge";
const TRON_OTHER_HEX="4100bf03f87539214307207c61b7f729ddc22977b8";
const USDT_TRON="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const trxTx=(id,owner,to,amount=2000000,over={})=>({
  txID:id,block_timestamp:Date.now()-3600e3,ret:[{contractRet:"SUCCESS",fee:0}],
  raw_data:{contract:[{type:"TransferContract",parameter:{value:{owner_address:owner,to_address:to,amount}}}]},...over
});
const trc20=(id,from,to,over={})=>({
  transaction_id:id,block_timestamp:Date.now()-7200e3,from,to,type:"Transfer",value:"5000000",
  token_info:{symbol:"USDT",address:USDT_TRON,decimals:6,name:"Tether USD"},...over
});

// Answers TronGrid by path and query; a Response answer stands for a failed call.
function trongrid({account={data:[{balance:5000000,create_time:1600000000000}]},tokens=[],out=[],incoming=[],sanctions=SANCTIONS}={}){
  const answer=value=>value instanceof Response?value:json({success:true,data:value});
  const paths=[];
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(sanctions);
    paths.push(parsed.pathname+parsed.search);
    if(parsed.pathname.endsWith("/trc20"))return answer(tokens);
    if(parsed.searchParams.get("only_from"))return answer(out);
    if(parsed.searchParams.get("only_to"))return answer(incoming);
    return account instanceof Response?account:json({success:true,...account});
  };
  return {fetchImpl,paths};
}

test("a TRON self-transfer in both lists is one SELF row with no counterparty",async()=>{
  const self=trxTx("self-1",TRON_SEED_HEX,TRON_SEED_HEX);
  const {fetchImpl}=trongrid({out:[self],incoming:[self]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.transactions.length,1);
  assert.equal(result.transactions[0].direction,"SELF");
  assert.equal(result.transactions[0].counterparties.length,0);
});

test("TRON direction comes from the addresses, not from which list held the row",async()=>{
  const {fetchImpl}=trongrid({incoming:[trxTx("sent",TRON_SEED_HEX,TRON_OTHER_HEX)],out:[trxTx("received",TRON_OTHER_HEX,TRON_SEED_HEX)]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.transactions.find(row=>row.id==="sent").direction,"OUT");
  assert.equal(result.transactions.find(row=>row.id==="received").direction,"IN");
});

test("a TRC-20 Approval never reads as a transfer, and a row with no type still does",async()=>{
  const {fetchImpl}=trongrid({tokens:[
    trc20("approval",TRON_SEED,TRON_OTHER,{type:"Approval",value:"115792089237316195423570985008687907853269984665640564039457584007913129639935"}),
    trc20("transfer",TRON_OTHER,TRON_SEED),
    trc20("untyped",TRON_OTHER,TRON_SEED,{type:undefined})
  ]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.deepEqual(Array.from(result.transactions,row=>row.id).sort(),["transfer","untyped"]);
  const row=result.transactions[0];
  assert.equal(row.stable,true);
  assert.equal(row.asset_key,USDT_TRON.toLowerCase());
  assert.equal(row.amount,5);
});

test("a TRC-20 transfer to itself has no counterparty",async()=>{
  const {fetchImpl}=trongrid({tokens:[trc20("self",TRON_SEED,TRON_SEED)]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.transactions[0].direction,"SELF");
  assert.equal(result.transactions[0].counterparties.length,0);
});

test("a reverted TRX transfer is marked failed",async()=>{
  const {fetchImpl}=trongrid({out:[trxTx("reverted",TRON_SEED_HEX,TRON_OTHER_HEX,2000000,{ret:[{contractRet:"OUT_OF_ENERGY"}]})]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.transactions[0].failed,true);
});

test("TRON exposes the account's creation time and its coverage",async()=>{
  const {fetchImpl}=trongrid({incoming:[trxTx("in",TRON_OTHER_HEX,TRON_SEED_HEX)]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.activity.account_created_at,"2020-09-13T12:26:40.000Z");
  assert.equal(result.balance.amount,5);
  assert.equal(result.coverage.complete,true);
});

test("one failed TRON list is partial, all failing still fails, and a bad shape counts as failing",async()=>{
  const down=()=>json({Error:"down"},500);
  const one=trongrid({tokens:down(),incoming:[trxTx("in",TRON_OTHER_HEX,TRON_SEED_HEX)]});
  const result=await harness(one.fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
  assert.equal(result.coverage.partial,true);
  assert.deepEqual(Array.from(result.coverage.failed_sources),["TronGrid TRC-20 history"]);
  const all=trongrid({tokens:down(),out:down(),incoming:down()});
  await assert.rejects(harness(all.fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV));
  const fetchImpl=async url=>new URL(String(url)).hostname==="sanctions.test"?json(SANCTIONS):html();
  await assert.rejects(harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV),/did not return JSON/);
});

test("a wallet's token rows screen the other party, whether the token was sent or received",async()=>{
  const listedEvm="0x3333333333333333333333333333333333333333";
  const evmList={...LIST_WITH_LISTED,addresses:[{a:listedEvm,c:"USDT",f:"evm",e:[0]}]};
  for(const row of [tokenTx({from:listedEvm,to:ETH}),tokenTx({from:ETH,to:listedEvm})]){
    const {fetchImpl}=etherscan({balance:OK("0"),txlist:EMPTY,tokentx:OK([row])},evmList);
    const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
    assert.equal(result.sanctions_screening.counterparty_matches[0]?.address,listedEvm,row.from===ETH?"sent":"received");
  }
  const tronList={...LIST_WITH_LISTED,addresses:[{a:TRON_OTHER,c:"USDT",f:"tron",e:[0]}]};
  for(const row of [trc20("in",TRON_OTHER,TRON_SEED),trc20("out",TRON_SEED,TRON_OTHER)]){
    const {fetchImpl}=trongrid({tokens:[row],sanctions:tronList});
    const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV);
    assert.equal(result.sanctions_screening.counterparty_matches[0]?.address,TRON_OTHER,row.transaction_id);
  }
});

test("the monitor's history-only read skips TronGrid's account call",async()=>{
  const {fetchImpl,paths}=trongrid({incoming:[trxTx("in",TRON_OTHER_HEX,TRON_SEED_HEX)]});
  const result=await harness(fetchImpl).analyzeCryptoAddress(TRON_SEED,"tron",50,ENV,{skipBalance:true});
  assert.equal(paths.some(path=>!path.includes("/transactions")),false);
  assert.equal(result.balance,null);
});

test("flows and the both-directions note compare one asset at a time and skip failed rows",()=>{
  const h=harness(async()=>{throw new Error("network not used");});
  const seed="bc1qseed";
  const rows=[
    {direction:"IN",asset:"USDT",asset_key:"0xusdt",amount:2000,counterparties:["a"]},
    {direction:"OUT",asset:"ETH",asset_key:"native",amount:1800,counterparties:["b"]}
  ];
  assert.equal(h.buildObservations(rows,seed).some(note=>/both directions/.test(note)),false);
  const same=[...rows,{direction:"OUT",asset:"USDT",asset_key:"0xusdt",amount:1900,counterparties:["c"]}];
  assert.equal(h.buildObservations(same,seed).some(note=>/both directions/.test(note)),true);
  const failed=[{direction:"OUT",asset:"ETH",amount:5,failed:true,counterparties:["a"]}];
  assert.equal(h.aggregateFlows(failed,seed).length,0);
});

const searchRequest=body=>({json:async()=>({user_id:"analyst",...body}),headers:{get:()=>"session-token"}});

test("a search response carries the assessment, its coverage, and the derived older fields",async()=>{
  const spend=btcTx("d".repeat(64),{vin:[{prevout:{scriptpubkey_address:BC1,value:30000}}],vout:manyOutputs(21)});
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(1),["/address/"+BC1+"/txs"]:[spend]},LIST_WITH_LISTED);
  const response=await harness(fetchImpl).handleCrypto(searchRequest({query:BC1,chain:"bitcoin"}),ENV);
  assert.equal(response.status,200);
  const body=response.value;
  assert.equal(body.version,"crypto-intel-v6-risk-assessment");
  const assessment=body.risk_assessment;
  for(const key of ["version","label","score","thresholds","service_discount","reasons","findings","not_evaluated","coverage","disclaimer"]){
    assert.ok(key in assessment,key);
  }
  assert.equal(assessment.label,"HIGH");
  assert.equal(assessment.findings[0].code,"DIRECT_SANCTIONS_EXPOSURE");
  assert.deepEqual(Array.from(assessment.findings[0].tx_ids),["d".repeat(64)],"the row past the display cap is the evidence");
  assert.equal(assessment.coverage.lifetime_tx_count,1);
  assert.equal(body.coverage.complete,true);
  assert.equal(assessment.coverage.complete,true);
  assert.equal(body.suspicious_patterns[0].code,"DIRECT_SANCTIONS_EXPOSURE");
  assert.equal(body.alert_summary.highest_severity,"HIGH");
  assert.ok(body.observations.some(note=>/Automated indicators in this sample, not findings/.test(note)));
  assert.equal(JSON.stringify(body).includes("all_counterparties"),false);
  assert.equal(JSON.stringify(body).includes("co_inputs"),false);
});

test("a search and a monitor read of the same wallet reach the same label",async()=>{
  const spend=btcTx("d".repeat(64),{vin:[{prevout:{scriptpubkey_address:BC1,value:30000}}],vout:manyOutputs(21)});
  const stub=()=>esplora({["/address/"+BC1]:btcInfo(1),["/address/"+BC1+"/txs"]:[spend]},LIST_WITH_LISTED).fetchImpl;
  const search=(await harness(stub()).handleCrypto(searchRequest({query:BC1,chain:"bitcoin"}),ENV)).value;
  const monitor=await harness(stub()).analyzeCryptoAddress(BC1,"bitcoin",50,ENV,{skipBalance:true});
  assert.equal(monitor.risk_assessment.label,search.risk_assessment.label);
  assert.equal(monitor.risk_assessment.score,search.risk_assessment.score);
});

test("exchange labels reach the assessment, so a sourced exchange seed gets the service discount",async()=>{
  const {fetchImpl}=esplora({["/address/"+BC1]:btcInfo(1),["/address/"+BC1+"/txs"]:[btcTx("c".repeat(64))]});
  const labels=[{chain:"bitcoin",address:BC1,name:"Synthetic exchange",category:"EXCHANGE",source_title:"Synthetic source"}];
  const h=harness(fetchImpl,{resolveExchangeLabels:async()=>labels});
  const result=await h.analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(result.exchange_behavior.status,"sourced_match");
  assert.equal(result.risk_assessment.service_discount,true);
  assert.equal(result.exchange_labels.length,1);
});

test("a partial read cannot come back LOW, and says what is missing",async()=>{
  const {fetchImpl}=etherscan({balance:OK("0"),txlist:OK([nativeTx()]),tokentx:{status:"0",message:"NOTOK",result:"Query Timeout occurred"}});
  const result=await harness(fetchImpl).analyzeCryptoAddress(ETH,"ethereum",50,ENV);
  assert.equal(result.risk_assessment.label,"NOT_ASSESSED");
  assert.equal(result.risk_assessment.coverage.partial,true);
  assert.ok(Array.from(result.risk_assessment.not_evaluated).some(item=>item.code==="PARTIAL_HISTORY"));
});

test("an unavailable sanctions list cannot come back LOW either",async()=>{
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")throw new Error("list down");
    return json(parsed.pathname.endsWith("/txs")?btcPage(0,10):btcInfo(10));
  };
  const result=await harness(fetchImpl).analyzeCryptoAddress(BC1,"bitcoin",50,ENV);
  assert.equal(result.sanctions_screening.status,"unavailable");
  assert.equal(result.risk_assessment.label,"NOT_ASSESSED");
});

test("a single-transaction view has no wallet assessment and keeps the older empty fields",async()=>{
  const txid="9".repeat(64);
  const fetchImpl=async url=>new URL(String(url)).hostname==="sanctions.test"?json(SANCTIONS):json(btcTx(txid));
  const response=await harness(fetchImpl).handleCrypto(searchRequest({query:txid,chain:"bitcoin"}),ENV);
  assert.equal(response.status,200);
  assert.equal(response.value.risk_assessment,undefined);
  assert.equal(response.value.suspicious_patterns.length,0);
  assert.equal(response.value.alert_summary.highest_severity,"LOW");
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
