// Offline Custom Intelligence Chinese coverage; no live model/source requests.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
  .replace(/export /g,'');
const shared=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
vm.runInContext(fs.readFileSync('cloudflare-worker/shared.js','utf8')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
  .replace(/export\s*\{[\s\S]*?\};?\s*$/,''),shared);
const helpers=Object.fromEntries(['normalizeTitle','tokenSimilarity','dateDistanceDays','isSameStory']
  .map(name=>[name,vm.runInContext(name,shared)]));
function harness(fetch){
  const context=vm.createContext({...helpers,fetch,URL,URLSearchParams,AbortSignal,
    setTimeout:fn=>fn(),cleanText:(v,n)=>String(v||'').trim().slice(0,n)});
  vm.runInContext(source,context);
  return vm.runInContext('({LANGUAGE_LOCALES,DEEP_SEARCH_LANGUAGE_CODES,DEEP_SEARCH_MAX_QUERIES,DEEP_SEARCH_VERSION,PLAN_SCHEMA,PLAN_INSTRUCTION,sanitizePlan,resolvePriorityLanguages,googleNewsUrl,bingNewsUrl,parseGdeltArticles,splitGdeltRowsByLanguage,filterByAnchor,computeLanguageAnchors,deduplicateRows,buildEvidence,languageDiagnostics,retrieveNews})',context);
}
function rawPlan(h){
  const queries=Object.fromEntries(h.DEEP_SEARCH_LANGUAGE_CODES.map(code=>[code,{
    primary:'Afghanistan security',secondary:'Afghanistan arrests',anchor:'Afghanistan'}]));
  queries.zh={primary:'伊朗 安全 调查',secondary:'伊朗 逮捕 案件',anchor:'伊朗'};
  queries['zh-Hant']={primary:'伊朗 安全 調查',secondary:'伊朗 逮捕 案件',anchor:'伊朗'};
  return {queries};
}
const window={startDt:new Date('2025-10-12T00:00:00Z'),endDt:new Date('2026-10-12T00:00:00Z')};
test('all existing languages plus both Chinese scripts require 28 searches',()=>{
  const h=harness();
  assert.deepEqual(Array.from(h.DEEP_SEARCH_LANGUAGE_CODES),['en','fr','ar','de','es','it','tr','ru','fa','ur','he','ps','zh','zh-Hant']);
  assert.equal(h.DEEP_SEARCH_MAX_QUERIES,2*h.DEEP_SEARCH_LANGUAGE_CODES.length);
  for(const code of ['zh','zh-Hant']){
    assert.ok(h.PLAN_SCHEMA.properties.queries.required.includes(code));
    assert.deepEqual(Array.from(h.PLAN_SCHEMA.properties.queries.properties[code].required),['primary','secondary','anchor']);
  }
});
test('the planner preserves both native query pairs, including the last Traditional pair',()=>{
  const h=harness(),plan=h.sanitizePlan(rawPlan(h),'Iran');
  assert.equal(plan.queries.length,28);
  assert.equal(plan.queries[24].query,'伊朗 安全 调查');
  assert.equal(plan.queries[26].query,'伊朗 安全 調查');
  assert.equal(plan.queries[27].language,'zh-Hant');
});
test('missing Chinese is an explicit planning error, never an English substitute',()=>{
  const h=harness();
  for(const code of ['zh','zh-Hant']){
    const raw=rawPlan(h);delete raw.queries[code];
    assert.throws(()=>h.sanitizePlan(raw,'Iran'),/every required language/);
  }
});
test('Chinese searches use separate Simplified and Traditional Google editions',()=>{
  const h=harness();
  for(const [code,hl,gl,ceid] of [['zh','zh-CN','CN','CN:zh-Hans'],['zh-Hant','zh-TW','TW','TW:zh-Hant']]){
    const url=new URL(h.googleNewsUrl('伊朗 安全',h.LANGUAGE_LOCALES[code],window));
    assert.equal(url.searchParams.get('hl'),hl);assert.equal(url.searchParams.get('gl'),gl);
    assert.equal(url.searchParams.get('ceid'),ceid);assert.ok(url.searchParams.get('q').startsWith('伊朗 安全'));
  }
});
test('Bing fallback preserves Chinese markets without changing the query script',()=>{
  const h=harness();
  assert.equal(new URL(h.bingNewsUrl('调查','zh')).searchParams.get('mkt'),'zh-CN');
  assert.equal(new URL(h.bingNewsUrl('調查','zh-Hant')).searchParams.get('mkt'),'zh-TW');
});
test('Chinese country and script priorities supplement English/French',()=>{
  const h=harness();
  assert.deepEqual(Array.from(h.resolvePriorityLanguages('China security',[])),['en','fr','zh','zh-Hant']);
  assert.deepEqual(Array.from(h.resolvePriorityLanguages('Taiwan security',[])),['en','fr','zh-Hant','zh']);
  assert.ok(h.resolvePriorityLanguages('中國安全',[]).includes('zh'));
  assert.ok(h.resolvePriorityLanguages('臺灣安全',[]).includes('zh-Hant'));
  assert.deepEqual(Array.from(h.resolvePriorityLanguages('Afghanistan security',[])),['en','fr','fa','ps','ur']);
});
test('two-character Chinese anchors remain active and reject unrelated stories',()=>{
  const h=harness(),plan=h.sanitizePlan(rawPlan(h),'Iran');
  const anchors=h.computeLanguageAnchors(plan);
  assert.equal(anchors.zh,'伊朗');assert.equal(anchors['zh-Hant'],'伊朗');
  const rows=h.filterByAnchor([{language:'zh',title:'伊朗安全调查'},{language:'zh',title:'其他地方的调查'},
    {language:'zh-Hant',title:'伊朗安全調查'}],anchors);
  assert.equal(rows.length,2);
});
test('GDELT generic Chinese is accepted once without inventing its script or incident country',()=>{
  const h=harness();
  const rows=h.parseGdeltArticles({articles:[{title:'伊朗安全调查',url:'https://example.test/a',language:'Chinese',sourcecountry:'China',seendate:'20261011000000Z'}]},'Iran');
  assert.equal(rows.length,1);assert.equal(rows[0].language,'zh');assert.equal(rows[0].language_script,'unspecified');
  assert.equal(rows[0].country,undefined);
  const waves=h.splitGdeltRowsByLanguage({rows,ok:true,status:200},'Iran',['en','fr','ar','fa','ur']);
  assert.equal(waves.find(w=>w.query.language==='zh').rows.length,1);
  assert.equal(waves.flatMap(w=>w.rows).length,1);
  const evidence=h.buildEvidence([{...rows[0],sources:[{}]}]);
  assert.equal(evidence[0].language_script,'unspecified');
});
test('Traditional GDELT attribution requires an explicit provider language label',()=>{
  const h=harness();
  const rows=h.parseGdeltArticles({articles:[{title:'伊朗安全調查',url:'https://example.test/b',language:'Chinese (Traditional)'}]},'Iran');
  assert.equal(rows[0].language,'zh-Hant');
});
test('distinct Chinese headlines are not collapsed into an empty Latin title',()=>{
  const h=harness();
  const rows=h.deduplicateRows([{title:'伊朗安全调查',url:'https://example.test/a',language:'zh'},
    {title:'海盗劫持船只',url:'https://example.test/b',language:'zh'}]);
  assert.equal(rows.length,2);
});
test('both Chinese scripts appear in evidence and honest language diagnostics',()=>{
  const h=harness(),plan=h.sanitizePlan(rawPlan(h),'Iran');
  const waves=['zh','zh-Hant'].map(code=>({query:{language:code},ok:true,rows:[{
    title:code==='zh'?'伊朗安全调查':'伊朗安全調查',language:code,url:'https://example.test/'+code,search_engine:'google_news'}]}));
  const diagnostics=h.languageDiagnostics(plan,{waves});
  assert.equal(diagnostics.length,14);
  for(const code of ['zh','zh-Hant']){
    const d=diagnostics.find(d=>d.code===code);assert.equal(d.article_count,1);assert.equal(d.successful_queries,1);
  }
  assert.equal(diagnostics.find(d=>d.code==='en').successful_queries,0);
  assert.equal(h.buildEvidence(waves.flatMap(w=>w.rows),[]).length,2);
});
test('a sparse long-period search retains all 28 base queries and five GDELT chunks within 40 requests',async()=>{
  const calls=[],h=harness(async url=>{calls.push(new URL(url));return new Response(url.includes('gdelt')?'{}':'<rss><channel></channel></rss>');});
  const plan=h.sanitizePlan(rawPlan(h),'Iran');
  const result=await h.retrieveNews(plan,window,['en','fr','zh','zh-Hant','fa']);
  assert.equal(calls.length,40);assert.equal(result.subrequest_budget.max_search_requests,40);
  assert.equal(result.subrequest_budget.gdelt_requests,5);assert.equal(result.subrequest_budget.bing_requests,1);
  for(const code of ['zh','zh-Hant'])assert.equal(result.waves.filter(w=>w.query.language===code&&['primary','secondary'].includes(w.query.variant)).length,2);
});
test('the cache version changes and the interface names both scripts with English report output',()=>{
  const h=harness(),front=fs.readFileSync('deep-search.js','utf8');
  assert.equal(h.DEEP_SEARCH_VERSION,'deep-search-v17-radnuc-background');
  assert.match(h.PLAN_INSTRUCTION,/28 planned queries/);
  assert.match(front,/14 supported language\/script options/);
  assert.match(front,/Chinese \(Simplified\)/);assert.match(front,/Chinese \(Traditional\)/);
  assert.match(front,/Reports remain in English/);
});
