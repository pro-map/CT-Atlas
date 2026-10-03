const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const host='a'.repeat(56)+'.onion';
const base='http://'+host+'/';
function harness(){
 const values=new Map();let queue=Promise.resolve();
 const storage={
  async get(key){return structuredClone(values.get(key));},
  async put(key,value){if(typeof key==='object'){for(const [k,v]of Object.entries(key))values.set(k,structuredClone(v));}else values.set(key,structuredClone(value));},
  async delete(key){values.delete(key);},
  async list({prefix='',limit=1000}={}){return new Map([...values].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));},
  transaction(callback){const result=queue.then(()=>callback(storage));queue=result.catch(()=>{});return result;}
 };
 const env={AUTH_USERS_JSON:'{}',DARKWEB_INGEST_TOKEN:'s'.repeat(48),ALLOWED_ORIGIN:'https://ct-atlas.com'};
 const context=vm.createContext({console,Response,Request,URL,TextDecoder,TextEncoder,Uint8Array,Date,JSON,Map,Set,Object,Array,String,Number,Math,crypto,
  cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),
  isAllowedUser:name=>['admin','analyst'].includes(name),
  sha256:async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex')});
 const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'').replace('export class ReportGate','class ReportGate');
 vm.runInContext(gateSource+'\nglobalThis.Gate=ReportGate;',context);
 const gate=new context.Gate({storage},env);
 context.gateCall=async(e,path,body)=>path==='/session-get'?Response.json({username:body.session_token}, {status:['admin','analyst'].includes(body.session_token)?200:401}):gate.fetch(new Request('https://gate'+path,{method:'POST',body:JSON.stringify(body)}));
 const source=fs.readFileSync('cloudflare-worker/darkweb.js','utf8').replace(/^import[^\n]+\n/,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={handleDarkweb,onionUrl};',context);
 async function call(path,body,user='admin',collector=false){const r=await context.api.handleDarkweb(new Request('https://worker'+path,{method:body===undefined?'GET':'POST',headers:collector?{Authorization:'Bearer '+env.DARKWEB_INGEST_TOKEN}:{'X-Session-Token':user},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json(),headers:r.headers};}
 return {call,values,env,api:context.api};
}
async function register(h){const r=await h.call('/darkweb/outlet',{name:'Outlet',url:base,keywords:'Niger, Sahel'});assert.equal(r.status,200);return r.data.outlet.id;}
test('feed requires a valid session; configuration and write privileges cannot be substituted',async()=>{
 const h=harness();assert.equal((await h.call('/darkweb/feed',undefined,'')).status,401);
 assert.equal((await h.call('/darkweb/feed',undefined,'stranger')).status,401);
 assert.equal((await h.call('/darkweb/outlet',{name:'x',url:base},'analyst')).status,403);
 assert.equal((await h.call('/darkweb/collector-config',undefined,'admin')).status,401);
 h.env.DARKWEB_INGEST_TOKEN='short';assert.equal((await h.call('/darkweb/collector-config',undefined,'',true)).status,401);
});
test('URLs reject public sites, embedded credentials, ports and another outlet host',async()=>{
 const h=harness();for(const url of ['https://example.com','http://admin:pass@'+host,'http://'+host+':8080','file://'+host,'http://short.onion'])assert.equal(h.api.onionUrl(url),'');
 const id=await register(h);
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:'http://'+'b'.repeat(56)+'.onion/new.pdf'}],scan_ok:true},'',true)).status,400);
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:id,items:Array(101).fill({url:base}),scan_ok:true},'',true)).status,400);
});
test('complete baseline, new keyword alerts, retries and hash preservation',async()=>{
 const h=harness(),id=await register(h);
 const ingest=items=>h.call('/darkweb/ingest',{outlet_id:id,items,scan_ok:true,scan_complete:true},'',true);
 await ingest([{url:base+'old.pdf',title:'Historical Niger',type:'pdf'}]);
 let state=(await h.call('/darkweb/feed',undefined,'analyst')).data;assert.equal(state.unread_count,0);assert.equal(state.items[0].baseline,true);
 await ingest([{url:base+'new.pdf',title:'Niger report',type:'pdf',acquired:true,sha256:'a'.repeat(64),bytes:123}]);
 const first=(await h.call('/darkweb/feed',undefined,'analyst')).data.items.find(i=>i.url.endsWith('new.pdf')).first_seen;
 await ingest([{url:base+'new.pdf',title:'Niger report',type:'pdf'}]);
 state=(await h.call('/darkweb/feed',undefined,'analyst')).data;
 assert.equal(state.items.length,2);assert.equal(state.unread_count,1);assert.equal(state.keyword_alert_count,1);
 const item=state.items.find(i=>i.url.endsWith('new.pdf'));assert.equal(item.first_seen,first);assert.equal(item.sha256,'a'.repeat(64));assert.equal(item.bytes,123);assert.equal(item.acquired,true);
 const snapshot=state.generated_at;
 await h.call('/darkweb/seen',{through:snapshot},'analyst');
 assert.equal((await h.call('/darkweb/feed',undefined,'analyst')).data.unread_count,0);
 assert.equal((await h.call('/darkweb/feed',undefined,'admin')).data.unread_count,1);
 await h.call('/darkweb/seen',{through:'2020-01-01T00:00:00Z'},'analyst');
 assert.equal((await h.call('/darkweb/feed',undefined,'analyst')).data.seen_through,snapshot);
 assert.equal((await h.call('/darkweb/feed')).headers.get('Cache-Control'),'no-store, private');
});
test('failed or truncated inventories never establish a misleading completed baseline',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[],scan_ok:false,scan_complete:true},'',true);
 let state=(await h.call('/darkweb/feed')).data;assert.equal(state.outlets[0].scan_ok,false);assert.equal(state.outlets[0].initialized_at,undefined);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf'}],scan_ok:true,scan_complete:true,truncated:true},'',true);
 state=(await h.call('/darkweb/feed')).data;assert.equal(state.outlets[0].initialized_at,undefined);assert.equal(state.outlets[0].truncated,true);
});
test('parallel idempotent scans and bounded retention',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[],scan_ok:true,scan_complete:true},'',true);
 await Promise.all(Array.from({length:6},(_,batch)=>h.call('/darkweb/ingest',{outlet_id:id,items:Array.from({length:100},(_,i)=>({url:base+(batch*100+i)+'.pdf'})),scan_ok:true,scan_complete:true},'',true)));
 const state=(await h.call('/darkweb/feed')).data;assert.equal(state.items.length,500);assert.equal(new Set(state.items.map(x=>x.id)).size,500);
 const retained=new Set(state.items.map(x=>x.url));
 const evicted=Array.from({length:600},(_,i)=>base+i+'.pdf').find(url=>!retained.has(url));
 const retry=await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:evicted}],scan_ok:true,scan_complete:true},'',true);
 assert.equal(retry.data.added,0,'An item evicted from the feed is still a known URL, not a new discovery');
});
test('actual body limit rejects chunked oversized JSON',async()=>{
 const h=harness();const r=await h.call('/darkweb/outlet',{name:'x'.repeat(130000),url:base});assert.equal(r.status,413);
});
test('mirror stages every local script and stylesheet used by its static pages',()=>{
 const script=fs.readFileSync('tools/deploy_mirror.sh','utf8');
 const block=script.match(/cp index\.html[\s\S]*?"\$STAGING"\//)[0];
 const staged=block.match(/[\w-]+\.(?:html|json|js|css|svg)\b/g);
 for(const filename of staged)assert.ok(fs.existsSync(filename),'Missing mirror asset: '+filename);
 for(const page of staged.filter(x=>x.endsWith('.html'))){const html=fs.readFileSync(page,'utf8');for(const match of html.matchAll(/(?:src|href)="([^"?]+\.(?:js|css))(?:\?[^"]*)?"/g))if(!match[1].includes('://'))assert.ok(staged.includes(match[1]),page+' requires '+match[1]);}
 assert.ok(staged.includes('report-illustration.js'));
 assert.ok(!staged.includes('quick-ask.js'));
});
