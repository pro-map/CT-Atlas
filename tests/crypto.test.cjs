const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const stripModuleSyntax=file=>fs.readFileSync(file,"utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");
const sanctionsSource=stripModuleSyntax("cloudflare-worker/sanctions.js");
const source=stripModuleSyntax("cloudflare-worker/crypto.js");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

function harness(fetchImpl){
  const context=vm.createContext({
    cleanText,
    URLSearchParams,
    AbortSignal,
    console,
    fetch:fetchImpl||(async()=>{throw new Error("network not used in unit tests");})
  });
  vm.runInContext(sanctionsSource,context);
  vm.runInContext(source,context);
  return vm.runInContext("({detectCryptoInput,aggregateFlows,buildObservations,detectSuspiciousPatterns,tronTrxRows,tronAddress,sha256,withSanctionsScreening,resetSanctionsCache,EVM_CHAINS,CRYPTO_VERSION})",context);
}

test("auto-detects common BTC, EVM and TRON address formats",()=>{
  const h=harness();
  assert.equal(h.detectCryptoInput("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh","auto").chain,"bitcoin");
  assert.equal(h.detectCryptoInput("0x52908400098527886E0F7030069857D2E4169EE7","auto").chain,"ethereum");
  assert.equal(h.detectCryptoInput("TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","auto").chain,"tron");
});

test("ambiguous 64-hex transaction IDs require an explicit chain",()=>{
  const h=harness();
  const id="a".repeat(64);
  assert.ok(h.detectCryptoInput(id,"auto").error);
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.detectCryptoInput(id,"bitcoin"))),
    {chain:"bitcoin",kind:"transaction",value:id}
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.detectCryptoInput(id,"tron"))),
    {chain:"tron",kind:"transaction",value:id}
  );
});

test("0x transaction hashes require chain choice in auto mode",()=>{
  const h=harness();
  const hash="0x"+"b".repeat(64);
  assert.ok(h.detectCryptoInput(hash,"auto").error);
  assert.equal(h.detectCryptoInput(hash,"arbitrum").chain,"arbitrum");
});

test("flow aggregation keeps incoming and outgoing directions separate",()=>{
  const h=harness();
  const seed="0x1111111111111111111111111111111111111111";
  const cp="0x2222222222222222222222222222222222222222";
  const flows=h.aggregateFlows([
    {direction:"IN",asset:"ETH",amount:2,counterparties:[cp]},
    {direction:"OUT",asset:"ETH",amount:1,counterparties:[cp]}
  ],seed);
  assert.equal(flows.length,2);
  assert.ok(flows.some(f=>f.from===cp&&f.to===seed&&f.tx_count===1));
  assert.ok(flows.some(f=>f.from===seed&&f.to===cp&&f.tx_count===1));
});

test("observations explicitly preserve the no-attribution rule",()=>{
  const h=harness();
  const notes=h.buildObservations([
    {direction:"IN",asset:"BTC",amount:1,counterparties:["bc1qa"]},
    {direction:"OUT",asset:"BTC",amount:0.9,counterparties:["bc1qb"]}
  ],"bc1qseed");
  assert.ok(notes.some(note=>/does not establish/i.test(note)));
});

test("crypto backend exposes a non-empty version and expected EVM chains",()=>{
  const h=harness();
  assert.equal(typeof h.CRYPTO_VERSION,"string");
  assert.ok(h.CRYPTO_VERSION.length>0);
  for(const chain of ["ethereum","bsc","polygon","arbitrum","base"]){
    assert.ok(h.EVM_CHAINS[chain]);
  }
});


test("crypto UI exposes specialized forensic filters",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  for(const id of [
    "filterDirection","filterAsset","filterType","filterStatus","filterMinAmount",
    "filterMaxAmount","filterFromDate","filterToDate","filterText",
    "filterGraphMinLinks","filterGraphNodes"
  ]){
    assert.ok(html.includes('id="'+id+'"'),"missing specialized filter "+id);
  }
});

