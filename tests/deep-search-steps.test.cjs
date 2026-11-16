// Custom Intelligence runs in steps from the page: the Worker (Cloudflare Free plan, 10 ms
// of CPU a request) plans, relays each search provider's answer unread and writes the
// assessment; the page searches, reads its copy of the database and assembles the evidence
// with the Worker's own functions. These tests hold each step to that split.
"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const plain=value=>JSON.parse(JSON.stringify(value));
function source(file){
  return fs.readFileSync(file,'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,'')
    .replace(/^export /gm,'');
}
const shared=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
vm.runInContext(source('cloudflare-worker/shared.js'),shared);
const sharedNames=['cleanText','normalizeTitle','titleTokens','tokenSimilarity','dateDistanceDays','isSameStory','parseEventDate',
  'eventUniqueKey','isRetiredJudicialEvent','priority','parseDatabaseFilters','hasActiveDatabaseFilters','matchesDatabaseFilters',
  'databaseFiltersLabel','normalizeUsername','sha256'];
const helpers=Object.fromEntries(sharedNames.map(name=>[name,vm.runInContext(name,shared)]));

function worker(extra={}){
  const calls={gate:[],fetch:[],model:0};
  const gateAnswers=extra.gateAnswers||{};
  const context=vm.createContext({...helpers,URL,URLSearchParams,Request,Response,Headers,AbortSignal,
    setTimeout:fn=>fn(),console:{log(){},warn(){},error(){}},
    isAllowedUser:()=>true,
    jsonResponse:(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),
    corsHeaders:()=>({'Access-Control-Allow-Origin':'https://ct-atlas.test'}),
    gateCall:async(env,route,payload)=>{
      calls.gate.push({route,payload});
      const answer=gateAnswers[route]||(route==='/session-get'?{username:'analyst'}:route==='/acquire'?{permit_id:'permit-1',log_id:'log-1'}:
        route==='/cache-get'?{hit:false}:{ok:true});
      return new Response(JSON.stringify(answer),{status:answer.status||200});
    },
    fetch:async(url)=>{calls.fetch.push(String(url));return new Response('<rss><channel><item><title>Relayed</title></item></channel></rss>',{status:200,headers:{'Content-Type':'application/rss+xml'}});},
    fetchEventsDatabase:async()=>{throw new Error('a step must not read the events database');},
    searchCorpusForDeepSearch:async()=>({available:true,rows:[{title:'Archived report',url:'https://archive.test/1',published:'2026-11-10T08:00:00Z',
      language:'en',search_engine:'ct_atlas_corpus',corpus_kind:'archived_incident',source:'Archive'}]}),
    illustrationCandidates:items=>items.slice(0,2).map(item=>({id:item.id,url:item.url})),
    ...extra.context});
  vm.runInContext(source('cloudflare-worker/deep-search.js'),context);
  vm.runInContext(`callGeminiJson = async (env, instruction, input) => {
    __model(input);
    return instruction === PLAN_INSTRUCTION ? __plan : { title: 'Assessment', analysis: 'KEY JUDGEMENTS\\nA documented attack in Mogadishu is confirmed by the database [S01].' };
  };`,Object.assign(context,{__model:input=>{calls.model++;calls.lastInput=input;},__plan:planFixture(context)}));
  return {context,calls,run:code=>vm.runInContext(code,context)};
}

function planFixture(context){
  const codes=vm.runInContext('DEEP_SEARCH_LANGUAGE_CODES',context);
  return {interpreted_request:'Recent attacks in Somalia',
    detected_period:{mode:'relative',relative_days:30,explanation:'Last 30 days'},
    priority_languages:['so'],
    queries:Object.fromEntries(codes.map(code=>[code,{primary:`${code} Somalia attack`,secondary:`${code} Mogadishu bombing`,anchor:'somalia'}]))};
}

function request(body,token='session'){
  return new Request('https://worker.test/deep-search',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':token},
    body:JSON.stringify({user_id:'analyst',question:'What attacks happened in Somalia recently?',...body})});
}
const ctx={waitUntil(promise){return promise;}};

