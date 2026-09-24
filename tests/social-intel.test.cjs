const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/social-intel.js","utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,"")
  .replace(/export\s*\{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=700){
  return String(value||"").replace(/\s+/g," ").trim().slice(0,max);
}
function normalizeUsername(value){return cleanText(value,64).toLowerCase();}
function isAllowedUser(){return true;}
function jsonResponse(body,status){return {body,status};}
async function gateCall(){throw new Error("not used");}
async function extractGeminiText(){throw new Error("not used");}

function harness(){
  const context=vm.createContext({
    cleanText,normalizeUsername,isAllowedUser,jsonResponse,gateCall,extractGeminiText,
    SOCIAL_AGENT_CLIENT_VERSION:"test-adk-client",
    isSocialAgentConfigured:()=>false,
    runSocialAgent:async()=>{throw new Error("not used");},
    URL,Set,Map,Array,Object,String,Number,RegExp,Date,JSON,console,
    crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000000"}
  });
  vm.runInContext(source,context);
  return vm.runInContext("({sanitizeRequest,extractToolSources,SOCIAL_INTEL_VERSION,socmintModels})",context);
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
  assert.ok(html.includes("ADK does not rely on Gemini Google Search grounding"));
});

test("SOCMINT version is explicit",()=>{
  const h=harness();
  assert.match(h.SOCIAL_INTEL_VERSION,/socmint-v3/);
});