test("graph node navigation opens a new CT Atlas Crypto tab with autorun",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(client.includes('url.searchParams.set("q",address)'));
  assert.ok(client.includes('url.searchParams.set("chain",chain)'));
  assert.ok(client.includes('url.searchParams.set("autorun","1")'));
  assert.ok(client.includes('window.open(url.toString(),"_blank")'));
});

test("crypto graph supports pointer dragging and layout reset",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  const html=fs.readFileSync("crypto.html","utf8");
  assert.ok(client.includes('group.addEventListener("pointerdown"'));
  assert.ok(client.includes('group.addEventListener("pointermove"'));
  assert.ok(client.includes('graphPositions=new Map()'));
  assert.ok(html.includes('id="cryptoResetGraph"'));
});

test("graph has relationship colors and enlarged drag canvas",()=>{
  const css=fs.readFileSync("crypto.css","utf8");
  const html=fs.readFileSync("crypto.html","utf8");
  for(const cls of [".graph-node.incoming",".graph-node.outgoing",".graph-node.both",".graph-node.seed"]){
    assert.ok(css.includes(cls),"missing graph relation style "+cls);
  }
  assert.ok(html.includes('viewBox="0 0 1000 650"'));
});


test("crypto graph exposes H2 H3 progressive tracing controls",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  for(const id of ["traceMaxDepth","traceBranch","cryptoAutoTrace","cryptoClearTrace"]){
    assert.ok(html.includes('id="'+id+'"'),"missing trace control "+id);
  }
  assert.ok(client.includes("async function expandTraceNode"));
  assert.ok(client.includes("async function autoTrace"));
  assert.ok(client.includes("fetchAddressAnalysis"));
});

test("multi-hop graph keeps node click navigation separate from plus expansion",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(client.includes('event.target.closest?.(".graph-expand-control")'));
  assert.ok(client.includes('svg.querySelectorAll(".graph-expand-control")'));
  assert.ok(client.includes("expandTraceNode(node.id)"));
  assert.ok(client.includes("openCryptoSearch(node.id,payload.chain)"));
});

test("trace table records hop and source wallet context",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(html.includes("<th>Hop / source</th>"));
  assert.ok(client.includes("_trace_source"));
  assert.ok(client.includes("_trace_depth"));
  assert.ok(client.includes("crypto-hop-badge"));
});

test("trace graph supports explicit H1 H2 H3 visual depth",()=>{
  const css=fs.readFileSync("crypto.css","utf8");
  for(const cls of [".graph-hop-ring.h1",".graph-hop-ring.h2",".graph-hop-ring.h3",".legend-hop.h1",".legend-hop.h2",".legend-hop.h3"]){
    assert.ok(css.includes(cls),"missing hop visual "+cls);
  }
});


test("crypto intelligence workspace exposes Chainalysis/TRM-style analytical modules",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  for(const id of [
    "cryptoPatternList","cryptoExposureSummary","pathFindButton","labelSeedButton",
    "caseNewButton","monitorSeedButton","monitorCheckButton","crossChainFindings"
  ]){
    assert.ok(html.includes('id="'+id+'"'),"missing intelligence control "+id);
  }
  for(const fn of [
    "detectPatterns","exposureFindings","shortestPath","saveLabel",
    "monitorSeed","checkMonitored","crossChainFindings"
  ]){
    assert.ok(client.includes("function "+fn)||client.includes("async function "+fn),"missing "+fn);
  }
});

test("case workspace supports PDF export, off-chain nodes and cross-chain links",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(html.includes('id="caseExportPdfButton"'));
  assert.ok(html.includes('id="caseOffchainToggle"'));
  assert.ok(html.includes('id="caseCrosschainToggle"'));
  assert.ok(html.includes('src="pdf-export.js'));
  assert.ok(client.includes("async function exportCasePdf"));
  assert.ok(client.includes("function saveOffchainNode"));
  assert.ok(client.includes("function saveCrosschainLink"));
});

