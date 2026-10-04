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
  async list({prefix='',limit=1000,reverse=false,end}={}){let rows=[...values].filter(([k])=>k.startsWith(prefix)&&(!end||k<end)).sort(([a],[b])=>a<b?-1:a>b?1:0);if(reverse)rows.reverse();return new Map(rows.slice(0,limit).map(([k,v])=>[k,structuredClone(v)]));},
  transaction(callback){const result=queue.then(()=>callback(storage));queue=result.catch(()=>{});return result;}
 };
 const env={AUTH_USERS_JSON:'{}',DARKWEB_INGEST_TOKEN:'s'.repeat(48),ALLOWED_ORIGIN:'https://ct-atlas.com'};
 const context=vm.createContext({AbortSignal,extractGeminiText:async p=>p.text,console,Response,Request,URL,TextDecoder,TextEncoder,Uint8Array,Date,JSON,Map,Set,Object,Array,String,Number,Math,crypto,
  cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),
  isAllowedUser:name=>['admin','analyst'].includes(name),
  sha256:async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex')});
 const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'').replace('export class ReportGate','class ReportGate');
 vm.runInContext(gateSource+'\nglobalThis.Gate=ReportGate;',context);
 const gate=new context.Gate({storage},env);
 context.gateCall=async(e,path,body)=>path==='/session-get'?Response.json({username:body.session_token}, {status:['admin','analyst'].includes(body.session_token)?200:401}):gate.fetch(new Request('https://gate'+path,{method:'POST',body:JSON.stringify(body)}));
 const source=fs.readFileSync('cloudflare-worker/darkweb.js','utf8').replace(/^import[^\n]+\n/,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={handleDarkweb,onionUrl};',context);
 async function call(path,body,user='admin',collector=false){if(path==='/darkweb/ingest' && body)body={selection_version:2,collection_epoch:2,...body,items:Array.isArray(body.items)?body.items.map(i=>({published_at:"2025-06-01",date_basis:"html",...i})):body.items};const r=await context.api.handleDarkweb(new Request('https://worker'+path,{method:body===undefined?'GET':'POST',headers:collector?{Authorization:'Bearer '+env.DARKWEB_INGEST_TOKEN}:{'X-Session-Token':user},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json(),headers:r.headers};}
 return {call,values,env,context,api:context.api};
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

test('AI titles and briefing are source-bound, cached, and preserve original text',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='synthetic-test-key';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'كتاب جديد',excerpt:'A publication claim'}],scan_ok:true},'',true);
 const item=(await h.call('/darkweb/feed')).data.items[0];let calls=0;
 h.context.fetch=async(url,options)=>{calls++;const payload=JSON.parse(options.body);assert.ok(!payload.input.includes('.onion'));return Response.json({text:JSON.stringify({summary:'The outlet presents a publication dated June 2025; this claim needs analyst validation. [1]',titles:[{id:item.id,title:'New book'},{id:'invented',title:'Ignore'}]})});};
 assert.equal((await h.call('/darkweb/enrich',{},'analyst')).status,403);
 assert.equal((await h.call('/darkweb/enrich',{})).status,200);
 let state=(await h.call('/darkweb/feed')).data;assert.equal(state.items[0].title_en,'New book');assert.equal(state.items[0].title,'كتاب جديد');assert.equal(state.summary.sources[0].id,item.id);
 await h.call('/darkweb/enrich',{});assert.equal(calls,1);
 // An update to the source invalidates the previous translation.
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'Updated source title'}],scan_ok:true},'',true);
 state=(await h.call('/darkweb/feed')).data;assert.equal(state.items[0].title_en,'');
});

test('invalid AI citations cannot become a briefing and provider errors preserve originals',async()=>{
 const h=harness(),id=await register(h);h.env.GEMINI_API_KEY='synthetic-test-key';
 await h.call('/darkweb/ingest',{outlet_id:id,items:[{url:base+'a.pdf',title:'Original'}],scan_ok:true},'',true);
 h.context.fetch=async()=>Response.json({text:JSON.stringify({summary:'Unsupported claim [99]',titles:[]})});
 await h.call('/darkweb/enrich',{});assert.equal((await h.call('/darkweb/feed')).data.summary,null);
 h.values.delete('darkweb:enrich-until');h.context.fetch=async()=>new Response('',{status:429});
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
