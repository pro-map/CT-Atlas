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
  async delete(key){for(const k of Array.isArray(key)?key:[key])values.delete(k);},
  async list({prefix='',limit=1000,reverse=false,end,startAfter}={}){let rows=[...values].filter(([k])=>k.startsWith(prefix)&&(!end||k<end)&&(!startAfter||k>startAfter)).sort(([a],[b])=>a<b?-1:a>b?1:0);if(reverse)rows.reverse();return new Map(rows.slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));},
  transaction(callback){const result=queue.then(()=>callback(storage));queue=result.catch(()=>{});return result;}
 };
 const env={AUTH_USERS_JSON:'{}',DARKWEB_INGEST_TOKEN:'s'.repeat(48),ALLOWED_ORIGIN:'https://ct-atlas.com'};
 const context=vm.createContext({AbortSignal,extractGeminiText:async p=>p.text,console,Response,Request,Headers,URL,TextDecoder,TextEncoder,Uint8Array,Date,JSON,Map,Set,Object,Array,String,Number,Math,crypto,
  cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),
  isAllowedUser:name=>['admin','analyst'].includes(name),
  sha256:async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex')});
 const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'').replace('export class ReportGate','class ReportGate');
 vm.runInContext(gateSource+'\nglobalThis.Gate=ReportGate;',context);
 const gate=new context.Gate({storage},env);
 context.gateCall=async(e,path,body)=>path==='/session-get'?Response.json({username:body.session_token}, {status:['admin','analyst'].includes(body.session_token)?200:401}):gate.fetch(new Request('https://gate'+path,{method:'POST',body:JSON.stringify(body)}));
 const fileSource=fs.readFileSync('cloudflare-worker/darkweb-files.js','utf8').replace(/^import[^\n]+\n/gm,'').replace(/export /g,'');
 vm.runInContext(fileSource,context);
 const source=fs.readFileSync('cloudflare-worker/darkweb.js','utf8').replace(/^import[^\n]+\n/gm,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={handleDarkweb,onionUrl};',context);
 async function call(path,body,user='admin',collector=false){if(path==='/darkweb/ingest' && body)body={selection_version:2,collection_epoch:2,...body,items:Array.isArray(body.items)?body.items.map(i=>({published_at:"2025-06-01",date_basis:"html",...i})):body.items};const r=await context.api.handleDarkweb(new Request('https://worker'+path,{method:body===undefined?'GET':'POST',headers:collector?{Authorization:'Bearer '+env.DARKWEB_INGEST_TOKEN}:{'X-Session-Token':user},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json(),headers:r.headers};}
 return {call,values,env,context,api:context.api};
}
function mockPdfStorage(h){
 const objects=new Map();let writes=0;
 h.context.FixedLengthStream=class{constructor(length){let count=0;return new TransformStream({transform(chunk,controller){count+=chunk.byteLength;if(count>length)throw Error('too long');controller.enqueue(chunk);},flush(){if(count!==length)throw Error('too short');}});}};
 h.env.DARKWEB_FILES={
  async head(key){const o=objects.get(key);return o?{size:o.data.length,customMetadata:o.customMetadata}:null;},
  async get(key){const o=objects.get(key);return o?{size:o.data.length,customMetadata:o.customMetadata,body:new Response(o.data).body}:null;},
  async put(key,stream,options){const data=Buffer.from(await new Response(stream).arrayBuffer());const sha=Buffer.from(await crypto.subtle.digest('SHA-256',data));assert.equal(sha.toString('hex'),Buffer.from(options.sha256).toString('hex'));objects.set(key,{data,customMetadata:options.customMetadata});writes++;return {size:data.length};}
 };
 return {objects,get writes(){return writes;}};
}
async function pdfFixture(h,content='%PDF-1.4\nNeutral test document',number=1){
 const outlets=(await h.call('/darkweb/feed')).data.outlets;
 const outlet=outlets[0]?.id||await register(h),data=Buffer.from(content),hash=Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
 const raw=publication(number,{attachments:[{url:base+'report-'+number+'.pdf',title:'تقرير.pdf',type:'pdf',acquired:true,sha256:hash,bytes:data.length}]});
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:outlet,items:[raw],scan_ok:true},'',true)).status,200);
 const item=(await h.call('/darkweb/archive')).data.items.find(i=>i.url===raw.url);
 const query='?'+new URLSearchParams({id:item.id,sha256:hash,epoch:'2',outlet_id:outlet});
 return {outlet,item,raw,hash,data,query};
}
async function pdfRequest(h,path,f,{user='',collector=false,body,headers={}}={}){
 return h.api.handleDarkweb(new Request('https://worker/darkweb/'+path+f.query,{method:body===undefined?'GET':'POST',headers:{...(collector?{Authorization:'Bearer '+h.env.DARKWEB_INGEST_TOKEN}:{'X-Session-Token':user}),...(body===undefined?{}:{'Content-Type':'application/pdf','Content-Length':String(body.length)}),...headers},...(body===undefined?{}:{body})}),h.env);
}
async function register(h){const r=await h.call('/darkweb/outlet',{name:'Outlet',url:base,keywords:'Niger, Sahel'});assert.equal(r.status,200);return r.data.outlet.id;}
test('feed requires a valid session; configuration and write privileges cannot be substituted',async()=>{
 const h=harness();assert.equal((await h.call('/darkweb/feed',undefined,'')).status,401);
 assert.equal((await h.call('/darkweb/feed',undefined,'stranger')).status,401);
 assert.equal((await h.call('/darkweb/outlet',{name:'x',url:base},'analyst')).status,403);
 assert.equal((await h.call('/darkweb/collector-config',undefined,'admin')).status,401);
 h.env.DARKWEB_INGEST_TOKEN='short';assert.equal((await h.call('/darkweb/collector-config',undefined,'',true)).status,401);
});
test('collector config exposes only Bessira and resumes from its last successful pass',async()=>{
 const h=harness();
 const b=await h.call('/darkweb/outlet',{name:'Bessira',url:base,keywords:''});
 assert.equal(b.status,200);
 const otherHost='b'.repeat(56)+'.onion',otherBase='http://'+otherHost+'/';
 assert.equal((await h.call('/darkweb/outlet',{name:'Other outlet',url:otherBase,keywords:''})).status,200);
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
 const today=`${parts.year}-${parts.month}-${parts.day}`;

 let config=(await h.call('/darkweb/collector-config',undefined,'',true)).data;
 assert.deepEqual(config.outlets.map(o=>o.name),['Bessira']);
 assert.equal(config.outlets[0].collection_phase,'watch');
 assert.equal(config.outlets[0].disable_english_switch,true);
 assert.equal(config.outlets[0].disable_pdf_preview,true);
 assert.equal(config.policy.from,'2025-01-01','Before the first successful pass the retained collection start is used');
 assert.equal(config.policy.through,today);

 await h.call('/darkweb/ingest',{outlet_id:b.data.outlet.id,items:[],scan_ok:true,scan_complete:true},'',true);
 config=(await h.call('/darkweb/collector-config',undefined,'',true)).data;
 assert.equal(config.policy.from,today,'After a successful pass catch-up starts from that pass day');
 assert.equal(config.policy.through,today);
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

test('recursive coverage cannot finalize a baseline with queued or failed pages; excerpts and provenance are bounded',async()=>{
 const h=harness(),id=await register(h);
 const submit=body=>h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'post',title:'Thread',excerpt:'Niger '+ 'x'.repeat(1000),source_page:base}],scan_ok:true,scan_complete:true,...body},'',true);
 await submit({pages_scanned:10,pending_pages:20,failed_pages:1});
 let state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.outlets[0].initialized_at,undefined);
 assert.equal(state.outlets[0].crawl_complete,false);
 assert.equal(state.outlets[0].pending_pages,20);
 assert.equal(state.items[0].excerpt.length,600);
 assert.equal(state.items[0].source_page,base);
 assert.deepEqual(Array.from(state.items[0].keyword_matches),['Niger']);
 await submit({pages_scanned:30,pending_pages:0,failed_pages:0});
 state=(await h.call('/darkweb/feed')).data;
 assert.ok(state.outlets[0].initialized_at);
 assert.equal(state.outlets[0].crawl_complete,true);
});


test('legacy feed is deleted once while outlets, URL history and new selections survive',async()=>{
 const h=harness(), id=await register(h);
 h.values.delete('darkweb:publication-selection-migration:1');
 h.values.set('darkweb:item:legacy',{id:'legacy',first_seen:'2020-01-01',type:'page'});
 h.values.set('darkweb:known:history',{legacy:{first_seen:'2020-01-01'}});
 h.values.set('unrelated:record',{keep:true});
 const state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.items.length,0);assert.equal(state.outlets.length,1);
 assert.equal(h.values.get('darkweb:publication-selection-migration:1').removed,1);
 assert.ok(h.values.has('darkweb:known:history'));assert.ok(h.values.has('unrelated:record'));
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:id,selection_version:0,items:[],scan_ok:true},'',true)).status,409);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'new.pdf',type:'pdf'}],scan_ok:true},'',true);
 assert.equal((await h.call('/darkweb/feed')).data.items.length,1);
 assert.equal((await h.call('/darkweb/feed')).data.items[0].selection_version,2);
});

test('controlled period, pause and reset reject old scans while preserving outlets',async()=>{
 const h=harness(),id=await register(h);
 const submit=items=>h.call('/darkweb/ingest',{outlet_id:id,items,scan_ok:true,scan_complete:true},'',true);
 await submit([{url:base+'old.pdf',published_at:'2024-01-01'},{url:base+'unknown.pdf',published_at:''},{url:base+'invalid.pdf',published_at:'2025-02-30'},{url:base+'future.pdf',published_at:'2099-01-01'},{url:base+'valid.pdf',published_at:'2025-03-10'}]);
 let state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.items.length,1);assert.equal(state.outlets[0].collection_phase,'watch');
 const policy={from:'2025-01-01',through:'2026-12-31',pages_per_scan:10,previews:true};
 assert.equal((await h.call('/darkweb/policy',{...policy,paused:true},'analyst')).status,403);
 await h.call('/darkweb/policy',{...policy,paused:true});assert.equal((await submit([])).status,409);
 await h.call('/darkweb/policy',{...policy,reset:true,paused:false});
 state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.policy.epoch,3);assert.equal(state.items.length,0);assert.equal(state.outlets.length,1);assert.equal(state.outlets[0].collection_phase,'backfill');
 assert.equal((await submit([])).status,409);
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:id,selection_version:1,items:[]},'',true)).status,409);
});

