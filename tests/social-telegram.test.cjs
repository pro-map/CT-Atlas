const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// The Telegram evidence panel left social.js when the Social workspace was rebuilt for
// OSINT Industries searches (3d1ae9a); its retention and gate behaviour stay tested below.

function gateHarness(){
  const values=new Map();
  const storage={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{assert.ok(Buffer.byteLength(JSON.stringify(value))<128000);values.set(key,structuredClone(value));},delete:async key=>{for(const k of Array.isArray(key)?key:[key])values.delete(k);},list:async({prefix})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),getAlarm:async()=>null,setAlarm:async()=>{}};
  storage.transaction=async fn=>{const snapshot=new Map(values);try{return await fn(storage);}catch(error){values.clear();for(const [k,v]of snapshot)values.set(k,v);throw error;}};
  const context=vm.createContext({Date,JSON,Map,Response,URL,normalizeUsername:s=>s,isAllowedUser:()=>true,cleanText:(s,n)=>String(s||'').slice(0,n)});
  vm.runInContext(fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[^\n]+\n/,'').replace('export class ReportGate','globalThis.ReportGate = class ReportGate'),context);
  return {gate:new context.ReportGate({storage},{}),storage,values};
}

test('large Social histories round-trip, migrate existing data and expire without orphan chunks',async()=>{
  const {gate,values}=gateHarness();const key='social-workspace:tester';
  const now=Date.now();const workspace={reports:[{id:'new',generated_at:new Date(now).toISOString(),text:'é'.repeat(150000)},{id:'old',generated_at:'2020-01-01',text:'x'.repeat(70000)}]};
  values.set(key,{reports:[]});await gate.writeSocialWorkspace(key,workspace);
  assert.equal(values.get(key).format,'social-chunks-v1');
  assert.deepEqual(JSON.parse(JSON.stringify(await gate.readSocialWorkspace(key))),workspace);
  const before=values.size;await gate.purgeExpired(now);
  assert.equal((await gate.readSocialWorkspace(key)).reports.length,1);assert.ok(values.size<before);
  await gate.writeSocialWorkspace(key,{reports:[]});assert.equal(values.size,2);
  assert.equal((await gate.readSocialWorkspace(key)).reports.length,0);
});

test('missing Social chunks fail explicitly rather than silently erasing reports',async()=>{
  const {gate,values}=gateHarness();values.set('social-workspace:tester',{format:'social-chunks-v1',chunks:1});
  await assert.rejects(gate.readSocialWorkspace('social-workspace:tester'),/incomplete/);
});
