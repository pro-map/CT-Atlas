const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');

// The Worker parses the events database from its byte stream, one event at a time, because
// response.json() held the whole text beside the parsed records: with the text on the V8
// heap, 144 MB for a 42.8 MB file against a 128 MB limit shared by concurrent requests, and
// already 144 MB for the full events.json it falls back to. The Database list goes out the same
// way, a batch of rows at a time, and reports let the records go before they wait on the model.
// These tests hold the reader to what JSON.parse returns on the real files, the list to the
// bytes of one JSON.stringify, and all of them to their memory at plateau size.

const source=fs.readFileSync('cloudflare-worker/shared.js','utf8').replace(/export /g,'');
// Results and errors are built inside the vm realm: compare plain data, and errors by name.
const plain=value=>JSON.parse(JSON.stringify(value));
const isSyntaxError=error=>error?.name==='SyntaxError';

function worker(fetch=async()=>({})){
 const c=vm.createContext({crypto,TextEncoder,TextDecoder,console,URL,fetch});
 vm.runInContext(source,c);
 return {parse:vm.runInContext('parseEventsStream',c),fetchEventsDatabase:vm.runInContext('fetchEventsDatabase',c)};
}
const parse=body=>worker().parse(body);

// Cycles through sizes that put boundaries inside strings, escapes and multi-byte characters.
const UNEVEN=[1021,1,8191,2,4093,3,16384,5];
function bodyOf(bytes,sizes=UNEVEN){
 let at=0,turn=0;
 return new ReadableStream({pull(controller){
  if(at>=bytes.length){controller.close();return;}
  const size=sizes[turn++%sizes.length];
  controller.enqueue(new Uint8Array(bytes.subarray(at,at+size)));
  at+=size;
 }});
}
const textBody=(text,sizes)=>bodyOf(Buffer.from(text),sizes);

// Event by event, so that a difference is reported in seconds, not as a diff of the whole file.
function assertSameDatabase(got,expected){
 assert.deepEqual(Object.keys(got),Object.keys(expected));
 assert.equal(got.events.length,expected.events.length);
 got.events.forEach((event,index)=>assert.deepEqual(event,expected.events[index],`event #${index}`));
 for(const key of Object.keys(expected))if(key!=='events')assert.deepEqual(got[key],expected[key],key);
}

let dir;
let fullBytes;
let liteBytes;

function findPython(){
 for(const name of ['python3','python','py']){
  const r=spawnSync(name,['--version'],{encoding:'utf8'});
  if(!r.error&&r.status===0)return name;
 }
 return null;
}

before(()=>{
 const python=findPython();
 assert.ok(python,'python is required to build events-lite.json');
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'events-stream-'));
 const output=path.join(dir,'events-lite.json');
 const run=spawnSync(python,['tools/build_events_lite.py','--input','events.json','--output',output],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr||run.stdout);
 liteBytes=fs.readFileSync(output);
 fullBytes=fs.readFileSync('events.json');
});

after(()=>fs.rmSync(dir,{recursive:true,force:true}));

// ---------------------------------------------------------------- same result as JSON.parse

test('the real lite file comes back exactly as JSON.parse returns it, keys after "events" included',async()=>{
 const expected=JSON.parse(liteBytes.toString('utf8'));
 const keys=Object.keys(expected);
 assert.ok(keys.indexOf('events')<keys.length-1,'the real file must have a key after events');
 assertSameDatabase(plain(await parse(bodyOf(liteBytes))),expected);
});

test('the real pretty-printed events.json comes back the same, without related_articles',async()=>{
 const expected=JSON.parse(fullBytes.toString('utf8'));
 const keys=Object.keys(expected);
 assert.ok(keys.indexOf('events')<keys.length-1,'the real file must have a key after events');
 assert.ok(expected.events.some(event=>event.related_articles?.length),'the real file must carry the field');
 expected.events=expected.events.map(({related_articles,...kept})=>kept);
 assertSameDatabase(plain(await parse(bodyOf(fullBytes))),expected);
});

const TRICKY=JSON.stringify({
 summary:'events',
 'x"events':[1],
 trend_summary:{events:[{id:'nested'}],'\\':']'},
 labels:['events','[',']'],
 events:[
  {id:'1',title:'\u00e9\u0634\u4e2d\ud83d\ude00',quote:'a"b\\',brackets:'}],{[',nested:[[1,2],{events:[3]}]},
  'text',7,null,true,[1,[2]],{'':0}
 ],
 after:{events:['no']},
 lite:{format:'x'}
},null,1);