test('Arabic titles decode; thumbnails are authenticated and excluded from the main feed payload',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.mp3',title:'/uploads/%D9%83%D8%AA%D8%A7%D8%A8_%D8%AC%D8%AF%D9%8A%D8%AF.mp3',preview:'data:image/jpeg;base64,/9j/AAAA'}],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/feed')).data.items[0];
 assert.equal(item.title,'كتاب جديد.mp3');assert.equal(item.has_preview,true);assert.equal(item.preview,undefined);
 assert.equal((await h.call('/darkweb/preview?id='+item.id,undefined,'')).status,401);
 assert.equal((await h.call('/darkweb/preview?id='+item.id)).data.preview,'data:image/jpeg;base64,/9j/AAAA');
});

test('AI titles are source-bound, cached, and preserve original text without spending output on a briefing',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='synthetic-test-key';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'كتاب جديد',excerpt:'A publication claim'}],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/feed')).data.items[0];let calls=0;
 h.context.fetch=async(url,options)=>{calls++;const payload=JSON.parse(options.body),input=JSON.parse(payload.input);assert.ok(!payload.input.includes('.onion'));assert.ok(!('summary_requested' in input));assert.match(payload.system_instruction,/Do not produce a briefing/);return Response.json({text:JSON.stringify({titles:[{id:item.id,title:'New book',overview_en:'A neutral overview.'},{id:'invented',title:'Ignore',overview_en:''}]})});};
 assert.equal((await h.call('/darkweb/enrich',{},'analyst')).status,403);
 assert.equal((await h.call('/darkweb/enrich',{})).status,200);
 let state=(await h.call('/darkweb/feed')).data;assert.equal(state.items[0].title_en,'New book');assert.equal(state.items[0].title,'كتاب جديد');assert.equal(state.summary,null);
 await h.call('/darkweb/enrich',{});assert.equal(calls,1);
 // An update to the source invalidates the previous translation.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'Updated source title'}],scan_ok:true},'',true);
 state=(await h.call('/darkweb/feed')).data;assert.equal(state.items[0].title_en,'');
});

test('provider errors preserve original Dark Web titles when translation is unavailable',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='synthetic-test-key';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'Original'}],scan_ok:true},'',true);
 h.context.fetch=async()=>Response.json({text:JSON.stringify({titles:[]})});
 await h.call('/darkweb/enrich',{});assert.equal((await h.call('/darkweb/feed')).data.summary,null);
 h.values.delete('darkweb:enrich-until');h.values.delete('darkweb:enrich-backoff');h.context.fetch=async()=>new Response('',{status:429});
 assert.equal((await h.call('/darkweb/enrich',{})).status,503);
 assert.equal((await h.call('/darkweb/feed')).data.items[0].title,'Original');
});

test('reset during AI generation cannot repopulate the cleared feed',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='synthetic-test-key';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'Original'}],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/feed')).data.items[0];let release,started;
 const ready=new Promise(resolve=>started=resolve);
 h.context.fetch=()=>{started();return new Promise(resolve=>release=resolve);};
 const inFlight=h.call('/darkweb/enrich',{});await ready;
 await h.call('/darkweb/policy',{from:'2025-01-01',through:'2026-12-31',pages_per_scan:10,reset:true});
 release(Response.json({text:JSON.stringify({summary:'Old outlet claim [1]',titles:[{id:item.id,title:'Old translation'}]})}));
 await inFlight;const state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.items.length,0);assert.equal(state.summary,null);
});

function publication(n=1,extra={}){return {url:base+'posts/news/'+n+'/',title:'عنوان عربي '+n,original_text:'الفقرة الأولى\n\nالفقرة الثانية',publication_version:1,category:'news',text_status:'complete',source_date:'3 أكتوبر 2026',published_at:'2026-10-03',attachments:[],...extra};}
test('parser-upgrade backfill remains a baseline even when the legacy inventory was complete',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[],scan_ok:true,scan_complete:true},'',true);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication()],scan_ok:true,inventory_phase:'backfill',pending_pages:12},'',true);
 const state=(await h.call('/darkweb/feed')).data;assert.equal(state.unread_count,0);assert.equal(state.items[0].baseline,true);assert.equal(state.outlets[0].collection_phase,'backfill');
});
test('structured records preserve Arabic paragraphs and group validated attachments behind authentication',async()=>{
 const h=harness(),id=await register(h),raw=publication(1,{title:'ع'.repeat(500),attachments:[{url:base+'report.pdf',type:'pdf',title:'تقرير',acquired:true,sha256:'a'.repeat(64),bytes:40}]});
 const submit=items=>h.call('/darkweb/ingest',{outlet_id:id,items,scan_ok:true},'',true);
 assert.equal((await submit([raw])).status,200);
 const archive=(await h.call('/darkweb/archive')).data;
 assert.equal(archive.items.length,1);assert.equal(archive.items[0].title.length,500);assert.equal(archive.items[0].original_text,undefined);
 const itemId=archive.items[0].id;
 assert.equal((await h.call('/darkweb/item?id='+itemId,undefined,'')).status,401);
 const full=(await h.call('/darkweb/item?id='+itemId,undefined,'analyst')).data.item;
 assert.equal(full.original_text,raw.original_text);assert.equal(full.attachments[0].sha256,'a'.repeat(64));
 assert.equal((await submit([publication(2,{attachments:[{url:'https://example.com/f.pdf',type:'pdf'}]})])).status,400);
 assert.equal((await submit([publication(2,{original_text:'ع'.repeat(24001)})])).status,400);
 // Listing revisits and old collectors cannot overwrite a complete publication.
 await submit([publication(1,{title:'listing',text_status:'listing'})]);
 await submit([{url:raw.url,title:'Legacy excerpt',type:'page'}]);
 assert.equal((await h.call('/darkweb/item?id='+itemId)).data.item.original_text,raw.original_text);
});
test('structured archive retains more than 500 records, paginates by date without duplicates and clears on reset',async()=>{
 const h=harness(),id=await register(h);
 for(let batch=0;batch<6;batch++)await h.call('/darkweb/ingest',{outlet_id:id,items:Array.from({length:90},(_,i)=>publication(batch*90+i,{published_at:i%2?'2025-01-01':'2025-01-02'})),scan_ok:true},'',true);
 const ids=new Set();let cursor='',pages=0,lastDate='9999';
 do{const result=await h.call('/darkweb/archive'+(cursor?'?cursor='+encodeURIComponent(cursor):''));assert.equal(result.status,200);for(const item of result.data.items){assert.ok(item.published_at<=lastDate);lastDate=item.published_at;assert.ok(!ids.has(item.id));ids.add(item.id);}cursor=result.data.next_cursor;pages++;assert.ok(pages<20);}while(cursor);
 assert.equal(ids.size,540);assert.equal((await h.call('/darkweb/feed')).data.items.length,500);
 const firstId=[...ids][0];assert.equal((await h.call('/darkweb/item?id='+firstId)).status,200);
 await h.call('/darkweb/policy',{from:'2025-01-01',through:'2026-12-31',pages_per_scan:10,reset:true});
 assert.equal((await h.call('/darkweb/archive')).data.items.length,0);assert.equal((await h.call('/darkweb/item?id='+firstId)).status,404);
 assert.equal([...h.values.keys()].filter(k=>/^darkweb:publication(?:-index|-pending)?:/.test(k)).length,0);
});
test('English overviews use source text and cannot overwrite newer source contents',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 const submit=raw=>h.call('/darkweb/ingest',{outlet_id:id,items:[raw],scan_ok:true},'',true);
 await submit(publication());const item=(await h.call('/darkweb/archive')).data.items[0];
 h.context.fetch=async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).input);assert.equal(input.titles[0].original_text,'الفقرة الأولى الفقرة الثانية');assert.ok(!options.body.includes(host));return Response.json({text:JSON.stringify({summary:'The outlet published this claim. [1]',titles:[{id:item.id,title:'English title',overview_en:'The source reports a claim.'}]})});};
 await h.call('/darkweb/enrich',{});let full=(await h.call('/darkweb/item?id='+item.id)).data.item;
 assert.equal(full.overview_en,'The source reports a claim.');assert.equal(full.original_text,publication().original_text);
 h.values.delete('darkweb:enrich-until');await submit(publication(1,{original_text:'النص الجديد'}));
 let release,started;const ready=new Promise(r=>started=r);h.context.fetch=()=>{started();return new Promise(r=>release=r);};
 const inflight=h.call('/darkweb/enrich',{});await ready;await submit(publication(1,{original_text:'النص الأحدث'}));
 release(Response.json({text:JSON.stringify({summary:'',titles:[{id:item.id,title:'Stale title',overview_en:'Stale overview'}]})}));await inflight;
 full=(await h.call('/darkweb/item?id='+item.id)).data.item;assert.equal(full.overview_en,'');assert.equal(full.original_text,'النص الأحدث');
});

test('private PDF upload, authenticated download and duplicate retry use one stored object',async()=>{
 const h=harness(),r2=mockPdfStorage(h),f=await pdfFixture(h);
 assert.equal((await pdfRequest(h,'file',f)).status,401);
 assert.equal((await pdfRequest(h,'file-upload',f,{user:'admin',body:f.data})).status,401);
 assert.equal((await pdfRequest(h,'file',f,{collector:true})).status,401);
 assert.equal((await pdfRequest(h,'file',f,{user:'analyst'})).status,404);
 let response=await pdfRequest(h,'file-upload',f,{collector:true,body:f.data});assert.equal(response.status,200);assert.equal((await response.json()).stored,true);
 response=await pdfRequest(h,'file',f,{user:'analyst'});assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.equal(response.headers.get('Cache-Control'),'no-store, private');assert.equal(response.headers.get('Content-Security-Policy'),"sandbox; default-src 'none'");assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.data);
 assert.equal((await (await pdfRequest(h,'file-status',f,{collector:true})).json()).stored,true);
 await pdfRequest(h,'file-upload',f,{collector:true,body:f.data});assert.equal(r2.writes,1);
 const feed=(await h.call('/darkweb/feed')).data;assert.equal(feed.files_storage.files,1);assert.equal(feed.files_storage.stored_bytes,f.data.length);assert.equal(feed.files_storage.reserved_bytes,0);assert.equal(feed.items[0].attachments[0].stored_in_atlas,true);
 await h.call('/darkweb/ingest',{outlet_id:f.outlet,items:[f.raw],scan_ok:true},'',true);
 assert.equal((await h.call('/darkweb/item?id='+f.item.id)).data.item.attachments[0].stored_in_atlas,true);
});

