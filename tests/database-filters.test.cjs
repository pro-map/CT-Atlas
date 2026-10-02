// The Database panel's filters (place, category, group, period) as the Worker
// applies them for the Report Generator, Atlas AI and Deep Search, and the
// "database first" evidence order of Deep Search. No network.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const strip=source=>source
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'')
  .replace(/export\s*\{[\s\S]*?\};?\s*$/,'')
  .replace(/^export /gm,'');

const shared=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
const plain=value=>JSON.parse(JSON.stringify(value));

function deepSearchContext(){
  const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8');
  const block=source.match(/^import\s*\{([\s\S]*?)\}\s*from\s*"\.\/shared.js"/m)[1];
  const names=block.split(',').map(s=>s.trim()).filter(Boolean);
  const injected=Object.fromEntries(names.map(n=>[n,vm.runInContext(`typeof ${n}==='undefined'?undefined:${n}`,shared)]));
  const c=vm.createContext({...injected,fetch:async()=>({}),URL,URLSearchParams,AbortSignal,setTimeout:fn=>fn(),console});
  vm.runInContext(strip(source),c);
  return c;
}

const event=(id,fields)=>({id,title:`Event ${id}`,summary:'',published:'2026-09-28T10:00:00Z',...fields});

test('topics match the map aliases: Maritime Security is piracy, legacy digital categories are Online / Cyber / AI',()=>{
  assert.equal(shared.matchesTopic(event('a',{category:'Maritime Piracy'}),'Maritime Security'),true);
  assert.equal(shared.matchesTopic(event('a',{category:'Maritime Piracy'}),'Maritime Piracy'),true);
  assert.equal(shared.matchesTopic(event('b',{categories:['Online Radicalization / Cyberterrorism']}),'Online / Cyber / AI'),true);
  assert.equal(shared.matchesTopic(event('c',{category:'Arrests'}),'Attacks'),false);
  assert.equal(shared.matchesTopic(event('c',{category:'Arrests'}),'ALL'),true);
});

test('groups match case-insensitively and events without a group form their own bucket',()=>{
  assert.equal(shared.matchesGroup(event('a',{actor_group:'Al-Shabaab'}),'al-shabaab'),true);
  assert.equal(shared.matchesGroup(event('a',{actor_group:'Al-Shabaab'}),'ISIS'),false);
  assert.equal(shared.matchesGroup(event('b',{}),shared.eventActorGroup({})),true);
  assert.equal(shared.matchesGroup(event('b',{}),'ALL'),true);
});

test('the Report Generator and Atlas AI accept a 24-hour period, and unknown periods mean no period filter',()=>{
  assert.equal(shared.parseDatabaseFilters({period_days:1}).periodDays,1);
  assert.equal(shared.parseDatabaseFilters({period_days:45}).periodDays,null);
  assert.deepEqual(plain(shared.parseDatabaseFilters({})),{region:'GLOBAL',topic:'ALL',actorGroup:'ALL',periodDays:null});
  assert.equal(shared.hasActiveDatabaseFilters(shared.parseDatabaseFilters({})),false);
  assert.equal(shared.hasActiveDatabaseFilters(shared.parseDatabaseFilters({actor_group:'ISIS'})),true);
});

test('database filters combine place, category, group and period',()=>{
  const now=new Date('2026-09-30T12:00:00Z');
  const filters=shared.parseDatabaseFilters({region:'Somalia',topic:'Attacks',actor_group:'Al-Shabaab',period_days:7});
  const hit=event('hit',{country:'Somalia',category:'Attacks',actor_group:'Al-Shabaab',published:'2026-09-29T08:00:00Z'});
  assert.equal(shared.matchesDatabaseFilters(hit,filters,now),true);
  assert.equal(shared.matchesDatabaseFilters({...hit,published:'2026-09-01T08:00:00Z'},filters,now),false,'outside the period');
  assert.equal(shared.matchesDatabaseFilters({...hit,published:'2026-09-01T08:00:00Z'},filters,now,{ignorePeriod:true}),true);
  assert.equal(shared.matchesDatabaseFilters({...hit,country:'Kenya'},filters,now),false);
  assert.equal(shared.databaseFiltersLabel(filters),'Somalia · Attacks · Al-Shabaab · last 7 days');
  assert.equal(shared.databaseFiltersLabel(shared.parseDatabaseFilters({region:'REGION:ASIA_SOUTH_PACIFIC'})),'ASIA SOUTH PACIFIC · all categories · all groups · any date');
});

