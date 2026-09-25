const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const source=fs.readFileSync("cloudflare-worker/sanctions.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

function harness(fetchImpl){
  const calls=[];
  const context=vm.createContext({
    cleanText,
    AbortSignal,
    console,
    fetch:async(...args)=>{calls.push(args);return fetchImpl(...args);}
  });
  vm.runInContext(source,context);
  const api=vm.runInContext("({chainFamily,normalizeSanctionsAddress,buildSanctionsIndex,loadSanctions,resetSanctionsCache,screenAnalysis,sanctionsObservation,SANCTIONS_VERSION})",context);
  return {api,calls};
}

const EVM="0x0330070fd38ec3bb94f58fa55d40368271e9e54a";
const BTC="123WBUDmSJv4GctdVEz6Qq6z8nXSKrJ4KX";
const TRON="TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz";

function fixture(overrides={}){
  return {
    version:"sanctions-crypto-v1",
    retrieved_at:new Date().toISOString(),
    sources:[{id:"OFAC_SDN",name:"OFAC Specially Designated Nationals (SDN) List",published:"2026-09-23"}],
    entities:[
      {id:"10",name:"ISIL KHORASAN",type:"entity",programs:["FTO","SDGT"],terrorism:true,list:"OFAC_SDN"},
      {id:"11",name:"SOME IRAN BANK",type:"entity",programs:["IRAN"],terrorism:false,list:"OFAC_SDN"}
    ],
    addresses:[
      {a:EVM,c:"ETH",f:"evm",e:[0]},
      {a:BTC,c:"XBT",f:"bitcoin",e:[1]},
      {a:TRON,c:"USDT",f:"tron",e:[0,1]}
    ],
    ...overrides
  };
}

const okFetch=payload=>async()=>({ok:true,status:200,json:async()=>payload});
const ENV={SANCTIONS_URL:"https://example.test/sanctions-crypto.json"};

test("chainFamily maps every supported chain and EVM chains share one family",()=>{
  const {api}=harness(okFetch(fixture()));
  assert.equal(api.chainFamily("bitcoin"),"bitcoin");
  assert.equal(api.chainFamily("tron"),"tron");
  for(const chain of ["ethereum","bsc","polygon","arbitrum","base"])assert.equal(api.chainFamily(chain),"evm");
  assert.equal(api.chainFamily("dogecoin"),"other");
});

test("EVM addresses match case-insensitively (checksummed input vs lowercase list)",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({chain:"polygon",kind:"address",query:EVM.toUpperCase().replace("0X","0x"),transactions:[]},state);
  assert.equal(screening.hit,true);
  assert.equal(screening.seed_match.currency,"ETH");
  assert.equal(screening.seed_match.entities[0].terrorism,true);
  assert.deepEqual(Array.from(screening.seed_match.entities[0].programs),["FTO","SDGT"]);
});

test("Bitcoin and TRON addresses stay case-sensitive (no false positives from case folding)",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  assert.equal(api.screenAnalysis({chain:"bitcoin",kind:"address",query:BTC,transactions:[]},state).hit,true);
  assert.equal(api.screenAnalysis({chain:"bitcoin",kind:"address",query:BTC.toLowerCase(),transactions:[]},state).hit,false);
  assert.equal(api.screenAnalysis({chain:"tron",kind:"address",query:TRON.toLowerCase(),transactions:[]},state).hit,false);
});

test("an address is only matched within its own chain family",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  // The same string queried as a different family must not match.
  assert.equal(api.screenAnalysis({chain:"tron",kind:"address",query:BTC,transactions:[]},state).hit,false);
});

