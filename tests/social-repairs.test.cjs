const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

// handleSocialInvestigate end to end, with the gate, the agent and every outbound
// fetch mocked: the failure paths below only show up when the whole handler runs.
const stripModuleSyntax=file=>fs.readFileSync(file,"utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,"")
  .replace(/export\s*\{[\s\S]*?\};\s*$/,"");
const sources=["address-utils","sanctions","social-intel"].map(name=>stripModuleSyntax("cloudflare-worker/"+name+".js"));

const GEMINI_URL="https://gemini.test/v1";
const ENV={GEMINI_API_KEY:"not-a-real-key",BRAVE_SEARCH_API_KEY:"not-a-real-key",SANCTIONS_URL:"https://sanctions.test/s.json"};
const BTC="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const clone=value=>JSON.parse(JSON.stringify(value));

function cleanText(value,max=700){return String(value||"").replace(/\s+/g," ").trim().slice(0,max);}
const answer=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:new Headers(headers),json:async()=>body,text:async()=>typeof body==="string"?body:JSON.stringify(body)});
const html=(text,status=200)=>answer(status,"<html><body>"+text+"</body></html>",{"Content-Type":"text/html"});
const brave=results=>answer(200,{web:{results}});
const gemini=report=>answer(200,{output_text:JSON.stringify(report)});
const sanctionsList={version:"sanctions-crypto-v1",retrieved_at:new Date().toISOString(),sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-09-23"}],
  entities:[{id:"1",name:"EXAMPLE FINANCIER",programs:["SDGT"],terrorism:true,list:"OFAC_SDN"}],addresses:[{a:BTC,c:"BTC",f:"bitcoin",e:[0]}]};

function memoryGate(overrides={}){
  const calls=[],saved=[];
  const gateCall=async(_env,path,payload)=>{
    calls.push({path,payload:clone(payload)});
    if(overrides[path])return overrides[path](payload);
    if(path==="/session-get")return answer(200,{username:"tester"});
    if(path==="/social-acquire")return answer(200,{ok:true,run_id:"run-1",log_id:"log-1"});
    if(path==="/social-release")return answer(200,{ok:true});
    if(path==="/social-report-add"){saved.push(clone(payload.report));return answer(200,{ok:true});}
    throw new Error("unexpected gate call "+path);
  };
  return {gateCall,calls,saved};
}

function harness({agent=null,routes=[],gate=memoryGate()}={}){
  const requests=[];
  const fetchImpl=async(url,init={})=>{
    url=String(url);
    requests.push({url,redirect:init.redirect,body:init.body});
    if(url===ENV.SANCTIONS_URL)return answer(200,sanctionsList);
    for(const [pattern,reply] of routes){
      if(url.includes(pattern))return typeof reply==="function"?reply(url,init):reply;
    }
    throw new Error("unexpected fetch "+url);
  };
  const context=vm.createContext({
    GEMINI_URL,AbortSignal,fetch:fetchImpl,cleanText,
    normalizeUsername:value=>cleanText(value,64).toLowerCase(),isAllowedUser:()=>true,
    jsonResponse:(body,status)=>({body,status}),gateCall:gate.gateCall,
    extractGeminiText:async payload=>payload.output_text,
    SOCIAL_AGENT_CLIENT_VERSION:"test-adk-client",isSocialAgentConfigured:()=>Boolean(agent),
    runSocialAgent:agent||(async()=>{throw new Error("not used");}),
    URL,URLSearchParams,Set,Map,Array,Object,String,Number,RegExp,Date,JSON,console:{...console,error(){}},AbortController,setTimeout,clearTimeout,
    crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000000"}
  });
  for(const source of sources)vm.runInContext(source,context);
  const api=vm.runInContext("({handleSocialInvestigate,normalizeAgentSources,normalizeReport,fetchBraveEvidencePages,isNoDirectFetch})",context);
  const run=async(body={})=>{
    const response=await api.handleSocialInvestigate({json:async()=>({user_id:"tester",...body}),headers:new Headers({"X-Session-Token":"session"})},ENV);
    return clone(response);
  };
  return {...api,run,requests,gate};
}

const failingAgent=(status=401,message="Unauthorized agent request.")=>async()=>{
  const error=new Error(message);error.status=status;error.code="SOCMINT_AGENT_FAILED";throw error;
};