test('the relay fetches only the addresses retrieveNews builds, unread, and only for an open permit',async()=>{
  const w=worker();
  for(const url of ['https://news.google.com/rss/search?q=a&hl=en-US','https://www.bing.com/news/search?q=a&format=rss',
    'https://api.gdeltproject.org/api/v2/doc/doc?query=a&mode=artlist']){
    assert.ok(w.run(`relayTarget(${JSON.stringify(url)})`),url);
  }
  for(const url of ['http://news.google.com/rss/search?q=a','https://news.google.com/rss/topics','https://evil.test/rss/search',
    'https://user:pw@news.google.com/rss/search','https://news.google.com:8443/rss/search','https://www.bing.com/search?q=a','not a url']){
    assert.equal(w.run(`relayTarget(${JSON.stringify(url)})`),null,url);
  }
  const relayed=await w.context.handleDeepSearch(request({step:'fetch',permit_id:'permit-1',url:'https://news.google.com/rss/search?q=Somalia'}),{},ctx);
  assert.equal(relayed.status,200);
  assert.match(await relayed.text(),/<title>Relayed<\/title>/);
  assert.equal(relayed.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(w.calls.fetch,['https://news.google.com/rss/search?q=Somalia']);
  assert.deepEqual(plain(w.calls.gate.find(call=>call.route==='/permit-use').payload),{permitId:'permit-1',username:'analyst',relay:true});

  const refused=await w.context.handleDeepSearch(request({step:'fetch',permit_id:'permit-1',url:'https://evil.test/x'}),{},ctx);
  assert.equal(refused.status,400);
  const expired=worker({gateAnswers:{'/permit-use':{status:409,error:'This Deep Search has expired. Run it again.'}}});
  const late=await expired.context.handleDeepSearch(request({step:'fetch',permit_id:'old',url:'https://news.google.com/rss/search?q=a'}),{},ctx);
  assert.equal(late.status,409);
  assert.deepEqual(expired.calls.fetch,[],'nothing is fetched for an expired permit');
  const anonymous=worker({gateAnswers:{'/session-get':{status:401,error:'no'}}});
  assert.equal((await anonymous.context.handleDeepSearch(request({step:'fetch',url:'https://news.google.com/rss/search?q=a'}),{},ctx)).status,401);
  assert.deepEqual(anonymous.calls.fetch,[]);
});

test('the plan step plans, searches the archive and keeps the permit open, without the database',async()=>{
  const w=worker();
  const response=await w.context.handleDeepSearch(request({step:'plan',region:'GLOBAL'}),{},ctx);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.step,'plan');
  assert.equal(body.permit_id,'permit-1');
  assert.equal(body.log_id,'log-1');
  assert.equal(body.plan.queries.length,28);
  assert.equal(body.detected_period.mode,'relative');
  assert.equal(Date.parse(body.detected_period.end)-Date.parse(body.detected_period.start),30*86400000);
  assert.ok(body.priority_languages.includes('en'));
  assert.equal(body.corpus.rows.length,1);
  assert.equal(w.calls.model,1,'only the planner');
  assert.ok(!w.calls.gate.some(call=>call.route==='/release'),'the permit stays open for the relays and the report');
  const cacheKey=w.calls.gate.find(call=>call.route==='/cache-get').payload.cacheKey;
  const expected='deep:'+await helpers.sha256(JSON.stringify({question:'what attacks happened in somalia recently?',region:'GLOBAL',
    topic:'ALL',actor_group:'ALL',version:w.run('DEEP_SEARCH_VERSION'),username:'analyst'}));
  assert.equal(cacheKey,expected,'a stepped report is keyed to its analyst');

  const failing=worker();
  failing.run('callGeminiJson = async () => { throw new Error("planner down"); };');
  const failed=await failing.context.handleDeepSearch(request({step:'plan'}),{},ctx);
  assert.equal(failed.status,503);
  assert.ok(failing.calls.gate.some(call=>call.route==='/release'),'a failed plan gives the permit back');
});

test('a cached stepped report comes back from the plan step and closes the search',async()=>{
  const w=worker({gateAnswers:{'/cache-get':{hit:true,report:{title:'Earlier',detected_period:{label:'Last 30 days'}}}}});
  const response=await w.context.handleDeepSearch(request({step:'plan'}),{},ctx);
  const body=await response.json();
  assert.equal(body.cached,true);
  assert.equal(body.title,'Earlier');
  assert.equal(w.calls.model,0);
  assert.deepEqual(w.calls.gate.map(call=>call.route),['/session-get','/acquire','/cache-get','/commit-report','/usage-increment','/release']);
});

