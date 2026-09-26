const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');

// events-lite.json is events.json minus the collector's bookkeeping fields
// (tools/events-lite-excluded-fields.json). These tests prove that removing them changes
// nothing the map, the report generator, Quick Ask or Deep Search produce, and that every
// consumer falls back to the full file when the lite one is unavailable.

const read=file=>fs.readFileSync(file,'utf8');
const excluded=JSON.parse(read('tools/events-lite-excluded-fields.json'));
const fullText=read('events.json');
const full=JSON.parse(fullText);

let liteDir;
let lite;
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
 liteDir=fs.mkdtempSync(path.join(os.tmpdir(),'events-lite-'));
 const output=path.join(liteDir,'events-lite.json');
 const run=spawnSync(python,['tools/build_events_lite.py','--input','events.json','--output',output],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr||run.stdout);
 liteBytes=fs.statSync(output).size;
 lite=JSON.parse(read(output));
});

// ---------------------------------------------------------------- the file itself

test('the lite file is materially smaller than the full database',()=>{
 assert.ok(liteBytes<Buffer.byteLength(fullText)*0.6,`lite ${liteBytes} vs full ${Buffer.byteLength(fullText)}`);
});

test('the lite file has every event, in order, and every top-level key',()=>{
 assert.equal(lite.events.length,full.events.length);
 assert.deepEqual(lite.events.map(e=>e.id),full.events.map(e=>e.id));
 for(const key of Object.keys(full))if(key!=='events')assert.deepEqual(lite[key],full[key],key);
 assert.equal(lite.last_updated,full.last_updated,'the report cache key reads last_updated');
});

test('events lose exactly the excluded fields and nothing else',()=>{
 const drop=new Set(excluded);
 full.events.forEach((event,i)=>{
  const expected=Object.fromEntries(Object.entries(event).filter(([k])=>!drop.has(k)));
  assert.deepEqual(lite.events[i],expected,`event #${i}`);
 });
});

// ---------------------------------------------------------------- nobody reads an excluded field

const consumerFiles=[
 'index.html',
 ...fs.readdirSync('cloudflare-worker').filter(f=>f.endsWith('.js')).map(f=>`cloudflare-worker/${f}`),
 ...fs.readdirSync('.').filter(f=>f.endsWith('.js')||(f.endsWith('.html')&&f!=='index.html'))
];

test('no code of the map, the pages or the Worker reads an excluded field',()=>{
 const offenders=[];
 for(const file of consumerFiles){
  const source=read(file);
  for(const name of excluded){
   const pattern=new RegExp(`\\.${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\]|["'\`]${name}["'\`]\\s*:|\\b${name}\\s*:`);
   if(pattern.test(source))offenders.push(`${file}: ${name}`);
  }
 }
 assert.deepEqual(offenders,[],'these fields are read by code but excluded from events-lite.json');
});

test('the map does not enumerate or spread whole events (which would expose the difference)',()=>{
 const source=read('index.html');
 assert.doesNotMatch(source,/Object\.(keys|entries|values)\(\s*(event|e|item)\s*\)/);
 assert.doesNotMatch(source,/\.\.\.\s*(event|e)\s*[,})]/);
});

// ---------------------------------------------------------------- the Worker gives the same answers

const sharedSource=read('cloudflare-worker/shared.js').replace(/export /g,'');
const quickSource=read('cloudflare-worker/quick-ask.js').replace(/^import[\s\S]*?from "\.\/shared.js";\s*/,'').replace(/export /g,'');
const deepSource=read('cloudflare-worker/deep-search.js')
 .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
 .replace(/export /g,'');

function sharedContext(){
 const c=vm.createContext({crypto,fetch:async()=>({}),TextEncoder,console});
 vm.runInContext(sharedSource,c);
 return c;
}