test("counterparties are screened, aggregated with direction counts, and the seed is not double-reported",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({
    chain:"ethereum",kind:"address",query:"0x1111111111111111111111111111111111111111",
    transactions:[
      {id:"a",direction:"IN",time:"2026-01-02T00:00:00.000Z",counterparties:[EVM.toUpperCase().replace("0X","0x")]},
      {id:"b",direction:"OUT",time:"2026-01-01T00:00:00.000Z",counterparties:[EVM]},
      {id:"c",direction:"OUT",time:"2026-01-03T00:00:00.000Z",counterparties:["0x2222222222222222222222222222222222222222"]}
    ]
  },state);
  assert.equal(screening.seed_match,null);
  assert.equal(screening.hit,true);
  assert.equal(screening.counterparties_checked,2,"same wallet in two casings is one counterparty");
  assert.equal(screening.counterparty_matches.length,1);
  const match=screening.counterparty_matches[0];
  assert.equal(match.received_from_count,1);
  assert.equal(match.sent_to_count,1);
  assert.equal(match.first_seen,"2026-01-01T00:00:00.000Z");
  assert.equal(match.last_seen,"2026-01-02T00:00:00.000Z");
  assert.deepEqual(Array.from(match.tx_ids).sort(),["a","b"]);
});

test("a listed seed that also appears as its own counterparty is reported once, as the seed",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({
    chain:"ethereum",kind:"address",query:EVM,
    transactions:[{id:"self",direction:"SELF",time:"2026-01-01T00:00:00.000Z",counterparties:[EVM]}]
  },state);
  assert.ok(screening.seed_match);
  assert.equal(screening.counterparty_matches.length,0);
});

test("single-transaction lookups screen their parties (Bitcoin inputs/outputs, EVM from/to, TRON owner/to)",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const btc=api.screenAnalysis({chain:"bitcoin",kind:"transaction",query:"x",transaction:{input_addresses:[BTC],output_addresses:["bc1qother"]},transactions:[]},state);
  assert.equal(btc.hit,true);
  const evm=api.screenAnalysis({chain:"base",kind:"transaction",query:"0xhash",transaction:{from:"0x9999999999999999999999999999999999999999",to:EVM},transactions:[]},state);
  assert.equal(evm.hit,true);
  const tron=api.screenAnalysis({chain:"tron",kind:"transaction",query:"hash",transaction:{owner_address:TRON,to_address:"TXother"},transactions:[]},state);
  assert.equal(tron.hit,true);
});

test("no match is reported honestly: hit=false, list metadata and the scope disclaimer are still returned",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({chain:"ethereum",kind:"address",query:"0x1111111111111111111111111111111111111111",transactions:[]},state);
  assert.equal(screening.status,"ok");
  assert.equal(screening.hit,false);
  assert.equal(screening.list.sources[0].id,"OFAC_SDN");
  assert.equal(screening.list.address_count,3);
  assert.match(screening.scope_note,/does NOT mean an address is safe/);
  assert.equal(api.sanctionsObservation(screening),"");
});

test("observation text is hedged to 'listed', never asserts guilt or attribution",async()=>{
  const {api}=harness(okFetch(fixture()));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({chain:"ethereum",kind:"address",query:EVM,transactions:[]},state);
  const note=api.sanctionsObservation(screening);
  assert.match(note,/SANCTIONS MATCH/);
  assert.match(note,/is listed/);
  assert.doesNotMatch(note,/terrorist|criminal|guilty|owned by|controlled by/i);
});

test("missing SANCTIONS_URL yields 'unavailable' and never a clean pass",async()=>{
  const {api,calls}=harness(okFetch(fixture()));
  const state=await api.loadSanctions({});
  assert.equal(state.status,"unavailable");
  const screening=api.screenAnalysis({chain:"ethereum",kind:"address",query:EVM,transactions:[]},state);
  assert.equal(screening.status,"unavailable");
  assert.equal(screening.hit,false);
  assert.equal(screening.list,null);
  assert.equal(calls.length,0);
});

test("HTTP errors and malformed payloads yield 'unavailable'",async()=>{
  let harnessed=harness(async()=>({ok:false,status:503,json:async()=>({})}));
  let state=await harnessed.api.loadSanctions(ENV);
  assert.equal(state.status,"unavailable");
  assert.match(state.reason,/503/);

  harnessed=harness(okFetch({not:"a sanctions file"}));
  state=await harnessed.api.loadSanctions(ENV);
  assert.equal(state.status,"unavailable");
});

