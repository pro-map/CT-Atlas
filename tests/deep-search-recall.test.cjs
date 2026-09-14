const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8').replace(/^import[\s\S]*?from "\.\/shared.js";\s*/,'').replace(/export /g,'');
function harness(fetch){
 const c=vm.createContext({fetch,URL,URLSearchParams,AbortSignal,setTimeout:fn=>fn(),cleanText:(v,n)=>String(v||'').trim().slice(0,n),parseEventDate:(event)=>{for(const key of ['event_date','occurrence_date','occurred_at','incident_date','attack_date','published_at','publication_date','published','pub_date','date','updated_at']){if(!event?.[key])continue;const d=new Date(event[key]);if(!Number.isNaN(d.getTime()))return d;}return null}});
 vm.runInContext(source,c);
 return vm.runInContext('({sanitizePlan,retrieveNews,resolvePriorityLanguages,buildEvidence,fetchNewsWave,fetchGdeltGlobalWave,fetchGdeltChunked,gdeltChunkRanges,splitGdeltRowsByLanguage,broadGdeltQuery,computeLanguageAnchors,filterByAnchor,DEEP_SEARCH_LANGUAGE_CODES,resolveSearchWindow,windowSpanDays,GDELT_ARCHIVE_START,fetchAcledWave,fetchBingWave,parseBingRss,extractBingRealUrl,isLikelyTransientFetchIssue})',c);
}
function plan(h){return h.sanitizePlan({priority_languages:['fa','ps','ur','invalid'],queries:Object.fromEntries(h.DEEP_SEARCH_LANGUAGE_CODES.map(l=>[l,{primary:`${l} Afghanistan opium`,secondary:`${l} Afghanistan heroin`}]))},'Afghanistan drugs');}
// Test-only helper: builds the same {startDt,endDt} shape resolveSearchWindow()
// produces for a "relative" window, since retrieveNews/fetchNewsWave/
// fetchAcledWave/fetchGdeltGlobalWave now take an explicit window/range object
// instead of a bare periodDays number.
function windowFor(days,now=new Date()){
 return {startDt:new Date(now.getTime()-days*86400000),endDt:now};
}
test('Afghanistan narcotics prioritises English, French, Dari, Pashto and Urdu',()=>{
 const h=harness();assert.deepEqual(Array.from(h.resolvePriorityLanguages('Afghanistan drug trafficking',[])),['en','fr','fa','ps','ur']);
 assert.deepEqual(Array.from(plan(h).priority_languages),['fa','ps','ur']);
});
test('English and French are always prioritised even without a detected country',()=>{
 const h=harness();assert.deepEqual(Array.from(h.resolvePriorityLanguages('What is the current threat level?',[])),['en','fr']);
});
test('Egypt questions prioritise Arabic alongside English and French',()=>{
 const h=harness();assert.deepEqual(Array.from(h.resolvePriorityLanguages('Recent extremist activity in Egypt',[])),['en','fr','ar']);
});
test('sparse local feeds get native queries through fallback edition within 33 search calls (24 google + 3 google rescue + 3 bing rescue + 2 chunked GDELT calls [180d > 90d threshold] + 1 ACLED call)',async()=>{
 const calls=[];const h=harness(async url=>{calls.push(new URL(url));return new Response(url.includes('gdelt')?'{}':'<rss><channel></channel></rss>');});
 const result=await h.retrieveNews(plan(h),windowFor(180),['fa','ps','ur']);
 assert.equal(calls.length,33);assert.equal(result.subrequest_budget.search_requests,33);
 assert.equal(calls.filter(u=>u.href.includes('gdelt')).length,2,'a 180-day period is over the 90-day chunk threshold, so GDELT should be queried twice (date-range chunks), never per-language');
 assert.equal(calls.filter(u=>(u.searchParams.get('q')||'').includes('site:acleddata.com')).length,1,'ACLED must be queried exactly once');
 assert.equal(calls.filter(u=>u.href.includes('bing.com')).length,3,'all 3 sparse priority languages should get a Bing rescue');
 const rescue=result.waves.filter(w=>w.query.variant==='priority-locale-rescue');
 assert.deepEqual(Array.from(rescue,w=>w.query.language),['fa','ps','ur']);
 assert.ok(rescue.every(w=>w.query.fallback_locale));
 const bingRescue=result.waves.filter(w=>w.query.engine==='bing');
 assert.deepEqual(Array.from(bingRescue,w=>w.query.language).sort(),['fa','ps','ur']);
 assert.ok(calls[0].searchParams.get('q').startsWith('fa '));
});
test('ACLED is queried once via a Google News query scoped to site:acleddata.com, tagged with search_engine "acled"',async()=>{
 const h=harness(async()=>new Response('<rss><channel><item><title>ACLED raid report</title><link>https://acleddata.com/x</link></item></channel></rss>'));
 const wave=await h.fetchAcledWave('Afghanistan opium cultivation',windowFor(30));
 assert.ok(wave.ok);
 assert.equal(wave.query.engine,'acled');
 assert.equal(wave.rows.length,1);
 assert.equal(wave.rows[0].search_engine,'acled');
 assert.equal(wave.rows[0].language,'en');
});
test('gdeltChunkRanges leaves short spans as a single un-sliced range and slices long ones into contiguous date ranges',()=>{
 const h=harness();
 const now=new Date();
 assert.equal(h.gdeltChunkRanges(windowFor(30,now).startDt,now).length,1,'spans at or under the 90-day threshold must not be chunked');
 assert.equal(h.gdeltChunkRanges(windowFor(90,now).startDt,now).length,1);
 const w365=windowFor(365,now);
 const chunks365=h.gdeltChunkRanges(w365.startDt,w365.endDt);
 assert.equal(chunks365.length,5,'ceil(365/90)=5, at the GDELT_MAX_CHUNKS cap');
 // Contiguous: each chunk's start must equal the previous chunk's end (within rounding).
 for(let i=0;i<chunks365.length-1;i++){
   assert.ok(Math.abs(chunks365[i].startDt.getTime()-chunks365[i+1].endDt.getTime())<2000,
     `chunk ${i} start should meet chunk ${i+1} end`);
 }
 assert.ok(chunks365[0].endDt.getTime()>chunks365[chunks365.length-1].startDt.getTime());
 const w180=windowFor(180,now);
 assert.equal(h.gdeltChunkRanges(w180.startDt,w180.endDt).length,2,'a 180-day span only needs 2 chunks of 90 days each');
 const w730=windowFor(730,now);
 const chunks730=h.gdeltChunkRanges(w730.startDt,w730.endDt);
 assert.equal(chunks730.length,5,'capped at GDELT_MAX_CHUNKS even for a 2-year span');
 assert.ok(chunks730[0].endDt.getTime()>chunks730[chunks730.length-1].startDt.getTime());
 // A "global" span (years wide) must chunk the same way, not error or explode.
 const chunksGlobal=h.gdeltChunkRanges(h.GDELT_ARCHIVE_START,now);
 assert.equal(chunksGlobal.length,5,'a multi-year global span is still capped at GDELT_MAX_CHUNKS');
});
test('fetchGdeltChunked issues one spaced request per chunk and merges rows, ok if any chunk succeeded',async()=>{
 let calls=0;
 const h=harness(async()=>{calls++;return new Response(JSON.stringify({articles:[{title:`Article ${calls}`,url:`https://x/${calls}`,language:'English',domain:'x.com',seendate:'20260101120000Z'}]}));});
 const w=windowFor(365);
 const result=await h.fetchGdeltChunked('terrorism',w.startDt,w.endDt);
 assert.equal(calls,5,'a full year should issue exactly GDELT_MAX_CHUNKS requests');
 assert.equal(result.chunks,5);
 assert.equal(result.ok,true);
 assert.equal(result.rows.length,5,'rows from every chunk must be merged');
});
test('parseBingRss extracts the real article URL from Bing\'s redirect link and the source from News:Source',()=>{
 const h=harness();
 const xml=`<rss><channel><item><title>UN warns terror groups exploiting AI</title>` +
   `<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fexample.com%2fai-terrorism&amp;c=123</link>` +
   `<description>Some summary text here.</description><pubDate>Wed, 01 Jul 2026 06:00:00 GMT</pubDate>` +
   `<News:Source>example.com</News:Source></item></channel></rss>`;
 const rows=h.parseBingRss(xml,'en','artificial intelligence terrorism');
 assert.equal(rows.length,1);
 assert.equal(rows[0].url,'https://example.com/ai-terrorism','must decode the real URL out of the Bing tracking redirect, not keep the bing.com link');
 assert.equal(rows[0].source,'example.com');
 assert.equal(rows[0].search_engine,'bing');
 assert.equal(rows[0].language,'en');
});
test('extractBingRealUrl falls back to the original link when there is no url= param',()=>{
 const h=harness();
 assert.equal(h.extractBingRealUrl('https://example.com/direct-article'),'https://example.com/direct-article');
});
test('fetchBingWave uses the market for the requested language and tags rows with search_engine "bing"',async()=>{
 const h=harness(async url=>{
   assert.ok(url.includes('mkt=fr-FR'),'French should map to the fr-FR Bing market: '+url);
   return new Response('<rss><channel><item><title>Alerte terrorisme IA</title><link>https://example.fr/x</link></item></channel></rss>');
 });
 const wave=await h.fetchBingWave('terrorisme intelligence artificielle','fr');
 assert.ok(wave.ok);
 assert.equal(wave.query.engine,'bing');
 assert.equal(wave.rows[0].search_engine,'bing');
});
test('retrieveNews does not call Bing at all when Google coverage is already sufficient (no cost on a healthy day)',async()=>{
 const goodRss='<rss><channel>'+Array.from({length:5},(_,i)=>`<item><title>Afghanistan real article ${i}</title><link>https://x/${i}</link></item>`).join('')+'</channel></rss>';
 const h=harness(async url=>new Response(url.includes('gdelt')?'{}':goodRss));
 const result=await h.retrieveNews(plan(h),windowFor(30),['fa','ps','ur']);
 const bingWaves=result.waves.filter(w=>w.query.engine==='bing');
 assert.equal(bingWaves.length,0,'Bing must not be called when every priority language already has >=3 results from Google');
});
test('retrieveNews includes exactly one ACLED wave alongside the Google News and GDELT waves',async()=>{
 const h=harness(async url=>new Response(url.includes('gdelt')?'{}':'<rss><channel></channel></rss>'));
 const result=await h.retrieveNews(plan(h),windowFor(30),[]);
 const acledWaves=result.waves.filter(w=>w.query.engine==='acled');
 assert.equal(acledWaves.length,1);
 assert.equal(result.subrequest_budget.acled_requests,1);
});
test('English priority rescue uses a genuinely different locale than its own primary/secondary queries, not a no-op duplicate',async()=>{
 // Regression test for v5.18: SEARCH_FALLBACK_LOCALE (en-US/US/US:en) used
 // to be reused for English's own rescue, but LANGUAGE_LOCALES.en is
 // *already* en-US/US/US:en -- so the "rescue" resent the exact same
 // request and could never surface anything new. English must get a
 // distinct fallback (the UK edition) instead.
 const calls=[];const h=harness(async url=>{calls.push(new URL(url));return new Response(url.includes('gdelt')?'{}':'<rss><channel></channel></rss>');});
 await h.retrieveNews(plan(h),windowFor(30),['en','fr','fa','ps','ur']);
 const englishCalls=calls.filter(u=>(u.searchParams.get('q')||'').toLowerCase().startsWith('en '));
 assert.ok(englishCalls.length>=3,'expected English primary, secondary, and a rescue call');
 const locales=new Set(englishCalls.map(u=>u.searchParams.get('hl')));
 assert.ok(locales.size>1,'English rescue must use a different hl than en-US, otherwise it just resends the identical request: '+[...locales]);
 assert.ok(englishCalls.some(u=>u.searchParams.get('hl')==='en-GB'&&u.searchParams.get('gl')==='GB'));
});
test('five priority languages still stay within the 36-call search budget, well under the 50 subrequest ceiling once the ~9 non-search calls are counted',async()=>{
 const calls=[];const h=harness(async url=>{calls.push(new URL(url));return new Response(url.includes('gdelt')?'{}':'<rss><channel></channel></rss>');});
 const result=await h.retrieveNews(plan(h),windowFor(30),h.resolvePriorityLanguages('Afghanistan drug trafficking',[]));
 assert.equal(calls.length,36);assert.equal(result.subrequest_budget.search_requests,36);
 assert.ok(result.subrequest_budget.search_requests+9<50);
 const rescue=result.waves.filter(w=>w.query.variant==='priority-locale-rescue');
 assert.equal(rescue.length,5);
 assert.equal(calls.filter(u=>u.href.includes('gdelt')).length,1,'a 30-day period is under the chunk threshold, so GDELT stays a single call even with 5 priority languages');
 assert.equal(calls.filter(u=>(u.searchParams.get('q')||'').includes('site:acleddata.com')).length,1,'ACLED must be queried exactly once even with 5 priority languages');
 assert.equal(calls.filter(u=>u.href.includes('bing.com')).length,5,'all 5 sparse priority languages should get a Bing rescue');
});
test('a failing wave is never retried — retries risk blowing the subrequest ceiling on exactly the runs where most waves are failing',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return new Response('rate limited',{status:429});});
 await h.fetchNewsWave({language:'en',query:'q',variant:'primary'},0,windowFor(30),{hl:'en-US',gl:'US',ceid:'US:en'});
 assert.equal(calls,1);
 calls=0;await h.fetchGdeltGlobalWave('q',windowFor(30));
 assert.equal(calls,1);
});
test('GDELT is queried once globally and its mixed-language response is split back into one wave per language',async()=>{
 // Regression test for v5.19: GDELT allows ~1 request per 5 seconds (its own
 // 429 response says so), so it must never be queried more than once per
 // Deep Search. A single global query (no sourcelang filter) is split back
 // into per-language rows using each article's own reported language.
 const h=harness();
 const globalWave={ok:true,status:200,rows:[
   {title:'Afghanistan opium seizure reported',summary:'',source:'x',url:'https://x/1',published:'',language:'en',query_index:-1,query_variant:'gdelt-rescue',search_query:'q',search_engine:'gdelt',fallback_locale:false},
   {title:'Article en arabe',summary:'',source:'x',url:'https://x/2',published:'',language:'ar',query_index:-1,query_variant:'gdelt-rescue',search_query:'q',search_engine:'gdelt',fallback_locale:false},
 ]};
 const waves=h.splitGdeltRowsByLanguage(globalWave,'q',['en','ar','fr']);
 assert.deepEqual(Array.from(waves,w=>w.query.language).sort(),['ar','en','fr']);
 assert.equal(waves.find(w=>w.query.language==='en').rows.length,1);
 assert.equal(waves.find(w=>w.query.language==='ar').rows.length,1);
 assert.equal(waves.find(w=>w.query.language==='fr').rows.length,0);
 assert.ok(waves.every(w=>w.ok===true&&w.status===200),'the shared fetch outcome must be visible on every derived per-language wave');
});
test('GDELT articles in an unrecognized language are dropped, not miscounted',async()=>{
 const json=JSON.stringify({articles:[
   {title:'English piece',url:'https://x/1',language:'English',domain:'x.com',seendate:'20260101120000Z'},
   {title:'Unknown script piece',url:'https://x/2',language:'Klingon',domain:'x.com',seendate:'20260101120000Z'},
 ]});
 const h=harness(async()=>new Response(json));
 const wave=await h.fetchGdeltGlobalWave('q',windowFor(30));
 assert.equal(wave.rows.length,1);
 assert.equal(wave.rows[0].language,'en');
});
test('HTML 200 provider failures remain distinct from empty RSS',async()=>{
 const h=harness(async url=>new Response(url.includes('gdelt')?'{}':'<html>Unavailable</html>'));
 const r=await h.retrieveNews(plan(h),windowFor(7),[]);
 assert.ok(r.waves.filter(w=>!w.query.engine).every(w=>!w.ok&&w.error.includes('non-RSS')));
});
test('missing language plans fail explicitly',()=>{assert.throws(()=>harness().sanitizePlan({queries:{}},''),/every required language/);});
test('GDELT broad query appends planner-supplied exclude terms as -term',()=>{
 const h=harness();
 const gdeltPlan={
   gdelt_broad_terms:['methamphetamine','fentanyl','cartel'],
   gdelt_exclude_terms:['spain','madrid'],
   queries:[
     {language:'en',variant:'primary',query:'Afghanistan opium cultivation ban enforcement decree'},
     {language:'en',variant:'secondary',query:'Afghanistan methamphetamine heroin laboratory seizure trafficking'},
   ]};
 assert.equal(h.broadGdeltQuery(gdeltPlan),'afghanistan (methamphetamine OR fentanyl OR cartel) -spain -madrid');
});
test('computeLanguageAnchors finds the shared geography token per language, in any script',()=>{
 const h=harness();
 const p={queries:[
   {language:'en',variant:'primary',query:'Afghanistan opium cultivation'},
   {language:'en',variant:'secondary',query:'Afghanistan heroin trafficking'},
   {language:'es',variant:'primary',query:'Afganistán cultivo de opio'},
   {language:'es',variant:'secondary',query:'Afganistán tráfico de heroína'},
   {language:'ar',variant:'primary',query:'أفغانستان زراعة الأفيون'},
   {language:'ar',variant:'secondary',query:'أفغانستان تهريب الهيروين'},
   {language:'de',variant:'primary',query:'Drogen Opium Anbau'},
   {language:'de',variant:'secondary',query:'Heroin Schmuggel Labor'},
 ]};
 const anchors=h.computeLanguageAnchors(p);
 assert.equal(anchors.en,'afghanistan');
 assert.equal(anchors.es,'afganistán');
 assert.equal(anchors.ar,'أفغانستان');
 assert.equal(anchors.de,undefined,'no shared token in German queries above: should not guess an anchor');
});
test('computeLanguageAnchors prefers the planner-supplied explicit anchor, fixing the real case where secondary never repeats the geography',()=>{
 const h=harness();
 // This is the exact failure mode found in production: the secondary query
 // is a global/comparative facet that never repeats "Afghanistan", so the
 // old shared-token heuristic found no anchor at all and left English rows
 // completely unfiltered — letting unrelated Nigeria/Mexico/Colombia drug
 // stories into the evidence pack.
 const p={
   anchors:{en:'afghanistan'},
   queries:[
     {language:'en',variant:'primary',query:'Afghanistan opium cultivation ban'},
     {language:'en',variant:'secondary',query:'global methamphetamine production trends emerging hubs'},
   ]};
 const anchors=h.computeLanguageAnchors(p);
 assert.equal(anchors.en,'afghanistan');
 const rows=[
   {language:'en',title:'NDLEA Uncovers Mexican Cartel Links to Ogun, Oyo Meth Labs',summary:''},
   {language:'en',title:'Afghanistan opium ban devastates farmers, UN says',summary:''},
 ];
 assert.deepEqual(h.filterByAnchor(rows,anchors).map(r=>r.title),['Afghanistan opium ban devastates farmers, UN says']);
});
test('sanitizePlan extracts the explicit anchor per language but does not require it',()=>{
 const h=harness();
 const raw={queries:Object.fromEntries(h.DEEP_SEARCH_LANGUAGE_CODES.map(l=>[l,{primary:`${l} p`,secondary:`${l} s`,anchor:l==='en'?'Afghanistan':''}]))};
 const sanitized=h.sanitizePlan(raw,'q');
 assert.equal(sanitized.anchors.en,'afghanistan');
 assert.equal(sanitized.anchors.fr,undefined);
});
test('filterByAnchor drops off-topic articles but is lenient when a language has no anchor',()=>{
 const h=harness();
 const anchors={es:'afganistán'};
 const rows=[
   {language:'es',title:'Detenido con heroína en Huelva',summary:'sin relación con el país solicitado'},
   {language:'es',title:'Afganistán: incautan heroína en ruta hacia Europa',summary:''},
   {language:'de',title:'Beliebiger Artikel ohne Anker',summary:''},
 ];
 const kept=h.filterByAnchor(rows,anchors);
 assert.deepEqual(kept.map(r=>r.title),['Afganistán: incautan heroína en ruta hacia Europa','Beliebiger Artikel ohne Anker']);
});
test('retrieveNews filters out an off-topic article for a language with a confident anchor',async()=>{
 const onTopicRss='<rss><channel><item><title>Afghanistan opium seizure reported</title><link>https://x/1</link></item></channel></rss>';
 const offTopicRss='<rss><channel><item><title>Domestic heroin bust unrelated to the requested country</title><link>https://x/2</link></item><item><title>Afganistán: incautan opio en la frontera</title><link>https://x/3</link></item></channel></rss>';
 const h=harness(async url=>new Response(url.includes('gdelt')?'{}':(url.includes('hl=es')?offTopicRss:onTopicRss)));
 const p=h.sanitizePlan({queries:Object.fromEntries(h.DEEP_SEARCH_LANGUAGE_CODES.map(l=>[l,{primary:`${l==='es'?'Afganistán':'Afghanistan'} opium cultivation`,secondary:`${l==='es'?'Afganistán':'Afghanistan'} heroin trafficking`}]))},'Afghanistan drugs');
 const result=await h.retrieveNews(p,windowFor(30),[]);
 // Both the primary and secondary "es" queries hit the same mocked feed, so
 // the off-topic item must be dropped from each of those two waves.
 const esRows=result.waves.filter(w=>w.query.language==='es').flatMap(w=>w.rows);
 assert.equal(esRows.length,2);
 assert.ok(esRows.every(r=>r.title==='Afganistán: incautan opio en la frontera'));
});
test('GDELT broad query uses the planner-supplied gdelt_broad_terms when available, ignoring the static heuristic',()=>{
 const h=harness();
 const gdeltPlan={
   gdelt_broad_terms:['methamphetamine','fentanyl','cartel'],
   queries:[
     {language:'en',variant:'primary',query:'Afghanistan opium cultivation ban enforcement decree'},
     {language:'en',variant:'secondary',query:'Afghanistan methamphetamine heroin laboratory seizure trafficking'},
   ]};
 assert.equal(h.broadGdeltQuery(gdeltPlan),'afghanistan (methamphetamine OR fentanyl OR cartel)');
});
test('GDELT broad query falls back to the heuristic when the planner gives too few broad terms',()=>{
 const h=harness();
 const gdeltPlan={
   gdelt_broad_terms:['opium'],
   queries:[
     {language:'en',variant:'primary',query:'Afghanistan opium cultivation ban enforcement decree'},
     {language:'en',variant:'secondary',query:'Afghanistan methamphetamine heroin laboratory seizure trafficking'},
   ]};
 const q=h.broadGdeltQuery(gdeltPlan);
 assert.ok(q.startsWith('afghanistan ('),q);
 assert.ok(!/\bban\b/.test(q)&&!/\benforcement\b/.test(q),'should still use the deprioritised heuristic, not the raw single AI term: '+q);
});
test('GDELT broad query prefers specific topic nouns from both primary and secondary over generic administrative words',()=>{
 const h=harness();
 const gdeltPlan={queries:[
   {language:'en',variant:'primary',query:'Afghanistan opium cultivation ban enforcement decree'},
   {language:'en',variant:'secondary',query:'Afghanistan methamphetamine heroin laboratory seizure trafficking'},
 ]};
 const q=h.broadGdeltQuery(gdeltPlan);
 assert.ok(q.startsWith('afghanistan ('),q);
 assert.ok(q.includes('methamphetamine')||q.includes('heroin'),'secondary-only drug nouns must not be crowded out: '+q);
 assert.ok(!q.includes(' ban ')&&!q.includes('(ban')&&!/\bban\b/.test(q),'generic "ban" should be deprioritised out of the top 4: '+q);
 assert.ok(!/\benforcement\b/.test(q),'generic "enforcement" should be deprioritised out of the top 4: '+q);
});
test('buildEvidence guarantees English at least a third of the final evidence even when another language ranks higher throughout',()=>{
 const h=harness();
 const arabicRow=(n)=>({title:`Ministry of Interior attack report ${n}`,summary:'attack operation',source:'Ministry of Interior',url:`https://x/ar${n}`,published:new Date().toISOString(),language:'ar',search_query:'attack',sources:[{},{},{}]});
 const englishRow=(n)=>({title:`Old blog post ${n}`,summary:'unrelated commentary',source:'Random Blog',url:`https://x/en${n}`,published:new Date(Date.now()-90*86400000).toISOString(),language:'en',search_query:'attack',sources:[{}]});
 const rows=[...Array.from({length:7},(_,i)=>arabicRow(i)),...Array.from({length:5},(_,i)=>englishRow(i))];
 const evidence=h.buildEvidence(rows,['en']);
 assert.equal(evidence.length,12);
 const englishCount=evidence.filter(e=>e.language==='en').length;
 assert.ok(englishCount>=Math.ceil(12/3),`expected at least 4 English items even though Arabic ranks higher throughout, got ${englishCount}`);
});
test('buildEvidence never fabricates English items beyond what was actually retrieved',()=>{
 const h=harness();
 const rows=[{title:'Only Arabic item',summary:'x',source:'x',url:'https://x/1',published:new Date().toISOString(),language:'ar',search_query:'x',sources:[{}]}];
 const evidence=h.buildEvidence(rows,['en']);
 assert.equal(evidence.length,1);
 assert.equal(evidence.filter(e=>e.language==='en').length,0);
});
test('resolveSearchWindow: "global" mode searches from the GDELT archive floor to now',()=>{
 // There is no period dropdown any more -- when the planner detects no time
 // cue in the question at all, it must return mode "global" so the search
 // covers the full available depth, not just a recent slice.
 const h=harness();
 const now=new Date('2026-06-15T12:00:00Z');
 const plan={detected_period:{mode:'global',explanation:'Global search across all available history'}};
 const w=h.resolveSearchWindow(plan,now);
 assert.equal(w.mode,'global');
 assert.equal(w.startDt.getTime(),h.GDELT_ARCHIVE_START.getTime());
 assert.equal(w.endDt.getTime(),now.getTime());
 assert.equal(w.label,'Global search across all available history');
});
test('resolveSearchWindow: "relative" mode turns a duration into a window ending now',()=>{
 const h=harness();
 const now=new Date('2026-06-15T12:00:00Z');
 const plan={detected_period:{mode:'relative',relative_days:90,explanation:'Last 90 days'}};
 const w=h.resolveSearchWindow(plan,now);
 assert.equal(w.mode,'relative');
 assert.equal(h.windowSpanDays(w),90);
 assert.equal(w.endDt.getTime(),now.getTime());
});
test('resolveSearchWindow: "absolute" mode uses the planner\'s exact past dates, not "now minus N days"',()=>{
 // Regression scenario for the real ask: "what happened in Syria in 2019"
 // must search 2019 itself, not the last N days from today.
 const h=harness();
 const now=new Date('2026-06-15T12:00:00Z');
 const plan={detected_period:{mode:'absolute',start_date:'2019-01-01',end_date:'2019-12-31',explanation:'January to December 2019'}};
 const w=h.resolveSearchWindow(plan,now);
 assert.equal(w.mode,'absolute');
 assert.equal(w.startDt.toISOString().slice(0,10),'2019-01-01');
 assert.equal(w.endDt.toISOString().slice(0,10),'2019-12-31');
});
test('resolveSearchWindow: "absolute" mode clamps an end date in the future to now',()=>{
 const h=harness();
 const now=new Date('2026-06-15T12:00:00Z');
 const plan={detected_period:{mode:'absolute',start_date:'2026-01-01',end_date:'2099-01-01',explanation:'Since January 2026'}};
 const w=h.resolveSearchWindow(plan,now);
 assert.equal(w.endDt.getTime(),now.getTime(),'an end date beyond now must clamp to now, never search the future');
});
test('resolveSearchWindow falls back to a bounded relative default when detected_period is missing or malformed, instead of crashing or defaulting to an unbounded search',()=>{
 const h=harness();
 const now=new Date('2026-06-15T12:00:00Z');
 assert.equal(h.windowSpanDays(h.resolveSearchWindow({},now)),90,'no detected_period at all');
 assert.equal(h.windowSpanDays(h.resolveSearchWindow({detected_period:{mode:'absolute',start_date:'not-a-date',explanation:''}},now)),90,'unparsable absolute start_date must fall back, not throw');
 assert.equal(h.windowSpanDays(h.resolveSearchWindow({detected_period:{mode:'nonsense'}},now)),90,'an unrecognised mode must fall back to the relative default');
});
test('isLikelyTransientFetchIssue flags a zero-result report only when every single wave failed',()=>{
 // Regression test for a real report: "AI in terrorism" over 1 year came
 // back with 0 results because every one of 35 search waves got a 503
 // (Google News) or 429 (GDELT) from Cloudflare's shared egress IPs -- a
 // transient infrastructure condition, not evidence that no coverage
 // exists. Confirmed live: the same Google News query succeeded (HTTP 200)
 // from a non-Cloudflare IP at the same time.
 const h=harness();
 const allFailed=[{ok:false},{ok:false},{ok:false}];
 assert.equal(h.isLikelyTransientFetchIssue(allFailed),true);
 const someSucceeded=[{ok:false},{ok:true},{ok:false}];
 assert.equal(h.isLikelyTransientFetchIssue(someSucceeded),false,'even one successful wave means this is a real (if sparse) search, not a wholesale outage');
 assert.equal(h.isLikelyTransientFetchIssue([]),false,'no waves at all is a different failure mode (e.g. planner error), not a fetch outage');
});
test('pdfDisplayUrl truncates long URLs so the PDF never renders a 200+ char unbroken string',()=>{
 const js=fs.readFileSync('deep-search.js','utf8');
 const fn=js.slice(js.indexOf('function pdfDisplayUrl'),js.indexOf('\nasync function downloadPdf'));
 const c=vm.createContext({});
 vm.runInContext(fn,c);
 const longUrl='https://news.google.com/rss/articles/'+'A'.repeat(250)+'?oc=5';
 const result=vm.runInContext('pdfDisplayUrl',c)(longUrl);
 assert.ok(result.length<=101,'expected truncation to ~100 chars, got '+result.length);
 assert.ok(result.endsWith('…'));
 assert.ok(longUrl.startsWith(result.slice(0,-1)));
 const shortUrl='https://example.com/short';
 assert.equal(vm.runInContext('pdfDisplayUrl',c)(shortUrl),shortUrl);
});
test('long PDF export renders bounded canvases and advances to the final page',async()=>{
 const js=fs.readFileSync('deep-search.js','utf8');
 const fn=js.slice(js.indexOf('async function savePagedPdf'),js.indexOf('\nfunction pdfSafeName'));
 const captures=[];let images=0,saved=false;
 const c=vm.createContext({window:{jspdf:{jsPDF:class{addPage(){}addImage(){images++}save(){saved=true}}},html2canvas:async(s,o)=>{captures.push(o);return {width:1560,height:o.height*2,toDataURL:()=>''}}}});
 vm.runInContext(fn,c);
 await c.savePagedPdf({offsetWidth:780,scrollHeight:45000,getBoundingClientRect:()=>({top:0}),querySelectorAll:()=>[]},'test.pdf');
 assert.ok(saved);assert.ok(images>35);assert.ok(captures.every(o=>o.height<=1130));
 assert.equal(captures.at(-1).y+captures.at(-1).height,45000);
});
