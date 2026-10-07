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
  return vm.runInContext("({sanitizeRequest,extractToolSources,sanitizeSocialReport,normalizeTelegramEvidence,normalizeAgentSources,normalizeReport,attachWalletScreening,needsIndependentDiscoveryFallback,SOCIAL_INTEL_VERSION,socmintModels})",context);
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

test("Telegram evidence and exact message citations survive normalization and saved history",()=>{
  const h=harness();
  const messages=Array.from({length:120},(_,i)=>({url:`https://t.me/examplechan/${i+1}`,text:"Line one\nLine two",date:"2026-10-04",username:"private-session"}));
  const raw={telegram_evidence:{messages,messages_observed:125,truncated:true,relationships:[{channel:"examplechan",type:"mention",target:"@another",source_urls:[messages[0].url,messages[0].url,"https://t.me/unread/9"]}]},key_findings:[{finding:"Citation",source_urls:[messages[119].url]}]};
  const sources=h.normalizeAgentSources(raw,{urls:[]});
  const report=h.normalizeReport(raw,{urls:[]},sources,"test","adk_agent");
  const saved=h.sanitizeSocialReport(report);
  assert.equal(saved.telegram_evidence.messages.length,120);
  assert.equal(saved.telegram_evidence.messages[0].text,"Line one\nLine two");
  assert.equal(saved.telegram_evidence.messages[0].username,undefined);
  assert.equal(saved.telegram_evidence.relationships[0].count,1);
  assert.equal(saved.sources.length,120);
  assert.equal(saved.key_findings[0].source_urls[0],messages[119].url);
  assert.equal(saved.telegram_evidence.truncated,true);
});

test("Telegram annex rejects unsafe or fabricated post URLs and bounds content",()=>{
  const h=harness();
  const evidence=h.normalizeTelegramEvidence({messages:[{url:"javascript:alert(1)"},{url:"https://t.me.evil.org/test/1"},{url:"https://t.me/examplechan/1",text:"x".repeat(5000),links:["javascript:alert(1)"]}],relationships:[{type:"ownership",source_urls:["https://t.me/examplechan/1"]}]});
  assert.equal(evidence.messages.length,1);
  assert.equal(evidence.messages[0].text.length,4000);
  assert.equal(evidence.messages[0].text_truncated,true);
  assert.equal(evidence.messages[0].links.length,0);
  assert.equal(evidence.relationships.length,0);
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

test("Social UI uses OSINT Industries and retains its law-enforcement access link",()=>{
  const html=fs.readFileSync("social.html","utf8");
  assert.ok(html.includes("POWERED BY OSINT INDUSTRIES"));
  assert.ok(html.includes('id="osintForm"'));
  assert.ok(html.includes('id="osintCredits"'));
  assert.ok(html.includes("https://www.osint.industries/industries/law-enforcement"));
  assert.ok(!html.includes("RUN SOCMINT INVESTIGATION"));
  assert.ok(html.includes('src="social.js')&&!html.includes('src="tab-access.js'));
});

test("SOCMINT free-tier search prefers Gemini 2.5 Flash-Lite",()=>{
  const h=harness();
  const search=Array.from(h.socmintModels({},true));
  const direct=Array.from(h.socmintModels({},false));
  assert.equal(search[0],"gemini-2.5-flash-lite");
  assert.ok(search.includes("gemini-2.5-flash"));
  assert.ok(direct.includes("gemini-3.5-flash-lite"));
});

test("the Social client shows provider failures and never automatically retries credit-consuming searches",()=>{
  const js=fs.readFileSync("social.js","utf8");
  const html=fs.readFileSync("social.html","utf8");
  assert.ok(js.includes("data.error"));
  assert.ok(js.includes("not retried automatically"));
  assert.ok(html.includes('src="social.js'));
  assert.ok(!js.includes("/social-investigate"));
});

test("SOCMINT version is explicit",()=>{
  const h=harness();
  assert.match(h.SOCIAL_INTEL_VERSION,/socmint-v6/);
});


test("empty ADK discovery evidence triggers the independent search fallback",()=>{
  const h=harness();
  assert.equal(h.needsIndependentDiscoveryFallback({mode:"discover",urls:[]},[]),true);
  assert.equal(h.needsIndependentDiscoveryFallback({mode:"discover",urls:[]},[{url:"https://example.org/"}]),false);
  assert.equal(h.needsIndependentDiscoveryFallback({mode:"urls_only",urls:["https://example.org/"]},[]),false);
});

test("SOCMINT discovery does not stop at ADK quota or an empty ADK report",()=>{
  const src=fs.readFileSync("cloudflare-worker/social-intel.js","utf8");
  assert.ok(src.includes("SOCMINT_AGENT_EMPTY_EVIDENCE"));
  assert.ok(src.includes("const agentQuota = status === 429"));
  assert.ok(src.includes("Brave is independent of Gemini"));
  const quotaPos=src.indexOf("const agentQuota = status === 429");
  const bravePos=src.indexOf("const discovery = await braveWorkerDiscovery",quotaPos);
  assert.ok(bravePos>quotaPos,"Brave fallback must still run after ADK quota/empty evidence");
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
  assert.match(src,/async function persistReport\(env, username, report, query = null\) \{\s*await attachWalletScreening\(env, report\);/);
});