test('a chunk boundary is safe at every byte of a character, escape or bracket',async()=>{
 const bytes=Buffer.from(TRICKY);
 const expected=JSON.parse(TRICKY);
 for(let cut=1;cut<bytes.length;cut++){
  assert.deepEqual(plain(await parse(bodyOf(bytes,[cut,bytes.length]))),expected,`split at byte ${cut}`);
 }
 assert.deepEqual(plain(await parse(bodyOf(bytes,[1]))),expected,'one byte at a time');
});

test('"events" is matched as a top-level key only',async()=>{
 for(const [text,expected] of [
  ['{"trend_summary":{"events":[{"id":"nested"}]},"events":[{"id":"real"}]}',['real']],
  ['{"events":[{"id":"real"}],"after":{"events":[{"id":"nested"}]}}',['real']],
  ['{"label":"events","events":[{"id":"real"}]}',['real']],
  ['{"list":["events",":",[{"id":"nested"}]],"events":[{"id":"real"}]}',['real']],
  ['{"ev\\"ents":[{"id":"other"}],"events":[{"id":"real"}]}',['real']]
 ]){
  const got=plain(await parse(textBody(text,[1])));
  assert.deepEqual(got.events.map(event=>event.id),expected,text);
  assert.deepEqual(got,JSON.parse(text),text);
 }
});

test('any JSON spacing is accepted',async()=>{
 for(const text of [
  '{ "events" : [ {"a":1} , {"a":2} ] , "z" : 1 }',
  '\r\n{\n\t"z"\t:\t1,\n\t"events"\r\n:\r\n[\r\n\t{ "a" : 1 }\r\n,\r\n\t{ "a" : 2 }\r\n]\r\n}\r\n',
  '{"events":[ ]}'
 ]){
  for(const sizes of [[1],[3],[text.length]])assert.deepEqual(plain(await parse(textBody(text,sizes))),JSON.parse(text),text);
 }
});

test('the other shapes read() has to judge come through unchanged',async()=>{
 for(const text of ['[{"a":1},{"a":2}]','[]','null','7','"events"','{}','{"events":"nope"}','{"events":null}','{"events":{"a":[1]}}',
  '{"ev\\u0065nts":[1,2]}','{"events":[1,"two",null,[3]]}','{"events":[1],"events":[2,3]}','{"events":[1],"events":[]}','{"events":[1],"events":"x"}']){
  assert.deepEqual(plain(await parse(textBody(text,[2]))),JSON.parse(text),text);
 }
 assert.deepEqual(plain(await parse(bodyOf(Buffer.from('\ufeff{"events":[1]}')))),{events:[1]},'response.json() ignored a byte order mark too');
});

// ---------------------------------------------------------------- never a shorter list

test('a cut-off copy of the real file throws: it can never pass for a shorter list',async()=>{
 for(let i=1;i<16;i++){
  const cut=Math.floor(liteBytes.length*i/16)+i%7;
  await assert.rejects(parse(bodyOf(liteBytes.subarray(0,cut))),isSyntaxError,`cut at byte ${cut}`);
 }
 // The closing bytes matter as much: every event present, the file still incomplete.
 for(const trim of [1,2,100])await assert.rejects(parse(bodyOf(liteBytes.subarray(0,liteBytes.length-trim))),isSyntaxError);
});

test('whatever JSON.parse rejects is rejected',async()=>{
 for(const text of ['','{','[','{"events":[','{"events":[{"a":1}','{"events":[{"a":1},','{"events":[{"a":1}]','{"events":[{"a":1}],"z"',
  '{"events":[1,]}','{"events":[,1]}','{"events":[,]}','{"events":[1 2]}','{"events":[{"a":1]}','{"events":[{"a":1}}','{"events":[1]}x','{"events":[1]} []',
  '[1,]','[1]]','{"a":1,}','{"events":["open]}','{"events":["a\\"]}','<!doctype html>',"{'events':[1]}",'{"events":[1],"z":}']){
  assert.throws(()=>JSON.parse(text),SyntaxError,text);
  for(const sizes of [[1],[text.length||1]])await assert.rejects(parse(textBody(text,sizes)),isSyntaxError,text);
 }
});