test("the Worker never requests a page on a closed platform, even when Brave ranks it first",async()=>{
  const h=harness({agent:failingAgent(502,"boom"),routes:[
    ["api.search.brave.com",brave([
      {url:"https://www.linkedin.com/in/someone",title:"Profile",description:"Snippet about the target"},
      {url:"https://www.facebook.com/someone",title:"Page",description:"Another snippet"},
      {url:"https://example.org/open",title:"Open page",description:"Open snippet"}
    ])],
    ["example.org",html("Readable public page")],
    [GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment.",key_findings:[]})]
  ]});
  const {body,status}=await h.run({target:"Example",mode:"discover"});
  assert.equal(status,200);
  assert.ok(!h.requests.some(request=>/linkedin\.com|facebook\.com/.test(request.url)),"no request reaches a blocked host");
  const byUrl=Object.fromEntries(body.report.sources.map(source=>[source.url,source]));
  assert.equal(byUrl["https://www.linkedin.com/in/someone"].retrieval_status,"snippet_only_policy");
  assert.equal(byUrl["https://www.linkedin.com/in/someone"].kind,"search_result");
  assert.equal(byUrl["https://example.org/open"].kind,"direct_public_page");
});

test("a redirect into a closed platform stops before that hop",async()=>{
  const h=harness({routes:[["short.example",answer(302,"",{Location:"https://www.instagram.com/someone/"})]]});
  const [page]=await h.fetchBraveEvidencePages([{url:"https://short.example/a",title:"Short"}]);
  assert.equal(page.fetch_status,"snippet_only_policy");
  assert.equal(page.fetched,false);
  assert.deepEqual(h.requests.map(request=>request.url),["https://short.example/a"]);
  assert.equal(h.requests[0].redirect,"manual");
});

test("redirects between open pages are followed, the final URL is the one reported, and loops end",async()=>{
  const h=harness({routes:[["old.example",answer(301,"",{Location:"https://new.example/page"})],["new.example",html("Moved page text")]]});
  const [page]=await h.fetchBraveEvidencePages([{url:"https://old.example/page"}]);
  assert.equal(page.fetched,true);
  assert.equal(page.observed_url,"https://new.example/page");

  const loop=harness({routes:[["loop.example",answer(302,"",{Location:"https://loop.example/again"})]]});
  const [result]=await loop.fetchBraveEvidencePages([{url:"https://loop.example/start"}]);
  assert.equal(result.fetch_status,"bad_redirect");
  assert.equal(loop.requests.length,4);
});

test("blocked results do not use up the six page fetches, and no discovered source is lost",async()=>{
  const open=Array.from({length:7},(_,i)=>({url:`https://open${i}.example/`}));
  const blocked=Array.from({length:5},(_,i)=>({url:`https://www.tiktok.com/@user${i}`}));
  const h=harness({routes:[[".example",html("Page")]]});
  const pages=await h.fetchBraveEvidencePages([...blocked,...open]);
  assert.equal(pages.length,12);
  assert.equal(pages.filter(page=>page.fetched).length,6);
  assert.equal(pages.filter(page=>page.fetch_status==="snippet_only_policy").length,5);
  assert.equal(pages.filter(page=>page.fetch_status==="snippet_only").length,1);
});

test("Gemini url_context is not pointed at a closed platform on the analyst's behalf",async()=>{
  const h=harness({routes:[[GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment."})]]});
  const {status}=await h.run({mode:"urls_only",urls:["https://www.linkedin.com/in/someone","https://example.org/open"]});
  assert.equal(status,200);
  const body=JSON.parse(h.requests.find(request=>request.url===GEMINI_URL).body);
  assert.ok(!body.input.includes("linkedin.com"),"the blocked URL is not in the prompt");
  assert.ok(body.input.includes("https://example.org/open"));
  assert.ok(body.input.includes("1 URL(s) supplied by the analyst are on platforms CT Atlas does not retrieve"));
  assert.deepEqual(body.tools.map(tool=>tool.type),["url_context"]);

  const only=harness({routes:[[GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment."})]]});
  await only.run({mode:"urls_only",urls:["https://x.com/someone"]});
  assert.equal(JSON.parse(only.requests.find(request=>request.url===GEMINI_URL).body).tools,undefined);
});

test("the host check matches whole labels only",()=>{
  const h=harness();
  for(const url of ["https://linkedin.com/in/a","https://de.linkedin.com/in/a","https://m.facebook.com/a","https://www.threads.com/@a","https://x.com/a","https://t.co/a"])assert.equal(h.isNoDirectFetch(url),true,url);
  for(const url of ["https://notx.com/a","https://x.com.evil.org/a","https://t.me/s/a","not a url"])assert.equal(h.isNoDirectFetch(url),false,url);
});

const REAL="https://example.org/observed";
const INVENTED="https://invented.example/never-fetched";
const agentReturning=(report,meta)=>async()=>({report,meta:{agent_version:"ct-atlas-socmint-adk-v2",session_id:"s1",event_count:4,max_llm_calls:12,llm_calls:4,...meta}});

test("a report cannot cite a URL no tool returned, however confident the model is",async()=>{
  const h=harness({agent:agentReturning({
    title:"Assessment",executive_assessment:"Assessment.",
    sources:[{url:INVENTED,title:"Made up",kind:"direct_public_page"},{url:REAL,title:"Model title",kind:"direct_public_page"}],
    key_findings:[
      {finding:"Only invented",confidence:"HIGH",basis:"b",source_urls:[INVENTED]},
      {finding:"Real and invented",confidence:"HIGH",basis:"b",source_urls:[REAL,INVENTED]}
    ],
    entities:[{type:"ACCOUNT",value:"@x",platform:"x",confidence:"HIGH",basis:"b",source_urls:[INVENTED]}]
  },{evidence_ledger:[{url:REAL,kind:"search_result",tool:"search_public_web",title:"Ledger title",snippet:"Ledger snippet"}]})});
  const {body,status}=await h.run({target:"Example",mode:"discover"});
  assert.equal(status,200);
  const report=body.report;
  assert.deepEqual(report.sources.map(source=>source.url),[REAL]);
  assert.equal(report.sources[0].kind,"search_result","the kind comes from the ledger, not the model");
  assert.equal(report.sources[0].title,"Ledger title");
  assert.equal(report.sources[0].snippet,"Ledger snippet");
  assert.deepEqual(report.key_findings[0].source_urls,[]);
  assert.deepEqual(report.key_findings[0].unverified_source_urls,[INVENTED]);
  assert.equal(report.key_findings[0].confidence,"LOW","nothing is left behind the finding");
  assert.deepEqual(report.key_findings[1].source_urls,[REAL]);
  assert.equal(report.key_findings[1].confidence,"HIGH");
  assert.equal(report.entities[0].confidence,"LOW");
  assert.deepEqual(report.unverified_sources,[INVENTED]);
  assert.equal(h.gate.saved[0].key_findings[0].confidence,"LOW");
  assert.deepEqual(h.gate.saved[0].unverified_sources,[INVENTED]);
});

test("only a successful fetch is labelled direct; analyst URLs the agent never read stay analyst_supplied",()=>{
  const h=harness();
  const fetched="https://example.org/fetched",unread="https://example.org/unread";
  const sources=h.normalizeAgentSources({sources:[{url:fetched,kind:"third_party_reporting"},{url:unread,kind:"direct_public_page"}]},{urls:[fetched,unread]},
    [{url:fetched,kind:"direct_public_page"}]);
  assert.deepEqual(clone(sources).map(item=>[item.url,item.kind]),[[fetched,"direct_public_page"],[unread,"analyst_supplied"]]);
});

test("a cited tool URL joins the sources even if the model left it out, and spelling differences do not fail it",()=>{
  const h=harness();
  const raw={key_findings:[{finding:"f",confidence:"MEDIUM",basis:"b",source_urls:["https://example.org/page/#section"]}]};
  const sources=h.normalizeAgentSources(raw,{urls:[]},[{url:"https://example.org/page",kind:"search_result"}]);
  const report=clone(h.normalizeReport(raw,{urls:[]},sources,"m","adk_agent"));
  assert.deepEqual(report.key_findings[0].source_urls,["https://example.org/page"]);
  assert.equal(report.key_findings[0].confidence,"MEDIUM");
  assert.equal(report.unverified_sources.length,0);

  const single={key_findings:[{finding:"f",confidence:"MEDIUM",basis:"b",source_urls:"https://example.org/page"}]};
  const kept=clone(h.normalizeReport(single,{urls:[]},h.normalizeAgentSources(single,{urls:[]},[{url:"https://example.org/page",kind:"search_result"}]),"m","adk_agent"));
  assert.deepEqual(kept.key_findings[0].source_urls,["https://example.org/page"],"a bare string is still one citation");
});

test("an agent that sends no ledger proves nothing beyond its Telegram annex",()=>{
  const h=harness();
  const post="https://t.me/examplechan/1";
  const raw={sources:[{url:REAL,kind:"direct_public_page"}],telegram_evidence:{messages:[{url:post,text:"x"}]}};
  const sources=clone(h.normalizeAgentSources(raw,{urls:[]}));
  assert.deepEqual(sources.map(item=>[item.url,item.kind]),[[post,"telegram_collected_post"]]);
  assert.deepEqual(clone(h.normalizeReport(raw,{urls:[]},sources,"m","adk_agent")).unverified_sources,[REAL]);
});

test("an unknown kind in the ledger is never trusted as a stronger observation",()=>{
  const h=harness();
  assert.equal(h.normalizeAgentSources({sources:[{url:REAL}]},{urls:[]},[{url:REAL,kind:"verified_by_police"}])[0].kind,"search_result");
});

test("a report the agent could not finish is marked partial, not presented as an assessment",async()=>{
  const h=harness({agent:agentReturning(
    {title:"Collected evidence — synthesis incomplete",executive_assessment:"Sources were collected.",sources:[{url:REAL,title:"Page",kind:"direct_public_page"}]},
    {partial:true,stop_reason:"deadline",evidence_ledger:[{url:REAL,kind:"direct_public_page"}]}
  )});
  const {body}=await h.run({target:"Example",mode:"discover"});
  assert.equal(body.partial,true);
  assert.equal(body.report.discovery_mode,"adk_agent_partial");
  assert.equal(body.report.agent_meta.stop_reason,"deadline");
  assert.equal(body.report.sources[0].kind,"direct_public_page");
});

test("a wallet that appears only in a Telegram post is screened, even when synthesis failed",async()=>{
  const post="https://t.me/examplechan/1";
  const h=harness({agent:agentReturning({
    title:"Collected evidence — synthesis incomplete",executive_assessment:"Posts were collected.",
    telegram_evidence:{channels:[{channel:"examplechan"}],messages:[{url:post,text:"Donate here: "+BTC,wallets:{bitcoin:[BTC]}}]}
  },{partial:true,stop_reason:"llm_call_limit",evidence_ledger:[{url:post,kind:"telegram_collected_post"}]})});
  const {body}=await h.run({target:"Example",mode:"discover"});
  const screening=body.report.wallet_screening;
  assert.equal(screening.wallets_found,1);
  assert.equal(screening.hit,true);
  assert.equal(screening.wallets[0].address,BTC);
  assert.deepEqual(h.gate.saved[0].telegram_evidence.messages[0].wallets,[BTC]);
});

test("wallets found in post links or in posts beyond the retained limit are screened too",async()=>{
  const post="https://t.me/examplechan/1";
  const annex={channels:[{channel:"examplechan"}],messages:[{url:post,text:"No address in the text",wallets:{bitcoin:[BTC]}}]};
  const viaLink=harness({agent:agentReturning({executive_assessment:"x",telegram_evidence:annex},{evidence_ledger:[{url:post,kind:"telegram_collected_post"}]})});
  assert.equal((await viaLink.run({target:"Example",mode:"discover"})).body.report.wallet_screening.hit,true);

  const beyond={channels:[{channel:"examplechan"}],messages:[{url:post,text:"Nothing"}],wallets:[BTC]};
  const viaAnnex=harness({agent:agentReturning({executive_assessment:"x",telegram_evidence:beyond},{evidence_ledger:[{url:post,kind:"telegram_collected_post"}]})});
  const {body}=await viaAnnex.run({target:"Example",mode:"discover"});
  assert.equal(body.report.wallet_screening.hit,true);
  assert.deepEqual(viaAnnex.gate.saved[0].telegram_evidence.wallets,[BTC]);
});

test("a stale agent key cannot hide behind a success: the URL fallback says what happened",async()=>{
  const h=harness({agent:failingAgent(401),routes:[[GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment."})]]});
  const {body,status}=await h.run({target:"Example",mode:"discover",urls:["https://example.org/known"]});
  assert.equal(status,200);
  assert.equal(body.agent,false);
  assert.equal(body.fallback,"url_context_agent_fallback");
  assert.equal(body.report.discovery_mode,"url_context_agent_fallback");
  assert.equal(body.report.agent_meta.fallback_stage,"url_context");
  assert.equal(body.report.agent_meta.agent_failure.status,401);
});

test("a failed save returns the report without re-running the investigation",async()=>{
  let agentCalls=0;
  const report={title:"Assessment",executive_assessment:"Assessment.",sources:[{url:REAL}]};
  const agent=async()=>{agentCalls++;return agentReturning(report,{evidence_ledger:[{url:REAL,kind:"direct_public_page"}]})();};
  for(const failure of [()=>answer(500,{}),()=>{throw new Error("storage down");}]){
    agentCalls=0;
    const gate=memoryGate({"/social-report-add":failure});
    const h=harness({agent,gate});
    const {body,status}=await h.run({target:"Example",mode:"discover"});
    assert.equal(status,200);
    assert.equal(body.saved,false);
    assert.match(body.warning,/could not be saved/);
    assert.equal(body.report.title,"Assessment");
    assert.equal(body.report.wallet_screening.status,"ok","screening does not depend on the save");
    assert.equal(agentCalls,1);
    assert.deepEqual(h.requests.map(request=>request.url),[ENV.SANCTIONS_URL],"no Brave or Gemini call after a good report");
  }
});

test("a failed save in the Brave path does not spend another Gemini call either",async()=>{
  const gate=memoryGate({"/social-report-add":()=>answer(500,{})});
  const h=harness({gate,agent:failingAgent(502,"boom"),routes:[
    ["api.search.brave.com",brave([{url:"https://example.org/open",title:"Open",description:"Snippet"}])],
    ["example.org",html("Readable public page")],
    [GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment."})]
  ]});
  const {body}=await h.run({target:"Example",mode:"discover"});
  assert.equal(body.saved,false);
  assert.equal(body.fallback,"brave_evidence_synthesis");
  assert.equal(h.requests.filter(request=>request.url===GEMINI_URL).length,1);
});

test("Brave refusing the key is not reported as a bad query",async()=>{
  const h=harness({agent:failingAgent(502,"boom"),routes:[["api.search.brave.com",answer(401,{})]]});
  const {body,status}=await h.run({target:"Example",mode:"discover"});
  assert.equal(status,502);
  assert.equal(body.code,"SOCMINT_SEARCH_PROVIDER_ERROR");
  assert.match(body.error,/Brave search provider failed \(HTTP 401\)/);
  assert.doesNotMatch(body.error,/Refine the target/);

  const quiet=harness({agent:failingAgent(502,"boom"),routes:[["api.search.brave.com",brave([])]]});
  const empty=await quiet.run({target:"Example",mode:"discover"});
  assert.equal(empty.body.code,"SOCMINT_AGENT_UNAVAILABLE");
  assert.match(empty.body.error,/Refine the target/);

  const quota=harness({agent:failingAgent(429,"quota"),routes:[["api.search.brave.com",async()=>{throw new Error("offline");}]]});
  const limited=await quota.run({target:"Example",mode:"discover"});
  assert.equal(limited.status,429);
  assert.match(limited.body.error,/Brave search provider failed \(network error\)/);
});

test("a fallback report keeps the analyst's own question",async()=>{
  const h=harness({agent:failingAgent(502,"boom"),routes:[
    ["api.search.brave.com",brave([{url:"https://example.org/open",title:"Open",description:"Snippet"}])],
    ["example.org",html("Readable public page")],
    [GEMINI_URL,gemini({title:"Report",executive_assessment:"Assessment.",key_findings:[{finding:"f",confidence:"MEDIUM",basis:"b",source_urls:["https://example.org/open"]}]})]
  ]});
  const {body}=await h.run({target:"Example",mode:"discover"});
  assert.equal(body.report.query.mode,"discover");
  assert.deepEqual(body.report.query.urls,[]);
  assert.deepEqual(body.report.key_findings[0].source_urls,["https://example.org/open"],"discovered URLs stay citable");
});

test("a failed URL fallback is not repeated on the same model chain",async()=>{
  let geminiCalls=0;
  const h=harness({agent:failingAgent(401),routes:[[GEMINI_URL,()=>{geminiCalls++;return answer(503,"unavailable");}]]});
  const {body,status}=await h.run({target:"Example",mode:"discover",urls:["https://example.org/known"]});
  assert.equal(status,503);
  assert.equal(body.code,"SOCMINT_GENERATION_FAILED");
  assert.equal(geminiCalls,2,"each model of the chain once");
});

test("the gate's refusal stops the run before anything leaves CT Atlas",async()=>{
  let agentCalls=0;
  const gate=memoryGate({"/social-acquire":()=>answer(429,{error:"Daily limit reached.",code:"SOCMINT_USER_QUOTA_EXHAUSTED"})});
  const h=harness({gate,agent:async()=>{agentCalls++;}});
  const {body,status}=await h.run({target:"Example",mode:"discover"});
  assert.equal(status,429);
  assert.equal(body.code,"SOCMINT_USER_QUOTA_EXHAUSTED");
  assert.equal(agentCalls,0);
  assert.deepEqual(h.requests,[]);
  assert.ok(!gate.calls.some(call=>call.path==="/social-release"));
});

test("every run is logged up front and released with its outcome, whatever happened",async()=>{
  const report={title:"Assessment",executive_assessment:"Assessment.",sources:[{url:REAL}]};
  const good=harness({agent:agentReturning(report,{evidence_ledger:[{url:REAL,kind:"direct_public_page"}]})});
  await good.run({target:"Example Person",usernames:["@handle"],mode:"discover",objective:"Find links"});
  const acquire=good.gate.calls.find(call=>call.path==="/social-acquire");
  assert.equal(acquire.payload.details.target,"Example Person");
  assert.deepEqual(acquire.payload.details.usernames,["@handle"]);
  const release=good.gate.calls.find(call=>call.path==="/social-release");
  assert.deepEqual(release.payload,{username:"tester",run_id:"run-1",log_update:{id:"log-1",outcome:"generated",title:"Assessment",discovery_mode:"adk_agent"}});

  const failed=harness({agent:failingAgent(502,"boom"),routes:[["api.search.brave.com",brave([])]]});
  await failed.run({target:"Example",mode:"discover"});
  assert.equal(failed.gate.calls.find(call=>call.path==="/social-release").payload.log_update.outcome,"failed");

  const crashed=harness({agent:failingAgent(502,"boom"),routes:[["api.search.brave.com",brave([{url:"https://example.org/open"}])],["example.org",()=>{throw new Error("offline");}],[GEMINI_URL,()=>{throw new TypeError("bad");}]]});
  await crashed.run({target:"Example",mode:"discover"});
  assert.ok(crashed.gate.calls.some(call=>call.path==="/social-release"));
});

test("the Worker sends the agent a deadline shorter than its own abort",()=>{
  const client=fs.readFileSync("cloudflare-worker/social-agent-client.js","utf8");
  const deadline=Number(client.match(/SOCIAL_AGENT_DEADLINE_SECONDS = (\d+)/)[1]);
  const abort=Number(client.match(/timeoutMs = (\d+)/)[1]);
  assert.ok(client.includes("deadline_seconds: SOCIAL_AGENT_DEADLINE_SECONDS"));
  assert.ok(deadline*1000<abort-10000,"the agent must have time to answer before the Worker gives up");
});

test("Cloud Run gets one investigation per instance and a limit above the Worker's",()=>{
  const workflow=fs.readFileSync(".github/workflows/deploy-socmint-agent.yml","utf8");
  assert.ok(workflow.includes("--concurrency 1 \\"));
  assert.ok(workflow.includes("--memory 1Gi \\"));
  assert.ok(Number(workflow.match(/--timeout (\d+) \\/)[1])>115);
  assert.ok(workflow.includes("tests/social-repairs.test.cjs")&&workflow.includes("tests/social-gate.test.cjs"));
});

function uiHarness(fetchImpl=async()=>{throw new Error("network not used");}){
  const elements=new Map();
  const element=()=>({value:"",innerHTML:"",textContent:"",title:"",className:"",hidden:false,disabled:false,querySelectorAll:()=>[],insertAdjacentHTML(_,value){this.innerHTML+=value;}});
  const document={addEventListener(){},querySelectorAll:()=>[],getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}};
  const context=vm.createContext({document,URL,location:{href:"https://ct-atlas.com/social.html"},window:{scrollTo(){}},sessionStorage:{getItem:()=>"tester"},fetch:fetchImpl});
  const source=fs.readFileSync("social.js","utf8").replace("})();","globalThis.testing={refreshAgentStatus,pdfBlocks,renderReport,runInvestigation};})();");
  vm.runInContext(source,context);
  document.getElementById("socialAgentBadge");
  return {...context.testing,el:id=>document.getElementById(id)};
}

test("the Social badge follows the live agent status, not its configuration",async()=>{
  const cases=[["operational","ADK AGENT"],["degraded","ADK AGENT"],["down","AGENT DOWN"],["not_configured","GEMINI FALLBACK"],[undefined,"SOCMINT AGENT"]];
  for(const [status,label] of cases){
    const urls=[];
    const ui=uiHarness(async url=>{urls.push(url);return {ok:true,json:async()=>({components:{agent:{status}}})};});
    await ui.refreshAgentStatus();
    assert.equal(ui.el("socialAgentBadge").textContent,label,String(status));
    assert.ok(urls[0].endsWith("/health/status"));
  }
  const offline=uiHarness(async()=>{throw new Error("offline");});
  await offline.refreshAgentStatus();
  assert.equal(offline.el("socialAgentBadge").textContent,"SOCMINT AGENT");
});

test("the status line warns about every degraded outcome and never claims a failed save",async()=>{
  const report={id:"r1",title:"Report",sources:[{url:REAL}]};
  const run=async result=>{
    const ui=uiHarness(async()=>({ok:true,json:async()=>({ok:true,report,...result})}));
    ui.el("socialTarget").value="Example";
    await ui.runInvestigation({preventDefault(){}});
    return [ui.el("socialStatus").textContent,ui.el("socialStatus").className];
  };
  assert.deepEqual(await run({saved:true}),["SOCMINT report generated · 1 public source. Saved.","social-status success"]);
  let [text,kind]=await run({saved:true,fallback:"url_context_agent_fallback"});
  assert.match(text,/The ADK agent failed/);assert.match(kind,/warning/);
  [text,kind]=await run({saved:true,partial:true});
  assert.match(text,/synthesis did not finish/);assert.match(kind,/warning/);
  [text,kind]=await run({saved:false,warning:"The report could not be saved to your history."});
  assert.match(text,/could not be saved/);assert.doesNotMatch(text,/Saved\./);assert.match(kind,/warning/);
  [text,kind]=await run({saved:false,fallback:"brave_evidence_only"});
  assert.doesNotMatch(text,/Saved\./);
});

test("removed citations are shown as text, escaped, and never as links",()=>{
  const ui=uiHarness();
  const hostile='https://invented.example/"><img src=x>';
  ui.renderReport({title:"T",sources:[],unverified_sources:[hostile],key_findings:[{finding:"F",confidence:"LOW",basis:"B",source_urls:[],unverified_source_urls:[hostile]}],entities:[{type:"URL",value:"v",confidence:"LOW",basis:"B",unverified_source_urls:[hostile]}]});
  for(const id of ["reportFindings","reportEntities","reportSources"]){
    const markup=ui.el(id).innerHTML;
    assert.match(markup,/Unverified citation removed/,id);
    assert.ok(!markup.includes("<img")&&!markup.includes('href="https://invented'),id);
  }
});

test("the PDF puts the sources under their heading, after the Telegram annex",()=>{
  const ui=uiHarness();
  const blocks=Array.from(ui.pdfBlocks({
    telegram_evidence:{messages_retained:1,messages_observed:1,retrieved_at:"now",scope:"Public",relationships:[],messages:[{channel:"c",date:"d",url:"https://t.me/c/1",text:"post"}]},
    sources:[{title:"Source",url:REAL}],unverified_sources:[INVENTED]
  }));
  const headings=blocks.filter(block=>block.type==="heading").map(block=>block.text);
  const sources=blocks.findIndex(block=>block.text==="SOURCES");
  assert.ok(headings.indexOf("TELEGRAM EVIDENCE")<headings.indexOf("SOURCES"));
  assert.ok(blocks[sources+1].text.startsWith("Source"),"the heading is directly above the first source");
  assert.ok(blocks.some(block=>block.text.includes(INVENTED)&&block.type==="body"));
});