const window={startDt:new Date('2026-09-01T00:00:00Z'),endDt:new Date('2026-09-30T23:59:59Z')};
const plan={
  interpreted_request:'Maritime incidents near Djibouti',
  anchors:{en:'djibouti'},
  queries:[{language:'en',variant:'primary',query:'Djibouti maritime attack'},{language:'en',variant:'secondary',query:'Gulf of Aden vessel Djibouti'}]
};

test('Deep Search picks in-scope database events that concern the question as primary evidence',()=>{
  const c=deepSearchContext();
  const db={events:[
    event('near',{title:'Vessel attacked off Djibouti',country:'Djibouti',category:'Maritime Piracy',actor_group:'Houthis',source:'Reuters',url:'https://r/1',source_count:3}),
    event('no-anchor',{title:'Vessel attacked off Yemen',country:'Yemen',category:'Maritime Piracy'}),
    event('too-old',{title:'Djibouti port attack',country:'Djibouti',published:'2026-06-01T00:00:00Z'}),
    event('other-group',{title:'Djibouti arrest of suspects',country:'Djibouti',actor_group:'ISIS'}),
  ]};
  const rows=plain(c.databaseEvidenceRows(db,plan,window,shared.parseDatabaseFilters({actor_group:'Houthis'})));
  assert.deepEqual(rows.map(r=>r.atlas_match_id),['near']);
  const [row]=rows;
  assert.equal(row.search_engine,'ct_atlas_database');
  assert.equal(row.atlas_status,'already_in_atlas');
  assert.equal(row.database_event.source_count,3);

  const unfiltered=plain(c.databaseEvidenceRows(db,plan,window,shared.parseDatabaseFilters({})));
  assert.deepEqual(unfiltered.map(r=>r.atlas_match_id).sort(),['near','other-group']);
});

test('Deep Search database evidence is capped so external search keeps most of the 48 slots',()=>{
  const c=deepSearchContext();
  const db={events:Array.from({length:40},(_,i)=>event(`e${i}`,{title:`Djibouti maritime attack number ${i}`,country:'Djibouti'}))};
  const rows=c.databaseEvidenceRows(db,plan,window,shared.parseDatabaseFilters({}));
  assert.equal(rows.length,vm.runInContext('DEEP_SEARCH_MAX_DATABASE_EVIDENCE',c));
  assert.ok(vm.runInContext('DEEP_SEARCH_MAX_DATABASE_EVIDENCE < DEEP_SEARCH_MAX_EVIDENCE / 2',c));
});

test('an external article matching a database event corroborates it instead of taking a slot',()=>{
  const c=deepSearchContext();
  const databaseRows=c.databaseEvidenceRows({events:[event('near',{title:'Vessel attacked off Djibouti',country:'Djibouti',url:'https://r/1'})]},plan,window,shared.parseDatabaseFilters({}));
  const external=[
    {title:'Ship hit near Djibouti',url:'https://ap/2',source:'AP',atlas_status:'already_in_atlas',atlas_match_id:'near',atlas_match_key:databaseRows[0].atlas_match_key,sources:[{source:'AP',url:'https://ap/2'}]},
    {title:'Unrelated gap',url:'https://x/3',source:'X',atlas_status:'potential_gap',atlas_match_id:'',atlas_match_key:'',sources:[{source:'X',url:'https://x/3'}]},
  ];
  const remaining=plain(c.foldIntoDatabaseEvidence(databaseRows,external));
  assert.deepEqual(remaining.map(r=>r.url),['https://x/3']);
  assert.deepEqual(plain(databaseRows)[0].sources.map(s=>s.url),['https://r/1','https://ap/2']);
  assert.equal(plain(c.evidenceItem(databaseRows[0],0)).source_count,2);
});