test('an unreadable or cut-off lite body falls back to the full file',async()=>{
 const ENV={EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json'};
 const lite=liteBytes.subarray(0,liteBytes.length>>1);
 const failing=new ReadableStream({pull(controller){controller.error(new TypeError('connection lost'));}});
 for(const [label,body] of [['cut off',bodyOf(lite)],['stream failed',failing],['no body',null]]){
  const urls=[];
  const {fetchEventsDatabase}=worker(async url=>{
   urls.push(url);
   return {ok:true,status:200,body:url===ENV.EVENTS_URL?textBody('{"events":[{"id":"full"}],"last_updated":"v"}'):body};
  });
  const result=plain(await fetchEventsDatabase(ENV));
  assert.equal(result.source,'full',label);
  assert.deepEqual(result,{ok:true,status:200,db:{events:[{id:'full'}],last_updated:'v'},source:'full'},label);
  assert.deepEqual(urls,[ENV.EVENTS_LITE_URL,ENV.EVENTS_URL],label);
 }
});

test('a body that turns out malformed is cancelled, not left open for the rest of the request',async()=>{
 let cancelled=false;
 const body=new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode('{"events":[{"id":1} {"id":2},'));},
  cancel(){cancelled=true;}
 });
 await assert.rejects(parse(body),isSyntaxError);
 assert.equal(cancelled,true);
});

// ---------------------------------------------------------------- the Database list

const strip=text=>text.replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'').replace(/export\s*\{[\s\S]*?\};?\s*$/,'').replace(/^export /gm,'');

// The handler as it was when it built the whole answer at once, kept as the reference for every
// byte the stream sends.
const EAGER_LIST=String.raw`
async function eagerList(body,db,env,now){
 const all=db.events;
 const filters=parseDatabaseFilters(body);
 const scoped=all.filter(event=>matchesDatabaseFilters(event,{...filters,actorGroup:'ALL'},now));
 const groupCounts=new Map();
 for(const event of scoped){
  const group=eventActorGroup(event);
  groupCounts.set(group,(groupCounts.get(group)||0)+1);
 }
 const groups=[...groupCounts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([name,count])=>({name,count}));
 const matched=scoped.filter(event=>matchesGroup(event,filters.actorGroup))
  .map(event=>({event,time:parseEventDate(event)?.getTime()||0})).sort((a,b)=>b.time-a.time);
 const backgroundArticles=await fetchRadnucBackground(env,filters,now);
 const rows=[...matched.map((item,index)=>databaseEventRow(item.event,index)),...backgroundArticles.items]
  .sort((a,b)=>(Date.parse(b.published||b.collected_at)||0)-(Date.parse(a.published||a.collected_at)||0));
 const total=matched.length+backgroundArticles.total;
 return JSON.stringify({
  version:DATABASE_QUERY_VERSION,scope:databaseFiltersLabel(filters),
  database_version:cleanText(db?.last_updated||db?.updated_at||'unknown',100),
  database_total:all.length,total,operational_total:matched.length,
  incomplete:backgroundArticles.included&&!backgroundArticles.available,
  truncated:total>MAX_DATABASE_RESULTS,groups,
  events:rows.slice(0,MAX_DATABASE_RESULTS),background_articles:backgroundArticles
 });
}
`;

function listWorker(db,{cap}={}){
 const now=db.last_updated;
 class FixedDate extends Date{
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return Date.parse(now);}
 }
 const shared=vm.createContext({crypto,TextEncoder,TextDecoder,console,URL,Intl,Response,ReadableStream,Date:FixedDate});
 vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
 let text=fs.readFileSync('cloudflare-worker/database-query.js','utf8');
 if(cap)text=text.replace(/const MAX_DATABASE_RESULTS = \d+;/,`const MAX_DATABASE_RESULTS = ${cap};`);
 const names=text.match(/^import\s*\{([\s\S]*?)\}\s*from\s*"\.\/shared.js"/m)[1].split(',').map(name=>name.trim()).filter(Boolean);
 const imported=Object.fromEntries(names.map(name=>[name,vm.runInContext(name,shared)]));
 const context=vm.createContext({...imported,Date:FixedDate,Intl,console,isAllowedUser:()=>true,
  gateCall:async()=>({ok:true,json:async()=>({username:'group-p-1'})}),
  fetchEventsDatabase:async()=>({ok:true,db})});
 vm.runInContext(strip(text)+EAGER_LIST,context);
 const request=body=>({json:async()=>({user_id:'group-p-1',...body}),headers:new Headers({'X-Session-Token':'s'})});
 return {context,now:new FixedDate(),list:(body,env)=>context.handleDatabaseEvents(request(body),env)};
}

function fakeBackground(rows,failure=false){
 return {prepare:()=>({bind:()=>({
  async first(){if(failure)throw new Error('D1 unavailable');return {total:rows.length,added_today_count:1};},
  async all(){if(failure)throw new Error('D1 unavailable');return {success:true,results:rows};}
 })})};
}