// A realistic assembly, built by the real functions from relayed searches and a database.
async function assembly(w){
  const now=Date.now();
  const window={mode:'relative',label:'Last 30 days',startDt:new Date(now-30*86400000),endDt:new Date(now)};
  const plan=w.run('sanitizePlan(__plan, "Somalia")');
  const rss=title=>`<rss><channel><item><title>${title}</title><link>https://news.test/${encodeURIComponent(title)}</link>`+
    `<pubDate>${new Date(now-2*86400000).toUTCString()}</pubDate><source url="https://news.test">News</source></item></channel></rss>`;
  const retrieval=await w.context.retrieveNews(plan,window,['en','fr','ar'],async url=>new Response(
    String(url).includes('gdelt')?'{}':rss(new URL(url).searchParams.get('q')?.split(' after:')[0]||'x')));
  const db={last_updated:'2026-11-16T10:00:00Z',events:[{id:'a1',title:'Somalia attack in Mogadishu kills soldiers',summary:'Somalia attack.',
    category:'Attacks',categories:['Attacks'],is_attack:true,primary_event_type:'ATTACK',country:'Somalia',published:new Date(now-86400000).toISOString(),
    url:'https://db.test/a1',source:'Outlet',source_count:2}]};
  const evidence=w.context.pageDatabaseEvidence(db,plan,window,{region:'GLOBAL'});
  const corpus={available:true,rows:[]};
  return {plan,window,raw:w.context.assembleDeepSearch({...evidence,plan,priorityLanguages:['en','fr','ar'],retrieval,corpus})};
}

test('the Worker accepts an honest assembly unchanged and caps an altered one',async()=>{
  const w=worker();
  const {raw}=await assembly(w);
  assert.ok(raw.evidence.length>10,'the fixture exercises real evidence');
  assert.equal(raw.evidence[0].search_engine,'ct_atlas_database','database events lead');
  assert.deepEqual(plain(w.context.acceptDeepSearchAssembly(plain(raw))),plain(raw));

  const long='x'.repeat(3000);
  const altered={...plain(raw),
    evidence:Array.from({length:80},(_,i)=>({id:'S99',title:long,summary:long,url:long,source_count:-3,atlas_match_score:500,
      additional_sources:Array(9).fill({source:long}),injected:true,database_event:{id:long,source_count:'many'}})),
    languages_searched:[{code:'xx',query_count:5},{code:'en',name:'Injected',query_count:'7',priority:'yes'}],
    priority_languages:['en','zz'],retrieval:{articles_retrieved:-5,matched_to_atlas:'3',ct_atlas_corpus_available:'yes'},
    search_queries:Array(200).fill({query:long,status:'500',ok:'true'}),database_version:long,database_evidence_count:999};
  const accepted=plain(w.context.acceptDeepSearchAssembly(altered));
  assert.equal(accepted.evidence.length,48);
  assert.deepEqual(accepted.evidence.slice(0,3).map(item=>item.id),['S01','S02','S03']);
  const first=accepted.evidence[0];
  assert.equal(first.title.length,420);
  assert.equal(first.summary.length,650);
  assert.equal(first.url.length,1200);
  assert.equal(first.source_count,1);
  assert.equal(first.atlas_match_score,100);
  assert.equal(first.additional_sources.length,4);
  assert.ok(!('injected' in first));
  assert.equal(first.database_event.id.length,120);
  assert.equal(first.database_event.source_count,1);
  assert.deepEqual(accepted.languages_searched,[{code:'en',name:'English',query_count:7,article_count:0,successful_queries:0,
    google_news_articles:0,gdelt_articles:0,acled_articles:0,bing_articles:0,priority:false}]);
  assert.deepEqual(accepted.priority_languages,['en']);
  assert.equal(accepted.retrieval.articles_retrieved,0);
  assert.equal(accepted.retrieval.matched_to_atlas,3);
  assert.equal(accepted.retrieval.ct_atlas_corpus_available,false);
  assert.equal(accepted.search_queries.length,80);
  assert.equal(accepted.search_queries[0].ok,false);
  assert.equal(accepted.database_version.length,100);
  assert.equal(accepted.database_evidence_count,48);
  assert.equal(w.context.acceptDeepSearchAssembly({evidence:'none'}),null);
});

