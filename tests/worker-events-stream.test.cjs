const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');

// The Worker parses the events database from its byte stream, one event at a time, because
// response.json() held the whole text beside the parsed records: with the text on the V8
// heap, 144 MB for a 42.8 MB file against a 128 MB limit shared by concurrent requests, and
// already 144 MB for the full events.json it falls back to. These tests hold the reader to
// what JSON.parse returns on the real files, and the read path to its memory at plateau size.

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

// ---------------------------------------------------------------- memory

// Node keeps a long decoded string off the V8 heap, so the heap limits below see the parsed
// records but not the text of a whole-file read. This sees the text, on any engine.
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

// 3.4 x the 6,381 events of 2026-11-06, the size the 180-day window settles at. It is a fixed
// number so that the test does not tighten as the database grows. Real events are repeated
// under new ids, which costs the same heap: JSON.parse does not share long strings.
const PLATEAU_EVENTS=21700;
// The read needs 64 MB at plateau and two parsed copies need 112, so a second copy held
// through a version refresh breaks this limit.
const READ_LIMIT_MB=96;
// The Database list keeps its rows beside the records: 96 MB at plateau.
const LIST_LIMIT_MB=128;
// The fallback keeps every field but related_articles, also 96 MB at plateau: keeping that
// field too is what breaks this limit.
const FALLBACK_LIMIT_MB=128;

const MEMORY_CHILD=String.raw`
const fs=require('node:fs'),vm=require('node:vm');
const [,file,mode]=process.argv;
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
const shared=vm.createContext({crypto,TextEncoder,TextDecoder,console,URL,Intl,Response,fetch:fetchFile});
vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),shared);
const env={EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json',ALLOWED_ORIGIN:'https://x.test'};
async function list(){
 const text=fs.readFileSync('cloudflare-worker/database-query.js','utf8');
 const names=text.match(/^import\s*\{([\s\S]*?)\}\s*from\s*"\.\/shared.js"/m)[1].split(',').map(name=>name.trim()).filter(Boolean);
 const imported=Object.fromEntries(names.map(name=>[name,vm.runInContext(name,shared)]));
 const context=vm.createContext({...imported,Intl,console,isAllowedUser:()=>true,gateCall:async()=>({ok:true,json:async()=>({username:'group-p-1'})})});
 vm.runInContext(strip(text),context);
 const request={json:async()=>({user_id:'group-p-1',period_days:180}),headers:new Headers({'X-Session-Token':'s'})};
 const response=await context.handleDatabaseEvents(request,env);
 const body=await response.text();
 if(response.status!==200)throw new Error('status '+response.status);
 return Number(body.slice(0,800).match(/"database_total":(\d+)/)[1]);
}
async function read(){
 const fetchEventsDatabase=vm.runInContext('fetchEventsDatabase',shared);
 // A version newer than the file makes load() read it a second time, on the versioned URL.
 const result=await fetchEventsDatabase(env,mode==='refresh'?{minVersion:'2999-01-01T00:00:00Z'}:{});
 if(mode==='refresh')return result.ok?-1:0;
 if(!result.ok)throw new Error('read failed');
 globalThis.keep=result;
 return result.db.events.length;
}
(mode==='list'?list():read()).then(count=>console.log('events='+count),error=>{console.error(error);process.exit(2);});
`;

function underHeapLimit(limit,file,mode){
 return spawnSync(process.execPath,[`--max-old-space-size=${limit}`,'--max-semi-space-size=4','-e',MEMORY_CHILD,file,mode],{encoding:'utf8',timeout:120000,maxBuffer:1<<24});
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

test(`the read fits ${READ_LIMIT_MB} MB of heap at 3.4 times the size of 2026-11-06`,()=>{
 const file=plateau();
 assert.ok(fs.statSync(file).size>40e6,`${fs.statSync(file).size} bytes is not the plateau file`);
 const run=underHeapLimit(READ_LIMIT_MB,file,'read');
 assert.equal(run.status,0,run.stderr.slice(-600));
 assert.match(run.stdout,new RegExp(`events=${PLATEAU_EVENTS}\\b`));
});

test('a version refresh does not hold two parsed copies at once',()=>{
 const run=underHeapLimit(READ_LIMIT_MB,plateau(),'refresh');
 assert.equal(run.status,0,run.stderr.slice(-600));
 assert.match(run.stdout,/events=0\b/,'the stale copy must not be served');
});

test(`the Database list, the heaviest caller, fits ${LIST_LIMIT_MB} MB at the same size through the real read`,()=>{
 const run=underHeapLimit(LIST_LIMIT_MB,plateau(),'list');
 assert.equal(run.status,0,run.stderr.slice(-600));
 assert.match(run.stdout,new RegExp(`events=${PLATEAU_EVENTS}\\b`));
});

test(`the fallback to the pretty-printed events.json fits ${FALLBACK_LIMIT_MB} MB at the same size`,()=>{
 const file=path.join(dir,'plateau-full.json');
 writePlateau(file,fullBytes,2);
 const run=underHeapLimit(FALLBACK_LIMIT_MB,file,'fallback');
 assert.equal(run.status,0,run.stderr.slice(-600));
 assert.match(run.stdout,new RegExp(`events=${PLATEAU_EVENTS}\\b`));
});