function moduleContext(shared,source,file){
 const block=read(file).match(/^import\s*\{([\s\S]*?)\}\s*from\s*"\.\/shared.js"/m)[1];
 const names=block.split(',').map(s=>s.trim()).filter(Boolean);
 const injected=Object.fromEntries(names.map(n=>[n,vm.runInContext(`typeof ${n}==='undefined'?undefined:${n}`,shared)]));
 const c=vm.createContext({...injected,fetch:async()=>({}),URL,URLSearchParams,AbortSignal,setTimeout:fn=>fn(),console});
 vm.runInContext(source,c);
 return c;
}

const NOW='2026-09-26T12:00:00Z';

// Same steps as the /report route in cloudflare-worker/index.js, for every region x topic x period.
function reportPipeline(shared,events,regions,topics,periods){
 const run=vm.runInContext(`(function(events,regions,topics,periods,nowText){
  const out=[];
  const now=new Date(nowText);
  for(const region of regions)for(const topic of topics){
   const matching=events.filter(e=>matchesRegion(e,region)&&matchesTopic(e,topic));
   for(const periodDays of periods){
    const currentStart=new Date(now.getTime()-periodDays*86400000);
    const previousStart=new Date(currentStart.getTime()-periodDays*86400000);
    const current=[],previous=[];
    for(const event of matching){
     const dt=parseEventDate(event);
     if(!dt)continue;
     if(dt>=currentStart&&dt<=now)current.push(event);
     else if(dt>=previousStart&&dt<currentStart)previous.push(event);
    }
    current.sort((a,b)=>priority(b)-priority(a));
    previous.sort((a,b)=>priority(b)-priority(a));
    out.push(JSON.stringify({region,topic,periodDays,
     current:current.slice(0,MAX_EVENTS_CURRENT).map(compactEvent),
     previous:previous.slice(0,MAX_EVENTS_PREVIOUS).map(compactEvent),
     currentStats:stats(current),previousStats:stats(previous)}));
   }
  }
  return out;
 })`,shared);
 return run(events,regions,topics,periods,NOW);
}

function reportInputs(shared){
 const regionCodes=vm.runInContext("typeof REPORT_REGION_COUNTRY_CODES==='undefined'?{}:REPORT_REGION_COUNTRY_CODES",shared);
 const perCountry={};
 for(const event of full.events)perCountry[event.country]=(perCountry[event.country]||0)+1;
 const countries=Object.entries(perCountry).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name])=>name);
 const categories=new Set();
 for(const event of full.events){
  if(event.category)categories.add(event.category);
  for(const c of event.categories||[])categories.add(c);
 }
 return {regions:['GLOBAL',...Object.keys(regionCodes),...countries],topics:['ALL',...categories],periods:[7,30,90]};
}

test('report generator: same selection, ranking, statistics and payload from lite as from full',()=>{
 const shared=sharedContext();
 const {regions,topics,periods}=reportInputs(shared);
 const fromFull=reportPipeline(shared,full.events,regions,topics,periods);
 const fromLite=reportPipeline(shared,lite.events,regions,topics,periods);
 assert.equal(fromLite.length,fromFull.length);
 assert.ok(fromFull.length>100);
 const nonEmpty=fromFull.filter(s=>JSON.parse(s).current.length).length;
 assert.ok(nonEmpty>20,'the comparison must exercise real matches');
 for(let i=0;i<fromFull.length;i++)assert.equal(fromLite[i],fromFull[i],`report combination #${i}`);
});