test('the list streams the same bytes, status and headers as one JSON.stringify of the whole answer',async()=>{
 const db=JSON.parse(liteBytes.toString('utf8'));
 const env={ALLOWED_ORIGIN:'https://x.test'};
 const country=db.events.find(event=>event.country).country;
 const articles=Array.from({length:700},(_,index)=>({title:`Guidance é中😀 "${index}"`,summary:'Technical guide',source:'IAEA',
  url:index%5?`https://example.test/${index}`:'javascript:alert(1)',
  published:index%7?db.events[index*3].published:'',collected_at:'2026-10-13T10:33:00+00:00',original_language:'en'}));
 for(const [label,body,background,cap] of [
  ['the default list',{period_days:180}],
  ['any date',{}],
  ['a short period',{period_days:7}],
  ['one country',{region:country,period_days:180}],
  ['one category',{topic:'Attacks',period_days:90}],
  ['one group',{actor_group:'Unspecified / no named group',period_days:90}],
  ['nothing matches',{region:'Atlantis',period_days:180}],
  ['archive rows among the events',{period_days:180},fakeBackground(articles)],
  ['archive rows and nothing else',{region:'GLOBAL',topic:'Radiological/Nuclear',period_days:1},fakeBackground(articles)],
  ['an empty archive',{period_days:30},fakeBackground([])],
  ['a failing archive',{period_days:30},fakeBackground([],true)],
  ['a cut list',{period_days:180},fakeBackground(articles),300]
 ]){
  const {context,now,list}=listWorker(db,{cap});
  const full={...env,...(background?{BACKGROUND_DB:background}:{})};
  const expected=Buffer.from(await context.eagerList(body,db,full,now));
  const response=await list(body,full);
  const got=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200,label);
  assert.deepEqual([...response.headers],[...context.jsonResponse({},200,full).headers],label);
  assert.equal(got.length,expected.length,label);
  assert.ok(got.equals(expected),label);
  assert.ok(got.indexOf('"database_total":')<400,label);
 }
});

test('a batch that fails midway leaves a body that never parses, so it cannot pass for a shorter list',async()=>{
 const db=JSON.parse(liteBytes.toString('utf8'));
 const {context,list}=listWorker(db);
 vm.runInContext("const realRow=databaseEventRow;databaseEventRow=(event,index)=>{if(index===1000)throw new Error('row failed');return realRow(event,index);};",context);
 const response=await list({period_days:180},{});
 assert.equal(response.status,200,'the status went out with the first batch');
 const reader=response.body.getReader();
 const received=[];
 // How the read ends is the engine's: Node rejects it, workerd ends the body as if it were whole.
 // Only the parse is the same on both, so only the parse is held here.
 try{for(;;){const {value,done}=await reader.read();if(done)break;received.push(value);}}catch{}
 const partial=Buffer.concat(received);
 assert.ok(partial.length>1000,'the batches before it were sent');
 assert.throws(()=>JSON.parse(partial.toString('utf8')),SyntaxError);
});

test('a client that stops reading stops the list: rows are built only as they are read',async()=>{
 const db=JSON.parse(liteBytes.toString('utf8'));
 const {context,list}=listWorker(db);
 vm.runInContext('globalThis.rowsBuilt=0;const realRow=databaseEventRow;databaseEventRow=(event,index)=>{rowsBuilt++;return realRow(event,index);};',context);
 const batch=vm.runInContext('ROW_BATCH',context);
 assert.ok(db.events.length>10*batch,'the list must be far longer than what may run ahead');
 const reader=(await list({},{})).body.getReader();
 const afterPause=async()=>{
  for(let tick=0;tick<20;tick++)await new Promise(resolve=>setImmediate(resolve));
  return vm.runInContext('rowsBuilt',context);
 };
 await reader.read();
 const paused=await afterPause();
 assert.ok(paused<=2*batch,`${paused} rows built after one read`);
 await reader.read();
 const resumed=await afterPause();
 assert.ok(resumed>paused&&resumed<=3*batch,`${resumed} rows built after two reads`);
 await reader.cancel();
});

// ---------------------------------------------------------------- the report route