test('private PDF rejects spoofed hashes, invalid bodies, size mismatch and off-collection references',async()=>{
 const h=harness(),r2=mockPdfStorage(h),f=await pdfFixture(h);
 for(const bad of [Buffer.from('not-a-pdf'),Buffer.alloc(f.data.length,65),Buffer.from('%PDF-'+'.'.repeat(f.data.length-5))])assert.notEqual((await pdfRequest(h,'file-upload',f,{collector:true,body:bad})).status,200);
 assert.equal(r2.objects.size,0);
 const forged={...f,query:f.query.replace(f.hash,'b'.repeat(64))};assert.equal((await pdfRequest(h,'file-upload',forged,{collector:true,body:f.data})).status,404);
 const foreign={...f,query:f.query.replace(f.outlet,'f'.repeat(32))};assert.equal((await pdfRequest(h,'file-upload',foreign,{collector:true,body:f.data})).status,409);
 const future={...f,query:f.query.replace('epoch=2','epoch=3')};assert.equal((await pdfRequest(h,'file-upload',future,{collector:true,body:f.data})).status,409);
 assert.equal((await pdfRequest(h,'file-upload',f,{collector:true,body:f.data,headers:{'Content-Type':'text/html'}})).status,400);
 // A collector-supplied hosted flag is not evidence of a completed server upload.
 f.raw.attachments[0].stored_in_atlas=true;
 await h.call('/darkweb/ingest',{outlet_id:f.outlet,items:[f.raw],scan_ok:true},'',true);
 assert.equal((await h.call('/darkweb/archive')).data.items[0].attachments[0].stored_in_atlas,false);
});

test('private PDF quota serializes concurrent uploads and retry after lost acknowledgement',async()=>{
 const h=harness(),r2=mockPdfStorage(h),a=await pdfFixture(h),b=await pdfFixture(h,'%PDF-1.4\nDifferent',2);
 h.values.set('darkweb:files-policy',{limit_bytes:a.data.length});
 const responses=await Promise.all([pdfRequest(h,'file-upload',a,{collector:true,body:a.data}),pdfRequest(h,'file-upload',b,{collector:true,body:b.data})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,507]);assert.equal(r2.objects.size,1);
 let usage=(await h.call('/darkweb/feed')).data.files_storage;assert.ok(usage.stored_bytes+usage.reserved_bytes<=a.data.length);
 // Simulate R2 success followed by a missing commit acknowledgement.
 const c=await pdfFixture(h,'%PDF-1.4\nLost acknowledgement',3);h.values.set('darkweb:files-policy',{limit_bytes:1000000});
 const real=h.context.gateCall;let fail=true;
 h.context.gateCall=(e,path,body)=>path==='/darkweb-file-commit'&&fail?(fail=false,Promise.reject(Error('lost ack'))):real(e,path,body);
 assert.equal((await pdfRequest(h,'file-upload',c,{collector:true,body:c.data})).status,502);
 const before=r2.writes;assert.equal((await pdfRequest(h,'file-upload',c,{collector:true,body:c.data})).status,200);assert.equal(r2.writes,before);
 usage=(await h.call('/darkweb/feed')).data.files_storage;assert.equal(usage.reserved_bytes,0);
});

test('PDF storage permissions, pause, reset and unconfigured storage preserve existing collection',async()=>{
 const h=harness(),r2=mockPdfStorage(h),f=await pdfFixture(h);
 assert.equal((await h.call('/darkweb/storage-policy',{limit_bytes:1000000},'analyst')).status,403);
 assert.equal((await h.call('/darkweb/storage-policy',{limit_bytes:1000000})).status,200);
 await pdfRequest(h,'file-upload',f,{collector:true,body:f.data});
 const policy={from:'2025-01-01',through:'2026-12-31',pages_per_scan:10};
 await h.call('/darkweb/policy',{...policy,paused:true});
 assert.equal((await pdfRequest(h,'file-upload',f,{collector:true,body:f.data})).status,409);
 assert.equal((await pdfRequest(h,'file',f,{user:'analyst'})).status,200);
 await h.call('/darkweb/policy',{...policy,reset:true,paused:false});
 assert.equal((await pdfRequest(h,'file',f,{user:'analyst'})).status,404);
 assert.equal(r2.objects.size,1);assert.equal((await h.call('/darkweb/feed')).data.files_storage.stored_bytes,f.data.length);
 delete h.env.DARKWEB_FILES;
 assert.equal((await h.call('/darkweb/collector-config',undefined,'',true)).data.files_storage.configured,false);
 assert.equal((await pdfRequest(h,'file',f,{user:'analyst'})).status,503);
});

test('existing generated titles are requeued as faithful translations without truncating long titles',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication()],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/archive')).data.items[0];
 const key='darkweb:publication:2:'+item.id;
 h.values.set(key,{...h.values.get(key),title_en:'Invented old heading',overview_en:'Existing overview'});
 h.values.delete('darkweb:publication-pending:2:'+item.id);
 const translated='A faithful translation with details preserved. '.repeat(12);
 h.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.match(body.system_instruction,/faithful English translation/);assert.match(body.system_instruction,/Do not invent, summarize, shorten/);assert.doesNotMatch(body.system_instruction,/produce a concise English title/);assert.doesNotMatch(body.system_instruction,/Arabic/);const input=JSON.parse(body.input);assert.equal(input.titles[0].id,item.id);return Response.json({text:JSON.stringify({summary:'',titles:[{id:item.id,title:translated,overview_en:'A neutral overview.'}]})});};
 assert.equal((await h.call('/darkweb/enrich',{})).status,200);
 const full=(await h.call('/darkweb/item?id='+item.id)).data.item;
 assert.equal(full.title_en,translated.trim());assert.equal(full.title_en_kind,'translation');assert.equal(full.title,item.title);assert.equal(full.original_text,publication().original_text);
 assert.ok(!h.values.has('darkweb:publication-pending:2:'+item.id));
});

test('private PDF handles fragmented signatures and refuses truncated bodies without committing',async()=>{
 const h=harness(),r2=mockPdfStorage(h),f=await pdfFixture(h);
 const requestFor=chunks=>new Request('https://worker/darkweb/file-upload'+f.query,{method:'POST',duplex:'half',headers:{Authorization:'Bearer '+h.env.DARKWEB_INGEST_TOKEN,'Content-Type':'application/pdf','Content-Length':String(f.data.length)},body:new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}})});
 let response=await h.api.handleDarkweb(requestFor([f.data.subarray(0,3),f.data.subarray(3,4)]),h.env);
 assert.equal(response.status,502);assert.equal(r2.objects.size,0);
 response=await h.api.handleDarkweb(requestFor([f.data.subarray(0,2),f.data.subarray(2,4),f.data.subarray(4)]),h.env);
 assert.equal(response.status,200);assert.equal(r2.objects.size,1);
 const duplicate=await pdfFixture(h,f.data.toString(),2);
 assert.equal((await pdfRequest(h,'file-upload',duplicate,{collector:true,body:duplicate.data})).status,200);
 assert.equal((await h.call('/darkweb/feed')).data.files_storage.files,1);
});