test('the report step writes from the cleaned assembly, caches it for its analyst and closes the permit',async()=>{
  const w=worker();
  const {raw}=await assembly(w);
  const period={mode:'relative',start:new Date(Date.now()-30*86400000).toISOString(),end:new Date().toISOString(),label:'Last 30 days'};
  const response=await w.context.handleDeepSearch(request({step:'report',permit_id:'permit-1',log_id:'log-1',
    interpreted_request:'Recent attacks in Somalia',detected_period:period,assembly:plain(raw)}),{},ctx);
  assert.equal(response.status,200);
  const report=await response.json();
  assert.equal(report.title,'Assessment');
  assert.equal(report.cached,false);
  assert.equal(report.evidence.length,raw.evidence.length);
  assert.equal(report.retrieval.ct_atlas_database_events,1);
  assert.deepEqual(report.detected_period,period);
  assert.equal(report.grounding.cited_sources,1);
  assert.equal(report.illustration_candidates.length,2);
  const dataset=JSON.parse(w.calls.lastInput.slice(w.calls.lastInput.indexOf('\n\n')+2));
  assert.equal(dataset.evidence.length,raw.evidence.length);
  assert.equal(dataset.interpreted_request,'Recent attacks in Somalia');
  const routes=w.calls.gate.map(call=>call.route);
  assert.deepEqual(routes,['/session-get','/permit-use','/cache-put','/commit-report','/usage-increment','/release']);
  assert.deepEqual(plain(w.calls.gate[1].payload),{permitId:'permit-1',username:'analyst',relay:false});
  assert.match(w.calls.gate.find(call=>call.route==='/cache-put').payload.cacheKey,/^deep:/);

  const expired=worker({gateAnswers:{'/permit-use':{status:409,error:'This Deep Search has expired. Run it again.'}}});
  const late=await expired.context.handleDeepSearch(request({step:'report',permit_id:'old',assembly:plain(raw)}),{},ctx);
  assert.equal(late.status,409);
  assert.equal(expired.calls.model,0);
  const unreadable=worker();
  const bad=await unreadable.context.handleDeepSearch(request({step:'report',permit_id:'permit-1',assembly:{evidence:'none'}}),{},ctx);
  assert.equal(bad.status,400);
  assert.ok(unreadable.calls.gate.some(call=>call.route==='/release'));
});

// ---- the gate's side ----------------------------------------------------------------------
function loadGate(){
  const sharedSource=fs.readFileSync('cloudflare-worker/shared.js','utf8');
  const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8');
  const sharedUrl='data:text/javascript;base64,'+Buffer.from(sharedSource).toString('base64');
  const linked=gateSource.replace('from"./shared.js";','from"'+sharedUrl+'";');
  return import('data:text/javascript;base64,'+Buffer.from(linked).toString('base64'));
}
class MemoryStorage{
  constructor(){this.values=new Map();}
  async get(key){return Array.isArray(key)?new Map(key.filter(k=>this.values.has(k)).map(k=>[k,this.values.get(k)])):this.values.get(key);}
  async put(key,value){if(key&&typeof key==='object'&&!Array.isArray(key)){for(const [k,v] of Object.entries(key))this.values.set(k,v);return;}this.values.set(key,value);}
  async delete(key){this.values.delete(key);}
  async list(){return new Map();}
  async getAlarm(){return null;}
  async setAlarm(){}
}