test('the Worker never reads an excluded field, never enumerates a whole event',()=>{
 const shared=sharedContext();
 const accessed=new Set();
 const spy=event=>new Proxy(event,{
  get(target,key){if(typeof key==='string')accessed.add(key);return target[key];},
  has(target,key){if(typeof key==='string')accessed.add(key);return key in target;},
  ownKeys(target){accessed.add('<enumerated>');return Reflect.ownKeys(target);}
 });
 const spied=full.events.map(spy);
 const {regions,topics,periods}=reportInputs(shared);
 reportPipeline(shared,spied,regions,topics,periods);

 const quick=moduleContext(shared,quickSource,'cloudflare-worker/quick-ask.js');
 const matcher=vm.runInContext('(function(events,q){return localEventMatches(events,q).map(compactEvent)})',quick);
 for(const question of QUESTIONS)matcher(spied,question);

 const deep=moduleContext(shared,deepSource,'cloudflare-worker/deep-search.js');
 vm.runInContext("(function(db){return candidateMapEvents(db,{startDt:new Date('2026-09-01T00:00:00Z')})})",deep)({events:spied});

 assert.ok(accessed.has('title')&&accessed.has('country'),'the spy must observe real reads');
 assert.ok(!accessed.has('<enumerated>'),'a whole event is enumerated (spread / Object.keys / JSON.stringify)');
 const read=[...accessed].filter(name=>excluded.includes(name));
 assert.deepEqual(read,[],'the Worker reads these fields, so they must not be excluded');
});

const QUESTIONS=[
 'What happened in Nigeria this week?','attacks in Somalia','ISIS Mozambique','Hamas hostages','al-Shabaab',
 'financing of terrorism Europe','piracy Gulf of Aden','arrests in France','Taliban Afghanistan',
 'cyber terrorism','sanctions OFAC','Sahel JNIM attacks','CBRN threat','Pakistan TTP','Syria ISIS detainees'
];

test('Quick Ask: same grounded records from lite as from full',()=>{
 const shared=sharedContext();
 const quick=moduleContext(shared,quickSource,'cloudflare-worker/quick-ask.js');
 const matcher=vm.runInContext('(function(events,q){return JSON.stringify(localEventMatches(events,q).map(compactEvent))})',quick);
 let matched=0;
 for(const question of QUESTIONS){
  const fromFull=matcher(full.events,question);
  assert.equal(matcher(lite.events,question),fromFull,question);
  if(JSON.parse(fromFull).length)matched++;
 }
 assert.ok(matched>=5,'the comparison must exercise real matches');
});

test('Deep Search: same Atlas records to compare against from lite as from full',()=>{
 const shared=sharedContext();
 const deep=moduleContext(shared,deepSource,'cloudflare-worker/deep-search.js');
 const candidates=vm.runInContext("(function(db){return JSON.stringify(candidateMapEvents(db,{startDt:new Date('2026-09-01T00:00:00Z')}))})",deep);
 const fromFull=candidates({events:full.events});
 assert.ok(JSON.parse(fromFull).length>500);
 assert.equal(candidates(lite),fromFull);
});

// ---------------------------------------------------------------- Worker loading and fallback

