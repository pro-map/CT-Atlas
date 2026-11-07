// Token transfers in a single-transaction lookup. Real provider answers (each fixture says where
// it came from) go through the real Worker code with fetch stubbed, then through the real page
// and report code, so a false NO MATCH would show up where the analyst reads it.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const Report=require("../crypto-report.js");

const stripped=file=>fs.readFileSync(file,"utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

function moduleExports(context,file,names){
  return vm.runInContext("(function(){"+stripped(file)+"\nreturn {"+names.join(",")+"};})()",context);
}

const ENV={ETHERSCAN_API_KEY:"stub",TRONGRID_API_KEY:"stub",SANCTIONS_URL:"https://sanctions.test/list.json"};

// The Worker as crypto-providers.test.cjs runs it, with the real collector of label addresses.
function worker(fetchImpl){
  const labelLookups=[];
  const context=vm.createContext({
    cleanText,URLSearchParams,URL,AbortSignal,console,setTimeout,
    fetch:fetchImpl,
    normalizeUsername:value=>cleanText(value,80).toLowerCase(),
    isAllowedUser:()=>true,
    jsonResponse:(value,status=200)=>({value,status}),
    gateCall:async(_env,path)=>({ok:true,json:async()=>path==="/session-get"?{username:"analyst"}:{ok:true}})
  });
  vm.runInContext(stripped("cloudflare-worker/address-utils.js"),context);
  vm.runInContext(stripped("cloudflare-worker/sanctions.js"),context);
  const {collectAddressEntries}=moduleExports(context,"cloudflare-worker/exchange-addresses.js",["collectAddressEntries"]);
  context.resolveExchangeLabels=async result=>{
    labelLookups.push(collectAddressEntries(result).map(entry=>entry.address));
    return [];
  };
  Object.assign(context,moduleExports(context,"cloudflare-worker/exchange-behavior.mjs",["detectExchangeBehavior","EXCHANGE_BEHAVIOR_VERSION"]));
  Object.assign(context,moduleExports(context,"cloudflare-worker/crypto-risk.mjs",["isStablecoin","stablecoinUnits","assessWallet","derivePatterns","deriveAlertSummary"]));
  vm.runInContext(stripped("cloudflare-worker/crypto.js"),context);
  const api=vm.runInContext("({detectCryptoInput,runAnalysis,handleCrypto})",context);
  return {
    ...api,
    labelLookups,
    lookup:async(hash,chain)=>plain(await api.runAnalysis(api.detectCryptoInput(hash,chain),50,ENV))
  };
}

// The real page in a vm with a fake DOM, as crypto-page.test.cjs runs it.
function page(){
  const nodes=new Map();
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:"",innerHTML:"",textContent:"",className:"",hidden:false,disabled:false,dataset:{},options:[],
      classList:{toggle(){},add(){},remove(){},contains(){return false;}},querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},addEventListener(){},focus(){}});
    return nodes.get(id);
  };
  el("filterDirection").value="all";el("filterAsset").value="all";el("filterType").value="all";el("filterStatus").value="all";
  el("filterGraphMinLinks").value="1";el("filterGraphNodes").value="80";el("traceMaxDepth").value="6";el("traceBranch").value="8";
  const context=vm.createContext({
    console:{warn(){},log(){}},
    document:{readyState:"loading",addEventListener(){},getElementById:el,body:{classList:{add(){},remove(){}}}},
    sessionStorage:{getItem:()=>"analyst"},
    window:{location:{href:"https://example.invalid/crypto.html",search:""},CTAtlasCryptoReport:Report},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,1)),clearTimeout,URL,URLSearchParams,
    fetch:async()=>({status:200,ok:true,json:async()=>({})})
  });
  vm.runInContext(fs.readFileSync("crypto.js","utf8").replace(/\}\)\(\);\s*$/,"globalThis.api={render,reportModel:()=>collectReportModel()};})();"),context);
  return {api:context.api,el};
}

// What the analyst sees: the sanctions badge and card, the transaction card, the KPIs and the report.
function shown(result){
  const p=page();
  p.api.render(result);
  const report=Report.build(p.api.reportModel());
  return {
    badge:p.el("cryptoSanctionsBadge").textContent,
    card:p.el("cryptoSanctionsBody").innerHTML,
    tokens:p.el("cryptoTokenTransfers").innerHTML,
    kpis:p.el("cryptoKpis").innerHTML,
    report:report.blocks.flatMap(block=>block.type==="table"
      ?(block.rows||[]).flatMap(row=>Object.values(row).map(cell=>typeof cell==="object"&&cell?cell.text:cell))
      :[block.text||""]).join("\n")
  };
}

