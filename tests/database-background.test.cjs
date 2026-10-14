// Authenticated DATABASE background reader: no network or map mutation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const strip=source=>source
  .replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'')
  .replace(/export\s*\{[\s\S]*?\};?\s*$/,'')
  .replace(/^export /gm,'');
const plain=value=>JSON.parse(JSON.stringify(value));
const NOW='2026-10-13T11:00:00.000Z';
class FixedDate extends Date {
  constructor(...args){super(...(args.length?args:[NOW]));}
  static now(){return Date.parse(NOW);}
}

function reader({events=[],allowed=true,session='group-p-1',eventsOk=true}={}){
  const calls={gate:0,events:0};
  const shared=vm.createContext({Date:FixedDate,Intl,Response,console,TextEncoder,crypto:globalThis.crypto});
  vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
  const source=fs.readFileSync('cloudflare-worker/database-query.js','utf8');
  const names=source.match(/^import\s*\{([\s\S]*?)\}\s*from\s*"\.\/shared.js"/m)[1]
    .split(',').map(name=>name.trim()).filter(Boolean);
  const imported=Object.fromEntries(names.map(name=>[name,vm.runInContext(name,shared)]));
  const context=vm.createContext({
    ...imported,Date:FixedDate,Intl,console,
    isAllowedUser:()=>allowed,
    gateCall:async()=>{calls.gate++;return {ok:true,json:async()=>({username:session})};},
    fetchEventsDatabase:async()=>{calls.events++;return {ok:eventsOk,db:{events,last_updated:'event-version'}};}
  });
  vm.runInContext(strip(source),context);
  return {context,calls};
}

function fakeDb({total=1,added=1,rows=[],failure=false}={}){
  const calls=[];
  return {calls,prepare(sql){return {bind(...args){return {
    async first(){calls.push({sql,args,method:'first'});if(failure)throw new Error('D1 unavailable');return {total,added_today_count:added};},
    async all(){calls.push({sql,args,method:'all'});if(failure)throw new Error('D1 unavailable');return {success:true,results:rows};}
  };}};}};
}
const filters={topic:'Radiological/Nuclear',region:'GLOBAL',actorGroup:'ALL',periodDays:1};
const request=(body={},token='session')=>({json:async()=>({user_id:'group-p-1',...body}),headers:new Headers(token?{'X-Session-Token':token}:{})});
const article={title:'Nuclear safety guidance',summary:'A new technical guide was released.',source:'IAEA',url:'https://example.test/guidance',published:'2026-10-13T08:00:00+00:00',collected_at:'2026-10-13T10:33:00+00:00',original_language:'en'};

test('background remains behind the existing session and account authorization',async()=>{
  for(const [setup,token,status] of [[{},'',401],[{allowed:false},'session',400],[{session:'group-p-2'},'session',401]]){
    const {context,calls}=reader(setup);
    const db=fakeDb();
    const response=await context.handleDatabaseEvents(request({topic:filters.topic},token),{BACKGROUND_DB:db});
    assert.equal(response.status,status);
    assert.equal(calls.events,0);
    assert.equal(db.calls.length,0);
  }
});

test('other categories and country/group filters do not invent background locations or actors',async()=>{
  const {context}=reader();
  for(const overrides of [{topic:'Biological'},{region:'France'},{region:'REGION:EUROPE'},{actorGroup:'ISIS'}]){
    const db=fakeDb();
    const result=plain(await context.fetchRadnucBackground({BACKGROUND_DB:db},{...filters,...overrides},new Date(NOW)));
    assert.equal(result.included,false);
    assert.equal(result.available,false);
    assert.deepEqual(result.items,[]);
    assert.equal(db.calls.length,0);
    assert.equal(result.reason,overrides.topic?'category_filter':'scope_filter');
  }
});

test('period uses publication with a collection fallback while added today uses the Paris collection day',async()=>{
  const {context}=reader();
  const db=fakeDb({total:15,added:17,rows:[article]});
  const result=plain(await context.fetchRadnucBackground({BACKGROUND_DB:db},filters,new Date(NOW)));
  assert.equal(result.total,15);
  assert.equal(result.added_today_count,17);
  assert.equal(result.today_date,'2026-10-13');
  assert.equal(db.calls.length,2);
  const count=db.calls.find(call=>call.method==='first');
  const list=db.calls.find(call=>call.method==='all');
  assert.deepEqual(plain(count.args),['2026-10-12T11:00:00.000Z',NOW,'2026-10-12T22:00:00.000Z','2026-10-13T22:00:00.000Z']);
  assert.deepEqual(plain(list.args),['2026-10-12T11:00:00.000Z',NOW]);
  assert.match(count.sql,/julianday\(collected_at\) >= julianday\(\?\)/);
  assert.match(count.sql,/julianday\(collected_at\) < julianday\(\?\)/);
  assert.match(list.sql,/COALESCE\(julianday\(NULLIF\(TRIM\(published\), ''\)\), julianday\(collected_at\)\)/);
  for(const call of db.calls){
    assert.match(call.sql,/kind = 'radnuc_background'/);
    assert.match(call.sql,/category = 'Radiological\/Nuclear'/);
    assert.match(call.sql,/primary_event_type = 'BACKGROUND_INFO'/);
    assert.doesNotMatch(call.sql,/background_articles_fts|related_article/);
  }
});

