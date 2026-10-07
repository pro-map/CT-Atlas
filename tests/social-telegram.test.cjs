const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('Telegram UI filters retained posts, paginates, escapes content and exports citations',()=>{
  const elements=new Map();
  const document={addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',hidden:false});return elements.get(id);}};
  const context=vm.createContext({document,URL,location:{href:'https://ct-atlas.com/social.html'},window:{}});
  const source=fs.readFileSync('social.js','utf8').replace('})();','globalThis.testing={renderTelegramEvidence,renderTelegramMessages,pdfBlocks,setReport:r=>currentReport=r,showMore:()=>telegramShown+=20};})();');
  vm.runInContext(source,context);
  const h=context.testing;
  const evidence={messages_retained:25,messages_observed:25,channels:[],relationships:[],scope:'Public preview',messages:Array.from({length:25},(_,i)=>({channel:'examplechan',url:`https://t.me/examplechan/${i+1}`,text:i===24?'Needle <img src=x onerror=alert(1)>':'ordinary',date:'2026-10-04',links:[]}))};
  const report={telegram_evidence:evidence};h.setReport(report);h.renderTelegramEvidence(report);
  assert.match(elements.get('reportTelegramCount').textContent,/25 matching posts · showing 20/);
  assert.equal(elements.get('telegramShowMore').hidden,false);
  h.showMore();h.renderTelegramMessages();assert.equal(elements.get('telegramShowMore').hidden,true);
  elements.get('telegramEvidenceSearch').value='needle';h.renderTelegramMessages();
  assert.match(elements.get('reportTelegramCount').textContent,/1 matching posts/);
  assert.ok(!elements.get('reportTelegramMessages').innerHTML.includes('<img'));
  assert.match(elements.get('reportTelegramMessages').innerHTML,/&lt;img/);
  assert.ok(h.pdfBlocks(report).some(block=>block.text.includes('https://t.me/examplechan/25')));
  h.renderTelegramEvidence({});assert.equal(elements.get('reportTelegramSection').hidden,true);
});

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