test('events sharing an id stay distinct: an article folds into the event it actually matched',()=>{
  const c=deepSearchContext();
  const db={events:[
    event('dup',{title:'Vessel attacked off Djibouti',country:'Djibouti',url:'https://r/1'}),
    event('dup',{title:'Djibouti maritime attack on tanker',country:'Djibouti',url:'https://r/2',published:'2026-09-27T10:00:00Z'}),
  ]};
  const databaseRows=c.databaseEvidenceRows(db,plan,window,shared.parseDatabaseFilters({}));
  assert.equal(databaseRows.length,2);
  assert.notEqual(databaseRows[0].atlas_match_key,databaseRows[1].atlas_match_key);
  const [matched]=plain(c.compareWithAtlas(
    [{title:'Djibouti maritime attack on tanker',url:'https://ap/9',published:'2026-09-27T12:00:00Z'}],
    c.candidateMapEvents(db,window)
  ));
  assert.equal(matched.atlas_match_key,shared.eventUniqueKey(db.events[1]));
  const remaining=c.foldIntoDatabaseEvidence(databaseRows,[{...matched,sources:[{source:'AP',url:'https://ap/9'}]}]);
  assert.equal(remaining.length,0);
  const byUrl=Object.fromEntries(plain(databaseRows).map(row=>[row.url,row.sources.map(s=>s.url)]));
  assert.deepEqual(byUrl['https://r/2'],['https://r/2','https://ap/9']);
  assert.deepEqual(byUrl['https://r/1'],['https://r/1']);
});

test('buildEvidence honours a reduced slot count',()=>{
  const c=deepSearchContext();
  const rows=Array.from({length:30},(_,i)=>({title:`t${i}`,url:`https://u/${i}`,language:'en',sources:[{}]}));
  assert.equal(c.buildEvidence(rows,[],10).length,10);
  assert.equal(c.buildEvidence(rows,[],0).length,0);
});

test('Deep Search consults the database before external search and numbers evidence database-first',()=>{
  const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8');
  const handler=source.slice(source.indexOf('export async function handleDeepSearch('));
  assert.ok(handler.indexOf('databaseEvidenceRows(db, plan, window, filters)')<handler.indexOf('await retrieveNews('),'database first');
  assert.match(handler,/if \(!unique\.length && !databaseRows\.length\)/);
  assert.match(handler,/\.\.\.databaseRows\.map\(evidenceItem\),\s*\.\.\.buildEvidence\(externalRows, priorityLanguages, DEEP_SEARCH_MAX_EVIDENCE - databaseRows\.length\)/);
  assert.equal((source.match(/fetchEventsDatabase\(env\)/g)||[]).length,1,'still a single events fetch');
  assert.match(source,/search_engine "ct_atlas_database" are verified events/);
});

test('Atlas AI scopes events with the Database filters before matching the question, then adds archive context',()=>{
  const source=fs.readFileSync('cloudflare-worker/quick-ask.js','utf8');
  const handler=source.slice(source.indexOf('async function handleQuickAsk('));
  assert.ok(handler.indexOf('matchesDatabaseFilters(event, filters, now)')<handler.indexOf('localEventMatches(scoped, question)'));
  assert.match(handler,/if \(!matched\.length && hasActiveDatabaseFilters\(filters\)\)/);
  assert.match(handler,/searchCorpusForQuestion\(env,/);
  assert.match(source,/You answer FROM THE CT ATLAS DATABASE FIRST/);
  assert.match(source,/QUICK_ASK_VERSION = "quick-ask-v6-quota-fallback"/);
});

test('the report route filters by group and keys its cache on it',()=>{
  const route=fs.readFileSync('cloudflare-worker/index.js','utf8');
  assert.match(route,/matchesRegion\(e, region\) && matchesTopic\(e, topic\) && matchesGroup\(e, actorGroup\)/);
  assert.match(route,/JSON\.stringify\(\{ region, topic, actorGroup, periodDays, compare, databaseVersion, version: REPORT_GENERATOR_VERSION \}\)/);
  assert.ok(vm.runInContext('ALLOWED_PERIODS.has(1)',shared));
});