test("persistent Crypto workspace is authenticated and routed through Worker storage",()=>{
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  const gate=fs.readFileSync("cloudflare-worker/report-gate.js","utf8");
  const auth=fs.readFileSync("usage-auth-fix.js","utf8");
  assert.ok(index.includes('"/crypto-workspace"'));
  assert.ok(index.includes("handleCryptoWorkspace"));
  assert.ok(gate.includes('"/crypto-workspace-get"'));
  assert.ok(gate.includes('"/crypto-workspace-put"'));
  assert.ok(auth.includes("crypto-workspace"));
});

test("graph renders sourced off-chain and cross-chain entities with draggable interactions",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  const css=fs.readFileSync("crypto.css","utf8");
  assert.ok(client.includes("attachAuxGraphInteraction"));
  assert.ok(client.includes("offchain-node"));
  assert.ok(client.includes("crosschain-node"));
  assert.ok(css.includes(".graph-aux-node.offchain-node"));
  assert.ok(css.includes(".graph-aux-node.crosschain-node"));
  assert.ok(css.includes(".graph-edge.crosschain-link"));
});

test("service detection registry includes DEX and verified bridge categories",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(client.includes("Uniswap V2 Router"));
  assert.ok(client.includes("Stargate USDC Pool"));
  assert.ok(client.includes('category:"DEX"'));
  assert.ok(client.includes('category:"BRIDGE"'));
});

test("detectSuspiciousPatterns flags a rapid pass-through of comparable in/out value",()=>{
  const h=harness();
  const now=Date.now();
  const seed="seedaddress";
  const rows=[
    {direction:"IN",amount:10,time:new Date(now-1000*60*5).toISOString(),counterparties:["a"]},
    {direction:"IN",amount:9,time:new Date(now-1000*60*4).toISOString(),counterparties:["b"]},
    {direction:"OUT",amount:9,time:new Date(now-1000*60*3).toISOString(),counterparties:["c"]},
    {direction:"OUT",amount:9,time:new Date(now-1000*60*2).toISOString(),counterparties:["d"]}
  ];
  const patterns=h.detectSuspiciousPatterns(rows,seed);
  const passThrough=patterns.find(p=>p.code==="RAPID_PASS_THROUGH");
  assert.ok(passThrough,"expected a RAPID_PASS_THROUGH flag for balanced in/out flow");
  assert.match(passThrough.explanation,/not proof|not by itself|does not establish/i,"the pattern must hedge that it is not proof of wrongdoing");
});

test("detectSuspiciousPatterns returns nothing for a single quiet transaction",()=>{
  const h=harness();
  const rows=[{direction:"IN",amount:1,time:new Date().toISOString(),counterparties:["a"]}];
  assert.equal(h.detectSuspiciousPatterns(rows,"seed").length,0);
});

test("regression: tronTrxRows ignores TriggerSmartContract calls, only real TRX transfers produce a row",()=>{
  const h=harness();
  const address="TSeedAddress0000000000000000000";
  const smartContractCall={
    txID:"contract-call-1",
    block_timestamp:Date.now(),
    raw_data:{contract:[{type:"TriggerSmartContract",parameter:{value:{owner_address:address,to_address:"TSomeContract"}}}]}
  };
  const realTransfer={
    txID:"real-transfer-1",
    block_timestamp:Date.now(),
    raw_data:{contract:[{type:"TransferContract",parameter:{value:{owner_address:address,to_address:"TRecipient",amount:5000000}}}]}
  };
  const rows=h.tronTrxRows(address,[smartContractCall,realTransfer],[]);
  assert.equal(rows.length,1,"the TriggerSmartContract call must not produce a phantom TRX row");
  assert.equal(rows[0].id,"real-transfer-1");
  assert.equal(rows[0].amount,5);
});