const REPORT_ENV={AUTH_USERS_JSON:JSON.stringify({analyst:'a'.repeat(64)}),ALLOWED_ORIGIN:'https://x.test',
 EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json'};

// The real route, up to the gate's answers and the two files.
async function reportRoute(gateAnswers,file){
 const {default:route}=await import(pathToFileURL(path.resolve('cloudflare-worker/index.js')).href);
 const gate=[],reads=[],pending=[];
 const stub={fetch:async(url,init)=>{
  const name=new URL(url).pathname;
  const payload=JSON.parse(init.body);
  gate.push({name,payload});
  const answer=gateAnswers[name]||{ok:true};
  return Response.json(answer,{status:answer.status||200});
 }};
 const env={...REPORT_ENV,REPORT_GATE:{idFromName:()=>'global',get:()=>stub}};
 const realFetch=globalThis.fetch;
 globalThis.fetch=async url=>{reads.push(String(url));return file?{ok:true,status:200,body:bodyOf(file)}:{ok:false,status:503};};
 try{
  const response=await route.fetch(new Request('https://x.test/report',{method:'POST',headers:{'X-Session-Token':'s'},
   body:JSON.stringify({user_id:'analyst',region:'GLOBAL',topic:'ALL',period_days:180})}),env,{waitUntil:promise=>pending.push(promise)});
  await Promise.all(pending);
  return {response,gate,reads};
 }finally{globalThis.fetch=realFetch;}
}
const SESSION={username:'analyst'};

test('a report refused at the gate never parses the database',async()=>{
 const {response,gate,reads}=await reportRoute({'/session-get':SESSION,'/acquire':{status:429,error:'Four reports are already being generated.'}},liteBytes);
 assert.equal(response.status,429);
 assert.deepEqual(reads,[]);
 assert.deepEqual(gate.map(call=>call.name),['/session-get','/acquire']);
});

test('a database that cannot be read answers 503, records the failure and gives the permit back',async()=>{
 const {response,gate,reads}=await reportRoute({'/session-get':SESSION,'/acquire':{permit_id:'permit',log_id:'log'}},null);
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:'Unable to read current events database.'});
 assert.deepEqual(reads,[REPORT_ENV.EVENTS_LITE_URL,REPORT_ENV.EVENTS_URL]);
 assert.deepEqual(gate.map(call=>call.name).sort(),['/acquire','/release','/session-get','/usage-log-update']);
 assert.equal(gate.find(call=>call.name==='/usage-log-update').payload.log_update.outcome,'failed');
});

test('a cached report is served after the gate, on the key of the database version',async()=>{
 const {sha256,REPORT_GENERATOR_VERSION}=await import(pathToFileURL(path.resolve('cloudflare-worker/shared.js')).href);
 const {response,gate}=await reportRoute({'/session-get':SESSION,'/acquire':{permit_id:'permit'},
  '/cache-get':{hit:true,report:{title:'Cached'}}},liteBytes);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{title:'Cached',cached:true});
 assert.deepEqual(gate.map(call=>call.name),['/session-get','/acquire','/cache-get','/commit-report','/usage-increment','/release']);
 const databaseVersion=JSON.parse(liteBytes.toString('utf8')).last_updated;
 const key=await sha256(JSON.stringify({region:'GLOBAL',topic:'ALL',actorGroup:'ALL',periodDays:180,compare:true,databaseVersion,version:REPORT_GENERATOR_VERSION}));
 assert.equal(gate.find(call=>call.name==='/cache-get').payload.cacheKey,key);
 // The selection costs up to a second of CPU at plateau size, and a cached report needs none of it.
 const route=fs.readFileSync('cloudflare-worker/index.js','utf8');
 assert.ok(route.indexOf('"/cache-get"')<route.indexOf('const matching ='),'the cache is asked before the selection');
});

