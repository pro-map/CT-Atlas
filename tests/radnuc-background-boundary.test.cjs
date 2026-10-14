// Archive-only RadNuc background stays context through live/archive merging,
// Atlas comparison, report counters, illustrations and the evidence renderer.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function source(file){
  return fs.readFileSync(file,'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,'')
    .replace(/^export /gm,'');
}
const shared=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
vm.runInContext(source('cloudflare-worker/shared.js'),shared);
const helpers=Object.fromEntries(['normalizeTitle','tokenSimilarity','dateDistanceDays','isSameStory',
  'parseEventDate','eventUniqueKey','cleanText','isRetiredJudicialEvent'].map(name=>[name,vm.runInContext(name,shared)]));
const plain=value=>JSON.parse(JSON.stringify(value));

function harness(extra={}){
  const context=vm.createContext({...helpers,URL,URLSearchParams,Request,Response,
    console:{log(){},warn(){},error(){}},...extra});
  vm.runInContext(source('cloudflare-worker/deep-search.js'),context);
  return {context,...vm.runInContext('({deduplicateRows,compareWithAtlas,buildEvidence,handleDeepSearch,NOT_ILLUSTRATIONS,REPORT_INSTRUCTION})',context)};
}

const background={title:'Paris conducts nuclear emergency exercise',summary:'An emergency preparedness exercise.',
  source:'Nuclear Safety Authority',url:'https://regulator.test/drill',published:'2026-10-13T07:00:00Z',
  language:'en',search_engine:'ct_atlas_corpus',corpus_kind:'radnuc_background'};

test('a live duplicate cannot erase a RadNuc article\'s deliberate background-only filing',()=>{
  for(const archiveFirst of [false,true]){
    const h=harness();
    const live={...background,search_engine:'google_news'};
    delete live.corpus_kind;
    const rows=h.deduplicateRows(archiveFirst?[background,live]:[live,background]);
    assert.equal(rows.length,1);
    assert.equal(rows[0].corpus_kind,'radnuc_background');
    const [compared]=h.compareWithAtlas(rows,[{id:'same-url',key:'event-key',...live}]);
    assert.equal(compared.atlas_status,'background_only','even an identical map URL cannot recast it as an incident');
    assert.equal(compared.atlas_match_id,'');
    assert.equal(compared.atlas_match_key,'');
    assert.equal(compared.atlas_match_score,0);
    assert.equal(h.buildEvidence([compared],[])[0].corpus_kind,'radnuc_background');
    assert.ok(h.NOT_ILLUSTRATIONS.has(compared.corpus_kind));
  }
});

test('ordinary CT reporting retains map-match and potential-gap behavior',()=>{
  const h=harness();
  const incident={title:'Police arrest Paris radioactive smuggling terror suspect',
    url:'https://police.test/plot',published:background.published,language:'en',search_engine:'google_news'};
  const [matched,gap]=h.compareWithAtlas([incident,{...incident,url:'https://other.test/case',
    title:'Militants bomb security post in Kabul'}],[{id:'ct-1',key:'ct-key',...incident}]);
  assert.equal(matched.atlas_status,'already_in_atlas');
  assert.equal(matched.atlas_match_id,'ct-1');
  assert.equal(gap.atlas_status,'potential_gap');
});

test('Deep Search uses RadNuc background as evidence without increasing event, gap or map-match counts',async()=>{
  const incident={id:'ct-1',incident_id:'inc-1',title:'Police arrest Paris radioactive smuggling terror suspect',
    category:'Radiological/Nuclear',categories:['Radiological/Nuclear'],primary_event_type:'ARREST',
    url:'https://police.test/plot',published:background.published,source:'Police',country:'France'};
  let modelCalls=0,modelEvidence;
  const h=harness({
    normalizeUsername:v=>v,isAllowedUser:()=>true,
    parseDatabaseFilters:()=>({region:'ALL',topic:'Radiological/Nuclear',actorGroup:'ALL'}),
    databaseFiltersLabel:()=> 'Radiological/Nuclear',hasActiveDatabaseFilters:()=>true,
    matchesDatabaseFilters:()=>true,priority:()=>1,sha256:async()=> 'test-cache-key',
    jsonResponse:(body,status=200)=>new Response(JSON.stringify(body),{status}),
    gateCall:async(env,path)=>new Response(JSON.stringify(path==='/session-get'?{username:'analyst'}:
      path==='/acquire'?{permit_id:'permit'}:path==='/cache-get'?{hit:false}:{ok:true})),
    fetchEventsDatabase:async()=>({ok:true,db:{events:[incident]}}),
    searchCorpusForDeepSearch:async()=>({available:true,rows:[background]}),
    illustrationCandidates:items=>items.map(item=>({id:item.id,url:item.url})),
    fixturePlan:{queries:[{language:'en',variant:'primary',query:'Paris nuclear safety',anchor:'Paris'}],
      anchors:{en:'Paris'},priority_languages:[],detected_period:{mode:'relative',days:30}},
    fixtureRetrieval:{rows:[{...background,corpus_kind:undefined,search_engine:'google_news'},
      {...incident,language:'en',search_engine:'google_news'}],waves:[],subrequest_budget:{search_requests:0}},
    modelStub:async(env,instruction,input)=>{
      modelCalls++;
      if(modelCalls===1)return {};
      modelEvidence=JSON.parse(input.slice(input.indexOf('\n\n')+2)).evidence;
      return {title:'Paris nuclear situational context',analysis:'A terrorism investigation is separate from routine preparedness [S01, S02].'};
    }
  });
  vm.runInContext('sanitizePlan = () => fixturePlan; retrieveNews = async () => fixtureRetrieval; callGeminiJson = modelStub;',h.context);
  const response=await h.handleDeepSearch(new Request('https://atlas.test/deep-search',{
    method:'POST',headers:{'X-Session-Token':'session','Content-Type':'application/json'},
    body:JSON.stringify({user_id:'analyst',question:'Paris nuclear safety and preparedness'})}),{}, {waitUntil(){}});
  assert.equal(response.status,200);
  const report=await response.json();
  assert.equal(report.evidence.length,2);
  assert.equal(modelEvidence.filter(item=>item.corpus_kind==='radnuc_background').length,1);
  assert.equal(report.retrieval.unique_event_clusters,1);
  assert.equal(report.retrieval.matched_to_atlas,1);
  assert.equal(report.retrieval.potential_atlas_gaps,0);
  assert.equal(report.retrieval.ct_atlas_database_events,1);
  assert.deepEqual(report.illustration_candidates.map(item=>item.url),[incident.url]);
  assert.match(h.REPORT_INSTRUCTION,/never potential CT Atlas gaps/);
});

test('the evidence renderer labels background neutrally instead of as a map match or gap',()=>{
  const client=fs.readFileSync('deep-search.js','utf8');
  const context=vm.createContext({esc:v=>String(v||''),fmtDate:v=>v,engineLabel:v=>v});
  vm.runInContext(client.slice(client.indexOf('function evidenceHtml('),client.indexOf('\nfunction render(',client.indexOf('function evidenceHtml('))),context);
  context.payload={evidence:[{id:'S01',...background,atlas_status:'background_only'}]};
  const html=vm.runInContext('evidenceHtml(payload)',context);
  assert.match(html,/BACKGROUND · ARCHIVE ONLY/);
  assert.doesNotMatch(html,/POTENTIAL ATLAS GAP|MATCHED IN CT ATLAS|deep-gap-badge (?:gap|matched)/);
});
