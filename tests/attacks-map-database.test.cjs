// The attacks-only map and the Database panel: the map loads events-map.json
// (falling back to events-lite.json filtered with the same rule), keeps the
// header and Key Developments working from recent_events, and the Database
// panel reaches every category through the Worker's /database-events route.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const html=fs.readFileSync('index.html','utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const strip=source=>source.replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'').replace(/export\s*\{[\s\S]*?\};?\s*$/,'');

function extract(name){
  const start=html.indexOf(`function ${name}(`);
  assert.ok(start>=0,`${name} not found`);
  let depth=0,i=html.indexOf('{',start);
  for(;i<html.length;i++){
    if(html[i]==='{')depth++;
    else if(html[i]==='}'&&--depth===0)break;
  }
  return html.slice(start,i+1);
}

const retirementRuleSource=extract('isJudicialCategory')+extract('isRetiredJudicialEvent');
const categoryRuleSource=retirementRuleSource+
  html.slice(html.indexOf('const CATEGORY_ALIASES'),html.indexOf('function normalizeCategoryName('))+
  extract('normalizeCategoryName')+extract('eventLooksLikeMaritimePiracy')+extract('eventCategories');
const retirementDataSource=categoryRuleSource+extract('normalizeActiveEvent')+
  extract('eventMatchKey')+extract('removeRetiredJudicialData');

const attackRule=vm.createContext({});
vm.runInContext(retirementRuleSource+extract('isMapAttackEvent'),attackRule);

test('the map and tools/build_events_map.py use the same attack rule',()=>{
  const cases=[
    [{primary_event_type:'ATTACK',is_attack:true},true],
    [{primary_event_type:'ATTACK',is_attack:false},false],
    [{primary_event_type:'attack',is_attack:true},true],
    [{primary_event_type:'ATTEMPTED_ATTACK'},true],
    [{primary_event_type:'DISRUPTED_PLOT',category:'Counter Terrorism Action'},true],
    [{primary_event_type:'ARREST',category:'Attacks'},false],
    [{primary_event_type:'PIRACY',category:'Maritime Piracy'},false],
    [{categories:['Attacks','Weapons']},true],
    [{category:'Arrests'},false],
  ];
  for(const [event,expected] of cases){
    assert.equal(attackRule.isMapAttackEvent(event),expected,JSON.stringify(event));
  }
  const python=fs.readFileSync('tools/build_events_map.py','utf8');
  assert.match(python,/MAP_TYPES = \("ATTACK", "ATTEMPTED_ATTACK", "DISRUPTED_PLOT"\)/);
  assert.match(python,/return event\.get\("is_attack"\) is True/);
  assert.match(python,/return "Attacks" in event_categories\(event\)/);
});

async function runLoader(responses){
  const c=vm.createContext({
    window:{},Date,Number,Array,
    fetch:async url=>{
      const body=responses[url];
      if(body===undefined)return {ok:false,status:404,json:async()=>{throw new Error('404');}};
      return {ok:true,status:200,json:async()=>body};
    }
  });
  vm.runInContext(retirementDataSource+extract('isMapAttackEvent')+extract('loadEventsDatabase')+'const MAP_RECENT_EVENT_DAYS = 181;'+extract('loadMapDatabase'),c);
  const data=await vm.runInContext('loadMapDatabase()',c);
  return {data:plain(data),source:c.window.eventsDataSource};
}

test('the map reads events-map.json when it is published',async()=>{
  const mapFile={events:[{id:'a'}],recent_events:[],map:{recent_events_days:181},database_summary:{total_events:9},trend_summary:{overview:'x'}};
  const {data,source}=await runLoader({'events-map.json':mapFile});
  assert.equal(source,'events-map.json');
  assert.deepEqual(data,mapFile);
});

test('without events-map.json the map filters events-lite.json with the same rule',async()=>{
  const now=new Date().toISOString();
  const lite={
    trend_summary:{overview:'whole database',developments:[{event_id:'cited-old-operation'}]},
    events:[
      {id:'attack',primary_event_type:'ATTACK',is_attack:true,published:now,category:'Attacks'},
      {id:'unlocated-attack',primary_event_type:'ATTACK',is_attack:true,published:now,excluded_from_map:true},
      {id:'arrest',primary_event_type:'ARREST',published:now,category:'Arrests'},
      {id:'arrest20',primary_event_type:'ARREST',published:new Date(Date.now()-20*86400000).toISOString(),category:'Arrests'},
      {id:'old-arrest',primary_event_type:'ARREST',published:'2020-01-01T00:00:00Z',category:'Arrests'},
      {id:'cited-old-operation',primary_event_type:'CT_OPERATION',published:'2020-01-01T00:00:00Z',category:'Counter Terrorism Action'},
    ]
  };
  const {data,source}=await runLoader({'events-map.json':{events:[],recent_events:[],map:{recent_events_days:8}},'events-lite.json':lite});
  assert.equal(source,'events-lite.json');
  // Unlocated attacks stay (never drawn, but in the ticker and header counts),
  // like tools/build_events_map.py.
  assert.deepEqual(data.events.map(e=>e.id),['attack','unlocated-attack']);
  assert.deepEqual(data.recent_events.map(e=>e.id),['arrest','arrest20','cited-old-operation']);
  assert.equal(data.database_summary.total_events,5);
  assert.equal(data.trend_summary.overview,'whole database');
});

