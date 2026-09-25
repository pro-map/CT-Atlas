const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const stripModuleSyntax=file=>fs.readFileSync(file,"utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,"")
  .replace(/export\s*\{[\s\S]*?\};\s*$/,"");
let source=stripModuleSyntax("cloudflare-worker/social-intel.js");
const addressUtilsSource=stripModuleSyntax("cloudflare-worker/address-utils.js");
const sanctionsSource=stripModuleSyntax("cloudflare-worker/sanctions.js");

function cleanText(value,max=700){
  return String(value||"").replace(/\s+/g," ").trim().slice(0,max);
}
function normalizeUsername(value){return cleanText(value,64).toLowerCase();}
function isAllowedUser(){return true;}
function jsonResponse(body,status){return {body,status};}
async function gateCall(){throw new Error("not used");}
async function extractGeminiText(){throw new Error("not used");}

function harness(fetchImpl){
  const context=vm.createContext({
    AbortSignal,
    fetch:fetchImpl||(async()=>{throw new Error("network not used");}),
    cleanText,normalizeUsername,isAllowedUser,jsonResponse,gateCall,extractGeminiText,
    SOCIAL_AGENT_CLIENT_VERSION:"test-adk-client",
    isSocialAgentConfigured:()=>false,
    runSocialAgent:async()=>{throw new Error("not used");},
    URL,Set,Map,Array,Object,String,Number,RegExp,Date,JSON,console,AbortController,setTimeout,clearTimeout,
    crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000000"}
  });
  vm.runInContext(addressUtilsSource,context);
  vm.runInContext(sanctionsSource,context);
  vm.runInContext(source,context);
  return vm.runInContext("({sanitizeRequest,extractToolSources,sanitizeSocialReport,attachWalletScreening,SOCIAL_INTEL_VERSION,socmintModels})",context);
}

test("SOCMINT request normalizes search fields and public URLs",()=>{
  const h=harness();
  const value=h.sanitizeRequest({
    target:"  Example target ",
    usernames:"@one\n@two",
    keywords:"alias, hashtag",
    platforms:["Telegram","X"],
    urls:["https://example.org/a","file:///etc/passwd"],
    countries_regions:"France; Tunisia",
    languages:"French, Arabic",
    date_from:"2026-09-01",
    date_to:"2026-09-23",
    objective:"Find public associations",
    mode:"urls_only"
  });
  assert.equal(value.target,"Example target");
  assert.deepEqual(Array.from(value.usernames),["@one","@two"]);
  assert.deepEqual(Array.from(value.keywords),["alias","hashtag"]);
  assert.equal(value.urls.length,1);
  assert.equal(value.urls[0],"https://example.org/a");
  assert.equal(value.mode,"urls_only");
});

test("SOCMINT source extraction keeps grounded public result URLs",()=>{
  const h=harness();
  const sources=h.extractToolSources({
    steps:[
      {type:"google_search_result",result:[{title:"Result",url:"https://example.com/result",snippet:"Public result"}]},
      {type:"url_context_result",result:[{title:"Profile",url:"https://social.example/u/test",snippet:"Profile text"}]},
      {type:"model_output",content:[{type:"text",text:"x",annotations:[{type:"url_citation",title:"Citation",url:"https://example.net/cite"}]}]}
    ]
  });
  assert.equal(sources.length,3);
  assert.ok(sources.some(x=>x.kind==="google_search"));
  assert.ok(sources.some(x=>x.kind==="url_context"));
  assert.ok(sources.some(x=>x.kind==="citation"));
});

test("SOCMINT UI contains investigation fields and report output",()=>{
  const html=fs.readFileSync("social.html","utf8");
  const js=fs.readFileSync("social.js","utf8");
  assert.ok(html.includes("RUN SOCMINT INVESTIGATION"));
  assert.ok(html.includes("TARGET / SUBJECT"));
  assert.ok(html.includes("USERNAMES / HANDLES"));
  assert.ok(html.includes("KNOWN PUBLIC URLS"));
  assert.ok(html.includes("ANALYTICAL QUESTION / OBJECTIVE"));
  assert.ok(html.includes("EXECUTIVE ASSESSMENT"));
  assert.ok(html.includes("DOWNLOAD PDF"));
  assert.ok(js.includes("/social-investigate"));
  assert.ok(js.includes("/social-workspace"));
});

test("SOCMINT free-tier search prefers Gemini 2.5 Flash-Lite",()=>{
  const h=harness();
  const search=Array.from(h.socmintModels({},true));
  const direct=Array.from(h.socmintModels({},false));
  assert.equal(search[0],"gemini-2.5-flash-lite");
  assert.ok(search.includes("gemini-2.5-flash"));
  assert.ok(direct.includes("gemini-3.5-flash-lite"));
});

test("SOCMINT UI contains friendly quota handling",()=>{
  const js=fs.readFileSync("social.js","utf8");
  const html=fs.readFileSync("social.html","utf8");
  assert.ok(js.includes('/QUOTA/.test(error.code||"")'));
  assert.ok(js.includes("retryAfter"));
  assert.ok(html.includes("does not use Gemini Google Search grounding"));
});

test("SOCMINT version is explicit",()=>{
  const h=harness();
  assert.match(h.SOCIAL_INTEL_VERSION,/socmint-v5/);
});


test("SOCMINT fallback builds an evidence-synthesis pipeline",()=>{
  const source=fs.readFileSync("cloudflare-worker/social-intel.js","utf8");
  assert.ok(source.includes("fetchBraveEvidencePages"));
  assert.ok(source.includes("geminiEvidenceSynthesis"));
  assert.ok(source.includes("brave_worker+direct_fetch+gemini_synthesis"));
  assert.ok(source.includes("direct_public_page"));
  assert.ok(source.includes("search_result"));
  assert.ok(!source.includes("The primary SOCMINT agent did not complete the investigation. Independent Brave discovery nevertheless identified"));
});

test("sanitizeSocialReport strips identity fields and caps array/string lengths before persistence",()=>{
  const h=harness();
  const report={
    id:"real-id",
    title:"x".repeat(500),
    user_id:"admin",
    username:"admin",
    key_findings:Array.from({length:20},(_,i)=>({finding:`f${i}`})),
    nested:{user_id:"should-be-stripped",note:"kept"}
  };
  const safe=h.sanitizeSocialReport(report);
  assert.equal(safe.id,"real-id");
  assert.equal(safe.title.length,220);
  assert.equal(safe.user_id,undefined,"top-level user_id must never be persisted");
  assert.equal(safe.username,undefined,"top-level username must never be persisted");
  assert.equal(safe.nested.user_id,undefined,"nested user_id must be stripped too, not just top-level");
  assert.equal(safe.nested.note,"kept");
  assert.equal(safe.key_findings.length,12,"key_findings must be capped even if the source report was not");
});

test("sanitizeSocialReport fills in safe defaults for a malformed/empty report instead of throwing",()=>{
  const h=harness();
  const safe=h.sanitizeSocialReport({});
  assert.equal(typeof safe.id,"string");
  assert.ok(safe.id.length>0);
  assert.equal(safe.title,"CT Atlas SOCMINT Assessment");
  assert.equal(safe.sources.length,0);
  assert.equal(h.sanitizeSocialReport(null),null);
  assert.equal(h.sanitizeSocialReport("not an object"),null);
});

test("every stored SOCMINT report gets wallet screening attached, and a listed wallet is flagged",async()=>{
  const listed="TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz";
  const payload={
    version:"sanctions-crypto-v1",retrieved_at:new Date().toISOString(),
    sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-09-23"}],
    entities:[{id:"1",name:"EXAMPLE FINANCIER",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],
    addresses:[{a:listed,c:"USDT",f:"tron",e:[0]}]
  };
  const h=harness(async()=>({ok:true,status:200,json:async()=>payload}));
  const report={
    executive_assessment:"Channel repeatedly posts "+listed+" as a donation address.",
    entities:[{type:"WALLET",value:listed,basis:"posted"},{type:"WALLET",value:"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",basis:"posted"}]
  };
  await h.attachWalletScreening({SANCTIONS_URL:"https://example.test/s.json"},report);
  assert.equal(report.wallet_screening.status,"ok");
  assert.equal(report.wallet_screening.hit,true);
  assert.equal(report.wallet_screening.wallets_found,2);
  assert.equal(report.wallet_screening.wallets[0].address,listed);
});

test("wallet screening never fails a report: an unreachable list yields status 'unavailable'",async()=>{
  const h=harness(async()=>{throw new Error("network down");});
  const report={executive_assessment:"Posts 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"};
  await h.attachWalletScreening({SANCTIONS_URL:"https://example.test/s.json"},report);
  assert.equal(report.wallet_screening.status,"unavailable");
  assert.equal(report.wallet_screening.wallets_found,1);
  assert.equal(report.wallet_screening.hit,false);
});

test("persistReport screens wallets before sanitising and storing the report",()=>{
  const src=fs.readFileSync("cloudflare-worker/social-intel.js","utf8");
  assert.match(src,/async function persistReport\(env, username, report\) \{\s*await attachWalletScreening\(env, report\);/);
});