function fetchHarness(routes){
 const calls=[];
 const c=vm.createContext({crypto,TextEncoder,console,
  fetch:async(url,options)=>{
   calls.push({url,options:JSON.parse(JSON.stringify(options||null))});
   const route=routes[url];
   if(!route)throw new Error('network down');
   if(route instanceof Error)throw route;
   return route;
  }});
 vm.runInContext(sharedSource,c);
 // Results are built inside the vm realm: normalise them so deepEqual compares plain data.
 return {call:async env=>JSON.parse(JSON.stringify(await vm.runInContext('fetchEventsDatabase',c)(env))),calls};
}
const jsonResponse=(body,ok=true,status=200)=>({ok,status,json:async()=>body});
const brokenJson={ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token');}};
const ENV={EVENTS_URL:'https://x.test/events.json',EVENTS_LITE_URL:'https://x.test/events-lite.json'};
const FULL={events:[{id:'f1',title:'full'}],last_updated:'full'};
const LITE={events:[{id:'l1',title:'lite'}],last_updated:'lite'};

test('fetchEventsDatabase reads the lite file and never touches the full one when it is good',async()=>{
 const h=fetchHarness({[ENV.EVENTS_LITE_URL]:jsonResponse(LITE),[ENV.EVENTS_URL]:jsonResponse(FULL)});
 const result=await h.call(ENV);
 assert.deepEqual(result,{ok:true,status:200,db:LITE,source:'lite'});
 assert.deepEqual(h.calls.map(c=>c.url),[ENV.EVENTS_LITE_URL]);
 assert.deepEqual(h.calls[0].options,{cf:{cacheTtl:60,cacheEverything:true}});
});

test('fetchEventsDatabase falls back to the full file when the lite one is missing or unusable',async()=>{
 const unusable={
  'lite is a 404':jsonResponse({},false,404),
  'lite is a 503':jsonResponse({},false,503),
  'lite is not JSON':brokenJson,
  'lite has no events array':jsonResponse({events:'nope'}),
  'lite has zero events':jsonResponse({events:[]}),
  'lite is null':jsonResponse(null),
  'lite is unreachable':new Error('boom')
 };
 for(const [label,liteRoute] of Object.entries(unusable)){
  const h=fetchHarness({[ENV.EVENTS_LITE_URL]:liteRoute,[ENV.EVENTS_URL]:jsonResponse(FULL)});
  const result=await h.call(ENV);
  assert.deepEqual(result,{ok:true,status:200,db:FULL,source:'full'},label);
  assert.deepEqual(h.calls.map(c=>c.url),[ENV.EVENTS_LITE_URL,ENV.EVENTS_URL],label);
 }
});

test('fetchEventsDatabase uses the full file alone when no lite URL is configured',async()=>{
 const h=fetchHarness({[ENV.EVENTS_URL]:jsonResponse(FULL)});
 const result=await h.call({EVENTS_URL:ENV.EVENTS_URL});
 assert.equal(result.source,'full');
 assert.deepEqual(h.calls.map(c=>c.url),[ENV.EVENTS_URL]);
});

test('fetchEventsDatabase reports failure when the full file is unavailable too',async()=>{
 const h=fetchHarness({[ENV.EVENTS_LITE_URL]:jsonResponse({},false,404),[ENV.EVENTS_URL]:jsonResponse({},false,503)});
 const result=await h.call(ENV);
 assert.deepEqual(result,{ok:false,status:503,db:null,source:'full'});
});

test('the three Worker consumers go through fetchEventsDatabase, not straight to EVENTS_URL',()=>{
 for(const file of ['index.js','quick-ask.js','deep-search.js']){
  const source=read(`cloudflare-worker/${file}`);
  assert.match(source,/fetchEventsDatabase\(env\)/,file);
  assert.doesNotMatch(source,/fetch\(\s*env\.EVENTS_URL/,file);
  assert.match(source.split('} from "./shared.js"')[0],/\bfetchEventsDatabase\b/,`${file} imports it`);
 }
});

test('wrangler.toml points EVENTS_LITE_URL next to EVENTS_URL',()=>{
 const toml=read('cloudflare-worker/wrangler.toml');
 const full=toml.match(/^EVENTS_URL\s*=\s*"([^"]+)"/m)[1];
 const lite=toml.match(/^EVENTS_LITE_URL\s*=\s*"([^"]+)"/m)[1];
 assert.equal(lite,full.replace(/events\.json$/,'events-lite.json'));
});

// ---------------------------------------------------------------- the map

function loaderHarness(routes){
 const html=read('index.html').replace(/\r\n/g,'\n');
 const match=html.match(/function loadEventsDatabase\(\)\s*\{[\s\S]*?\n\}\n/);
 assert.ok(match,'loadEventsDatabase() not found in index.html');
 const calls=[];
 const window={};
 const c=vm.createContext({window,
  fetch:async url=>{
   calls.push(url);
   const route=routes[url];
   if(!route)throw new Error('network down');
   if(route instanceof Error)throw route;
   return route;
  }});
 vm.runInContext(match[0],c);
 return {load:async()=>JSON.parse(JSON.stringify(await vm.runInContext('loadEventsDatabase',c)())),calls,window};
}

test('the map loads events-lite.json first and records which file it used',async()=>{
 const h=loaderHarness({'events-lite.json':jsonResponse(LITE),'events.json':jsonResponse(FULL)});
 assert.deepEqual(await h.load(),LITE);
 assert.deepEqual(h.calls,['events-lite.json']);
 assert.equal(h.window.eventsDataSource,'events-lite.json');
});