// The real Worker on the real lite file, up to the model. Every record JSON.parse hands out is
// watched, so that a parsed copy held across an await shows, whichever local holds it.
const HELD_CHILD=String.raw`
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const [,file,route]=process.argv;
const bytes=fs.readFileSync(file);
const records=[];
const realParse=JSON.parse;
JSON.parse=function(...args){
 const value=realParse.apply(this,args);
 if(value?.id||Array.isArray(value?.events))records.push(new WeakRef(value));
 return value;
};
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
// A WeakRef pins its target until the current job ends, hence the ticks.
async function held(){
 await tick();
 global.gc();global.gc();
 const count=records.filter(record=>record.deref()).length;
 await tick();
 return count;
}
const languages=[...fs.readFileSync('cloudflare-worker/deep-search.js','utf8').match(/const LANGUAGE_LOCALES = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/^\s*"?([\w-]+)"?: \{/gm)].map(match=>match[1]);
const PLAN={interpreted_request:'Attacks',detected_period:{mode:'relative',relative_days:30},
 queries:Object.fromEntries(languages.map(language=>[language,{primary:'attack news',secondary:'attack reports',anchor:''}]))};
const REPORT={title:'Assessment',analysis:'A paragraph long enough to count as a factual statement of the assessment [S01].'};
const waits=[],seen=new Set();
globalThis.fetch=async(url,options)=>{
 const target=String(url);
 if(/events(-lite)?\.json/.test(target)){
  let at=0;
  return {ok:true,status:200,body:new ReadableStream({pull(controller){
   if(at>=bytes.length)return controller.close();
   controller.enqueue(new Uint8Array(bytes.subarray(at,at+65536)));
   at+=65536;
  }})};
 }
 const model=target.includes('generativelanguage.googleapis.com');
 const planning=model&&realParse(options.body).input.startsWith('Analyst question');
 const on=model?'model':'search';
 if(records.length&&!seen.has(on)){
  seen.add(on);
  waits.push({on,held:await held()});
 }
 if(model)return new Response(JSON.stringify({output_text:JSON.stringify(planning?PLAN:REPORT)}),{status:200});
 return new Response('',{status:503});
};
const gate={fetch:async url=>{
 const name=new URL(url).pathname;
 return Response.json(name==='/session-get'?{username:'analyst'}:name==='/acquire'?{permit_id:'permit'}:name==='/cache-get'?{hit:false}:{ok:true});
}};
const env={AUTH_USERS_JSON:JSON.stringify({analyst:'a'.repeat(64)}),ALLOWED_ORIGIN:'https://x.test',GEMINI_API_KEY:'test',
 EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json',
 REPORT_GATE:{idFromName:()=>'global',get:()=>gate}};
const body=route==='/report'?{user_id:'analyst',region:'GLOBAL',topic:'ALL',period_days:180}:{user_id:'analyst',question:'Recent attacks reported in the Sahel'};
(async()=>{
 const {default:worker}=await import(pathToFileURL(path.resolve('cloudflare-worker/index.js')).href);
 const response=await worker.fetch(new Request('https://x.test'+route,{method:'POST',headers:{'X-Session-Token':'s'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 console.log(JSON.stringify({status:response.status,records:records.length,waits}));
})().catch(error=>{process.stderr.write(String(error?.stack));process.exit(2);});
`;

function heldDuringWaits(file,route){
 const run=spawnSync(process.execPath,['--expose-gc','--no-warnings','-e',HELD_CHILD,file,route],{encoding:'utf8',timeout:300000,maxBuffer:1<<24});
 assert.equal(run.status,0,run.stderr.slice(-600));
 return JSON.parse(run.stdout.trim().split('\n').pop());
}

test('a report holds no parsed record while it waits for the model',()=>{
 const file=path.join(dir,'events-lite.json');
 const {status,records,waits}=heldDuringWaits(file,'/report');
 assert.equal(status,200);
 assert.ok(records>1000,`${records} records watched`);
 assert.deepEqual(waits,[{on:'model',held:0}]);
});

test('Deep Search holds no parsed record while it searches and waits for the model',()=>{
 const file=path.join(dir,'events-lite.json');
 const {status,records,waits}=heldDuringWaits(file,'/deep-search');
 assert.equal(status,200);
 assert.ok(records>1000,`${records} records watched`);
 assert.deepEqual(waits,[{on:'search',held:0},{on:'model',held:0}]);
});

// ---------------------------------------------------------------- memory

// The budgets below measure what is alive at each stage, so a whole-file text dropped before a
// stage does not show there. This sees it, on any engine.
test('JSON.parse never receives more than a small part of a file',async()=>{
 for(const bytes of [liteBytes,fullBytes]){
  const fetch=async()=>new Response(bodyOf(bytes));
  const c=vm.createContext({crypto,TextEncoder,TextDecoder,console,URL,Response,fetch});
  vm.runInContext(source,c);
  vm.runInContext('const realParse=JSON.parse;let largest=0;JSON.parse=text=>{largest=Math.max(largest,text.length);return realParse(text);};',c);
  const result=await vm.runInContext('fetchEventsDatabase',c)({EVENTS_URL:'https://x.test/events.json'});
  assert.equal(result.ok,true);
  const largest=vm.runInContext('largest',c);
  assert.ok(largest>1000&&largest<bytes.length/20,`${largest} characters of a ${bytes.length} byte file`);
 }
});