const archiveKeys=/^darkweb:(?:item|publication|publication-index|publication-pending|file|known|seen):|^darkweb:files-usage$/;
const archiveSnapshot=h=>new Map([...h.values].filter(([k])=>archiveKeys.test(k)).map(([k,v])=>[k,JSON.stringify(v)]));
test('widening the period keeps the epoch and every stored record; narrowing still requires reset',async()=>{
 const h=harness();mockPdfStorage(h);const f=await pdfFixture(h);
 assert.equal((await pdfRequest(h,'file-upload',f,{collector:true,body:f.data})).status,200);
 await h.call('/darkweb/ingest',{outlet_id:f.outlet,items:[{url:base+'legacy.pdf',title:'Legacy',type:'pdf'}],scan_ok:true},'',true);
 const before=archiveSnapshot(h),limits={pages_per_scan:10,previews:true};
 assert.ok(before.size>5);
 assert.equal((await h.call('/darkweb/policy',{...limits,from:'2025-02-01',through:'2026-12-31'})).status,400);
 assert.equal((await h.call('/darkweb/policy',{...limits,from:'2025-01-01',through:'2026-06-30'})).status,400);
 const direct=await h.context.gateCall(h.env,'/darkweb-policy',{reset:false,policy:{from:'2025-03-01',through:'2026-12-31'}});
 assert.equal(direct.status,400,'The gate refuses narrowing without reset on its own');
 const widened=await h.call('/darkweb/policy',{...limits,from:'2023-01-01',through:'2027-12-31'});
 assert.equal(widened.status,200);assert.equal(widened.data.policy.epoch,2);assert.equal(widened.data.recrawl,true);
 assert.deepEqual(archiveSnapshot(h),before,'Widening neither changes nor removes a stored record');
 const state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.policy.epoch,2);assert.equal(state.policy.from,'2023-01-01');assert.equal(state.policy.through,'2027-12-31');assert.equal(state.items.length,2);
 assert.equal(state.outlets[0].collection_phase,'backfill');assert.equal(state.outlets[0].period_backfill.fresh,false);
 assert.equal((await pdfRequest(h,'file',f,{user:'analyst'})).status,200);
 assert.equal((await h.call('/darkweb/ingest',{outlet_id:f.outlet,items:[publication(7,{published_at:'2023-05-01'})],scan_ok:true,inventory_phase:'backfill'},'',true)).status,200);
 assert.equal((await h.call('/darkweb/archive')).data.items.length,2);
 // A later Through alone, while the period is still running, needs no re-crawl.
 const later=await h.call('/darkweb/policy',{...limits,from:'2023-01-01',through:'2028-12-31'});
 assert.equal(later.data.recrawl,false);assert.equal(later.data.policy.epoch,2);
});
test('a widening backfill ends only after a crawl started after it, and keeps stored alerts',async()=>{
 const h=harness(),id=await register(h);
 const ingest=body=>h.call('/darkweb/ingest',{outlet_id:id,items:[],scan_ok:true,...body},'',true);
 const outlet=async()=>(await h.call('/darkweb/feed')).data.outlets[0];
 await ingest({scan_complete:true,pages_scanned:40,inventory_phase:'watch'});
 await ingest({items:[{url:base+'alert.pdf',title:'Niger alert',type:'pdf'}],pages_scanned:5,pending_pages:3,inventory_phase:'watch'});
 assert.equal((await h.call('/darkweb/feed',undefined,'analyst')).data.keyword_alert_count,1);
 await h.call('/darkweb/policy',{from:'2024-01-01',through:'2026-12-31',pages_per_scan:10,previews:true});
 assert.equal((await outlet()).collection_phase,'backfill');
 // A pass that read the old configuration may restart and complete; that crawl used the old period.
 await ingest({scan_complete:true,pages_scanned:2,inventory_phase:'watch'});
 let o=await outlet();assert.equal(o.collection_phase,'backfill');assert.equal(o.period_backfill.fresh,true);
 await ingest({items:[{url:base+'alert.pdf',title:'Niger alert',type:'pdf'},{url:base+'older.pdf',title:'Older',type:'pdf',published_at:'2024-02-01'}],pages_scanned:10,pending_pages:30,inventory_phase:'backfill'});
 const state=(await h.call('/darkweb/feed',undefined,'analyst')).data;
 assert.equal(state.keyword_alert_count,1,'A backfill revisit does not clear a stored alert');
 assert.equal(state.items.find(i=>i.url.endsWith('alert.pdf')).baseline,false);assert.equal(state.items.find(i=>i.url.endsWith('older.pdf')).baseline,true);
 await ingest({scan_complete:true,pages_scanned:45,inventory_phase:'backfill'});
 o=await outlet();assert.equal(o.collection_phase,'watch');assert.equal(o.period_backfill,undefined);
});
test('a crawl restarted with the widened configuration is recognised; an outlet still in backfill waits one report',async()=>{
 const h=harness(),id=await register(h);
 const ingest=body=>h.call('/darkweb/ingest',{outlet_id:id,items:[],scan_ok:true,...body},'',true);
 const outlet=async()=>(await h.call('/darkweb/feed')).data.outlets[0];
 const widen=()=>h.call('/darkweb/policy',{from:'2024-01-01',through:'2026-12-31',pages_per_scan:10,previews:true});
 await ingest({scan_complete:true,pages_scanned:40,inventory_phase:'watch'});
 await ingest({pages_scanned:20,pending_pages:4,inventory_phase:'watch'});
 await widen();
 await ingest({pages_scanned:3,pending_pages:9,inventory_phase:'watch'});
 assert.equal((await outlet()).period_backfill.fresh,false,'A restart under the old configuration does not count');
 await ingest({pages_scanned:2,pending_pages:9,inventory_phase:'backfill'});
 assert.equal((await outlet()).period_backfill.fresh,true);
 await ingest({scan_complete:true,pages_scanned:40,inventory_phase:'backfill'});
 assert.equal((await outlet()).collection_phase,'watch');
 const h2=harness(),id2=await register(h2);
 const ingest2=body=>h2.call('/darkweb/ingest',{outlet_id:id2,items:[],scan_ok:true,...body},'',true);
 await ingest2({pages_scanned:30,pending_pages:5,inventory_phase:'backfill'});
 await h2.call('/darkweb/policy',{from:'2024-01-01',through:'2026-12-31',pages_per_scan:10,previews:true});
 await ingest2({pages_scanned:2,pending_pages:5,inventory_phase:'backfill'});
 let o=(await h2.call('/darkweb/feed')).data.outlets[0];assert.equal(o.period_backfill.fresh,false);
 await ingest2({scan_complete:true,pages_scanned:12,inventory_phase:'backfill'});
 o=(await h2.call('/darkweb/feed')).data.outlets[0];assert.equal(o.collection_phase,'backfill');assert.ok(o.initialized_at);
 await ingest2({scan_complete:true,pages_scanned:12,inventory_phase:'backfill'});
 assert.equal((await h2.call('/darkweb/feed')).data.outlets[0].collection_phase,'watch');
 // Reset clears a pending widening together with the archive it was extending.
 await h2.call('/darkweb/policy',{from:'2023-01-01',through:'2026-12-31',pages_per_scan:10,previews:true});
 await h2.call('/darkweb/policy',{from:'2025-01-01',through:'2026-12-31',pages_per_scan:10,previews:true,reset:true});
 assert.equal((await h2.call('/darkweb/feed')).data.outlets[0].period_backfill,undefined);
});
test('a failed pass still stores received items and PDF hashes without establishing a baseline',async()=>{
 const h=harness(),id=await register(h);
 const raw=publication(3,{attachments:[{url:base+'f.pdf',title:'f',type:'pdf',acquired:true,sha256:'c'.repeat(64),bytes:99}]});
 const r=await h.call('/darkweb/ingest',{outlet_id:id,items:[raw,{url:base+'legacy.pdf',title:'Legacy',type:'pdf',acquired:true,sha256:'d'.repeat(64),bytes:5}],scan_ok:false,scan_complete:true},'',true);
 assert.equal(r.status,200);assert.equal(r.data.ok,true);assert.equal(r.data.added,2);
 const state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.items.length,2);assert.equal(state.outlets[0].scan_ok,false);assert.equal(state.outlets[0].initialized_at,undefined);assert.equal(state.outlets[0].error,'collection_failed');
 assert.equal(state.items.find(i=>i.url.endsWith('legacy.pdf')).sha256,'d'.repeat(64));
 const item=(await h.call('/darkweb/archive')).data.items[0];assert.equal(item.attachments[0].sha256,'c'.repeat(64));assert.equal(item.attachments[0].acquired,true);
 const refused=await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'old.pdf',published_at:'2020-01-01'},{url:base+'ok.pdf'}],scan_ok:true},'',true);
 assert.equal(refused.data.out_of_period,1);assert.equal((await h.call('/darkweb/feed')).data.outlets[0].last_out_of_period,1);
});
test('Dark Web enrichment uses the background model, a Pacific-day cap, backoff and per-record attempts',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';h.env.DARKWEB_ENRICH_DAILY='3';h.env.GEMINI_MODEL='gemini-3.5-flash-lite';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication(1),publication(2)],scan_ok:true},'',true);
 const [first,second]=(await h.call('/darkweb/archive')).data.items.sort((a,b)=>a.url.localeCompare(b.url));
 const models=[];let answer={summary:'',titles:[]},status=200;
 h.context.fetch=async(url,options)=>{models.push(JSON.parse(options.body).model);return status===200?Response.json({text:JSON.stringify(answer)}):new Response('',{status});};
 const unlock=()=>h.values.delete('darkweb:enrich-until');
 const record=item=>h.values.get('darkweb:publication:2:'+item.id);
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
 let t=Date.now(),r=await h.call('/darkweb/enrich',{});
 assert.equal(r.status,200);assert.equal(r.data.enriched,0);assert.deepEqual(models,['gemini-3.1-flash-lite']);
 assert.deepEqual({...h.values.get('darkweb:enrich-ledger')},{day:`${parts.year}-${parts.month}-${parts.day}`,count:1});
 let backoff=h.values.get('darkweb:enrich-backoff');assert.equal(backoff.failures,1);assert.ok(Math.abs(backoff.until-t-900000)<5000);
 assert.equal(record(first).enrich_attempts,1);assert.equal(h.values.get('darkweb:summary-attempt'),undefined);
 assert.equal((await h.call('/darkweb/enrich',{})).data.reason,'lock');unlock();
 assert.equal((await h.call('/darkweb/enrich',{})).data.reason,'backoff');assert.equal(models.length,1);
 // Success resets the backoff; translation is the only AI output retained.
 h.values.set('darkweb:enrich-backoff',{failures:1,until:0});unlock();h.env.DARKWEB_GEMINI_MODEL='gemini-test-model';
 answer={titles:[{id:first.id,title:'English',overview_en:'Neutral overview.'}]};
 r=await h.call('/darkweb/enrich',{});assert.equal(r.data.enriched,1);assert.equal(r.data.summary_updated,undefined);
 assert.equal(models[1],'gemini-test-model');assert.equal(h.values.has('darkweb:enrich-backoff'),false);
 assert.equal((await h.call('/darkweb/feed')).data.summary,null);
 assert.equal(record(second).enrich_attempts,2);assert.ok(!h.values.has('darkweb:publication-pending:2:'+first.id));
 // A provider error backs off without charging the record.
 unlock();status=429;t=Date.now();assert.equal((await h.call('/darkweb/enrich',{})).status,503);
 assert.equal(record(second).enrich_attempts,2);assert.equal(h.values.get('darkweb:enrich-backoff').failures,1);
 assert.deepEqual(models.slice(-4),['gemini-test-model','gemini-3.7-flash','gemini-3.8-flash','gemini-3.5-flash']);
 unlock();h.values.delete('darkweb:enrich-backoff');status=200;
 r=await h.call('/darkweb/enrich',{});assert.equal(r.data.reason,'daily_limit');assert.equal(r.data.daily_limit,3);assert.equal(models.length,6);
 // The backoff doubles up to 6 hours.
 h.values.delete('darkweb:enrich-ledger');h.values.set('darkweb:enrich-backoff',{failures:9,until:0});answer={titles:[]};t=Date.now();
 await h.call('/darkweb/enrich',{});backoff=h.values.get('darkweb:enrich-backoff');assert.equal(backoff.failures,10);assert.ok(Math.abs(backoff.until-t-21600000)<5000);
 // Today's/newest-day record is never permanently stranded by old failed attempts.
 assert.equal(record(second).enrich_attempts,3);assert.ok(h.values.has('darkweb:publication-pending:2:'+second.id));
 unlock();h.values.delete('darkweb:enrich-backoff');
 r=await h.call('/darkweb/enrich',{});assert.equal(r.data.cached,undefined);assert.equal(models.length,8);assert.equal(record(second).enrich_attempts,1);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication(2,{original_text:'نص جديد'})],scan_ok:true},'',true);
 assert.equal(record(second).enrich_attempts,0,'A source change makes the record eligible again');
 unlock();h.values.delete('darkweb:enrich-backoff');h.env.DARKWEB_ENRICH_DAILY='0';assert.equal((await h.call('/darkweb/enrich',{})).data.reason,'daily_limit');
});
test('newest-day translation candidates outrank historical queue order and exhausted attempts are reset',async()=>{
 const h=harness(),id=await register(h);
 for(let batch=0;batch<2;batch++)await h.call('/darkweb/ingest',{outlet_id:id,items:Array.from({length:70},(_,i)=>publication(batch*70+i,{title:'Başlık '+(batch*70+i),original_text:'Kaynak metni',source_language:'tr'})),scan_ok:true},'',true);
 const keys=[...h.values.keys()].filter(k=>k.startsWith('darkweb:publication-pending:2:')).sort();
 assert.equal(keys.length,140);
 for(const key of keys){const archive='darkweb:publication:2:'+h.values.get(key);h.values.set(archive,{...h.values.get(archive),enrich_attempts:3});}
 const result=await (await h.context.gateCall(h.env,'/darkweb-enrich-candidates',{})).json();
 assert.equal(result.newest_day,'2026-10-03');assert.equal(result.items.length,10);
 assert.ok(result.items.every(i=>i.enrich_attempts===0),'Newest-day publications are made retryable again');
 assert.equal([...h.values.keys()].filter(k=>k.startsWith('darkweb:publication-pending:2:')).length,140);
});
test('Arabic archive backfill requeues exhausted untranslated publications once',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication(777,{source_language:'ar'})],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/archive')).data.items[0],archive='darkweb:publication:2:'+item.id;
 h.values.set(archive,{...h.values.get(archive),enrich_attempts:3,title_en:'',title_en_kind:'',overview_en:''});
 const result=await (await h.context.gateCall(h.env,'/darkweb-enrich-candidates',{})).json();
 assert.ok(result.items.some(i=>i.id===item.id));
 assert.equal(h.values.get(archive).enrich_attempts,0);
 assert.equal(h.values.get('darkweb:publication-pending:2:'+item.id),item.id);
});
test('the 500-item feed limit removes archived publication cards before legacy records',async()=>{
 const h=harness(),id=await register(h);
 await h.call('/darkweb/ingest',{outlet_id:id,items:Array.from({length:20},(_,i)=>({url:base+'legacy-'+i+'.pdf',type:'pdf'})),scan_ok:true},'',true);
 for(let batch=0;batch<5;batch++)await h.call('/darkweb/ingest',{outlet_id:id,items:Array.from({length:100},(_,i)=>publication(batch*100+i)),scan_ok:true},'',true);
 const state=(await h.call('/darkweb/feed')).data;
 assert.equal(state.items.length,500);assert.equal(state.items.filter(i=>!i.publication_version).length,20);
 assert.equal([...h.values.keys()].filter(k=>k.startsWith('darkweb:publication:2:')).length,500);
});