test('the map falls back to events.json when the lite file is missing or unusable',async()=>{
 const unusable={
  '404':jsonResponse({},false,404),
  'not JSON':brokenJson,
  'no events':jsonResponse({events:[]}),
  'events is not an array':jsonResponse({events:{}}),
  'null':jsonResponse(null),
  'unreachable':new Error('boom')
 };
 for(const [label,liteRoute] of Object.entries(unusable)){
  const h=loaderHarness({'events-lite.json':liteRoute,'events.json':jsonResponse(FULL)});
  assert.deepEqual(await h.load(),FULL,label);
  assert.deepEqual(h.calls,['events-lite.json','events.json'],label);
  assert.equal(h.window.eventsDataSource,'events.json',label);
 }
});

test('the map still reports an error when neither file can be loaded',async()=>{
 const h=loaderHarness({'events-lite.json':jsonResponse({},false,404),'events.json':jsonResponse({},false,500)});
 await assert.rejects(h.load(),/Unable to load events\.json/);
});

test('events.json is fetched in exactly one place in the map, and the startup chain uses the loader',()=>{
 const html=read('index.html');
 assert.equal((html.match(/fetch\(\s*"events\.json"\s*\)/g)||[]).length,1);
 assert.equal((html.match(/fetch\(\s*"events-lite\.json"\s*\)/g)||[]).length,1);
 assert.match(html,/loadEventsDatabase\(\)\s*\.then\(/);
});

// ---------------------------------------------------------------- publication

test('every workflow that publishes GitHub Pages builds events-lite.json first',()=>{
 const dir='.github/workflows';
 let publishing=0;
 for(const file of fs.readdirSync(dir).filter(f=>/\.ya?ml$/.test(f))){
  const text=read(path.join(dir,file));
  if(!text.includes('upload-pages-artifact'))continue;
  publishing++;
  const build=text.indexOf('./.github/actions/build-events-lite');
  assert.ok(build>=0,`${file} publishes Pages without building events-lite.json`);
  assert.ok(build<text.indexOf('upload-pages-artifact'),`${file} must build events-lite.json BEFORE uploading the site`);
 }
 assert.ok(publishing>=7,'expected the 7 Pages-publishing workflows');
});

test('the build step never fails a deployment and cleans up after itself',()=>{
 const action=read('.github/actions/build-events-lite/action.yml');
 assert.match(action,/python3 tools\/build_events_lite\.py/);
 assert.match(action,/rm -f events-lite\.json/);
 assert.match(action,/::warning::/);
 assert.doesNotMatch(action,/\bexit\s+1\b/);
});

test('events-lite.json is derived, never committed',()=>{
 assert.match(read('.gitignore').replace(/\r\n/g,'\n'),/^events-lite\.json$/m);
});

test('the Cloudflare mirror builds and serves events-lite.json from the events.json it copies',()=>{
 const script=read('tools/deploy_mirror.sh');
 assert.match(script,/python3 tools\/build_events_lite\.py --input events\.json --output "\$STAGING\/events-lite\.json"/);
 assert.match(script,/rm -f "\$STAGING\/events-lite\.json"/);
});

test('the live smoke test rejects a lite file that disagrees with events.json but only warns when it is absent',()=>{
 const smoke=read('.github/workflows/live-smoke.yml');
 const step=smoke.slice(smoke.indexOf('- name: Check lightweight map data'));
 assert.ok(step.length>0,'smoke step missing');
 assert.match(step,/::warning::events-lite\.json is not published/);
 assert.match(step,/last_updated/);
 assert.match(step,/event ids differ/);
});

test('the Worker deployment workflow runs the lite builder tests',()=>{
 assert.match(read('.github/workflows/deploy-report-worker.yml'),/python3 tests\/build_events_lite_test\.py/);
});