// 3.35 x the 6,481 events of 2026-11-06, the size the 180-day window settles at. It is a fixed
// number so that the test does not tighten as the database grows. Real events are repeated
// under new ids, which costs the same heap: JSON.parse does not share long strings.
const PLATEAU_EVENTS=21700;

// Live bytes, measured in a child process: a forced full GC at each stage, then heapUsed +
// arrayBuffers + external. External already holds arrayBuffers, so those count twice and the
// sum errs high. An old-space limit cannot do this job: V8 checks it only after a Mark-Compact,
// so the same code passes or crashes on GC timing (19 of 20 runs passed under 96 MB with 162 MB
// live, 9 of 100 crashed at 128 MB). Figures are Node's on the plateau file, not workerd's: each
// budget separates the code as it should be from the regression named beside it, and says
// nothing exact about the Worker's own 128 MB.
// The read: one parsed copy is 62 MB, a second one held through a refresh makes 114.
const READ_BUDGET_MB=88;
// The list: 68 MB, the records plus their selection. Building every row first makes 95, a clone
// of the body in the route 89, and buffering it there 162.
const LIST_BUDGET_MB=80;
// The fallback: 98 MB with every field but related_articles, 160 with that field.
const FALLBACK_BUDGET_MB=128;
// Largest batch sent, and largest text built: a whole answer is 40 MB.
const LIST_PIECE_LIMIT=2e6;

const MEMORY_CHILD=String.raw`
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const [,file,mode]=process.argv;
const stages=[];
function measure(stage,sent=0){
 global.gc();global.gc();
 const {heapUsed,arrayBuffers,external}=process.memoryUsage();
 stages.push({stage,sent,mb:(heapUsed+arrayBuffers+external)/1048576});
}
function fileBody(){
 const fd=fs.openSync(file,'r');
 return new ReadableStream({pull(controller){
  const chunk=new Uint8Array(16384);
  const size=fs.readSync(fd,chunk,0,chunk.length,null);
  if(size)controller.enqueue(chunk.subarray(0,size));
  else{fs.closeSync(fd);controller.close();}
 }});
}
const strip=text=>text.replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'').replace(/export\s*\{[\s\S]*?\};?\s*$/,'').replace(/^export /gm,'');
const fetchFile=async url=>mode==='fallback'&&url.endsWith('lite.json')?{ok:false,status:404}:{ok:true,status:200,body:fileBody()};
const shared=vm.createContext({crypto,TextEncoder,TextDecoder,console,URL,Intl,Response,ReadableStream,fetch:fetchFile,measure});
vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
// The end of a parse is when a copy held from before would sit beside the new one.
vm.runInContext('const realParse=parseEventsStream;let parses=0;parseEventsStream=async body=>{const parsed=await realParse(body);measure("end of parse "+(++parses));return parsed;};',shared);
const env={EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json',ALLOWED_ORIGIN:'https://x.test'};
// The list goes through the real route: anything there that buffers or clones the body counts.
async function list(){
 globalThis.fetch=fetchFile;
 const realStringify=JSON.stringify;
 let largestText=0;
 JSON.stringify=function(...args){const text=realStringify.apply(this,args);largestText=Math.max(largestText,text?.length||0);return text;};
 // Making the streamed Response is the handler's last act: its selection is still in the frame.
 const RealResponse=Response;
 globalThis.Response=class extends RealResponse{constructor(body,init){if(body instanceof ReadableStream)measure('selected');super(body,init);}};
 const gate={fetch:async url=>Response.json(new URL(url).pathname==='/session-get'?{username:'analyst'}:{ok:true})};
 const {default:worker}=await import(pathToFileURL(path.resolve('cloudflare-worker/index.js')).href);
 const response=await worker.fetch(new Request('https://x.test/database-events',{method:'POST',headers:{'X-Session-Token':'s'},body:JSON.stringify({user_id:'analyst',period_days:180})}),
  {...env,AUTH_USERS_JSON:JSON.stringify({analyst:'a'.repeat(64)}),REPORT_GATE:{idFromName:()=>'global',get:()=>gate}},{waitUntil(){}});
 if(response.status!==200)throw new Error('status '+response.status);
 measure('route returned');
 const reader=response.body.getReader();
 let head='',sent=0,batches=0,largestChunk=0;
 for(;;){
  const {value,done}=await reader.read();
  if(done)break;
  if(!head)head=Buffer.from(value.subarray(0,800)).toString();
  sent+=value.length;
  largestChunk=Math.max(largestChunk,value.length);
  if(++batches%8===0)measure('sent',sent);
 }
 measure('all sent',sent);
 return {count:Number(head.match(/"database_total":(\d+)/)[1]),sent,largestChunk,largestText};
}
async function read(){
 const fetchEventsDatabase=vm.runInContext('fetchEventsDatabase',shared);
 // A version newer than the file makes load() read it a second time, on the versioned URL.
 const result=await fetchEventsDatabase(env,mode==='refresh'?{minVersion:'2999-01-01T00:00:00Z'}:{});
 if(mode==='refresh')return {count:result.ok?-1:0};
 if(!result.ok)throw new Error('read failed');
 measure('read');
 return {count:result.db.events.length};
}
(mode==='list'?list():read()).then(result=>console.log(JSON.stringify({...result,stages})),error=>{console.error(error);process.exit(2);});
`;