test('the gate keeps a stepped search alive, counts its relays and refuses anyone else',async()=>{
  const {ReportGate}=await loadGate();
  const storage=new MemoryStorage();
  const gate=new ReportGate({storage},{AUTH_USERS_JSON:JSON.stringify({analyst:'a'.repeat(64),other:'b'.repeat(64)})});
  const call=async(route,body)=>{
    const response=await gate.fetch(new Request('https://gate'+route,{method:'POST',body:JSON.stringify(body)}));
    return {status:response.status,body:await response.json().catch(()=>({}))};
  };
  const deep=await call('/acquire',{username:'analyst',kind:'deep_search',details:{question:'q'}});
  assert.equal(deep.status,200);
  const permitId=deep.body.permit_id;
  assert.equal((await storage.get('active'))[permitId].kind,'deep_search');
  for(let i=1;i<=48;i++){
    const used=await call('/permit-use',{permitId,username:'analyst',relay:true});
    assert.equal(used.status,200,'relay '+i);
  }
  assert.equal((await call('/permit-use',{permitId,username:'analyst',relay:true})).status,429,'relays are capped');
  assert.equal((await call('/permit-use',{permitId,username:'analyst',relay:false})).status,200,'the report step still checks in');
  assert.equal((await call('/permit-use',{permitId,username:'other',relay:true})).status,409,'another analyst cannot use it');

  // Idle for over three minutes: stale, and freed at the next acquire.
  const active=await storage.get('active');
  active[permitId].last_seen=Date.now()-4*60*1000;
  active[permitId].started_at=Date.now()-5*60*1000;
  await storage.put('active',active);
  assert.equal((await call('/permit-use',{permitId,username:'analyst',relay:true})).status,409);

  const report=await call('/acquire',{username:'other',kind:'report_generator',details:{}});
  assert.equal(report.status,200);
  assert.ok(!(permitId in await storage.get('active')),'the stale permit was freed');
  assert.equal((await call('/permit-use',{permitId:report.body.permit_id,username:'other',relay:true})).status,409,
    'a report permit cannot relay searches');
});

test('the page runs the steps with the Worker module, and the site and mirror serve every module it imports',()=>{
  const client=fs.readFileSync('deep-search.js','utf8');
  assert.match(client,/const DEEP_SEARCH_MODULE="\.\/cloudflare-worker\/deep-search\.js\?v=\d{8}";/);
  const run=client.slice(client.indexOf('async function run(){'),client.indexOf('async function copyReport('));
  assert.match(run,/step\(\{\.\.\.base,step:"plan"\},sessionToken\)/);
  assert.match(run,/body:JSON\.stringify\(\{user_id:username,step:"fetch",permit_id:permitId,url:String\(url\)\}\)/);
  assert.match(run,/core\.retrieveNews\(plan,searchWindow,priorityLanguages,relay\)/);
  assert.match(run,/core\.assembleDeepSearch\(\{\.\.\.core\.pageDatabaseEvidence\(db,plan,searchWindow,scope\),plan,priorityLanguages,retrieval,corpus\}\)/);
  assert.match(run,/step\(\{\.\.\.base,step:"report",permit_id:permitId,log_id:logId,/);
  assert.match(fs.readFileSync('usage-auth-fix.js','utf8'),/script\.src="deep-search\.js\?v=20261116";/);
  assert.match(fs.readFileSync('index.html','utf8'),/events: \(\) => loadDatabaseQueryModule\(\)\.then\(loadDatabaseEvents\)/);

  // Every module the page imports, through deep-search.js and the others, is staged and watched.
  const imported=new Set();
  const visit=file=>{
    if(imported.has(file))return;
    imported.add(file);
    for(const match of fs.readFileSync(path.join('cloudflare-worker',file),'utf8').matchAll(/^\s*\}?\s*from\s*"\.\/([^"]+)";/gm))visit(match[1]);
    for(const match of fs.readFileSync(path.join('cloudflare-worker',file),'utf8').matchAll(/^import \{[^}]*\} from "\.\/([^"]+)";/gm))visit(match[1]);
  };
  ['database-query.js','report-selection.js','deep-search.js'].forEach(visit);
  const mirror=fs.readFileSync('tools/deploy_mirror.sh','utf8');
  const staged=mirror.match(/^cp (cloudflare-worker\/[^"]+) "\$STAGING\/cloudflare-worker\/"$/m)[1].split(/\s+/);
  const ui=fs.readFileSync('.github/workflows/deploy-current-ct-atlas-ui.yml','utf8');
  for(const file of imported){
    assert.ok(staged.includes('cloudflare-worker/'+file),`the mirror must stage ${file}`);
    assert.ok(ui.includes(`- "cloudflare-worker/${file}"`),`a change to ${file} must redeploy the site`);
  }
  assert.ok(imported.has('source-preview.js')&&imported.has('shared.js'),'the walk follows nested imports');
});