test("a list older than a week is served but flagged 'stale'",async()=>{
  const old=new Date(Date.now()-9*24*3600*1000).toISOString();
  const {api}=harness(okFetch(fixture({retrieved_at:old})));
  const state=await api.loadSanctions(ENV);
  assert.equal(state.status,"stale");
  const screening=api.screenAnalysis({chain:"ethereum",kind:"address",query:EVM,transactions:[]},state);
  assert.equal(screening.status,"stale");
  assert.equal(screening.hit,true,"a stale list must still be used to screen");
});

test("the list is cached between calls (one download, not one per analysis)",async()=>{
  const {api,calls}=harness(okFetch(fixture()));
  await api.loadSanctions(ENV);
  await api.loadSanctions(ENV);
  await api.loadSanctions(ENV);
  assert.equal(calls.length,1);
});

test("a failed refresh keeps the last good list (status 'stale') and backs off instead of re-fetching every call",async()=>{
  let fail=false;
  const {api,calls}=harness(async()=>{
    if(fail)throw new Error("network down");
    return {ok:true,status:200,json:async()=>fixture()};
  });
  const t0=Date.now();
  const first=await api.loadSanctions(ENV,t0);
  assert.equal(first.status,"ok");

  fail=true;
  const afterTtl=t0+31*60*1000;
  const degraded=await api.loadSanctions(ENV,afterTtl);
  assert.equal(degraded.status,"stale");
  assert.match(degraded.reason,/network down/);
  assert.ok(degraded.index,"the last good index must still be served");
  assert.equal(calls.length,2);

  await api.loadSanctions(ENV,afterTtl+5000);
  assert.equal(calls.length,2,"within the backoff window there must be no further fetch");

  fail=false;
  const recovered=await api.loadSanctions(ENV,afterTtl+61*1000);
  assert.equal(recovered.status,"ok");
  assert.equal(calls.length,3);
});

test("matches are capped so a pathological wallet cannot bloat the response",async()=>{
  const addresses=[];
  const rows=[];
  for(let i=0;i<80;i++){
    const address="0x"+i.toString(16).padStart(40,"0");
    addresses.push({a:address,c:"ETH",f:"evm",e:[0]});
    rows.push({id:"t"+i,direction:"IN",time:"2026-01-01T00:00:00.000Z",counterparties:[address]});
  }
  const {api}=harness(okFetch(fixture({addresses})));
  const state=await api.loadSanctions(ENV);
  const screening=api.screenAnalysis({chain:"ethereum",kind:"address",query:"0x"+"f".repeat(40),transactions:rows},state);
  assert.equal(screening.counterparty_matches.length,40);
  assert.equal(screening.counterparties_checked,80);
});

// --- integrity of the shipped data file -------------------------------------