// Values built inside a vm have that realm's prototypes; assertions compare plain copies.
const plain=value=>JSON.parse(JSON.stringify(value));
const fixture=name=>JSON.parse(fs.readFileSync("tests/fixtures/crypto-token-transfers/"+name,"utf8"));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});

// GAZA NOW's OFAC SDN entry and its USDT addresses, as tools/update_sanctions.py wrote them on 2026-11-05.
const GAZA_NOW={id:"47635",name:"GAZA NOW",type:"entity",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"};
const LISTED_ETH="0x175d44451403edf28469df03a9280c1197adb92c";
const LISTED_TRON="TGJVc32ig2u8tQsYMLE7KXHT5NDQroaVNU";
// Stands in for a listing of an address that is not listed, only to prove that it is screened.
const STUB={id:"0",name:"SYNTHETIC ENTITY",type:"entity",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"};
const listing=address=>address===LISTED_ETH?{a:address,c:"USDT",f:"evm",e:[0]}
  :address===LISTED_TRON?{a:address,c:"USDT",f:"tron",e:[0]}
    :{a:address,c:"ETH",f:"evm",e:[1]};
const sanctionsList=(...addresses)=>({
  retrieved_at:new Date().toISOString(),
  sources:[{id:"OFAC_SDN",name:"OFAC Specially Designated Nationals (SDN) List",published:"2026-11-05"}],
  entities:[GAZA_NOW,STUB],
  addresses:addresses.map(listing)
});

// Etherscan's own words, as tests/crypto-provider-health.test.cjs records them.
const notok=result=>({status:"0",message:"NOTOK",result});
const SHARED_POOL="Community Free API limit reached. Resets 2026-06-24 12:00:00 UTC. For higher, uninterrupted limits, please upgrade to API Pro: https://etherscan.io/apis";
const PER_SECOND="Max calls per sec rate limit reached (3/sec)";

// Answers Etherscan V2 by action; a Response answer stands for a failed call.
function etherscan(answers,sanctions){
  const calls=[];
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(sanctions);
    calls.push(Object.fromEntries(parsed.searchParams));
    const answer=answers[parsed.searchParams.get("action")];
    if(answer===undefined)return json({error:"not stubbed"},404);
    return answer instanceof Response?answer:json(answer);
  };
  return {fetchImpl,calls};
}
const answersOf=(fx,over={})=>({eth_getTransactionByHash:fx.transaction,eth_getTransactionReceipt:fx.receipt,...over});

// Answers TronGrid's two solidified-transaction calls by path.
function trongrid(answers,sanctions){
  const paths=[];
  const fetchImpl=async url=>{
    const parsed=new URL(String(url));
    if(parsed.hostname==="sanctions.test")return json(sanctions);
    const name=parsed.pathname.split("/").pop();
    paths.push(name);
    const answer=answers[name];
    if(answer===undefined)return json({Error:"not stubbed"},404);
    return answer instanceof Response?answer:json(answer);
  };
  return {fetchImpl,paths};
}

test("a USDT transfer to a listed address on Ethereum is a match, as a native transfer is",async()=>{
  const fx=fixture("eth-usdt-to-listed.json");
  const {fetchImpl,calls}=etherscan(answersOf(fx),sanctionsList(LISTED_ETH));
  const h=worker(fetchImpl);
  const result=await h.lookup(fx.transaction.result.hash,"ethereum");
  const screening=result.sanctions_screening;
  assert.equal(screening.status,"ok");
  assert.equal(screening.hit,true);
  assert.equal(screening.counterparty_matches[0].address,LISTED_ETH);
  assert.equal(screening.counterparty_matches[0].summary,"GAZA NOW [SDGT]");
  assert.equal(screening.token_parties_unscreened,undefined);
  assert.equal(result.transaction.to,"0xdac17f958d2ee523a2206206994597c13d831ec7","the transaction's own recipient is the token contract");
  assert.deepEqual(result.transaction.token_transfers,[{
    from:"0xfa12cf384ecde4bea5c7bdd9d698ecae1c0eacd7",to:LISTED_ETH,contract:"0xdac17f958d2ee523a2206206994597c13d831ec7",
    asset:"USDT",amount:25,amount_raw:"25000000",decimals:6,stable:true
  }]);
  assert.equal(result.transaction.token_transfers_total,1);
  assert.equal(result.transaction.execution_result,"SUCCESS");
  assert.equal("all_addresses" in result.transaction,false,"the uncapped list stays in the Worker");
  assert.deepEqual(calls.map(call=>call.action),["eth_getTransactionByHash","eth_getTransactionReceipt"],"one receipt call, after the transaction");
  for(const call of calls)assert.deepEqual([call.module,call.chainid,call.apikey],["proxy","1","stub"]);
  assert.ok(h.labelLookups[0].includes(LISTED_ETH),"labels see the token recipient too");

  const view=shown(result);
  assert.equal(view.badge,"1 MATCH");
  assert.match(view.tokens,/25 USDT/);
  assert.match(view.tokens,/ALLOW-LISTED/);
  assert.match(view.kpis,/SUCCESS/);
  assert.match(view.report,/TOKEN TRANSFERS/);
  assert.match(view.report,new RegExp("To "+LISTED_ETH));
});

test("a batch payout names its listed recipient only in the receipt, and it is still found",async()=>{
  const fx=fixture("eth-batch-payout.json");
  const {fetchImpl}=etherscan(answersOf(fx),sanctionsList(LISTED_ETH));
  const result=await worker(fetchImpl).lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].address,LISTED_ETH);
  const tx=result.transaction;
  assert.equal(tx.to,"0xd91efec7e42f80156d1d9f660a69847188950747");
  assert.equal(tx.token_call,undefined,"the payout call is not a token transfer() and is not guessed at");
  assert.equal(tx.token_transfers.length,9,"two other events in the receipt are not transfers");
  assert.equal(new Set(tx.token_transfers.map(row=>row.contract)).size,5);
  assert.equal(tx.token_parties_unscreened,undefined);
  const paid=tx.token_transfers.find(row=>row.to===LISTED_ETH);
  assert.deepEqual([paid.asset,paid.amount,paid.stable],["USDT",75,true]);
  const other=tx.token_transfers.find(row=>row.contract==="0xf34960d9d60be18cc1d5afc1a6f012a723a28811");
  assert.deepEqual([other.asset,other.amount,other.decimals,other.amount_raw,other.stable],[null,null,null,"23065899",undefined]);
});