test("sha256 matches published FIPS 180-4 test vectors",()=>{
  const h=harness();
  const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  assert.equal(hex(h.sha256(new TextEncoder().encode("abc"))),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hex(h.sha256(new Uint8Array(0))),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // 200 bytes spans several 64-byte blocks (cross-checked against Python hashlib).
  assert.equal(hex(h.sha256(new TextEncoder().encode("a".repeat(200)))),"c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
});

test("tronAddress converts TronGrid hex addresses to base58check and leaves other input alone",()=>{
  const h=harness();
  // USDT-TRC20 contract, hex from TronGrid, base58 as shown by Tronscan.
  assert.equal(h.tronAddress("41a614f803b6fd780986a42c78ec9c7f77e6ded13c"),"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  // Two sanctioned addresses decoded independently with Python.
  assert.equal(h.tronAddress("4100be5e0c85be35948d97ad37f62d108243f89ae0"),"TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz");
  assert.equal(h.tronAddress("4100bf03f87539214307207c61b7f729ddc22977b8"),"TA39q3p75XRSWYAEaSF7dANtyksoa3sLge");
  assert.equal(h.tronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(h.tronAddress(""),"");
  assert.equal(h.tronAddress(undefined),"");
  assert.equal(h.tronAddress("41zz"),"41zz");
});

test("regression: tronTrxRows reports base58 counterparties so they match the analysed wallet",()=>{
  const h=harness();
  const seed="TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz";
  const rows=h.tronTrxRows(seed,[{
    txID:"out-1",block_timestamp:Date.now(),
    raw_data:{contract:[{type:"TransferContract",parameter:{value:{
      owner_address:"4100be5e0c85be35948d97ad37f62d108243f89ae0",
      to_address:"41a614f803b6fd780986a42c78ec9c7f77e6ded13c",amount:2000000}}}]}
  }],[{
    txID:"in-1",block_timestamp:Date.now()-1000,
    raw_data:{contract:[{type:"TransferContract",parameter:{value:{
      owner_address:"4100bf03f87539214307207c61b7f729ddc22977b8",
      to_address:"4100be5e0c85be35948d97ad37f62d108243f89ae0",amount:1000000}}}]}
  }]);
  const out=rows.find(r=>r.id==="out-1");
  const inn=rows.find(r=>r.id==="in-1");
  assert.equal(out.from_address,seed);
  assert.equal(out.counterparties[0],"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(inn.counterparties[0],"TA39q3p75XRSWYAEaSF7dANtyksoa3sLge");
  assert.equal(inn.to_address,seed);
});

const SANCTIONS_FIXTURE={
  version:"sanctions-crypto-v1",
  retrieved_at:new Date().toISOString(),
  sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-09-23"}],
  entities:[{id:"1",name:"EXAMPLE TERROR FINANCIER",type:"individual",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],
  addresses:[{a:"TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz",c:"USDT",f:"tron",e:[0]}]
};

test("withSanctionsScreening flags a sanctioned TRON counterparty end-to-end and adds a hedged observation",async()=>{
  const h=harness(async()=>({ok:true,json:async()=>SANCTIONS_FIXTURE}));
  const result=await h.withSanctionsScreening({
    chain:"tron",kind:"address",query:"TSeedWallet00000000000000000000000",
    transactions:[{id:"t1",direction:"OUT",time:"2026-09-01T00:00:00.000Z",counterparties:["TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz"]}],
    observations:["existing"]
  },{SANCTIONS_URL:"https://example.test/sanctions.json"});
  assert.equal(result.sanctions_screening.status,"ok");
  assert.equal(result.sanctions_screening.hit,true);
  assert.equal(result.sanctions_screening.counterparty_matches[0].entities[0].terrorism,true);
  assert.match(result.observations[0],/SANCTIONS EXPOSURE/);
  assert.equal(result.observations[1],"existing");
});

test("withSanctionsScreening reports 'unavailable' -- never a clean pass -- when the list cannot be loaded",async()=>{
  const h=harness(async()=>{throw new Error("network down");});
  const analysis={chain:"bitcoin",kind:"address",query:"bc1qseed",transactions:[],observations:[]};
  const result=await h.withSanctionsScreening(analysis,{SANCTIONS_URL:"https://example.test/sanctions.json"});
  assert.equal(result.sanctions_screening.status,"unavailable");
  assert.equal(result.sanctions_screening.hit,false);
  assert.ok(result.sanctions_screening.reason);
  assert.equal(result.observations.length,0,"an unavailable list must not add observations");
  assert.equal(result.chain,"bitcoin","the analysis itself must still be returned");
});