test('source_language is validated, optional and kept on feed, archive and detail records',async()=>{
 const h=harness(),id=await register(h);
 const r=await h.call('/darkweb/ingest',{outlet_id:id,items:[
  {url:base+'a.pdf',title:'Rapor',type:'pdf',source_language:'TR'},
  {url:base+'b.pdf',title:'Izvještaj',type:'pdf',source_language:'bs-Latn'},
  {url:base+'c.pdf',title:'Report',type:'pdf',source_language:'english'},
  {url:base+'d.pdf',title:'Numbers',type:'pdf',source_language:12},
  {url:base+'e.pdf',title:'Older collector',type:'pdf'},
  publication(1,{title:'Sınır bölgesinde çatışma',original_text:'Sınır bölgesinde yeni bir çatışma.',source_language:'tr'})],scan_ok:true},'',true);
 assert.equal(r.status,200);
 const feed=(await h.call('/darkweb/feed')).data.items,lang=end=>feed.find(i=>i.url.endsWith(end)).source_language;
 assert.equal(lang('a.pdf'),'tr');
 for(const end of ['b.pdf','c.pdf','d.pdf','e.pdf'])assert.equal(lang(end),undefined,end+' carries no language');
 assert.equal(feed.find(i=>i.publication_version).source_language,'tr');
 const archived=(await h.call('/darkweb/archive')).data.items[0];assert.equal(archived.source_language,'tr');
 assert.equal((await h.call('/darkweb/item?id='+archived.id,undefined,'analyst')).data.item.source_language,'tr');
 // A later pass from an older collector keeps the stored hint and the record.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication(1,{title:'Sınır bölgesinde çatışma',original_text:'Sınır bölgesinde yeni bir çatışma.'})],scan_ok:true},'',true);
 const full=(await h.call('/darkweb/item?id='+archived.id)).data.item;
 assert.equal(full.source_language,'tr');assert.equal(full.content_hash,archived.content_hash);
});
test('a collector that starts sending source_language keeps Arabic translations and content hashes',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication()],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/archive')).data.items[0];
 h.context.fetch=async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).input);assert.equal(input.titles[0].source_language,undefined,'No hint is invented for an older record');return Response.json({text:JSON.stringify({summary:'',titles:[{id:item.id,title:'Arabic title in English',overview_en:'A neutral overview.'}]})});};
 await h.call('/darkweb/enrich',{});
 await h.call('/darkweb/ingest',{outlet_id:id,items:[publication(1,{source_language:'ar'})],scan_ok:true},'',true);
 const full=(await h.call('/darkweb/item?id='+item.id)).data.item;
 assert.equal(full.content_hash,item.content_hash);assert.equal(full.source_language,'ar');
 assert.equal(full.title_en,'Arabic title in English');assert.equal(full.title_en_kind,'translation');assert.equal(full.overview_en,'A neutral overview.');
 assert.ok(!h.values.has('darkweb:publication-pending:2:'+item.id),'Adding the hint does not requeue a translated record');
});
test('English originals keep their title without a title translation, a model call or a ledger unit',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 const english=publication(1,{title:'Statement on the border clash',original_text:'The outlet claims a clash near the border.',source_language:'en'});
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'report.pdf',title:'Annual report',type:'pdf',source_language:'en'},{url:base+'mislabelled.pdf',title:'تقرير سنوي',type:'pdf',source_language:'en'},english],scan_ok:true},'',true);
 let feed=(await h.call('/darkweb/feed')).data.items;const card=end=>feed.find(i=>i.url.endsWith(end));
 assert.equal(card('report.pdf').title_en,'Annual report');assert.equal(card('report.pdf').title_en_kind,'original');
 assert.equal(card('mislabelled.pdf').title_en,'','A title in another script is still translated, whatever the declared language');
 const pub=(await h.call('/darkweb/archive')).data.items[0];
 assert.equal(pub.title_en,english.title);assert.equal(pub.title_en_kind,'original');
 assert.ok(h.values.has('darkweb:publication-pending:2:'+pub.id),'Only the overview remains pending');
 const inputs=[];
 h.context.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.doesNotMatch(body.system_instruction,/Arabic/);assert.match(body.system_instruction,/already in English, return it unchanged/);inputs.push(JSON.parse(body.input));
  return Response.json({text:JSON.stringify({summary:'The outlets make claims that need validation. [1]',titles:[{id:pub.id,title:'Rewritten by the model',overview_en:'The outlet claims a clash.'},{id:card('mislabelled.pdf').id,title:'Annual report'}]})});};
 assert.equal((await h.call('/darkweb/enrich',{})).status,200);
 const requested=inputs[0].titles.map(t=>t.id);
 assert.ok(!requested.includes(card('report.pdf').id),'No title translation is requested for an English original');
 assert.ok(requested.includes(pub.id));assert.equal(inputs[0].titles.find(t=>t.id===pub.id).source_language,'en');
 const full=(await h.call('/darkweb/item?id='+pub.id)).data.item;
 assert.equal(full.title_en,english.title,'The model cannot rewrite an English original');assert.equal(full.title_en_kind,'original');assert.equal(full.overview_en,'The outlet claims a clash.');
 assert.ok(!h.values.has('darkweb:publication-pending:2:'+pub.id));
 feed=(await h.call('/darkweb/feed')).data.items;
 assert.equal(card('mislabelled.pdf').title_en,'Annual report');assert.equal(card('mislabelled.pdf').title_en_kind,'translation');
 assert.equal(card('report.pdf').title_en,'Annual report');assert.equal(card('report.pdf').title_en_kind,'original');
 // Nothing is left to do: no further model call and no further ledger unit.
 h.values.delete('darkweb:enrich-until');
 assert.equal((await h.call('/darkweb/enrich',{})).data.cached,true);assert.equal(inputs.length,1);assert.equal(h.values.get('darkweb:enrich-ledger').count,1);
 // A record no longer declared English loses the "original" title and is queued for translation.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{...english,source_language:'tr'}],scan_ok:true},'',true);
 const relabelled=(await h.call('/darkweb/item?id='+pub.id)).data.item;
 assert.equal(relabelled.title_en,'');assert.equal(relabelled.title_en_kind,'');assert.ok(h.values.has('darkweb:publication-pending:2:'+pub.id));
});
test('an English original relabelled to another language after three failed overviews really reaches the model',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 const english=publication(1,{title:'Statement on the clash',original_text:'Statement on the clash\n\nLe texte reste en français.',source_language:'en'});
 await h.call('/darkweb/ingest',{outlet_id:id,items:[english],scan_ok:true},'',true);
 const pub=(await h.call('/darkweb/archive')).data.items[0],record=()=>h.values.get('darkweb:publication:2:'+pub.id);
 assert.equal(pub.title_en_kind,'original');
 const inputs=[];let answer=input=>({summary:'',titles:input.titles.map(t=>({id:t.id,title:t.title,overview_en:''}))});
 h.context.fetch=async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).input);inputs.push(input);return Response.json({text:JSON.stringify(answer(input))});};
 const unlock=()=>{h.values.delete('darkweb:enrich-until');h.values.delete('darkweb:enrich-backoff');};
 // The model returns no overview three times: the original's attempts are used up.
 for(let k=0;k<3;k++){unlock();await h.call('/darkweb/enrich',{});}
 assert.equal(inputs.length,3);assert.equal(record().enrich_attempts,3);
 unlock();assert.equal((await h.call('/darkweb/enrich',{})).data.cached,true);assert.equal(inputs.length,3);
 // A later pass declares French for the same text: the title is cleared and its attempts start again.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{...english,source_language:'fr'}],scan_ok:true},'',true);
 assert.equal(record().title_en,'');assert.equal(record().title_en_kind,'');assert.equal(record().enrich_attempts,0);
 assert.equal(record().content_hash,pub.content_hash);assert.ok(h.values.has('darkweb:publication-pending:2:'+pub.id));
 answer=input=>({summary:'',titles:input.titles.map(t=>({id:t.id,title:'Statement on the clash',overview_en:'The outlet makes a claim.'}))});
 unlock();assert.equal((await h.call('/darkweb/enrich',{})).data.enriched,1);
 const sent=inputs.at(-1).titles.find(t=>t.id===pub.id);
 assert.ok(sent,'The relabelled title is sent for translation');assert.equal(sent.title,english.title);assert.equal(sent.source_language,'fr');
 assert.equal(record().title_en_kind,'translation');assert.equal(record().overview_en,'The outlet makes a claim.');
 assert.ok(!h.values.has('darkweb:publication-pending:2:'+pub.id));
});
test('source_translation is kept only as "outlet", stays out of the content hash and never requeues a translation',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='test';
 const english=publication(1,{title:'Statement on the border clash',original_text:'The outlet claims a clash near the border.',source_language:'en'});
 const r=await h.call('/darkweb/ingest',{outlet_id:id,items:[
  {url:base+'a.pdf',title:'Report',type:'pdf',source_language:'en',source_translation:'outlet'},
  {url:base+'b.pdf',title:'Report',type:'pdf',source_translation:'Outlet'},
  {url:base+'c.pdf',title:'Report',type:'pdf',source_translation:'machine'},
  {url:base+'d.pdf',title:'Report',type:'pdf',source_translation:true},
  {url:base+'e.pdf',title:'Report',type:'pdf',source_translation:' outlet'},
  {url:base+'f.pdf',title:'Report',type:'pdf',source_translation:['outlet']},
  english,publication(2)],scan_ok:true},'',true);
 assert.equal(r.status,200);
 let feed=(await h.call('/darkweb/feed')).data.items;const flag=end=>feed.find(i=>i.url.endsWith(end)).source_translation;
 assert.equal(flag('a.pdf'),'outlet');assert.equal(feed.find(i=>i.url.endsWith('a.pdf')).title_en_kind,'original');
 for(const end of ['b.pdf','c.pdf','d.pdf','e.pdf','f.pdf'])assert.equal(flag(end),undefined,end+' carries no flag');
 const pub=feed.find(i=>i.url===english.url),arabic=feed.find(i=>i.url===publication(2).url);
 assert.equal(pub.source_translation,undefined,'No flag is invented');
 assert.equal(Object.hasOwn(h.values.get('darkweb:publication:2:'+arabic.id),'source_translation'),false,'Records without the flag are stored as before');
 let calls=0;
 h.context.fetch=async(url,options)=>{calls++;const input=JSON.parse(JSON.parse(options.body).input);return Response.json({text:JSON.stringify({summary:'The outlets make claims that need validation. [1]',titles:input.titles.map(t=>({id:t.id,title:t.id===pub.id?t.title:'Arabic title in English',overview_en:'The outlet claims a clash.'}))})});};
 await h.call('/darkweb/enrich',{});assert.equal(calls,1);
 const before=(await h.call('/darkweb/item?id='+pub.id)).data.item;
 assert.equal(before.title_en_kind,'original');assert.equal(before.overview_en,'The outlet claims a clash.');assert.ok(!h.values.has('darkweb:publication-pending:2:'+pub.id));
 // A collector that starts sending the flag keeps the hash, the English fields and the queue as they were.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{...english,source_translation:'outlet'}],scan_ok:true},'',true);
 const flagged=(await h.call('/darkweb/item?id='+pub.id,undefined,'analyst')).data.item;
 assert.equal(flagged.source_translation,'outlet');assert.equal(flagged.content_hash,before.content_hash);
 assert.equal(flagged.title_en,before.title_en);assert.equal(flagged.title_en_kind,'original');assert.equal(flagged.overview_en,before.overview_en);assert.equal(flagged.enrich_attempts,before.enrich_attempts);
 assert.ok(!h.values.has('darkweb:publication-pending:2:'+pub.id),'Adding the flag does not requeue the record');
 assert.equal((await h.call('/darkweb/archive')).data.items.find(i=>i.id===pub.id).source_translation,'outlet');
 assert.equal((await h.call('/darkweb/feed')).data.items.find(i=>i.id===pub.id).source_translation,'outlet');
 h.values.delete('darkweb:enrich-until');assert.equal((await h.call('/darkweb/enrich',{})).data.cached,true);assert.equal(calls,1);
 // The hash is the same whether or not the flag is sent.
 const h2=harness(),id2=await register(h2);
 await h2.call('/darkweb/ingest',{outlet_id:id2,items:[{...english,source_translation:'outlet'}],scan_ok:true},'',true);
 assert.equal((await h2.call('/darkweb/archive')).data.items[0].content_hash,before.content_hash);
 // An unchanged re-send without the flag (an older collector) keeps it; new text without it drops it.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[english],scan_ok:true},'',true);
 assert.equal((await h.call('/darkweb/item?id='+pub.id)).data.item.source_translation,'outlet');
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{...english,original_text:'The outlet claims a second clash.'}],scan_ok:true},'',true);
 assert.equal((await h.call('/darkweb/item?id='+pub.id)).data.item.source_translation,undefined);
 feed=(await h.call('/darkweb/feed')).data.items;assert.equal(feed.find(i=>i.id===pub.id).source_translation,undefined);
});
test('keyword alerts fold diacritics, Turkish i and Unicode forms on both sides and read the original text',async()=>{
 const h=harness(),f=h.context.foldText;
 assert.ok(f('İSTANBUL saldırısı').includes(f('istanbul')));
 assert.equal(f('IŞİD'),f('ışid'));
 assert.ok(f('saldırı').includes(f('saldiri')));
 assert.ok(f('Déclaration').includes(f('declaration')));
 assert.equal(f('Cafe\u0301'),f('Caf\u00e9'));
 const outlet=(await h.call('/darkweb/outlet',{name:'Latin outlet',url:base,keywords:'istanbul, ışid, saldiri, declaration, café, Sahel, \u0301'})).data.outlet.id;
 await h.call('/darkweb/ingest',{outlet_id:outlet,items:[
  {url:base+'1',title:'İSTANBUL saldırısı'},
  {url:base+'2',title:'IŞİD açıklaması'},
  {url:base+'3',title:'Déclaration officielle',excerpt:'Le cafe\u0301 du port'},
  {url:base+'4',title:'Ankara'},
  publication(5,{title:'Haber',original_text:'Sahel bölgesinde yeni bir açıklama',source_language:'tr'})],scan_ok:true},'',true);
 const matches=Object.fromEntries((await h.call('/darkweb/feed')).data.items.map(i=>[i.url.slice(base.length),Array.from(i.keyword_matches)]));
 assert.deepEqual(matches['1'],['istanbul','saldiri']);
 assert.deepEqual(matches['2'],['ışid']);
 assert.deepEqual(matches['3'],['declaration','café']);
 assert.deepEqual(matches['4'],[],'A keyword made only of combining marks never matches everything');
 assert.deepEqual(matches['posts/news/5/'],['Sahel'],'A keyword found only in the original text is an alert');
});