test("a swap: every Transfer event is decoded and screened, and its other events are not failures",async()=>{
  const fx=fixture("eth-uniswap-swap.json");
  const pair="0x6ffc7c4d9ca1963aa4f39c5feda234eccfbf1f3c";
  const {fetchImpl}=etherscan(answersOf(fx),sanctionsList(pair));
  const h=worker(fetchImpl);
  const result=await h.lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].address,pair);
  const tx=result.transaction;
  assert.deepEqual(tx.token_transfers.map(row=>[row.from,row.to,row.contract]),[
    ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d",pair,"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
    [pair,"0xbf06dba8d4083f81176473c9965b1162e54091ba","0x4f69f92cb9943914808fc35d89b72fadf6cabba2"]
  ]);
  assert.equal(tx.token_transfers[0].asset,null,"WETH is not on the stablecoin allow-list, so no symbol is claimed");
  assert.equal(tx.token_parties_unscreened,undefined,"Deposit, Sync and Swap are not Transfer events");
  assert.equal([tx.from,tx.to].includes(pair),false,"the pool is named only in the events");
  assert.ok(h.labelLookups[0].includes(pair));
});

test("a fake USDT is never called USDT, and the senders it invented are still screened",async()=>{
  const fx=fixture("eth-fake-usdt.json");
  const invented="0x945a8bf1e551460a80ee52beb349920c8b29cff8";
  const {fetchImpl}=etherscan(answersOf(fx),sanctionsList(invented));
  const result=await worker(fetchImpl).lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].address,invented);
  const rows=result.transaction.token_transfers;
  assert.equal(rows.length,2);
  for(const row of rows){
    assert.equal(row.contract,"0x417d2cc0c90920d4abefa724fc1688ffb5d3a154");
    assert.deepEqual([row.asset,row.amount,row.decimals,row.stable],[null,null,null,undefined]);
  }
  assert.deepEqual(rows.map(row=>row.amount_raw),["30000000","12500000000"]);
  assert.equal(JSON.stringify(rows).includes("USDT"),false);

  const view=shown(result);
  assert.match(view.tokens,/Unverified token · 30000000 base units, decimals unknown/);
  assert.match(view.tokens,/UNVERIFIED/);
  assert.doesNotMatch(view.tokens,/USDT/);
  assert.match(view.card,/Any contract can emit a token transfer event/);
});