test('the start-up chain uses the map loader and gives every event a unique key',()=>{
  assert.match(html,/loadMapDatabase\(\)\s*\.then\(/);
  assert.equal((html.match(/fetch\("events-map\.json",/g)||[]).length,1);
  assert.match(html,/usedKeys\.has\(base\)\s*\?\s*base \+ "#" \+ index/);
  assert.match(html,/\[\.\.\.allEvents, \.\.\.recentContextEvents\]\.filter\(\s*isCurrentCasualtyEvent/);
});

test('with no category or group checkboxes on the page, no map event is filtered out',()=>{
  const c=vm.createContext({document:{querySelectorAll:()=>[],querySelector:()=>null}});
  vm.runInContext(
    html.slice(html.indexOf('const MAP_ALL_CATEGORIES'),html.indexOf('function selectedCategories('))+
    retirementRuleSource+extract('selectedCategories')+extract('categoryMatches')+
    'const UNSPECIFIED_GROUP_LABEL = "Unspecified / no named group";'+
    extract('eventActorGroup')+extract('selectedGroups')+extract('groupMatches')+
    'function eventCategories(e){ return e.categories || []; }',c);
  const oddEvent={categories:['Something new'],actor_group:''};
  assert.equal(vm.runInContext('categoryMatches',c)(oddEvent),true);
  assert.equal(vm.runInContext('groupMatches',c)(oddEvent),true);
  assert.equal(vm.runInContext('groupMatches',c)(oddEvent,null),true);
});

test('the removed map controls are gone and nothing references them any more',()=>{
  for(const id of ['searchInput','heatToggle','officesToggle','selectAll','clearAll','selectAllGroups','clearAllGroups','groupFilterList',
    'keyDevelopmentsButton','trendSummaryPanel','trendSummaryClose','mapScopeNote','mapScopeDatabase']){
    assert.ok(!html.includes(`id="${id}"`),`${id} markup is still there`);
    assert.ok(!new RegExp(`getElementById\\(\\s*"${id}"`).test(html),`${id} is still looked up`);
  }
  assert.ok(!html.includes('class="category-filter"'));
  for(const name of ['openTrendSummary','closeTrendSummary','renderTrendSummaryPanel','openTrendDevelopmentEvent','renderDatabaseScopeNote']){
    assert.ok(!new RegExp(`\\b${name}\\b`).test(html),`${name} is still referenced`);
  }
  assert.ok(!html.includes('VIEW KEY DEVELOPMENTS'));
  assert.ok(!html.includes('map-scope-note'));
});

function archiveCounter(fetch){
  const node={textContent:'',hidden:true};
  let now=100000;
  const c=vm.createContext({
    document:{getElementById:id=>id==='databaseTotalCount'?node:null},
    Date:{now:()=>now},
    REPORT_GENERATOR_API_BASE:'https://worker',
    databaseEventTotal:4388,databaseArchiveTotal:null,databaseArchiveByKind:{},
    databaseArchiveLoadedAt:0,databaseArchivePromise:null,DATABASE_ARCHIVE_REFRESH_MS:60000,
    fetch
  });
  vm.runInContext(extract('refreshDatabaseArchiveTotal')+extract('renderDatabaseTotal'),c);
  return {c,node,advance:ms=>{now+=ms;}};
}

const archiveResponse=(total,radnuc=0)=>({ok:true,json:async()=>({background_corpus:{available:true,total,by_kind:{radnuc_background:radnuc}}})});

test('the DATABASE total includes the archive and explains RadNuc background without adding incidents',async()=>{
  assert.match(html,/Database <span id="databaseTotalCount" class="database-total" hidden><\/span>/);
  const {c,node}=archiveCounter(async()=>archiveResponse(8958,17));
  c.renderDatabaseTotal();
  assert.equal(node.hidden,true,'nothing shown before the archive size is known');
  await c.databaseArchivePromise;
  assert.equal(node.textContent,(4388+8958).toLocaleString('en-GB'));
  assert.equal(node.hidden,false);
  assert.match(node.title,/including 17 RadNuc background articles/);
  assert.match(node.title,/excluded from map incident counts/);
  assert.equal(c.databaseEventTotal,4388);
  assert.match(html,/databaseEventTotal =\s*Number\(data\.map\?\.source_event_count\)/);
});

test('an open page refreshes an independent archive addition after the freshness interval',async()=>{
  let total=8941,calls=0;
  const {c,node,advance}=archiveCounter(async(url,options)=>{
    calls++;
    assert.equal(url,'https://worker/database-stats');
    assert.equal(options.cache,'no-store');
    return archiveResponse(total,total===8958?17:0);
  });
  await c.refreshDatabaseArchiveTotal();
  const before=node.textContent;
  total+=17;
  advance(59999);
  await c.refreshDatabaseArchiveTotal();
  assert.equal(node.textContent,before);
  assert.equal(calls,1,'recent stats reused');
  advance(1);
  await c.refreshDatabaseArchiveTotal();
  assert.equal(calls,2);
  assert.equal(node.textContent,(4388+8958).toLocaleString('en-GB'));
  assert.equal(c.databaseEventTotal,4388,'archive update leaves incident count unchanged');
});

test('initial stats failure is throttled and recovers, while later failure keeps the last good count',async()=>{
  let mode='network-error',calls=0;
  const {c,node,advance}=archiveCounter(async()=>{
    calls++;
    if(mode==='network-error')throw new Error('offline');
    if(mode==='unavailable')return {ok:true,json:async()=>({background_corpus:{available:false}})};
    if(mode==='http-error')return {ok:false};
    return archiveResponse(8958,17);
  });
  await c.refreshDatabaseArchiveTotal();
  assert.equal(node.textContent,(4388).toLocaleString('en-GB'));
  await c.refreshDatabaseArchiveTotal();
  assert.equal(calls,1,'failed initial request does not loop');
  mode='ok';advance(60000);
  await c.refreshDatabaseArchiveTotal();
  const lastGood=node.textContent;
  for(const failure of ['network-error','http-error','unavailable']){
    mode=failure;advance(60000);
    await c.refreshDatabaseArchiveTotal();
    assert.equal(node.textContent,lastGood);
    assert.match(node.title,/including 17 RadNuc/);
  }
});

test('simultaneous archive refreshes share one request',async()=>{
  let resolve,calls=0;
  const {c,node}=archiveCounter(()=>{calls++;return new Promise(done=>{resolve=done;});});
  const first=c.refreshDatabaseArchiveTotal();
  assert.equal(c.refreshDatabaseArchiveTotal(true),first);
  c.renderDatabaseTotal();
  assert.equal(calls,1);
  resolve(archiveResponse(8958,17));
  await first;
  assert.equal(node.textContent,(4388+8958).toLocaleString('en-GB'));
  assert.equal(c.databaseArchivePromise,null);
});

test('one set of Database filters drives the list, both exports, the Report Generator and Atlas AI',()=>{
  for(const id of ['reportPeriod','reportRegion','reportTopic','reportGroup']){
    const markup=html.indexOf(`id="${id}"`);
    assert.ok(markup>html.indexOf('id="databasePanel"')&&markup<html.indexOf('id="reportGeneratorPanel"'),`${id} must live in the Database panel`);
  }
  assert.match(html,/<option value="1">Last 24 hours<\/option>/);
  assert.match(extract('queryDatabase'),/REPORT_GENERATOR_API_BASE \+ "\/database-events"[\s\S]*\{ \.\.\.filters, user_id: reportGeneratorUserId\(\), min_database_version: mapDatabaseVersion \}/);
  assert.match(extract('chronologyBaseEvents'),/return databaseResultsCurrent\(\) \? databaseResults : \[\];/);
  assert.match(extract('exportChronologyExcel'),/selectedDatabaseEvents\(\)/);
  assert.match(html,/exportDatabaseMapJpeg\(\s*selectedDatabaseEvents\(\),/);
  assert.match(extract('generateCustomReport'),/actor_group:\s*actorGroup/);
  assert.match(html,/window\.CTAtlasDatabase = \{\s*filters: databaseFilters,/);
  assert.match(fs.readFileSync('deep-search.js','utf8'),/\.\.\.databaseScope\(\)\.filters,user_id:username,question/);
});

test('the region list is filled once so opening the Report Generator never resets the analyst choice',()=>{
  assert.match(extract('populateReportRegions'),/if \(!select \|\| select\.dataset\.populated\)/);
});

test('the page never queries the database on load, only on the first use of the Database panel',()=>{
  const init=html.slice(html.indexOf('The first touch of the Database panel'),html.indexOf('let dashboardRefreshTimer'));
  assert.match(init,/addEventListener\("pointerdown", activate\)/);
  assert.match(extract('onDatabaseFiltersChanged'),/if \(!databaseActivated && !chronologyOpen\) return;/);
});

test('database rows only link to the map when they are attacks themselves, by the unique key',()=>{
  const c=vm.createContext({
    allEvents:[
      {id:'dup',published:'2026-09-30T08:00:00Z',title:'Attack in Kabul',category:'Attacks',_mapKey:'dup'},
      {id:'dup',published:'2026-09-30T08:00:00Z',title:'Other attack',category:'Attacks',_mapKey:'dup#1'},
    ],
    recentContextEvents:[],
    databaseResults:[
      {id:'dup',published:'2026-09-30T08:00:00Z',title:'Other attack',primary_event_type:'ATTACK',is_attack:true},
      {id:'dup',published:'2026-09-30T08:00:00Z',title:'Attack in Kabul',primary_event_type:'ARREST'},
      {id:'dup',published:'2026-09-30T08:00:00Z',title:'Not in the map file',primary_event_type:'ATTACK',is_attack:true},
    ]
  });
  vm.runInContext(retirementRuleSource+extract('isMapAttackEvent')+extract('eventMatchKey')+extract('linkDatabaseRowsToMap'),c);
  vm.runInContext('linkDatabaseRowsToMap()',c);
  assert.deepEqual(c.databaseResults.map(r=>r._mapEventKey),['dup#1','','']);
  assert.match(extract('queryDatabase'),/linkDatabaseRowsToMap\(\);/);
  assert.ok(!/mapKeyById/.test(html),'ids are shared by unrelated events');
  // Rows that arrive before the map's file are linked again once it loads.
  const chain=html.slice(html.indexOf('usedKeys.add(event._mapKey);'),html.indexOf('renderDatabaseScopeNote();',html.indexOf('usedKeys.add(event._mapKey);')));
  assert.match(chain,/linkDatabaseRowsToMap\(\);/);
});

test('a late answer never undoes the group the analyst just picked, and a stale error clears',()=>{
  const query=extract('queryDatabase');
  assert.match(query,/const liveGroup = document\.getElementById\("reportGroup"\)\?\.value \|\| filters\.actor_group;\s*renderDatabaseGroups\([^;]*liveGroup\);/);
  assert.match(query,/if \(databaseCacheReusable\(key, force\)\) \{[\s\S]*?databaseLastError = "";[\s\S]*?setDatabaseStatus\(databaseLastStatus, "ready"\);[\s\S]*?return Promise\.resolve\(databaseResults\);/);
});

test('Escape closes the event card alone, not the list underneath',()=>{
  const init=html.slice(html.indexOf('Capture phase + stop: Escape closes only the card'),html.indexOf('let dashboardRefreshTimer'));
  assert.match(init,/closeDatabaseEventCard\(\);\s*keyEvent\.stopImmediatePropagation\(\);\s*\}, true\);/);
});

test('the page and the Worker build the same unique event key',()=>{
  const page=vm.createContext({});
  vm.runInContext(extract('eventMatchKey'),page);
  const worker=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
  vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),worker);
  const cases=[
    {id:'2026-09-30-',published:'2026-09-30T08:15:00Z',title:'هجوم  في\nكابول'},
    {id:'2026-09-30-',published:'2026-09-30T08:15:00+02:00',title:'Another   title'},
    {id:'x',published:'not a date',title:'  padded  '},
    {id:null,title:'x'.repeat(300)},
  ];
  for(const event of cases){
    assert.equal(page.eventMatchKey(event),vm.runInContext('eventUniqueKey',worker)(event),JSON.stringify(event));
  }
  assert.notEqual(page.eventMatchKey(cases[0]),page.eventMatchKey({...cases[0],title:'Other'}));
});

test('a list that no longer matches the filters is never shown or exported',()=>{
  const c=vm.createContext({
    databaseQueryPromise:null,databaseResultsKey:'',databaseLastError:'',
    databaseResults:[{_mapKey:'db-0'},{_mapKey:'db-1'}],
    chronologySelectedKeys:new Set(['db-0','db-1']),
    mapDatabaseVersion:'',databaseSourceVersion:'',
    currentFilters:{region:'GLOBAL',topic:'ALL',actor_group:'ALL',period_days:7}
  });
  vm.runInContext(categoryRuleSource+extract('normalizeActiveEvent')+'function databaseFilters(){ return currentFilters; }'+extract('databaseSnapshotCompatible')+extract('databaseResultsCurrent')+extract('chronologyBaseEvents')+extract('selectedDatabaseEvents')+extract('databaseExportBlockedText'),c);
  vm.runInContext('databaseResultsKey = JSON.stringify(currentFilters);',c);
  assert.equal(vm.runInContext('selectedDatabaseEvents().length',c),2);
  vm.runInContext('currentFilters = {...currentFilters, topic: "Arrests"};',c);
  assert.equal(vm.runInContext('selectedDatabaseEvents().length',c),0);
  assert.equal(vm.runInContext('chronologyBaseEvents().length',c),0);
  assert.match(vm.runInContext('databaseExportBlockedText()',c),/does not match the current filters/);
  vm.runInContext('databaseQueryPromise = {};',c);
  assert.match(vm.runInContext('databaseExportBlockedText()',c),/still loading/);
  assert.match(extract('queryDatabase'),/const seq = \+\+databaseQuerySeq;[\s\S]*?chronologySelectedKeys\.clear\(\);[\s\S]*?const promise = fetch/);
});

test('list and ticker clicks only zoom to events the map shows; the rest open their card',()=>{
  assert.match(extract('openDatabaseEvent'),/if \(isOnMapNow\(event\._mapEventKey\)\)/);
  assert.match(extract('openMapEventOrCard'),/if \(isOnMapNow\(event\._mapKey\)\)[\s\S]*showDatabaseEventCard\(event\)/);
  assert.match(extract('renderAttackTicker'),/openMapEventOrCard\(allEvents\.find\(/);
  const c=vm.createContext({selectedDays:1,mapCategoryScope:'ATTACKS'});
  vm.runInContext(retirementRuleSource+extract('isMapAttackEvent')+extract('withinDays')+extract('databaseEventCardNote'),c);
  assert.match(c.databaseEventCardNote({primary_event_type:'ARREST'}),/attacks only/);
  assert.match(c.databaseEventCardNote({primary_event_type:'ATTACK',is_attack:true,latitude:1,longitude:2,published:'2020-01-01T00:00:00Z'}),/last 24 hours/);
  assert.match(c.databaseEventCardNote({primary_event_type:'ATTACK',is_attack:true,latitude:1,longitude:2,published:new Date().toISOString()}),/after the map was loaded/);
  assert.match(c.databaseEventCardNote({primary_event_type:'ATTACK',is_attack:true,location_precision:'unlocated'}),/not precise enough/);
});

test('chronology and Excel links only accept http(s) URLs',()=>{
  assert.match(html,/sourceLink\.href =\s*safeHttpUrl\(event\.url\);/);
  assert.match(extract('exportChronologyExcel'),/Target:\s*safeHttpUrl\(event\.url\),/);
});

test('the event card only links http(s) URLs and escapes every field',()=>{
  const card=extract('showDatabaseEventCard');
  assert.match(card,/const url = safeHttpUrl\(event\.url\);/);
  assert.ok(!/\$\{event\.(title|summary|source|actor_group)\}/.test(card),'unescaped field in the card');
  const c=vm.createContext({});
  vm.runInContext(extract('safeHttpUrl'),c);
  assert.equal(c.safeHttpUrl('javascript:alert(1)'),'');
  assert.equal(c.safeHttpUrl('https://example.com/a'),'https://example.com/a');
});

test('the ticker lists the period attacks, pauses on hover, respects reduced motion and hides on phones',()=>{
  assert.match(extract('refreshDashboard'),/renderEvents\(\);\s*renderAttackTicker\(\);/);
  assert.match(html,/@media \(prefers-reduced-motion: reduce\) \{\s*#attackTickerList\.ticker-animated \{ animation: none; \}/);
  assert.match(html,/#attackTickerViewport:hover #attackTickerList/);
  assert.match(html,/@media \(max-width: 820px\) \{\s*#attackTicker \{ display: none; \}/);
  assert.match(extract('renderAttackTicker'),/if \(!reducedMotion && list\.scrollHeight/,'no hidden duplicate list without the animation');
  assert.match(html,/new ResizeObserver\(/,'re-measured once the page is unlocked');
});

test('the Database route is protected by the session wrapper and scripts are cache-busted',()=>{
  const auth=fs.readFileSync('usage-auth-fix.js','utf8');
  assert.match(auth,/deep-search\|database-events\|/);
  assert.ok(Number(auth.match(/deep-search\.js\?v=(\d+)/)?.[1]) >= 7, "Custom Intelligence keeps a current cache version");
  assert.ok(!/quick-ask/.test(auth),'the retired quick Q&A is not loaded');
  assert.ok(Number(html.match(/usage-auth-fix\.js\?v=(\d+)/)?.[1]) >= 20261003, "session wrapper keeps a current cache version");
});

// ---- Worker /database-events --------------------------------------------
function workerContext(events,sessionUser='analyst'){
  const shared=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console});
  vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
  const pick=names=>Object.fromEntries(names.map(n=>[n,vm.runInContext(n,shared)]));
  const c=vm.createContext({
    ...pick(['cleanText','normalizeUsername','parseEventDate','eventCategories','eventActorGroup','eventUniqueKey','matchesGroup','parseDatabaseFilters','matchesDatabaseFilters','databaseFiltersLabel']),
    isAllowedUser:()=>true,
    gateCall:async()=>({ok:true,json:async()=>({username:sessionUser})}),
    fetchEventsDatabase:async()=>({ok:true,db:{last_updated:'2026-09-30T10:00:00Z',events}}),
    jsonResponse:(body,status)=>({status,body}),
    Response,console
  });
  vm.runInContext(strip(fs.readFileSync('cloudflare-worker/database-query.js','utf8')),c);
  return c;
}

test('/database-events filters every category and lists the groups of the scope',async()=>{
  const now=new Date().toISOString();
  const events=[
    {id:'1',title:'Al-Shabaab attack',country:'Somalia',category:'Attacks',actor_group:'Al-Shabaab',published:now,related_articles:['never sent']},
    {id:'2',title:'Arrest in Mogadishu',country:'Somalia',category:'Arrests',actor_group:'Al-Shabaab',published:now},
    {id:'3',title:'Unattributed blast',country:'Somalia',category:'Attacks',published:now},
    {id:'4',title:'Kenya raid',country:'Kenya',category:'Attacks',actor_group:'Al-Shabaab',published:now},
  ];
  const c=workerContext(events);
  const request=body=>({json:async()=>body,headers:{get:()=>'token'}});
  const result=plain(await c.handleDatabaseEvents(request({user_id:'analyst',region:'Somalia',topic:'Attacks',actor_group:'Al-Shabaab',period_days:7}),{}));
  assert.equal(result.status,200);
  assert.equal(result.body.total,1);
  assert.deepEqual(result.body.events.map(e=>e.id),['1']);
  assert.deepEqual(result.body.groups,[{name:'Al-Shabaab',count:1},{name:'Unspecified / no named group',count:1}]);
  assert.equal(result.body.events[0].key,'db-0');
  assert.ok(!('related_articles' in result.body.events[0]),'rows carry explicit fields only');

  const unauthenticated=plain(await c.handleDatabaseEvents({json:async()=>({user_id:'analyst'}),headers:{get:()=>''}},{}));
  assert.equal(unauthenticated.status,401);
});

test('/database-events with no category filter returns every category, newest first',async()=>{
  const recent=new Date(Date.now()-3600e3).toISOString();
  const older=new Date(Date.now()-2*86400e3).toISOString();
  const events=[
    {id:'a',title:'Attack',country:'Mali',primary_event_type:'ATTACK',is_attack:true,category:'Attacks',published:older,url:'https://example.com/a'},
    {id:'b',title:'Arrest',country:'Mali',primary_event_type:'ARREST',category:'Arrests',published:recent,url:'javascript:alert(1)'},
    {id:'c',title:'Piracy',country:'Mali',primary_event_type:'PIRACY',category:'Maritime Piracy',published:recent},
  ];
  const c=workerContext(events);
  const result=plain(await c.handleDatabaseEvents({json:async()=>({user_id:'analyst',topic:'ALL',period_days:7}),headers:{get:()=>'token'}},{}));
  assert.equal(result.status,200);
  assert.equal(result.body.total,3);
  assert.deepEqual(result.body.events.map(e=>e.id).slice(-1),['a']);
  assert.deepEqual(new Set(result.body.events.map(e=>e.id)),new Set(['a','b','c']));
  const byId=Object.fromEntries(result.body.events.map(e=>[e.id,e]));
  assert.equal(byId.a.url,'https://example.com/a');
  assert.equal(byId.b.url,'','non-http(s) URLs are dropped');
  assert.equal(byId.a.match_key,vm.runInContext('eventUniqueKey',c)(events[0]));
});

test('/database-events refuses a session that belongs to another user',async()=>{
  const c=workerContext([{id:'a',title:'x',published:new Date().toISOString()}],'someone-else');
  const result=plain(await c.handleDatabaseEvents({json:async()=>({user_id:'analyst'}),headers:{get:()=>'token'}},{}));
  assert.equal(result.status,401);
});

// ---- "Show on map": attacks by default, every category or one on demand ----
function mapScopeHarness(){
  const day=86400000, now=Date.now();
  const iso=ms=>new Date(now-ms).toISOString();
  const c=vm.createContext({document:{getElementById:()=>null},Date,Number,Array,Object,String,Set,Map});
  vm.runInContext(`
    const MAP_ALL_CATEGORIES = Object.freeze(["Attacks","Counter Terrorism Action","Arrests",
      "Terrorist Financing","Weapons","Maritime Security","Radiological/Nuclear","Chemicals and Explosives","Biological Terrorism","Online / Cyber / AI"]);
    let selectedDays = 1;
    let recentContextEvents = [];
    let attacks = [];
    let allEvents = [];
    function withinDays(published, days){ return Date.now()-Date.parse(published) <= days*86400000; }
    function filteredAllEvents(){ return attacks.filter(e => withinDays(e.published, selectedDays)); }
    function normalizeCategoryName(c){ return c === "RADNUC" ? "Radiological/Nuclear" : c; }
    function eventLooksLikeMaritimePiracy(){ return false; }
    function categoryMatches(event, list){ return eventCategories(event).some(category => list.includes(category)); }
    function groupMatches(){ return true; }
    function searchMatches(){ return true; }
  `,c);
  vm.runInContext(retirementRuleSource+extract('eventCategories'),c);
  const src=html.slice(html.indexOf('let _filteredAllEventsCache = null;'),html.indexOf('function filteredAllEvents()'));
  vm.runInContext(src,c);
  vm.runInContext(extract('filteredMappedEvents'),c);
  c.attacksData={
    attacks:[{id:'a1',category:'Attacks',published:iso(3600e3),latitude:1,longitude:1},
             {id:'a7',category:'Attacks',published:iso(5*day),latitude:1,longitude:1}],
    others:[{id:'r1',category:'Arrests',published:iso(7200e3),latitude:2,longitude:2},
            {id:'l1',category:'Legal / Judicial',published:iso(2*day),latitude:3,longitude:3},
            {id:'r20',category:'Arrests',published:iso(20*day),latitude:4,longitude:4},
            {id:'r31',category:'Arrests',published:iso(31*day),latitude:5,longitude:5},
            {id:'u1',category:'Arrests',published:iso(7200e3),location_precision:'unlocated'}]
  };
  vm.runInContext('attacks = attacksData.attacks; allEvents=attacks; recentContextEvents = attacksData.others;',c);
  return {
    context:c,
    ids:(scope,days)=>vm.runInContext(`selectedDays=${days}; setMapCategoryScope(${JSON.stringify(scope)}); invalidateFilterCache();
      ({scope: mapScopeEvents().map(e=>e.id), mapped: filteredMappedEvents().map(e=>e.id), state: mapCategoryScope})`,c),
  };
}

test('the map shows all events by default and filters every category over 1, 7, 30, 90 or 180 days',()=>{
  const h=mapScopeHarness();
  assert.deepEqual(plain(h.ids('ATTACKS',1)).mapped,['a1']);
  assert.deepEqual(plain(h.ids('ATTACKS',7)).mapped,['a1','a7']);
  assert.deepEqual(plain(h.ids('ALL',1)).mapped,['a1','r1']);
  assert.deepEqual(plain(h.ids('ALL',7)).mapped,['a1','a7','r1']);
  assert.deepEqual(plain(h.ids('ALL',30)).mapped,['a1','a7','r1','r20']);
  assert.deepEqual(plain(h.ids('Arrests',30)).mapped,['r1','r20']);
  assert.deepEqual(plain(h.ids('Arrests',90)).mapped,['r1','r20','r31']);
  const arrests=plain(h.ids('Arrests',7));
  assert.deepEqual(arrests.mapped,['r1'],'one category: no attacks');
  assert.deepEqual(arrests.scope,['r1','u1'],'the counter also counts events without a location');
  assert.equal(plain(h.ids('anything else',1)).state,'ATTACKS','an unknown value falls back to attacks');
});

test('the "Show on map" selector defaults to all events and the map file covers 180 days of other categories',()=>{
  const select=html.slice(html.indexOf('<select id="mapCategory">'),html.indexOf('</select>',html.indexOf('<select id="mapCategory">')));
  assert.match(select,/<option value="ATTACKS">Attacks only<\/option>/);
  assert.match(select,/<option value="ALL" selected>All events<\/option>/);
  assert.match(html,/let mapCategoryScope = "ALL";/);
  assert.match(html,/_filteredMappedEventsCache = mapScopeEvents\(\)\.filter\(/);
  assert.match(html,/const MAP_RECENT_EVENT_DAYS = 181;/);
  assert.match(fs.readFileSync('tools/build_events_map.py','utf8'),/^RECENT_DAYS = 181$/m);
  // The ticker, KPIs and trends stay about attacks whatever the map shows.
  assert.match(html,/const events = filteredAllEvents\(\)\s*\n?\s*\.map/);
});

test('attacks pulse in red on the map, clusters holding one too; the offices are small and static',()=>{
  const css=html.replace(/\r\n/g,'\n');
  assert.match(css,/\.ct-marker\.attacks \{\n    position: relative;\n    background: #e3191f !important;\n    animation: attackMarkerGlow/);
  assert.match(css,/\.ct-marker\.attacks::after \{[\s\S]*?animation: attackMarkerRing/);
  assert.match(css,/\.marker-cluster\.attack-cluster div::after \{[\s\S]*?animation: attackMarkerRing/);
  assert.match(css,/className: "marker-cluster marker-cluster-" \+ size \+ \(attack \? " attack-cluster" : ""\)/);
  assert.match(css,/ctAttack:\s*style\.className === "attacks"/);
  const office=css.slice(css.indexOf('.interpol-office-marker {'),css.indexOf('.interpol-office-hq {'));
  assert.ok(!/animation/.test(office),'offices do not pulse');
  assert.ok(!/interpolOfficePulse/.test(css));
  assert.match(css,/\.interpol-office-hq \{\n    width: 22px;/);
});



test('RADNUC subgroup includes attacks and contextual CBRN events, excludes other CBRN and state actors',()=>{
  const h=mapScopeHarness();
  vm.runInContext(`
    const now=new Date().toISOString();
    attacks=[{id:'rad-attack',category:'Attacks',categories:['Attacks','CBRN'],cbrn_subgroups:['RADNUC'],
      published:now,latitude:1,longitude:2}];
    allEvents=attacks;
    recentContextEvents=[
      {id:'rad-arrest',category:'CBRN',cbrn_subgroups:['RADNUC'],published:now,latitude:1,longitude:2},
      {id:'chemical',category:'CBRN',cbrn_subgroups:[],published:now,latitude:1,longitude:2},
      {id:'state-strike',category:'CBRN',cbrn_subgroups:['RADNUC'],actor_scope:'STATE_ONLY',published:now,latitude:1,longitude:2},
      {id:'unlocated-rad',category:'CBRN',cbrn_subgroups:['RADNUC'],published:now,excluded_from_map:true}
    ];
  `,h.context);
  assert.deepEqual(plain(h.ids('RADNUC',7)).mapped,['rad-attack','rad-arrest']);
  assert.equal(plain(h.ids('RADNUC',7)).state,'RADNUC');
  assert.deepEqual(plain(vm.runInContext("mapScopeCandidates().map(e=>e.id)",h.context)),['rad-attack','rad-arrest','unlocated-rad']);
  assert.ok(plain(h.ids('Radiological/Nuclear',7)).mapped.includes('rad-attack'),'standalone category includes its radiological attack');
  assert.equal(plain(h.ids('CBRN',7)).state,'ATTACKS','removed parent is not a selectable scope');
});



test('RADNUC Database queries preserve subgroup metadata and return the same events as the map',async()=>{
  const now=new Date().toISOString();
  const hit={id:'rad',title:'Dirty bomb plot foiled',published:now,category:'CBRN',categories:['CBRN','Arrests'],
    cbrn_subgroups:['RADNUC'],actor_scope:'NON_STATE',primary_event_type:'ARREST',latitude:1,longitude:2};
  const c=workerContext([hit,{...hit,id:'chemical',cbrn_subgroups:[]},{...hit,id:'state',actor_scope:'STATE_ONLY'}]);
  const result=plain(await c.handleDatabaseEvents({json:async()=>({user_id:'analyst',topic:'RADNUC',period_days:90}),headers:{get:()=>'token'}},{}));
  assert.equal(result.status,200);
  assert.deepEqual(result.body.events.map(e=>e.id),['rad']);
  assert.deepEqual(result.body.events[0].cbrn_subgroups,['RADNUC']);
  assert.equal(result.body.events[0].actor_scope,'NON_STATE');
  const h=mapScopeHarness();
  h.context.radHit=hit;
  vm.runInContext('attacks=[]; allEvents=[]; recentContextEvents=[radHit];',h.context);
  assert.deepEqual(plain(h.ids('RADNUC',90)).mapped,result.body.events.map(e=>e.id));
});

test('Database results cannot be reused after the map publishes a newer snapshot or the cache expires',()=>{
  const c=vm.createContext({Date,Number,databaseResultsKey:'same',databaseQueryPromise:null,
    databaseSourceVersion:'2026-10-07T10:00:00Z',mapDatabaseVersion:'2026-10-07T10:00:00Z',
    databaseResultsLoadedAt:Date.now(),DATABASE_RESULTS_CACHE_MS:60000});
  vm.runInContext(extract('databaseSnapshotCompatible')+extract('databaseCacheReusable'),c);
  assert.equal(c.databaseCacheReusable('same'),true);
  assert.equal(c.databaseCacheReusable('same',true),false,'opening the list can force a new query');
  c.mapDatabaseVersion='2026-10-07T11:00:00Z';
  assert.equal(c.databaseCacheReusable('same'),false,'new map events invalidate an older database list');
  c.databaseSourceVersion=c.mapDatabaseVersion;
  c.databaseResultsLoadedAt=Date.now()-61000;
  assert.equal(c.databaseCacheReusable('same'),false,'unchanged filters do not cache the list forever');
  assert.match(extract('queryDatabase'),/min_database_version: mapDatabaseVersion/);
});

test('CBRN contextual Database rows link to their actual map markers',()=>{
  const event={id:'new-cbrn',title:'Radioactive trafficking investigation',published:'2026-10-07T10:00:00Z',
    primary_event_type:'CBRN',categories:['CBRN'],_mapKey:'new-cbrn'};
  const c=vm.createContext({allEvents:[],recentContextEvents:[event],databaseResults:[{...event,_mapKey:'db-0'}]});
  vm.runInContext(retirementRuleSource+extract('isMapAttackEvent')+extract('eventMatchKey')+extract('linkDatabaseRowsToMap'),c);
  c.linkDatabaseRowsToMap();
  assert.equal(c.databaseResults[0]._mapEventKey,'new-cbrn');
});


test('six-month map filtering includes every category and excludes events older than 180 days',()=>{
  const h=mapScopeHarness();
  const day=86400000;
  const categories=['Counter Terrorism Action','Arrests','Terrorist Financing',
    'Weapons','Maritime Security','Radiological/Nuclear','Chemicals and Explosives','Biological Terrorism','Online / Cyber / AI'];
  h.context.sixMonthOthers=categories.map((category,i)=>({id:'six-'+i,category,
    published:new Date(Date.now()-179*day).toISOString(),latitude:1,longitude:1}));
  h.context.sixMonthOthers.push({id:'expired',category:'Arrests',
    published:new Date(Date.now()-181*day).toISOString(),latitude:1,longitude:1});
  h.context.sixMonthAttack={id:'six-attack',category:'Attacks',categories:['Attacks','Weapons'],
    published:new Date(Date.now()-179*day).toISOString(),latitude:1,longitude:1};
  vm.runInContext('recentContextEvents.push(...sixMonthOthers); attacks.push(sixMonthAttack);',h.context);
  const all=plain(h.ids('ALL',180)).mapped;
  assert.ok(all.includes('six-attack'));
  assert.ok(!all.includes('expired'));
  for(const [i,category] of categories.entries()){
    assert.ok(all.includes('six-'+i),category+' missing from all events');
    assert.ok(plain(h.ids(category,180)).mapped.includes('six-'+i),category+' filter lost historical event');
    assert.ok(!plain(h.ids(category,90)).mapped.includes('six-'+i),category+' ignored the 90-day cutoff');
  }
  assert.ok(plain(h.ids('Weapons',180)).mapped.includes('six-attack'),
    'A multi-category attack must remain visible in its relevant thematic filter');
  assert.equal(all.length,new Set(all).size,'No duplicate records in the all-events map');
});

test('the browser rejects an outdated 91-day payload and loads the full six-month data',async()=>{
  const old={id:'older-arrest',title:'Historical arrest',category:'Arrests',primary_event_type:'ARREST',
    published:new Date(Date.now()-150*86400000).toISOString()};
  const stale={events:[],recent_events:[],map:{recent_events_days:91}};
  const {data:loaded,source}=await runLoader({'events-map.json':stale,'events-lite.json':{events:[old]}});
  assert.equal(source,'events-lite.json');
  assert.ok(loaded.recent_events.some(e=>e.id==='older-arrest'));
  assert.equal(loaded.map.recent_events_days,181);
});

test('RadNuc context is selectable and exported on the same Excel sheet as operational records',()=>{
  const records=[
    {_mapKey:'db-0',title:'Suspect arrested',categories:['Arrests'],published:'2026-10-13T09:00:00Z',url:'https://example.test/incident'},
    {_mapKey:'bg-0',title:'Nuclear regulation update',categories:['Radiological/Nuclear'],published:'2026-10-13T08:00:00Z',url:'https://example.test/update',archive_only:true,excluded_from_map:true,primary_event_type:'BACKGROUND_INFO',ai_relevance_score:null,latitude:null,longitude:null},
  ];
  let exported;
  const c=vm.createContext({Date,Number,Array,JSON,databaseResults:records,
    chronologySelectedKeys:new Set(['db-0','bg-0']),databaseResultsCurrent:()=>true,
    eventCategories:row=>row.categories||[],databaseFiltersText:()=> 'Global · all categories · 7 days',
    chronologyCountry:'',chronologySearchText:'',alert:message=>{throw new Error(message);},
    XLSX:{utils:{
      json_to_sheet:rows=>({rows,...Object.fromEntries(rows.map((row,i)=>['R'+(i+2),{v:row['Source URL']}]))}),
      book_new:()=>({sheets:[]}),book_append_sheet:(book,sheet,name)=>book.sheets.push({name,sheet}),
    },writeFile:book=>{exported=book;}}
  });
  vm.runInContext(categoryRuleSource+extract('normalizeActiveEvent')+extract('selectedDatabaseEvents')+extract('excelRowsFromEvents')+extract('safeHttpUrl')+extract('exportChronologyExcel'),c);
  c.exportChronologyExcel();
  const sheet=exported.sheets.find(s=>s.name==='Events').sheet;
  assert.equal(sheet.rows.length,2);
  assert.equal(sheet.rows[1]['English Title'],'Nuclear regulation update');
  assert.equal(sheet.rows[1]['Event type'],'BACKGROUND_INFO');
  assert.equal(sheet.rows[1]['AI relevance score'],'','no invented CT score');
  assert.equal(sheet.rows[1]['Country'],'','no invented incident location');
  assert.equal(sheet.R3.l.Target,'https://example.test/update');
  assert.doesNotMatch(html,/id="databaseBackgroundSection"/);
  assert.match(extract('linkDatabaseRowsToMap'),/row\.archive_only === true/);
});

function unifiedQueryHarness(){
  const c=vm.createContext({Date,Number,Array,JSON,
    document:{getElementById:()=>null},
    currentFilters:{region:'GLOBAL',topic:'ALL',actor_group:'ALL',period_days:7},
    REPORT_GENERATOR_API_BASE:'https://worker',databaseResults:[],databaseResultsKey:'',
    databaseResultsLoadedAt:0,databaseSourceVersion:'',mapDatabaseVersion:'',databaseQuerySeq:0,
    databaseActivated:false,chronologySelectedKeys:new Set(),chronologyOpen:false,
    databaseQueryPromise:null,databaseLastError:'',databaseLastStatus:'',
    databaseCacheReusable:()=>false,reportGeneratorUserId:()=> 'analyst',
    setDatabaseStatus:()=>{},linkDatabaseRowsToMap:()=>{},renderDatabaseGroups:()=>{},
  });
  vm.runInContext(categoryRuleSource+extract('normalizeActiveEvent')+'function databaseFilters(){ return currentFilters; }'+extract('queryDatabase'),c);
  return c;
}

test('a late mixed response cannot populate the list after the filters change',async()=>{
  const c=unifiedQueryHarness();
  let finish;
  c.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=c.queryDatabase();
  c.currentFilters={...c.currentFilters,topic:'Arrests'};
  finish({ok:true,json:async()=>({events:[{key:'db-0',title:'Incident'},{key:'bg-0',title:'Nuclear policy',archive_only:true}],total:2})});
  await pending;
  assert.equal(c.databaseResults.length,0);
});

test('the normal match counter includes context and reports incomplete archive access explicitly',async()=>{
  const c=unifiedQueryHarness();
  let status;
  c.setDatabaseStatus=text=>{status=text;};
  c.fetch=async()=>({ok:true,json:async()=>({events:[{key:'db-0'},{key:'bg-0',archive_only:true}],total:2,incomplete:false})});
  await c.queryDatabase();
  assert.equal(c.databaseResults.length,2);
  assert.equal(status,'2 records match');
  c.fetch=async()=>({ok:true,json:async()=>({events:[{key:'db-0'}],total:1,incomplete:true})});
  await c.queryDatabase(true);
  assert.match(status,/results incomplete/);
});

test('mixed-list refresh requires prior authenticated panel use, an idle query and no export selection',()=>{
  let now=100000,calls=0;
  const c=vm.createContext({Date:{now:()=>now},databaseActivated:false,databaseQueryPromise:null,
    chronologySelectedKeys:new Set(),databaseResultsLoadedAt:0,DATABASE_RESULTS_CACHE_MS:60000,
    currentFilters:{region:'GLOBAL',topic:'Radiological/Nuclear',actor_group:'ALL'},
    queryDatabase:()=>{calls++;return Promise.resolve();}});
  vm.runInContext('function databaseFilters(){ return currentFilters; }'+extract('databaseRadnucBackgroundScope')+extract('refreshVisibleDatabaseBackground'),c);
  c.refreshVisibleDatabaseBackground();assert.equal(calls,0);
  c.databaseActivated=true;c.databaseResultsLoadedAt=now;c.refreshVisibleDatabaseBackground();assert.equal(calls,0);
  now+=61000;c.chronologySelectedKeys.add('db-0');c.refreshVisibleDatabaseBackground();assert.equal(calls,0);
  c.chronologySelectedKeys.clear();c.databaseQueryPromise={};c.refreshVisibleDatabaseBackground();assert.equal(calls,0);
  c.databaseQueryPromise=null;c.refreshVisibleDatabaseBackground();assert.equal(calls,1);
  c.currentFilters={...c.currentFilters,topic:'ALL'};c.refreshVisibleDatabaseBackground();assert.equal(calls,2);
});

test('an open map ages a RadNuc item out of the 24h badge and marker cache without needless redraws',()=>{
  const h=mapScopeHarness(),c=h.context;
  let now=Date.now(),draws=0,facets=0;
  class Clock extends Date { static now(){return now;} }
  c.Date=Clock;
  c.clockEvents=[
    {id:'expires',_mapKey:'expires',category:'Radiological/Nuclear',published:new Date(now-86400000+30000).toISOString(),latitude:1,longitude:1},
    {id:'stays',_mapKey:'stays',category:'Radiological/Nuclear',published:new Date(now-3600000).toISOString(),latitude:2,longitude:2},
  ];
  Object.assign(c,{
    updateKPIs:()=>{}, updateFacetCounts:()=>{facets=vm.runInContext('mapScopeCandidates().filter(e=>withinDays(e.published,1)).length',c);},
    renderEvents:()=>{draws++;},updateCoverage:()=>{},updateTopLocations:()=>{},renderAttackTicker:()=>{},
    updateTrends:()=>{},updateCommandCenterPanels:()=>{},updateHealthStatusPanel:()=>{},renderHeaderSituationBrief:()=>{},
  });
  vm.runInContext('let dashboardClockMinute = -1; attacks=[];allEvents=[];recentContextEvents=clockEvents;selectedDays=1;setMapCategoryScope("Radiological/Nuclear");invalidateFilterCache();'+extract('refreshTimeSensitiveDashboard'),c);
  assert.equal(vm.runInContext('filteredMappedEvents().length',c),2);
  c.refreshTimeSensitiveDashboard(); assert.equal(facets,2);assert.equal(draws,0);
  now+=61000;
  assert.equal(vm.runInContext('filteredMappedEvents().length',c),2,'the old memo stays stale until the clock refresh');
  c.refreshTimeSensitiveDashboard();
  assert.equal(facets,1);
  assert.deepEqual(plain(vm.runInContext('filteredMappedEvents().map(e=>e.id)',c)),['stays']);
  assert.equal(draws,1);
  c.refreshTimeSensitiveDashboard();assert.equal(draws,1,'same minute does not redraw markers');
  now+=61000;c.refreshTimeSensitiveDashboard();assert.equal(draws,1,'unchanged membership preserves marker state');
  assert.match(html,/refreshDatabaseArchiveTotal\(\);\s*refreshVisibleDatabaseBackground\(\);\s*refreshTimeSensitiveDashboard\(\);/);
});



test('retired Judicial reporting is absent from every selector and category display',()=>{
  for(const id of ['mapCategory','reportTopic']){
    const start=html.indexOf(`<select id="${id}">`);
    const select=html.slice(start,html.indexOf('</select>',start));
    assert.doesNotMatch(select,/Legal \/ Judicial|JUDICIAL/);
  }
  assert.doesNotMatch(html,/"Legal \/ Judicial"|summaryJudicial|className:\s*"legal"|\.chronology-item\.legal/);
});

test('the browser retires court records and preserves real operations, including judicial update phases',()=>{
  const c=vm.createContext({});
  vm.runInContext(categoryRuleSource+extract('normalizeActiveEvent'),c);
  const cases=[
    [{primary_event_type:'JUDICIAL',categories:['Weapons']},true,[]],
    [{primary_event_type:'JUDICIAL'},true,[]],
    [{primary_event_type:'OTHER_CT',categories:['Legal / Judicial']},true,[]],
    [{category:'Legal / Judicial'},true,[]],
    [{primary_event_type:'ARREST',categories:['Legal / Judicial'],event_update_phase:'JUDICIAL_UPDATE'},false,['Arrests']],
    [{primary_event_type:'FINANCING',categories:['Legal / Judicial']},false,['Terrorist Financing']],
    [{primary_event_type:'ATTACK',categories:['Legal / Judicial','Attacks'],is_attack:true},false,['Attacks']],
    [{primary_event_type:'OTHER_CT',categories:['Legal / Judicial','Weapons']},false,['Weapons']],
    [{primary_event_type:'CBRN',categories:['Legal / Judicial'],cbrn_subgroups:['RADNUC'],actor_scope:'NON_STATE'},false,['Radiological/Nuclear']],
  ];
  for(const [event,retired,categories] of cases){
    assert.equal(c.isRetiredJudicialEvent(event),retired,JSON.stringify(event));
    assert.deepEqual(plain(c.eventCategories(event)),categories);
    if(!retired) assert.deepEqual(plain(c.normalizeActiveEvent(event).categories),categories);
  }
});

test('old map files discard retired Judicial rows and remove their counts and development links',async()=>{
  const now=new Date().toISOString();
  const mapFile={
    events:[{id:'attack',title:'Attack',primary_event_type:'ATTACK',is_attack:true,category:'Attacks',published:now}],
    recent_events:[
      {id:'court',title:'Verdict',primary_event_type:'JUDICIAL',categories:['Weapons'],published:now},
      {id:'legacy',title:'Trial',category:'Legal / Judicial',published:now},
      {id:'arrest',title:'Arrest',primary_event_type:'ARREST',categories:['Legal / Judicial'],published:now},
    ],
    map:{source_event_count:4,recent_events_days:181},
    database_summary:{total_events:4,by_category:{Attacks:1,Weapons:1,'Legal / Judicial':2}},
    trend_summary:{developments:[{event_id:'court'},{event_id:'attack'}]},
  };
  const {data,source}=await runLoader({'events-map.json':mapFile});
  assert.equal(source,'events-map.json');
  assert.deepEqual(data.events.map(e=>e.id),['attack']);
  assert.deepEqual(data.recent_events.map(e=>e.id),['arrest']);
  assert.deepEqual(data.recent_events[0].categories,['Arrests']);
  assert.equal(data.map.source_event_count,2);
  assert.equal(data.database_summary.total_events,2);
  assert.ok(!('Legal / Judicial' in data.database_summary.by_category));
  assert.equal(data.database_summary.by_category.Weapons,0);
  assert.deepEqual(data.trend_summary.developments,[{event_id:'attack'}]);
});

test('both lite and full fallbacks reject retired Judicial events and keep operational category matches',async()=>{
  const now=new Date().toISOString();
  const database={events:[
    {id:'court',title:'Verdict',primary_event_type:'JUDICIAL',categories:['Weapons'],published:now},
    {id:'only-court',title:'Sentence',primary_event_type:'OTHER_CT',category:'Legal / Judicial',published:now},
    {id:'arrest',title:'Fresh arrest',primary_event_type:'ARREST',category:'Legal / Judicial',published:now},
    {id:'weapons',title:'Seizure',primary_event_type:'OTHER_CT',categories:['Legal / Judicial','Weapons'],published:now},
  ]};
  for(const file of ['events-lite.json','events.json']){
    const {data,source}=await runLoader({[file]:database});
    assert.equal(source,file);
    assert.deepEqual(data.recent_events.map(e=>e.id),['arrest','weapons']);
    assert.deepEqual(data.recent_events.map(e=>e.categories),[['Arrests'],['Weapons']]);
    assert.equal(data.database_summary.total_events,2);
    assert.deepEqual(data.database_summary.by_category,{Arrests:1,Weapons:1});
  }
});

test('the old all-events map scope cannot show or count judicial records',()=>{
  const h=mapScopeHarness();
  assert.ok(!plain(h.ids('ALL',180)).scope.includes('l1'));
  assert.ok(!plain(vm.runInContext('mapScopeCandidates().map(e=>e.id)',h.context)).includes('l1'));
  assert.equal(plain(h.ids('Legal / Judicial',7)).state,'ATTACKS');
});

test('a stale Worker answer excludes court rows from the list, match counter and export selection',async()=>{
  const c=unifiedQueryHarness();
  let status;
  c.setDatabaseStatus=text=>{status=text;};
  c.fetch=async()=>({ok:true,json:async()=>({events:[
    {key:'db-court',title:'Verdict',primary_event_type:'JUDICIAL',categories:['Weapons']},
    {key:'db-arrest',title:'Arrest',primary_event_type:'ARREST',categories:['Legal / Judicial']},
    {key:'bg-rad',title:'Nuclear regulation',categories:['Radiological/Nuclear'],archive_only:true},
  ],total:3})});
  await c.queryDatabase();
  assert.deepEqual(plain(c.databaseResults.map(e=>e._mapKey)),['db-arrest','bg-rad']);
  assert.deepEqual(plain(c.databaseResults[0].categories),['Arrests']);
  assert.equal(status,'2 records match');
  c.databaseResultsCurrent=()=>true;
  c.chronologySelectedKeys=new Set(['db-court','db-arrest','bg-rad']);
  // Guard a selection made before the Worker update as well.
  c.databaseResults.push({_mapKey:'db-court',primary_event_type:'JUDICIAL'});
  vm.runInContext(extract('selectedDatabaseEvents'),c);
  assert.deepEqual(plain(c.selectedDatabaseEvents().map(e=>e._mapKey)),['db-arrest','bg-rad']);
});