function liveBytes(file,mode){
 const run=spawnSync(process.execPath,['--expose-gc','-e',MEMORY_CHILD,file,mode],{encoding:'utf8',timeout:300000,maxBuffer:1<<24});
 assert.equal(run.status,0,run.stderr.slice(-600));
 const result=JSON.parse(run.stdout.trim().split('\n').pop());
 const peak=Math.max(...result.stages.map(stage=>stage.mb));
 const trail=result.stages.map(stage=>`${stage.stage} ${stage.mb.toFixed(1)}`).join(', ');
 return {...result,peak,trail};
}

function writePlateau(file,bytes,indent){
 const database=JSON.parse(bytes.toString('utf8'));
 const [head,tail]=JSON.stringify({...database,events:'@@EVENTS@@'},null,indent).split('"@@EVENTS@@"');
 const fd=fs.openSync(file,'w');
 fs.writeSync(fd,head+'[');
 const now=Date.parse(database.last_updated)||Date.now();
 for(let i=0;i<PLATEAU_EVENTS;i++){
  const event=database.events[i%database.events.length];
  const copy=i<database.events.length?event:{...event,id:`${event.id}-${i}`,published:new Date(now-(i%170)*864e5).toISOString()};
  fs.writeSync(fd,(i?',':'')+JSON.stringify(copy,null,indent));
 }
 fs.writeSync(fd,']'+tail);
 fs.closeSync(fd);
}

let plateauFile;
function plateau(){
 if(!plateauFile){
  plateauFile=path.join(dir,'plateau-lite.json');
  writePlateau(plateauFile,liteBytes);
 }
 return plateauFile;
}

test(`the read stays under ${READ_BUDGET_MB} MB at plateau size: one parsed copy`,()=>{
 const file=plateau();
 assert.ok(fs.statSync(file).size>40e6,`${fs.statSync(file).size} bytes is not the plateau file`);
 const {count,peak,trail}=liveBytes(file,'read');
 assert.equal(count,PLATEAU_EVENTS);
 assert.ok(peak<READ_BUDGET_MB,trail);
});

test(`a version refresh stays under ${READ_BUDGET_MB} MB: it never holds two parsed copies`,()=>{
 const {count,peak,trail,stages}=liveBytes(plateau(),'refresh');
 assert.equal(count,0,'the stale copy must not be served');
 assert.ok(stages.length>=2,trail);
 assert.ok(peak<READ_BUDGET_MB,trail);
});

test(`the Database list, the heaviest caller, stays under ${LIST_BUDGET_MB} MB and lets records go as it sends`,()=>{
 const {count,peak,trail,stages,sent,largestChunk,largestText}=liveBytes(plateau(),'list');
 assert.equal(count,PLATEAU_EVENTS);
 assert.equal(stages[0].stage,'selected',trail);
 assert.ok(sent>30e6,`${sent} bytes is not the whole list`);
 assert.ok(peak<LIST_BUDGET_MB,trail);
 assert.ok(largestChunk<LIST_PIECE_LIMIT,`${largestChunk} bytes in one batch`);
 assert.ok(largestText<LIST_PIECE_LIMIT,`${largestText} characters in one text`);
 const halfway=stages.find(stage=>stage.sent>=sent/2);
 assert.ok(halfway.mb<peak*0.75,trail);
});

test(`the fallback to the pretty-printed events.json stays under ${FALLBACK_BUDGET_MB} MB: no related_articles`,()=>{
 const file=path.join(dir,'plateau-full.json');
 writePlateau(file,fullBytes,2);
 const {count,peak,trail}=liveBytes(file,'fallback');
 assert.equal(count,PLATEAU_EVENTS);
 assert.ok(peak<FALLBACK_BUDGET_MB,trail);
});