test("more transfers than the display shows: every party is screened, only the list is capped",async()=>{
  const fx=fixture("eth-disperse-airdrop.json");
  const last="0xfab0e6d77eea0f115cd1f7a749bad87065aa8793";
  const {fetchImpl}=etherscan(answersOf(fx),sanctionsList(last));
  const h=worker(fetchImpl);
  const result=await h.lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].address,last);
  const tx=result.transaction;
  assert.equal(tx.token_transfers.length,20);
  assert.equal(tx.token_transfers_total,26);
  assert.equal(tx.token_transfers_truncated,true);
  assert.equal(tx.token_transfers.some(row=>row.to===last),false,"the 26th transfer is past the display cap");
  assert.ok(h.labelLookups[0].includes(last));
  const view=shown(result);
  assert.match(view.tokens,/first 20 of 26, all screened/);
  assert.match(view.report,/first 20 of 26 token transfers/);
});

test("a USDT transfer to a listed address on TRON is a match, from the receipt already fetched",async()=>{
  const fx=fixture("tron-usdt-to-listed.json");
  const {fetchImpl,paths}=trongrid({gettransactionbyid:fx.transaction,gettransactioninfobyid:fx.receipt},sanctionsList(LISTED_TRON));
  const result=await worker(fetchImpl).lookup(fx.transaction.txID,"tron");
  const screening=result.sanctions_screening;
  assert.equal(screening.hit,true);
  assert.equal(screening.counterparty_matches[0].address,LISTED_TRON);
  assert.equal(screening.counterparty_matches[0].summary,"GAZA NOW [SDGT]");
  const tx=result.transaction;
  assert.deepEqual(paths.sort(),["gettransactionbyid","gettransactioninfobyid"],"no extra call");
  assert.equal(tx.contract_type,"TriggerSmartContract");
  assert.equal(tx.to_address,"","a contract call has no to_address");
  assert.equal(tx.contract_address,"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  // TronGrid's TRC-20 history lists this transfer from TE2f4FXH8b2u27xgv3sNz3p4Kg8suym6Rw.
  assert.deepEqual(tx.token_transfers,[{
    from:"TE2f4FXH8b2u27xgv3sNz3p4Kg8suym6Rw",to:LISTED_TRON,contract:"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    asset:"USDT",amount:1000,amount_raw:"1000000000",decimals:6,stable:true
  }]);
  assert.equal(tx.token_call.to,LISTED_TRON,"the 41 that TRON puts in the padding is not part of the address");
  assert.equal(tx.execution_result,"SUCCESS");
  assert.equal(shown(result).badge,"1 MATCH");
});

test("an unreadable Ethereum receipt reads TOKEN PARTIES NOT SCREENED, never NO MATCH",async()=>{
  const fx=fixture("eth-usdt-to-listed.json");
  for(const receipt of [notok(PER_SECOND),json({message:"Bad gateway"},502)]){
    const {fetchImpl,calls}=etherscan(answersOf(fx,{eth_getTransactionReceipt:receipt}),sanctionsList());
    const result=await worker(fetchImpl).lookup(fx.transaction.result.hash,"ethereum");
    const screening=result.sanctions_screening;
    assert.equal(screening.status,"ok");
    assert.equal(screening.hit,false);
    assert.match(screening.token_parties_unscreened,/^the receipt could not be read: /);
    assert.equal(result.transaction.token_transfers_total,null);
    assert.equal(result.transaction.execution_result,"");
    const view=shown(result);
    assert.equal(view.badge,"TOKEN PARTIES NOT SCREENED");
    assert.match(view.card,/token transfer parties of this transaction were NOT screened/);
    assert.doesNotMatch(view.card,/No match among/);
    assert.match(view.tokens,/Token transfer parties NOT screened/);
    assert.match(view.report,/TOKEN PARTIES NOT SCREENED/);
    assert.doesNotMatch(view.report,/NO MATCH/);
    if(receipt.status==="0"){
      assert.equal(calls.filter(call=>call.action==="eth_getTransactionReceipt").length,2,"a rate limit is retried once");
      assert.match(screening.token_parties_unscreened,/Max calls per sec rate limit reached/,"the provider's words reach the analyst");
    }
  }
});

test("without the receipt, the recipient named in the input data is still screened",async()=>{
  const fx=fixture("eth-usdt-to-listed.json");
  const {fetchImpl}=etherscan(answersOf(fx,{eth_getTransactionReceipt:json({message:"Bad gateway"},502)}),sanctionsList(LISTED_ETH));
  const result=await worker(fetchImpl).lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.transaction.token_call.method,"transfer");
  assert.equal(result.transaction.token_call.to,LISTED_ETH);
  assert.equal(result.sanctions_screening.hit,true);
  const view=shown(result);
  assert.equal(view.badge,"1 MATCH");
  assert.match(view.card,/were NOT screened/,"the coverage gap is still stated next to the match");
});