// Minimal DOM for darkweb.js: enough structure for contains, closest and simple selectors.
function pageHarness(fixture){
 const doc={hidden:false};
 class El{
  constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];this.parentNode=null;this._text='';this.attributes={};this.dataset={};this.style={};this.hidden=false;this.value='';this.checked=false;this.disabled=false;this.id='';this.className='';this.listeners={};this._open=false;this.scrolled=0;}
  get textContent(){return this.tagName==='#TEXT'?this._text:this.children.map(c=>c.textContent).join('');}
  set textContent(v){for(const c of this.children)c.parentNode=null;this.children=[];if(this.tagName==='#TEXT')this._text=String(v);else if(String(v))this.append(String(v));}
  get childNodes(){return this.children;}get firstChild(){return this.children[0]||null;}
  append(...nodes){for(let n of nodes){if(typeof n==='string'){const t=new El('#text');t._text=n;n=t;}n.remove();n.parentNode=this;this.children.push(n);}}
  prepend(...nodes){const tail=this.children;this.children=[];this.append(...nodes);this.children.push(...tail);}
  click(){}
  // Serializes the properties darkweb.js sets (class, lang, dir) as attributes, for export checks.
  get outerHTML(){if(this.tagName==='#TEXT')return this._text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const tag=this.tagName.toLowerCase(),attrs={...this.attributes};if(this.className)attrs.class=this.className;for(const k of ['lang','dir'])if(this[k])attrs[k]=this[k];return '<'+tag+Object.entries(attrs).map(([k,v])=>' '+k+'="'+String(v).replace(/"/g,'&quot;')+'"').join('')+'>'+this.children.map(c=>c.outerHTML).join('')+'</'+tag+'>';}
  replaceChildren(...nodes){for(const c of this.children)c.parentNode=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null;}}
  contains(n){for(;n;n=n.parentNode)if(n===this)return true;return false;}
  closest(sel){for(let n=this;n;n=n.parentNode)if(n.matches(sel))return n;return null;}
  matches(sel){return sel.split(',').some(s=>{const m=s.trim().match(/^([a-z0-9]*)(?:\[([\w-]+)(?:=([\w-]+))?\])?$/i);const[,tag,attr,val]=m;if(tag&&this.tagName!==tag.toUpperCase())return false;if(attr){const v=attr.startsWith('data-')?this.dataset[attr.slice(5)]:this[attr]??this.attributes[attr];if(v===undefined)return false;if(val!==undefined&&String(v)!==val)return false;}return true;});}
  querySelectorAll(sel){const out=[],walk=n=>{for(const c of n.children){if(c.matches(sel))out.push(c);walk(c);}};walk(this);return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  setAttribute(k,v){this.attributes[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5)]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  dispatch(type,event={}){for(const fn of this.listeners[type]||[])fn(event);this['on'+type]?.(event);}
  focus(){doc.activeElement=this;}scrollIntoView(){this.scrolled++;}
  get classList(){const el=this,list=()=>el.className.split(/\s+/).filter(Boolean);return{add:(...c)=>{el.className=[...new Set([...list(),...c])].join(' ');},remove:(...c)=>{el.className=list().filter(x=>!c.includes(x)).join(' ');},contains:c=>list().includes(c),toggle(c,force){const want=force===undefined?!list().includes(c):!!force;want?this.add(c):this.remove(c);return want;}};}
  get open(){return this._open;}set open(v){if(!!v===this._open)return;this._open=!!v;queueMicrotask(()=>this.ontoggle?.());}
 }
 const root=new El('html');let current=root;
 const html=fs.readFileSync('darkweb.html','utf8').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi,'').replace(/<!DOCTYPE[^>]*>/i,'');
 for(const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)){
  if(m[4]!==undefined){if(m[4].trim())current.append(m[4].trim());continue;}
  if(m[1]){current=current.parentNode||root;continue;}
  const el=new El(m[2]);
  for(const [,k,v='']of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)){if(k==='class')el.className=v;else if(k==='hidden')el.hidden=true;else if(k==='checked')el.checked=true;else if(['id','type','value'].includes(k))el[k]=v;el.setAttribute(k,v);}
  current.append(el);if(!['input','img','meta','link','br'].includes(m[2].toLowerCase()))current=el;
 }
 Object.assign(doc,{documentElement:root,body:root.querySelector('body'),createElement:tag=>new El(tag),createElementNS:(ns,tag)=>new El(tag),querySelectorAll:sel=>root.querySelectorAll(sel),
  implementation:{createHTMLDocument:()=>{const html=new El('html'),head=new El('head'),body=new El('body');html.append(head,body);return {documentElement:html,head,body,createElement:tag=>new El(tag)};}},
  getElementById(id){const walk=n=>{for(const c of n.children){if(c.id===id)return c;const found=walk(c);if(found)return found;}return null;};return walk(root);}});
 doc.activeElement=doc.body;
 const calls=[],confirms=[];let confirmAnswer=false,interval=null;
 const session=new Map([['ct_map_session_token','admin']]);
 const respond=(data,status=200)=>({ok:status<400,status,json:async()=>structuredClone(data)});
 const fetch=async(url,options={})=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):undefined;calls.push({path:u.pathname,id:u.searchParams.get('id'),body});
  if(u.pathname==='/session-check')return respond({username:'admin'});
  if(u.pathname==='/darkweb/feed')return respond(fixture.feed);
  if(u.pathname==='/darkweb/archive')return respond(fixture.archive);
  if(u.pathname==='/darkweb/item'){await fixture.itemGate;const item=fixture.full[u.searchParams.get('id')];return item?respond({item}):respond({error:'Publication unavailable in this collection.'},404);}
  if(u.pathname==='/darkweb/enrich')return respond({ok:true,cached:true});
  return respond({ok:true});
 };
 const downloads=[];
 class PageURL extends URL{static createObjectURL(blob){downloads.push(blob);return 'blob:test/'+downloads.length;}static revokeObjectURL(){}}
 class Blob{constructor(parts,options={}){this.text=parts.map(String).join('');this.type=options.type;}}
 const context=vm.createContext({window:{},document:doc,fetch,console,URL:PageURL,Blob,IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
  sessionStorage:{getItem:k=>session.get(k)??null,setItem:(k,v)=>{session.set(k,String(v));},removeItem:k=>{session.delete(k);}},location:{replace(){}},navigator:{},
  setInterval:fn=>{interval=fn;return 1;},setTimeout:()=>1,clearTimeout(){},confirm:message=>{confirms.push(message);return confirmAnswer;}});
 vm.runInContext(fs.readFileSync('darkweb.js','utf8'),context);
 const flush=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
 return {doc,downloads,$:id=>doc.getElementById(id),calls,confirms,flush,count:path=>calls.filter(c=>c.path===path).length,
  answer:value=>{confirmAnswer=value;},tick:async()=>{interval();await flush();}};
}
function pageFixture(){
 const id=c=>c.repeat(64);
 const pub=(c,outlet,extra={})=>({id:id(c),publication_version:1,outlet_id:outlet,url:base+c,title:'عنوان '+c,title_en:'Title '+c,title_en_kind:'translation',overview_en:'Overview '+c,published_at:'2026-10-02',first_seen:'2026-10-03T10:00:00.000Z',baseline:false,keyword_matches:[],type:'page',category:'news',text_status:'complete',attachments:[],content_hash:'hash-'+c,has_preview:false,...extra});
 const p1=pub('a','o1',{keyword_matches:['Niger'],published_at:'2026-10-03'}),p2=pub('b','o2'),older=pub('d','o2',{published_at:'2025-02-01'});
 const legacy={id:id('c'),outlet_id:'o1',url:base+'c.pdf',title:'legacy.pdf',title_en:'Legacy file',type:'pdf',published_at:'2025-06-01',first_seen:'2026-10-03T09:00:00.000Z',baseline:false,keyword_matches:[],has_preview:false,acquired:false,bytes:null};
 const feed={admin:true,policy:{epoch:2,from:'2025-01-01',through:'2026-12-31',pages_per_scan:10,paused:false,previews:true},
  summary:{text:'Claim [1]. Other [2].',generated_at:'2026-10-03T11:00:00.000Z',sources:[{number:1,id:legacy.id,title:'legacy.pdf',published_at:legacy.published_at},{number:2,id:older.id,title:older.title,published_at:older.published_at}]},
  outlets:[{id:'o1',name:'Outlet A',url:base,keywords:['Niger'],enabled:true},{id:'o2',name:'Outlet B',url:'http://'+'b'.repeat(56)+'.onion/',keywords:[],enabled:true}],
  items:[p1,p2,legacy],unread_count:3,keyword_alert_count:1,seen_through:'',generated_at:'2026-10-03T12:00:00.000Z',retention_limit:500,files_storage:null,collector_configured:true};
 return {feed,archive:{items:[p1,p2],next_cursor:'',epoch:2},full:{[p1.id]:{...p1,original_text:'النص الكامل'},[older.id]:{...older,original_text:'نص أقدم'}},id};
}
test('page: non-admin analysts see only the centrally managed publication feed',async()=>{
 const fixture=pageFixture();fixture.feed.admin=false;
 const page=pageHarness(fixture);await page.flush();
 assert.equal(page.$('collectionForm').hidden,true);
 assert.equal(page.$('storageForm').hidden,true);
 assert.equal(page.$('enrichNow'),null,'Translation runs automatically; there is no manual enrichment control.');
 assert.equal(page.$('outletFilterWrap').hidden,true);
 assert.equal(page.$('markSeen').hidden,true);
 const visibleViews=page.doc.querySelectorAll('[data-view]').filter(b=>!b.hidden).map(b=>b.dataset.view);
 assert.deepEqual(visibleViews,['latest']);
 assert.equal(page.$('feedView').hidden,false);
 assert.match(page.doc.body.textContent,/Collection is managed centrally by the administrator/);
});
test('page: publication feed includes late-arriving items from earlier dates and exposes no historical pagination',async()=>{
 const fixture=pageFixture(),page=pageHarness(fixture);await page.flush();
 assert.deepEqual(page.$('feed').querySelectorAll('article').map(a=>a.id),['item-'+fixture.id('a'),'item-'+fixture.id('b')]);
 assert.match(page.$('archiveStatus').textContent,/Last 2 detected publications/);
 assert.equal(page.$('nextPage'),null);assert.equal(page.$('prevPage'),null);assert.equal(page.$('pageStatus'),null);
});
test('page: the 60 s refresh never enriches and keeps an opened source text, focus and outlet selector',async()=>{
 const fixture=pageFixture(),page=pageHarness(fixture);await page.flush();
 assert.equal(page.count('/darkweb/enrich'),1,'First load enriches once');
 const card=page.$('item-'+fixture.id('a')),details=card.querySelector('details'),option=page.$('outletFilter').children[1];
 details.open=true;await page.flush();
 assert.equal(details.querySelector('p').textContent,'النص الكامل');assert.equal(page.count('/darkweb/item'),1);
 await page.tick();
 assert.equal(page.count('/darkweb/feed'),2);assert.equal(page.count('/darkweb/enrich'),1,'The interval refresh does not enrich');
 assert.equal(page.$('item-'+fixture.id('a')).querySelector('details'),details,'Unchanged data keeps the card');assert.equal(details.open,true);
 assert.equal(page.$('outletFilter').children[1],option,'The outlet selector is not rebuilt');
 details.querySelector('summary').focus();
 fixture.feed.items[0].overview_en=fixture.archive.items[0].overview_en='Updated overview';
 await page.tick();
 const rebuilt=page.$('item-'+fixture.id('a')).querySelector('details');
 assert.notEqual(rebuilt,details);assert.equal(rebuilt.open,true);assert.equal(rebuilt.querySelector('p').textContent,'النص الكامل');
 assert.equal(page.count('/darkweb/item'),1,'Loaded text is reused, not fetched again');
 assert.equal(page.doc.activeElement,rebuilt.querySelector('summary'),'Focus returns to the same control');
 assert.equal(page.$('enrichNow'),null);assert.equal(page.count('/darkweb/enrich'),1,'No manual enrichment control is exposed.');
});
test('page: a source text still loading when the feed changes reaches the rebuilt panel with one request',async()=>{
 const fixture=pageFixture();let release;fixture.itemGate=new Promise(r=>release=r);
 const page=pageHarness(fixture);await page.flush();
 page.$('item-'+fixture.id('a')).querySelector('details').open=true;await page.flush();
 fixture.feed.items[0].overview_en=fixture.archive.items[0].overview_en='Updated overview';await page.tick();
 const rebuilt=page.$('item-'+fixture.id('a')).querySelector('details');assert.equal(rebuilt.open,true);
 release();await page.flush();
 assert.equal(rebuilt.querySelector('p').textContent,'النص الكامل');assert.equal(page.count('/darkweb/item'),1);
});
test('page: unsaved period edits survive refresh; widen, narrow, pause and reset state their effect',async()=>{
 const fixture=pageFixture(),page=pageHarness(fixture);await page.flush();
 const policyCalls=()=>page.calls.filter(c=>c.path==='/darkweb/policy');
 page.$('collectFrom').value='2024-03-01';page.$('collectionForm').dispatch('input');page.doc.activeElement=page.$('search');
 await page.tick();
 assert.equal(page.$('collectFrom').value,'2024-03-01');assert.equal(page.$('discardCollection').hidden,false);
 page.answer(false);page.$('resetCollection').onclick();
 assert.match(page.confirms.at(-1),/DELETES THE ARCHIVE/);assert.ok(page.confirms.at(-1).includes('2024-03-01 → 2026-12-31'));assert.equal(policyCalls().length,0);
 page.$('pauseCollection').onclick();await page.flush();
 assert.equal(policyCalls()[0].body.from,'2025-01-01','Pause keeps the stored period');assert.equal(policyCalls()[0].body.paused,true);
 assert.equal(page.$('collectFrom').value,'2024-03-01','Pause keeps the unsaved edit');
 page.answer(true);page.$('collectionForm').onsubmit({preventDefault(){}});await page.flush();
 assert.match(page.confirms.at(-1),/Nothing is deleted/);assert.ok(page.confirms.at(-1).includes('2025-01-01 → 2026-12-31 to 2024-03-01 → 2026-12-31'));
 assert.deepEqual({...policyCalls()[1].body,paused:undefined},{from:'2024-03-01',through:'2026-12-31',pages_per_scan:10,previews:true,paused:undefined,reset:false});
 page.$('collectFrom').value='2025-06-01';page.$('collectionForm').dispatch('input');page.$('collectionForm').onsubmit({preventDefault(){}});
 assert.match(page.$('message').textContent,/requires RESET, which deletes the archive/);assert.equal(policyCalls().length,2);
 page.$('discardCollection').onclick();assert.equal(page.$('collectFrom').value,'2025-01-01');assert.equal(page.$('discardCollection').hidden,true);
 fixture.feed.policy.through='2026-10-01';await page.tick();
 assert.match(page.$('collectionState').textContent,/PERIOD ENDED/);assert.ok(page.$('collectionState').classList.contains('warning'));
 assert.match(page.$('snapshot').textContent,/Collection period ended on 2026-10-01/);
});
test('page: mark-all stays global and Latest publications includes earlier source dates',async()=>{
 const fixture=pageFixture(),page=pageHarness(fixture);await page.flush();
 page.answer(false);page.$('markSeen').onclick();
 assert.match(page.confirms.at(-1),/ALL 3 unreviewed item\(s\) across all outlets/);assert.match(page.confirms.at(-1),/1 keyword alert/);assert.equal(page.count('/darkweb/seen'),0);
 page.answer(true);page.$('markSeen').onclick();await page.flush();
 assert.equal(page.calls.find(c=>c.path==='/darkweb/seen').body.through,fixture.feed.generated_at);
 page.doc.querySelectorAll('[data-view=alerts]')[0].onclick();
 const alerts=page.$('feed').querySelectorAll('article');
 assert.deepEqual(alerts.map(a=>a.id),['item-'+fixture.id('a')]);assert.match(page.$('archiveStatus').textContent,/alert keywords/);
 page.doc.querySelectorAll('[data-view=latest]')[0].onclick();
 const links=page.$('aiSources').querySelectorAll('a');
 assert.deepEqual(links.map(a=>a.textContent),['Title a','Title b']);
 assert.doesNotMatch(page.doc.body.textContent,/AI synthesis of outlet claims|corpus contains publications spanning/i);
 links[0].onclick({preventDefault(){}});await page.flush();
 const latestCard=page.$('item-'+fixture.id('a'));
 assert.ok(latestCard);assert.equal(latestCard.scrolled,1);assert.equal(page.doc.activeElement,latestCard);
});

