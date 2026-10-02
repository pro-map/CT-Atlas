// Report Generator background context: retrieval from the D1 corpus
// (cloudflare-worker/background-corpus.js), the C-id citation support in
// citationMetrics, and the wiring into the /report route and the map's
// report renderer. No network: D1 is a fake binding that records SQL.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// The real "same story" helpers from shared.js (background-corpus.js imports them).
const sharedHelpers=(()=>{
  const source=fs.readFileSync('cloudflare-worker/shared.js','utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,'');
  const c=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
  vm.runInContext(source,c);
  return Object.fromEntries(['normalizeTitle','titleTokens','tokenSimilarity','dateDistanceDays','isSameStory']
    .map(name=>[name,vm.runInContext(name,c)]));
})();

function load(file, extra={}){
  const source=fs.readFileSync(file,'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,'')
    .replace(/^export /gm,'');
  const c=vm.createContext({
    console:{error(){},warn(){},log(){}},
    cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),
    ...sharedHelpers,
    ...extra
  });
  vm.runInContext(source,c);
  // Top-level const bindings are not properties of the vm context object.
  c.constant=name=>vm.runInContext(name,c);
  return c;
}

const corpus=load('cloudflare-worker/background-corpus.js');
const plain=value=>JSON.parse(JSON.stringify(value));

function fakeDb(responder){
  const calls=[];
  return {calls, prepare(sql){
    return {bind(...args){
      return {async all(){ calls.push({sql,args}); return {results:responder(sql,args)}; }};
    }};
  }};
}

const events=[
  {source_id:'S01',incident_id:'inc-a',title:'Pirates hijack dhow off Puntland',country:'Somalia',actor_group:'Somali pirates'},
  {source_id:'S02',incident_id:'inc-b',title:'Al-Shabaab attack in Mogadishu',country:'Somalia',actor_group:'Al-Shabaab'},
  {source_id:'S03',incident_id:'inc-a',title:'Second report',country:'Djibouti',actor_group:'Unknown'},
];
const period={start:new Date('2026-09-01T00:00:00Z'),end:new Date('2026-09-30T00:00:00Z')};

test('no D1 binding means no context, never an error',async()=>{
  assert.deepEqual(plain(await corpus.fetchBackgroundContext({}, {events,...period})),{available:false,items:[]});
});

test('search terms rank countries and actors by frequency and drop unattributed actors',()=>{
  const terms=plain(corpus.backgroundSearchTerms(events));
  assert.deepEqual(terms.countries,['Somalia','Djibouti']);
  assert.deepEqual(terms.actors,['Al-Shabaab','Somali pirates']);
});

test('FTS query quotes every term as a phrase so operators and quotes stay inert',()=>{
  assert.equal(corpus.ftsQuery(['Al-Shabaab','Somalia','Somalia']),'"Al-Shabaab" OR "Somalia"');
  assert.equal(corpus.ftsQuery(['say "NEAR" OR x']),'"say ""NEAR"" OR x"');
  assert.equal(corpus.ftsQuery([]),'');
});

test('related articles and thematic context are queried, mapped and de-duplicated',async()=>{
  const db=fakeDb(sql=>sql.includes("kind = 'related_article'")
    ? [
        {url:'https://garowe/1',kind:'related_article',title:'Garowe: dhow hijacked',summary:'s',source:'Garowe Online',published:'2026-09-20T00:00:00Z',parent_incident_id:'inc-a'},
        {url:'https://dup/1',kind:'related_article',title:'Pirates hijack dhow off Puntland',parent_incident_id:'inc-a'},
      ]
    : [
        {url:'gemini-review:abc',kind:'historical_review',title:'Djibouti and Somalia sign maritime security pact',collected_at:'2026-09-25T00:00:00Z',ai_relevance_reason:'Interstate diplomacy, out of scope.'},
        {url:'https://garowe/1',kind:'rejected_candidate',title:'Duplicate URL'},
      ]);
  const result=plain(await corpus.fetchBackgroundContext({BACKGROUND_DB:db},{events,...period}));

  assert.equal(result.available,true);
  assert.deepEqual(result.items.map(i=>i.context_id),['C01','C02']);
  const [related,review]=result.items;
  assert.equal(related.covers_source_id,'S01');
  assert.equal(related.url,'https://garowe/1');
  assert.equal(review.kind,'historical_review');
  assert.equal(review.url,'','synthetic keys are not links');
  assert.match(review.map_exclusion_reason,/out of scope/);
  assert.equal(review.date,'2026-09-25T00:00:00Z');

  const relatedCall=db.calls.find(c=>c.sql.includes("kind = 'related_article'"));
  assert.deepEqual(relatedCall.args,['inc-a','inc-b']);
  const ftsCall=db.calls.find(c=>c.sql.includes('MATCH'));
  assert.deepEqual(ftsCall.args,['"Somalia" OR "Djibouti" OR "Al-Shabaab" OR "Somali pirates"',period.start.toISOString(),period.end.toISOString()]);
});

test('bound parameters stay under the D1 limit of 100',async()=>{
  const many=Array.from({length:150},(_,i)=>({source_id:`S${i}`,incident_id:`inc-${i}`,title:`t${i}`}));
  const db=fakeDb(()=>[]);
  await corpus.fetchBackgroundContext({BACKGROUND_DB:db},{events:many,...period});
  for(const call of db.calls) assert.ok(call.args.length<=100,`${call.args.length} parameters`);
});

test('context is capped so the prompt cannot balloon',async()=>{
  const rows=Array.from({length:120},(_,i)=>({url:`https://x/${i}`,kind:'rejected_candidate',title:`Item ${i}`}));
  const items=plain(corpus.toContextItems(rows,events));
  assert.equal(items.length,corpus.constant('MAX_CONTEXT_ITEMS'));
  assert.equal(items.length,40);
});

test('the shared "same story" rule gives the verdicts the archive dedup is tested against',()=>{
  const cases=JSON.parse(fs.readFileSync('tests/same_story_cases.json','utf8'));
  for(const c of cases.titles) assert.equal(sharedHelpers.normalizeTitle(c.title),c.normalized,c.title);
  for(const p of cases.pairs){
    assert.equal(sharedHelpers.isSameStory({title:p.a,date:p.a_date},{title:p.b,date:p.b_date}),p.same,`${p.a} / ${p.b}`);
  }
});

test('context keeps one item per story and never repeats an event already in the prompt',()=>{
  const promptEvents=[{source_id:'S01',incident_id:'inc-a',title:'Gunmen kill twelve soldiers in attack on army base near Gao',date:'2026-09-20T08:00:00Z',url:'https://map/lead'}];
  const rows=[
    {url:'https://wire/1',kind:'related_article',title:'Gunmen kill 12 soldiers in attack on army base near Gao, Mali',published:'2026-09-20T09:00:00Z',parent_incident_id:'inc-a'},
    {url:'https://a/hamburg',kind:'rejected_candidate',title:'Police arrest suspect after stabbing in Hamburg station',published:'2026-09-25T10:00:00Z'},
    {url:'https://b/hamburg',kind:'rejected_candidate',title:'Police arrest suspect after stabbing in Hamburg station, officials say',published:'2026-09-25T12:00:00Z'},
    {url:'https://a/munich',kind:'rejected_candidate',title:'Police arrest suspect after stabbing in Munich station',published:'2026-09-25T11:00:00Z'},
  ];
  const items=plain(corpus.toContextItems(rows,promptEvents));
  assert.deepEqual(items.map(i=>i.url),['https://a/hamburg','https://a/munich']);
  assert.deepEqual(items.map(i=>i.context_id),['C01','C02']);
});

test('an archive row repeating an event in its own language is not sent next to it (Report path included)',()=>{
  const promptEvents=[{source_id:'S01',incident_id:'inc-r',title:'18-year-old terrorist found in Saratov region',
    original_title:'В Саратовской области обнаружен 18-летний террорист',date:'2026-09-20T08:00:00Z'}];
  const rows=[{url:'https://ru/1',kind:'related_article',title:'В Саратовской области обнаружен 18-летний террорист',published:'2026-09-20T09:00:00Z',parent_incident_id:'inc-r'}];
  assert.deepEqual(plain(corpus.toContextItems(rows,promptEvents)),[]);
  const route=fs.readFileSync('cloudflare-worker/index.js','utf8');
  assert.match(route,/original_title: cleanText\(current\[index\]\?\.original_title, 280\)/);
  assert.match(route,/fetchBackgroundContext\(env, \{ events: storyEvents,/);
});

test('off-topic reviews (score 0) are never served by any archive search',()=>{
  const source=fs.readFileSync('cloudflare-worker/background-corpus.js','utf8');
  assert.match(source,/const NOT_NOISE = "COALESCE\(ba\.ai_relevance_score, 1\) <> 0";/);
  assert.equal((source.match(/AND \$\{NOT_NOISE\}/g)||[]).length,3,'thematic, Deep Search and Atlas AI queries');
  assert.match(fs.readFileSync('cloudflare-worker/quick-ask.js','utf8'),/searchCorpusForQuestion\(env, \{[\s\S]*?events: matched\s*\}\)/);
});

test('a D1 failure degrades to no context instead of failing the report',async()=>{
  const db={prepare(){ throw new Error('D1_ERROR: no such table'); }};
  assert.deepEqual(plain(await corpus.fetchBackgroundContext({BACKGROUND_DB:db},{events,...period})),{available:false,items:[]});
});

test('Deep Search corpus query requires the anchor and any topic term, and honours exclusions',()=>{
  const plan={anchors:{en:'djibouti'},gdelt_broad_terms:['djibouti','piracy','vessel'],gdelt_exclude_terms:['football']};
  assert.equal(corpus.deepSearchCorpusQuery(plan),'"djibouti" AND ("piracy" OR "vessel") NOT ("football")');
  assert.equal(corpus.deepSearchCorpusQuery({anchors:{en:'sahel'}}),'"sahel"');
  assert.equal(corpus.deepSearchCorpusQuery({gdelt_broad_terms:['heroin','afghanistan']}),'"heroin" OR "afghanistan"');
  assert.equal(corpus.deepSearchCorpusQuery({gdelt_broad_terms:['heroin']}),'','one loose term alone is too broad');
  assert.equal(corpus.deepSearchCorpusQuery({}),'');
});

test('Deep Search corpus rows look like live search rows and keep only real links',async()=>{
  assert.deepEqual(plain(await corpus.searchCorpusForDeepSearch({}, {plan:{anchors:{en:'djibouti'}},...period})),{available:false,rows:[]});

  const db=fakeDb(()=>[
    {url:'https://garowe/1',kind:'related_article',title:'Doorbixi: markab la afduubay',source:'Garowe Online',published:'2026-09-20T08:00:00+00:00',original_language:'so'},
    {url:'https://x/2',kind:'rejected_candidate',title:'Djibouti hosts naval talks',source:'AFP',published:null,collected_at:'2026-09-21T00:00:00+00:00',original_language:'fr'},
  ]);
  const result=plain(await corpus.searchCorpusForDeepSearch({BACKGROUND_DB:db},{
    plan:{anchors:{en:'djibouti'},gdelt_broad_terms:['piracy']},...period,searchQuery:'Djibouti maritime incidents'
  }));
  assert.equal(result.available,true);
  const [related,rejected]=result.rows;
  assert.equal(related.search_engine,'ct_atlas_corpus');
  assert.equal(related.language,'so','related articles keep their outlet language');
  assert.equal(rejected.language,'en','collector-normalised rows are English');
  assert.equal(rejected.published,'2026-09-21T00:00:00.000Z','falls back to the collection date');
  assert.equal(rejected.corpus_kind,'rejected_candidate');
  assert.equal(rejected.search_query,'Djibouti maritime incidents');
  assert.match(db.calls[0].sql,/ba\.url LIKE 'http%'/);
});

test('Deep Search merges the archive before de-duplication and labels it in the UI',()=>{
  const worker=fs.readFileSync('cloudflare-worker/deep-search.js','utf8');
  assert.match(worker,/import \{ searchCorpusForDeepSearch \} from "\.\/background-corpus\.js"/);
  assert.match(worker,/deduplicateRows\(\[\.\.\.retrieval\.rows, \.\.\.corpus\.rows\]\)/);
  assert.match(worker,/corpus_kind: row\.corpus_kind/);
  assert.match(worker,/"ct_atlas_corpus" come from CT Atlas's own archive/);
  assert.match(worker,/DEEP_SEARCH_VERSION = "deep-search-v11-quota-fallback"/);
  assert.match(fs.readFileSync('deep-search.js','utf8'),/ct_atlas_corpus:"CT ATLAS ARCHIVE"/);
});

const shared=load('cloudflare-worker/shared.js',{crypto:globalThis.crypto,TextEncoder,Intl});

test('citation metrics count C context ids and three-digit S ids',()=>{
  const text=[
    'EXECUTIVE ASSESSMENT',
    'Piracy off Puntland likely reflects renewed capability [S01, C02].',
    'Record one hundred and twenty supports the trend described here [S120].',
    'An invented id should not count toward cited sources here [C99].',
  ].join('\n');
  const metrics=plain(shared.citationMetrics(text,['S01','S120','C02']));
  assert.deepEqual(metrics.cited_source_ids.sort(),['C02','S01','S120']);
  assert.equal(metrics.factual_paragraphs,3);
  assert.equal(metrics.cited_factual_paragraphs,3);
});

test('the report prompt asks for a longer, analytical assessment with context rules',()=>{
  const prompt=shared.constant('SYSTEM_INSTRUCTION');
  assert.match(prompt,/1,000-1,350 words/);
  for(const heading of ['ANALYTICAL INTERPRETATION','STRATEGIC CONTEXT','BACKGROUND CONTEXT RULES']) assert.ok(prompt.includes(heading),heading);
  assert.match(prompt,/Never count context items/);
  assert.match(prompt,/\[S03, C02\]/);
  assert.equal(shared.constant('REPORT_GENERATOR_VERSION'),'report-v9-quota-fallback');
});

test('the /report route feeds background context to Gemini and lists it as sources',()=>{
  const route=fs.readFileSync('cloudflare-worker/index.js','utf8');
  assert.match(route,/import \{ fetchBackgroundContext[^}]*\} from "\.\/background-corpus\.js"/);
  assert.match(route,/background_context: \{/);
  assert.match(route,/contextItems\.map\(item => item\.context_id\)/);
  assert.match(route,/previewCandidates = \[\.\.\.eventSources\]/,'image previews stay limited to map events');
});

test('archive size is read from the one-row corpus_stats summary, never counted per request',async()=>{
  const calls=[];
  const db={prepare(sql){ calls.push(sql); return {async first(){ return {total:11187,by_kind:'{"related_article":4264}',updated_at:'2026-09-30T21:23:26Z'}; }}; }};
  const stats=plain(await corpus.corpusStats({BACKGROUND_DB:db}));
  assert.deepEqual(stats,{available:true,total:11187,by_kind:{related_article:4264},updated_at:'2026-09-30T21:23:26Z'});
  assert.deepEqual(calls,['SELECT total, by_kind, updated_at FROM corpus_stats WHERE id = 1']);
  assert.deepEqual(plain(await corpus.corpusStats({})),{available:false});
  assert.deepEqual(plain(await corpus.corpusStats({BACKGROUND_DB:{prepare(){ throw new Error('no such table'); }}})),{available:false});
  assert.match(fs.readFileSync('cloudflare-worker/index.js','utf8'),/url\.pathname === "\/database-stats"/);
  assert.match(fs.readFileSync('tools/sync_background_corpus.py','utf8'),/collector\.d1_query\(CORPUS_STATS_UPSERT\)/);
});

test('the Worker binds the D1 corpus and reports the binding in /health',()=>{
  const toml=fs.readFileSync('cloudflare-worker/wrangler.toml','utf8');
  assert.match(toml,/\[\[d1_databases\]\]\s*\nbinding = "BACKGROUND_DB"\s*\ndatabase_name = "ct-atlas-background-articles"\s*\ndatabase_id = "7c00bac7-05b6-443c-a305-c2bd9352c857"/);
  assert.match(fs.readFileSync('cloudflare-worker/index.js','utf8'),/background_corpus: typeof env\.BACKGROUND_DB\?\.prepare === "function"/);
});

test('the map renders the new sections, C citations and context source labels',()=>{
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('function reportSectionHtml(');
  const block=html.slice(start,start+2500);
  assert.ok(block.indexOf('"ANALYTICAL INTERPRETATION"')<block.indexOf('"STRATEGIC CONTEXT"'));
  assert.ok(block.indexOf('"STRATEGIC CONTEXT"')<block.indexOf('"OUTLOOK / WATCHPOINTS"'));
  assert.ok(html.includes('/\\[([SC]\\d{2,3}(?:,\\s*[SC]\\d{2,3})*)\\]/g'));
  assert.ok(html.includes('"Background · outside map scope"'));
});