test("a TRON receipt that cannot be read leaves token parties NOT SCREENED; a TRX transfer needs none",async()=>{
  const fx=fixture("tron-usdt-to-listed.json");
  const down=()=>json({Error:"Service unavailable"},503);
  const failed=await worker(trongrid({gettransactionbyid:fx.transaction,gettransactioninfobyid:down()},sanctionsList()).fetchImpl).lookup(fx.transaction.txID,"tron");
  assert.equal(failed.sanctions_screening.hit,false);
  assert.match(failed.sanctions_screening.token_parties_unscreened,/^the receipt could not be read: TronGrid transaction receipt: /);
  assert.equal(failed.transaction.fee_trx,null);
  assert.equal(shown(failed).badge,"TOKEN PARTIES NOT SCREENED");
  const empty=await worker(trongrid({gettransactionbyid:fx.transaction,gettransactioninfobyid:{}},sanctionsList()).fetchImpl).lookup(fx.transaction.txID,"tron");
  assert.match(empty.sanctions_screening.token_parties_unscreened,/no receipt/);
  // The same body as a plain TRX transfer: a TransferContract runs no contract, so it writes no event.
  const trx=structuredClone(fx.transaction);
  trx.raw_data.contract[0]={type:"TransferContract",parameter:{value:{owner_address:trx.raw_data.contract[0].parameter.value.owner_address,to_address:"414576847b1cf999843ba6620815e65a9c5e8a4021",amount:1000000}}};
  const native=await worker(trongrid({gettransactionbyid:trx,gettransactioninfobyid:down()},sanctionsList(LISTED_TRON)).fetchImpl).lookup(fx.transaction.txID,"tron");
  assert.equal(native.sanctions_screening.token_parties_unscreened,undefined);
  assert.equal(native.sanctions_screening.hit,true);
});

test("a TRON body that cannot be read fails the lookup instead of screening a receipt with no parties",async()=>{
  const fx=fixture("tron-usdt-to-listed.json");
  const lookup=answers=>worker(trongrid(answers,sanctionsList()).fetchImpl).lookup(fx.transaction.txID,"tron");
  await assert.rejects(lookup({gettransactionbyid:json({Error:"down"},500),gettransactioninfobyid:fx.receipt}),/^Error: TronGrid transaction: /);
  await assert.rejects(lookup({gettransactionbyid:{},gettransactioninfobyid:fx.receipt}),/did not return this solidified transaction/);
});

test("the receipt's status is shown, and a failed transfer still names a listed recipient",async()=>{
  const fx=fixture("eth-usdt-to-listed.json");
  // The same receipt as it would read had transfer() reverted: status 0 and no events.
  const reverted={...fx.receipt,result:{...fx.receipt.result,status:"0x0",logs:[]}};
  const {fetchImpl}=etherscan(answersOf(fx,{eth_getTransactionReceipt:reverted}),sanctionsList(LISTED_ETH));
  const result=await worker(fetchImpl).lookup(fx.transaction.result.hash,"ethereum");
  assert.equal(result.transaction.execution_result,"FAILED");
  assert.equal(result.transaction.token_transfers_total,0);
  assert.equal(result.sanctions_screening.token_parties_unscreened,undefined,"a receipt without events was read in full");
  assert.equal(result.sanctions_screening.hit,true);
  const view=shown(result);
  assert.match(view.kpis,/FAILED/);
  assert.match(view.tokens,new RegExp("Called transfer to "+LISTED_ETH+", but no Transfer event was emitted"));
});

test("Etherscan's refusal in words is shown as such, not as a hash missing from the chain",async()=>{
  const hash="0x"+"ab".repeat(32);
  const {fetchImpl,calls}=etherscan({eth_getTransactionByHash:notok(SHARED_POOL)},sanctionsList());
  const response=await worker(fetchImpl).handleCrypto({json:async()=>({user_id:"analyst",query:hash,chain:"arbitrum"}),headers:{get:()=>"session-token"}},ENV);
  assert.equal(response.status,503);
  assert.match(response.value.error,/^Etherscan transaction lookup: Community Free API limit reached\. Resets 2026-06-24/);
  assert.doesNotMatch(response.value.error,/did not return this transaction/);
  assert.deepEqual(calls.map(call=>call.action),["eth_getTransactionByHash"],"no receipt is asked for a transaction that was not read");
  // A JSON-RPC null is the answer for a hash the chain does not have.
  const missing=etherscan({eth_getTransactionByHash:{jsonrpc:"2.0",id:1,result:null}},sanctionsList());
  await assert.rejects(worker(missing.fetchImpl).lookup(hash,"ethereum"),/did not return this transaction on the selected chain/);
});