test('page: a settled search is recorded once for the admin history, with the outlet name and never its onion address',async()=>{
 const fixture=pageFixture(),page=pageHarness(fixture);await page.flush();
 const records=()=>page.calls.filter(c=>c.path==='/usage-record').map(c=>c.body);
 const search=page.$('search'),enter=()=>search.dispatch('keydown',{key:'Enter'});
 search.value='  Niger ';search.dispatch('input');
 assert.equal(records().length,0,'Typing alone waits for the pause, Enter or leaving the box');
 enter();enter();
 assert.deepEqual(records(),[{username:'admin',action:'darkweb_search',details:{text:'Niger',view:'latest',outlet:'',material:'',results:1}}],'One record, not repeated for the same search');
 page.$('outletFilter').value='o2';page.$('outletFilter').dispatch('input');enter();
 assert.equal(records().length,2);
 assert.equal(records()[1].details.outlet,'Outlet B');
 page.doc.querySelectorAll('[data-view=outlets]')[0].onclick();page.doc.querySelectorAll('[data-view=latest]')[0].onclick();enter();
 assert.equal(records().length,2,'Visiting the outlet list and coming back is not a new search');
 assert.ok(!JSON.stringify(records()).includes('.onion'),'The outlet address never leaves the page');
 search.value='';page.$('outletFilter').value='';search.dispatch('input');enter();
 assert.equal(records().length,2,'Clearing the filters is not a search');
});
// The Arabic page fixture plus a Turkish record, an English original and an untagged Latin record.
function latinFixture(){
 const fixture=pageFixture(),{id}=fixture,arabic=fixture.archive.items[0];
 const pub=(c,extra)=>({...arabic,id:id(c),url:base+c,keyword_matches:[],content_hash:'hash-'+c,...extra});
 const turkish=pub('e',{title:'Sınır bölgesinde çatışma',title_en:'Clash in the border region',source_language:'tr'});
 const english=pub('f',{title:'Statement on the border clash',title_en:'Statement on the border clash',title_en_kind:'original',source_language:'en',overview_en:'The outlet claims a clash.'});
 const untagged=pub('g',{title:'Napad na kontrolni punkt',title_en:'Attack on a checkpoint'});
 fixture.feed.items.push(turkish,english,untagged);fixture.archive.items.push(turkish,english,untagged);
 Object.assign(fixture.full,{[turkish.id]:{...turkish,original_text:'Sınır bölgesinde yeni bir çatışma bildirildi.'},[english.id]:{...english,original_text:'The outlet claims a clash near the border.'},[untagged.id]:{...untagged,original_text:'Izvor tvrdi da je bio napad.'}});
 return fixture;
}
test('page: Latin-script records get neutral labels, a language chip and no Arabic tag; an English original is shown once',async()=>{
 const fixture=latinFixture(),page=pageHarness(fixture);await page.flush();
 const [arabic,turkish,english,untagged]=['a','e','f','g'].map(c=>page.$('item-'+fixture.id(c)));
 const chips=el=>el.querySelectorAll('span').filter(s=>s.classList.contains('lang')).map(s=>s.textContent);
 const langs=el=>{const out=[];const walk=n=>{if(n.lang)out.push(n.lang);n.children.forEach(walk);};walk(el);return out;};
 assert.deepEqual(chips(turkish),['TR']);assert.deepEqual(chips(english),['EN']);assert.deepEqual(chips(untagged),[]);assert.deepEqual(chips(arabic),[]);
 assert.equal(turkish.querySelectorAll('span').find(s=>s.classList.contains('lang')).title,'Source language: Turkish');
 for(const card of [arabic,turkish,english,untagged]){
  assert.equal(card.querySelector('summary').textContent,'READ ORIGINAL TEXT');
  const title=card.querySelector('h3');assert.equal(title.className,'source-title');assert.equal(title.dir,'auto');
 }
 assert.equal(turkish.querySelector('h3').lang,'tr');assert.equal(turkish.querySelector('details').querySelector('p').lang,'tr');assert.ok(!langs(turkish).includes('ar'));
 assert.equal(untagged.querySelector('h3').lang,undefined,'Latin text without a declared language has no lang');assert.equal(untagged.querySelector('details').querySelector('p').lang,undefined);assert.ok(!langs(untagged).includes('ar'));
 assert.equal(arabic.querySelector('h3').lang,'ar','Arabic-script text keeps lang="ar"');assert.equal(arabic.querySelector('details').querySelector('p').lang,'ar');
 assert.match(turkish.textContent,/ENGLISH · MACHINE TRANSLATION/);assert.match(turkish.textContent,/Clash in the border region/);assert.match(arabic.textContent,/ENGLISH · MACHINE TRANSLATION/);
 assert.equal(english.textContent.split('Statement on the border clash').length-1,1,'An English original is shown once');
 assert.doesNotMatch(english.textContent,/MACHINE TRANSLATION|English translation pending/);assert.equal(english.querySelector('h3').lang,'en');
 assert.match(page.doc.body.textContent,/original-language text/i);assert.doesNotMatch(page.doc.body.textContent,/Arabic/);
 assert.doesNotMatch(fs.readFileSync('darkweb.js','utf8'),/ORIGINAL ARABIC|arabic-title|Arabic titles/);assert.doesNotMatch(fs.readFileSync('darkweb.css','utf8'),/arabic-title/);
 // Search folds diacritics and the Turkish dotless i.
 page.$('search').value='SINIR';page.$('search').dispatch('input');
 assert.deepEqual(page.$('feed').querySelectorAll('article').map(a=>a.id),['item-'+fixture.id('e')]);
 page.$('search').value='';page.$('search').dispatch('input');
 // Exports name the language only when it is known and never call an English original a translation.
 const exportHtml=async c=>{page.$('item-'+fixture.id(c)).querySelectorAll('button').find(b=>b.textContent==='EXPORT HTML').onclick();await page.flush();return page.downloads.at(-1).text;};
 const tr=await exportHtml('e');
 assert.match(tr,/<h2>Original source text · Turkish<\/h2>/);assert.match(tr,/lang="tr"/);assert.doesNotMatch(tr,/lang="ar"|Arabic/);
 const en=await exportHtml('f');
 assert.match(en,/Original source text · English/);assert.doesNotMatch(en,/machine translation|English translation pending/i);
 const untaggedHtml=await exportHtml('g');
 assert.match(untaggedHtml,/<h2>Original source text<\/h2>/);assert.doesNotMatch(untaggedHtml,/ lang="/);
 const ar=await exportHtml('a');
 assert.match(ar,/<h2>Original source text · Arabic<\/h2>/);assert.match(ar,/lang="ar"/);assert.match(ar,/English title · machine translation/);assert.match(ar,/Title a/);
});
test('page: the outlet\'s own English version is labelled as its translation on the card and in both exports',async()=>{
 const fixture=latinFixture(),{id}=fixture,english=fixture.archive.items.find(i=>i.id===id('f')),turkish=fixture.archive.items.find(i=>i.id===id('e'));
 const outletItem={...english,id:id('h'),url:base+'h',content_hash:'hash-h',title:'Statement on the clash',title_en:'Statement on the clash',source_translation:'outlet',overview_en:''};
 // The flag alone never relabels a CT Atlas translation.
 const translated={...turkish,id:id('i'),url:base+'i',content_hash:'hash-i',source_translation:'outlet'};
 fixture.feed.items.push(outletItem,translated);fixture.archive.items.push(outletItem,translated);
 Object.assign(fixture.full,{[outletItem.id]:{...outletItem,original_text:'Statement on the clash\n\nThe outlet reports a clash.'},[translated.id]:{...translated,original_text:'Sınır bölgesinde yeni bir çatışma bildirildi.'}});
 const page=pageHarness(fixture);await page.flush();
 const [card,plain,other]=['h','f','i'].map(c=>page.$('item-'+id(c)));
 const pills=el=>el.querySelectorAll('span').filter(s=>s.classList.contains('pill')).map(s=>s.textContent);
 const note=/English version published by the outlet \(its own, possibly automatic, translation; not verified by CT Atlas\)/;
 assert.ok(pills(card).includes('OUTLET TRANSLATION'));assert.ok(pills(card).includes('EN'));
 assert.equal(card.querySelectorAll('span').find(s=>s.textContent==='OUTLET TRANSLATION').title,'English version published by the outlet (its own, possibly automatic, translation; not verified by CT Atlas)');
 assert.match(card.textContent,note);assert.equal(card.querySelector('summary').textContent,"READ OUTLET'S ENGLISH TEXT");
 assert.doesNotMatch(card.textContent,/MACHINE TRANSLATION|English translation pending|READ ORIGINAL TEXT|Original source text/);
 assert.equal(card.textContent.split('Statement on the clash').length-1,1,'The English text is shown once');
 for(const el of [plain,other]){assert.ok(!pills(el).includes('OUTLET TRANSLATION'));assert.doesNotMatch(el.textContent,/possibly automatic/);assert.equal(el.querySelector('summary').textContent,'READ ORIGINAL TEXT');}
 assert.match(other.textContent,/ENGLISH · MACHINE TRANSLATION/);
 const exportAs=async(c,format)=>{page.$('item-'+id(c)).querySelectorAll('button').find(b=>b.textContent==='EXPORT '+format).onclick();await page.flush();return page.downloads.at(-1).text;};
 const html=await exportAs('h','HTML');
 assert.match(html,/<h2>English title · outlet translation<\/h2>/);assert.match(html,note);
 assert.match(html,/<h2>Source text · English · outlet translation, not the original<\/h2>/);
 assert.doesNotMatch(html,/is in English and is not translated|Original source text|machine translation/i);
 const json=JSON.parse(await exportAs('h','JSON'));
 assert.equal(json.source_translation,'outlet');assert.match(json.source_translation_note,note);assert.match(json.source_translation_note,/not an English original/);
 // An English original without the flag exports exactly as before.
 const plainHtml=await exportAs('f','HTML');
 assert.match(plainHtml,/The original title above is in English and is not translated\./);assert.match(plainHtml,/<h2>Original source text · English<\/h2>/);assert.doesNotMatch(plainHtml,/outlet translation|possibly automatic/i);
 const plainJson=JSON.parse(await exportAs('f','JSON'));assert.equal(plainJson.source_translation_note,undefined);assert.equal(plainJson.source_translation,undefined);
 assert.equal(JSON.parse(await exportAs('i','JSON')).source_translation_note,undefined);
});
