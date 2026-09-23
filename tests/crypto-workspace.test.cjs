const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/crypto-workspace.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/shared\.js";\s*/,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}
function normalizeUsername(value){return cleanText(value,80).toLowerCase();}
function isAllowedUser(){return true;}
function jsonResponse(value,status=200){return {value,status};}
async function gateCall(){throw new Error("network not used");}

function harness(){
  const context=vm.createContext({
    cleanText,normalizeUsername,isAllowedUser,jsonResponse,gateCall,
    crypto:{randomUUID:()=> "uuid-test"},
    Date,URL,Number,Set,Array,Object,String,RegExp
  });
  vm.runInContext(source,context);
  return vm.runInContext("({sanitizeWorkspace,CRYPTO_WORKSPACE_VERSION})",context);
}

test("workspace sanitizer preserves sourced labels and strips unsafe URLs",()=>{
  const h=harness();
  const workspace=h.sanitizeWorkspace({
    labels:[
      {chain:"ethereum",address:"0x1111111111111111111111111111111111111111",name:"Example",category:"SANCTIONS",confidence:"HIGH",source_url:"https://example.com/source"},
      {chain:"ethereum",address:"0x2222222222222222222222222222222222222222",name:"Unsafe",category:"MIXER",confidence:"MEDIUM",source_url:"javascript:alert(1)"}
    ]
  },"group-i-1");
  assert.equal(workspace.version,h.CRYPTO_WORKSPACE_VERSION);
  assert.equal(workspace.labels.length,2);
  assert.equal(workspace.labels[0].source_url,"https://example.com/source");
  assert.equal(workspace.labels[1].source_url,"");
});

test("unknown label category and confidence degrade safely",()=>{
  const h=harness();
  const workspace=h.sanitizeWorkspace({
    labels:[{chain:"bitcoin",address:"bc1qexample",name:"X",category:"made-up",confidence:"certain"}]
  },"group-i-1");
  assert.equal(workspace.labels[0].category,"OTHER");
  assert.equal(workspace.labels[0].confidence,"LOW");
});

test("case sanitizer keeps off-chain nodes and sourced cross-chain links",()=>{
  const h=harness();
  const workspace=h.sanitizeWorkspace({
    cases:[{
      name:"Case A",chain:"ethereum",
      offchain_nodes:[{type:"TELEGRAM CHANNEL",label:"Channel X",linked_address:"0xabc",source_url:"https://example.com/channel"}],
      crosschain_links:[{
        from_chain:"ethereum",from_address:"0xabc",to_chain:"tron",to_address:"TExample",
        service:"Bridge X",confidence:"MEDIUM",source_url:"https://example.com/bridge"
      }]
    }]
  },"group-i-1");
  assert.equal(workspace.cases.length,1);
  assert.equal(workspace.cases[0].offchain_nodes.length,1);
  assert.equal(workspace.cases[0].crosschain_links.length,1);
  assert.equal(workspace.cases[0].crosschain_links[0].to_chain,"tron");
});

test("watch thresholds are bounded and malformed chains are rejected",()=>{
  const h=harness();
  const workspace=h.sanitizeWorkspace({
    watchlist:[
      {chain:"ethereum",address:"0xabc",thresholds:{velocity_24h:999999,dormant_days:999999}},
      {chain:"fakechain",address:"x"}
    ]
  },"group-i-1");
  assert.equal(workspace.watchlist.length,1);
  assert.equal(workspace.watchlist[0].thresholds.velocity_24h,10000);
  assert.equal(workspace.watchlist[0].thresholds.dormant_days,3650);
});
