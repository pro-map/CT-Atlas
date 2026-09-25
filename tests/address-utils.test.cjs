const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const source=fs.readFileSync("cloudflare-worker/address-utils.js","utf8")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function load(){
  const context=vm.createContext({});
  vm.runInContext(source,context);
  return vm.runInContext("({sha256,base58Encode,tronAddress,isValidWalletAddress,findWalletCandidates})",context);
}

const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");

test("sha256 matches published FIPS 180-4 test vectors",()=>{
  const u=load();
  assert.equal(hex(u.sha256(new TextEncoder().encode("abc"))),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hex(u.sha256(new Uint8Array(0))),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // 200 bytes spans several 64-byte blocks (cross-checked against Python hashlib).
  assert.equal(hex(u.sha256(new TextEncoder().encode("a".repeat(200)))),"c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
});

test("tronAddress converts TronGrid hex addresses to base58check and leaves other input alone",()=>{
  const u=load();
  // USDT-TRC20 contract, hex from TronGrid, base58 as shown by Tronscan.
  assert.equal(u.tronAddress("41a614f803b6fd780986a42c78ec9c7f77e6ded13c"),"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  // Two sanctioned addresses decoded independently with Python.
  assert.equal(u.tronAddress("4100be5e0c85be35948d97ad37f62d108243f89ae0"),"TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz");
  assert.equal(u.tronAddress("4100bf03f87539214307207c61b7f729ddc22977b8"),"TA39q3p75XRSWYAEaSF7dANtyksoa3sLge");
  assert.equal(u.tronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(u.tronAddress(""),"");
  assert.equal(u.tronAddress(undefined),"");
  assert.equal(u.tronAddress("41zz"),"41zz");
});

const VALID={
  bitcoin:[
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"
  ],
  tron:["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz"],
  evm:["0x52908400098527886E0F7030069857D2E4169EE7"]
};
const INVALID={
  bitcoin:[
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
    "Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
  ],
  tron:["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"],
  evm:["0x123","0x"+"g".repeat(40)]
};

test("real wallet strings pass checksum validation (BIP173/BIP350 vectors, genesis, USDT-TRC20)",()=>{
  const u=load();
  for(const [family,list] of Object.entries(VALID)){
    for(const address of list)assert.equal(u.isValidWalletAddress(family,address),true,family+" "+address);
  }
});

test("corrupted, mixed-case or wrong-family strings fail validation",()=>{
  const u=load();
  for(const [family,list] of Object.entries(INVALID)){
    for(const address of list)assert.equal(u.isValidWalletAddress(family,address),false,family+" "+address);
  }
  assert.equal(u.isValidWalletAddress("tron",VALID.bitcoin[0]),false,"a Bitcoin address is not a TRON address");
  assert.equal(u.isValidWalletAddress("dogecoin","D8vFz4p1L37jdg47HXKtW9U5dgmNhHm1J1"),false);
});

test("findWalletCandidates keeps only checksum-valid wallets, de-duplicated across the text",()=>{
  const u=load();
  const text="Donate 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa or 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb; "+
    "again 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa. TRON TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t, "+
    "EVM 0x52908400098527886E0F7030069857D2E4169EE7 and 0x52908400098527886e0f7030069857d2e4169ee7, "+
    "bech32 bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4.";
  const found=Array.from(u.findWalletCandidates(text),item=>item.family+":"+item.address);
  assert.deepEqual(found.sort(),[
    "bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "evm:0x52908400098527886E0F7030069857D2E4169EE7",
    "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
  ].sort());
});

test("findWalletCandidates returns nothing for ordinary prose",()=>{
  const u=load();
  assert.equal(u.findWalletCandidates("The 3 quick brown foxes met at 10:30 near Tunis; ref 1234567890.").length,0);
  assert.equal(u.findWalletCandidates("").length,0);
  assert.equal(u.findWalletCandidates(undefined).length,0);
});