test('unrestricted publication period does not turn the collection-day count into a rolling count',async()=>{
  const {context}=reader();
  const db=fakeDb({rows:[article]});
  await context.fetchRadnucBackground({BACKGROUND_DB:db},{...filters,periodDays:null},new Date(NOW));
  assert.deepEqual(plain(db.calls.find(call=>call.method==='all').args),[]);
  assert.deepEqual(plain(db.calls.find(call=>call.method==='first').args),['2026-10-12T22:00:00.000Z','2026-10-13T22:00:00.000Z']);
});

test('Paris calendar bounds handle spring and autumn daylight saving changes',()=>{
  const {context}=reader();
  const spring=plain(context.parisDayBounds(new Date('2026-03-29T12:00:00Z')));
  const autumn=plain(context.parisDayBounds(new Date('2026-10-25T12:00:00Z')));
  assert.deepEqual(spring,{date:'2026-03-29',start:'2026-03-28T23:00:00.000Z',end:'2026-03-29T22:00:00.000Z'});
  assert.deepEqual(autumn,{date:'2026-10-25',start:'2026-10-24T22:00:00.000Z',end:'2026-10-25T23:00:00.000Z'});
  assert.equal((Date.parse(spring.end)-Date.parse(spring.start))/3600000,23);
  assert.equal((Date.parse(autumn.end)-Date.parse(autumn.start))/3600000,25);
  const nearMidnight=plain(context.parisDayBounds(new Date('2026-10-12T22:30:00Z')));
  assert.equal(nearMidnight.date,'2026-10-13');
});

test('background rows whitelist text, safe URLs and explicit non-map markers, never coordinates or incident actors',()=>{
  const {context}=reader();
  const result=plain(context.backgroundArticleRow({...article,url:'javascript:alert(1)',country:'France',actor_group:'ISIS',latitude:12,longitude:34,primary_event_type:'ATTACK',kind:'related_article',secret:'ignored'}));
  assert.equal(result.url,'');
  assert.equal(result.archive_only,true);
  assert.equal(result.kind,'radnuc_background');
  assert.equal(result.primary_event_type,'BACKGROUND_INFO');
  assert.deepEqual(result.categories,['Radiological/Nuclear']);
  assert.equal(result.latitude,null);
  assert.equal(result.longitude,null);
  assert.equal(result.country,undefined);
  assert.equal(result.actor_group,undefined);
  assert.equal(result.secret,undefined);
  assert.equal(result.title,article.title);
  assert.equal(result.collected_at,article.collected_at);
});

test('background uses the normal database export cap and reports truncation',async()=>{
  const {context}=reader();
  const db=fakeDb({total:8001,added:8001,rows:Array.from({length:8005},(_,index)=>({...article,title:`Guide ${index}`}))});
  const result=plain(await context.fetchRadnucBackground({BACKGROUND_DB:db},filters,new Date(NOW)));
  assert.equal(result.items.length,8000);
  assert.equal(result.total,8001);
  assert.equal(result.truncated,true);
  assert.match(db.calls.find(call=>call.method==='all').sql,/LIMIT 8000/);
});

test('missing or failing D1 is unavailable instead of an apparently empty archive',async()=>{
  const {context}=reader();
  for(const env of [{},{BACKGROUND_DB:fakeDb({failure:true})}]){
    const result=plain(await context.fetchRadnucBackground(env,filters,new Date(NOW)));
    assert.equal(result.included,true);
    assert.equal(result.available,false);
    assert.equal(result.reason,'unavailable');
    assert.deepEqual(result.items,[]);
  }
});

test('the authenticated response merges background into the same count and selectable rows',async()=>{
  const events=[{id:'event-1',title:'RadNuc suspect arrested',category:'Radiological/Nuclear',actor_group:'Unknown',published:'2026-10-13T09:00:00Z',url:'https://example.test/event'}];
  const {context}=reader({events});
  const db=fakeDb({total:17,added:17,rows:[article]});
  const response=await context.handleDatabaseEvents(request({topic:filters.topic,period_days:1}),{BACKGROUND_DB:db});
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.database_total,1);
  assert.equal(result.total,18);
  assert.equal(result.operational_total,1);
  assert.equal(result.events.length,2);
  assert.equal(result.events[0].title,events[0].title);
  assert.equal(result.groups.reduce((sum,group)=>sum+group.count,0),1);
  assert.equal(result.background_articles.total,17);
  assert.equal(result.background_articles.items[0].title,article.title);
  assert.equal(result.events[1].archive_only,true);
  assert.equal(result.events[1].excluded_from_map,true);
  assert.notEqual(result.events[0].key,result.events[1].key);
  assert.equal(result.incomplete,false);
});

test('All categories includes RadNuc background sorted together by publication date',async()=>{
  const events=[{id:'event-1',title:'Operational event',category:'Arrests',published:'2026-10-13T07:00:00Z'}];
  const {context}=reader({events});
  const response=await context.handleDatabaseEvents(request({topic:'ALL',period_days:1}),{BACKGROUND_DB:fakeDb({rows:[article]})});
  const result=await response.json();
  assert.equal(result.total,2);
  assert.deepEqual(result.events.map(row=>row.title),[article.title,events[0].title]);
  assert.equal(result.events[0].latitude,null);
  assert.equal(result.events[0].actor_group,undefined);
});

test('D1 failure does not fail the event database response',async()=>{
  const {context}=reader({events:[]});
  const response=await context.handleDatabaseEvents(request({topic:filters.topic}),{BACKGROUND_DB:fakeDb({failure:true})});
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.total,0);
  assert.equal(result.background_articles.available,false);
  assert.equal(result.background_articles.reason,'unavailable');
  assert.equal(result.incomplete,true);
});

