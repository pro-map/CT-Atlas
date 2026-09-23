const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/crypto.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/shared\.js";\s*/,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

function harness(){
  const context=vm.createContext({
    cleanText,
    URLSearchParams,
    console,
    fetch:async()=>{throw new Error("network not used in unit tests");}
  });
  vm.runInContext(source,context);
  return vm.runInContext("({detectCryptoInput,aggregateFlows,buildObservations,EVM_CHAINS,CRYPTO_VERSION})",context);
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