test("sanctions-crypto.json is well-formed, internally consistent and not truncated",()=>{
  const data=JSON.parse(fs.readFileSync("sanctions-crypto.json","utf8"));
  assert.equal(data.version,"sanctions-crypto-v1");
  assert.ok(Date.parse(data.retrieved_at),"retrieved_at must be a valid timestamp");
  assert.ok(data.sources.length>=1&&data.sources[0].id==="OFAC_SDN");
  assert.ok(data.addresses.length>500,"suspiciously few addresses -- did the updater truncate?");
  assert.equal(data.sources[0].addresses,data.addresses.length);
  assert.equal(data.sources[0].entities,data.entities.length);

  const seen=new Set();
  for(const item of data.addresses){
    assert.ok(item.a&&item.c&&item.f&&Array.isArray(item.e)&&item.e.length>0,"bad record "+JSON.stringify(item));
    for(const position of item.e)assert.ok(data.entities[position],"dangling entity index for "+item.a);
    const key=item.f+":"+item.a;
    assert.ok(!seen.has(key),"duplicate address "+key);
    seen.add(key);
    assert.ok(!item.a.endsWith("."),"trailing-dot artifact (sdn.csv truncation) in "+item.a);
    if(item.f==="evm"){
      assert.match(item.a,/^0x[0-9a-f]{40}$/,"EVM addresses must be lowercase 40-hex");
    }
    if(item.f==="tron")assert.match(item.a,/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  }
  const families=new Set(data.addresses.map(item=>item.f));
  for(const family of ["bitcoin","evm","tron"])assert.ok(families.has(family),"no "+family+" addresses");

  assert.ok(data.entities.some(entity=>entity.terrorism),"terrorism designations must remain distinguishable");
  assert.ok(data.entities.some(entity=>!entity.terrorism),"non-terrorism programs must not be flagged as terrorism");
  for(const entity of data.entities){
    assert.ok(Array.isArray(entity.programs));
    assert.equal(entity.terrorism,entity.programs.some(program=>["SDGT","FTO","SDT"].includes(program)));
  }
});

test("the shipped data file loads through the same code path the Worker uses",async()=>{
  const data=JSON.parse(fs.readFileSync("sanctions-crypto.json","utf8"));
  const {api}=harness(okFetch(data));
  const state=await api.loadSanctions(ENV);
  assert.ok(["ok","stale"].includes(state.status));
  const sample=data.addresses.find(item=>item.f==="tron");
  const screening=api.screenAnalysis({chain:"tron",kind:"address",query:sample.a,transactions:[]},state);
  assert.equal(screening.hit,true);
});

test("worker wiring: SANCTIONS_URL is configured and /health reports the sanctions version",()=>{
  const toml=fs.readFileSync("cloudflare-worker/wrangler.toml","utf8");
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  assert.match(toml,/SANCTIONS_URL\s*=\s*"https:\/\/ct-atlas\.com\/sanctions-crypto\.json"/);
  assert.ok(index.includes("sanctions_version"));
});

test("Crypto UI renders a sanctions card for both address and transaction views",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  const css=fs.readFileSync("crypto.css","utf8");
  for(const id of ["cryptoSanctions","cryptoSanctionsBadge","cryptoSanctionsBody","cryptoSanctionsNote"]){
    assert.ok(html.includes('id="'+id+'"'),"missing "+id);
  }
  assert.ok(client.includes("function renderSanctions"));
  assert.ok(client.includes("function sanctionsHits"));
  // Re-rendered on every trace expansion (renderIntelligencePanels) and for single-transaction lookups.
  assert.match(client,/function renderIntelligencePanels\(\)\{\s*renderSanctions\(\);/);
  assert.match(client,/cryptoTransactionJson[\s\S]{0,200}renderSanctions\(\);/);
  for(const cls of [".sanctions-card.hit",".intel-badge.unscreened",".intel-badge.clear"]){
    assert.ok(css.includes(cls),"missing style "+cls);
  }
});

test("Crypto UI never presents an unscreened result as a clean pass",()=>{
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(client.includes("NOT SCREENED"));
  assert.ok(client.includes("was NOT performed"));
  assert.ok(client.includes("No match does not mean an address is safe"));
  // Only shows NO MATCH on the branch that is not 'unscreened'.
  const noMatch=client.indexOf('"NO MATCH"');
  const unscreened=client.indexOf('"NOT SCREENED"');
  assert.ok(unscreened>0&&noMatch>unscreened,"NOT SCREENED must be decided before NO MATCH");
});

test("CI refreshes the sanctions list daily, publishes it, and smoke-tests the Worker's view of it",()=>{
  const updateMap=fs.readFileSync(".github/workflows/update-map.yml","utf8");
  assert.ok(updateMap.includes("python -u tools/update_sanctions.py"));
  assert.match(updateMap,/Refresh OFAC sanctioned crypto addresses[\s\S]{0,400}continue-on-error: true/);
  assert.ok(updateMap.includes('"sanctions-crypto.json"'),"the refreshed file must be committed");
  const smoke=fs.readFileSync(".github/workflows/live-smoke.yml","utf8");
  assert.ok(smoke.includes("health.sanctions.status"));
  const deploy=fs.readFileSync(".github/workflows/deploy-report-worker.yml","utf8");
  assert.ok(deploy.includes("update_sanctions_test.py"));
  assert.ok(deploy.includes("cloudflare-worker/sanctions.js"));
});
