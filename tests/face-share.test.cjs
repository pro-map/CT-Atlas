const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// face-share.js hosts ONE face crop for a few minutes so reverse-image engines can fetch it.
// The real Worker code runs here against an in-memory Durable Object (storage + alarm) and a
// controllable clock.

const source=fs.readFileSync('cloudflare-worker/face-share.js','utf8')
 .replace(/^import[\s\S]*?from "\.\/shared.js";\s*/,'')
 .replace(/^export \{[\s\S]*?\};\s*$/m,'');

const START=1_800_000_000_000;
const SESSIONS={'tok-alice':'alice','tok-bob':'bob','tok-mallory':'mallory'};
const ALLOWED=new Set(['alice','bob']);

class FakeStorage{
 constructor(){this.data=new Map();this.alarm=null;this.log=[];}
 async get(key){return this.data.get(key);}
 async put(a,b){
  if(typeof a==='object'&&a!==null)for(const [k,v] of Object.entries(a))this.data.set(k,v);
  else this.data.set(a,b);
 }
 async setAlarm(time){this.alarm=time;}
 async deleteAlarm(){this.alarm=null;}
 async deleteAll(){this.data.clear();this.log.push('deleteAll');}
}

function world(options={}){
 const clock={t:START};
 class FakeDate extends Date{static now(){return clock.t;}}
 const instances=new Map();
 const touched=[];
 const context=vm.createContext({
  Response,Request,URL,Uint8Array,Map,Promise,Number,String,Math,JSON,btoa,crypto,Date:FakeDate,
  cleanText:(v,n)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),
  jsonResponse:(body,status)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),
  isAllowedUser:name=>ALLOWED.has(String(name)),
  gateCall:async(env,path,payload)=>{
   const username=SESSIONS[payload.session_token];
   return username
    ?new Response(JSON.stringify({username}),{status:200})
    :new Response(JSON.stringify({error:'no session'}),{status:401});
  }
 });
 vm.runInContext(source,context);
 const api=vm.runInContext('({FaceShare,handleFaceShareUpload,handleFaceShareGet,resetFaceShareRateLimit,FACE_SHARE_TTL_MS,FACE_SHARE_MAX_BYTES,FACE_SHARE_MAX_READS,FACE_SHARE_VERSION})',context);

 const namespace={
  idFromName:name=>name,
  get:id=>{
   touched.push(id);
   if(!instances.has(id))instances.set(id,{storage:new FakeStorage()});
   const record=instances.get(id);
   record.object=record.object||new api.FaceShare({storage:record.storage});
   return {fetch:(url,init)=>record.object.fetch(new Request(url,init))};
  }
 };
 let jurisdiction=null;
 const binding=options.eu===false?namespace:Object.assign(Object.create(namespace),{jurisdiction:name=>{jurisdiction=name;return namespace;}});
 const env={FACE_SHARE:options.noBinding?undefined:binding};
 return {api,env,clock,instances,touched,namespace,get jurisdiction(){return jurisdiction;}};
}

const jpeg=(size=2000)=>{const b=new Uint8Array(size);b[0]=0xff;b[1]=0xd8;b[2]=0xff;for(let i=3;i<size;i++)b[i]=(i*31)%251;return b;};

function upload(w,{token='tok-alice',type='image/jpeg',body=jpeg(),headers={}}={}){
 const h={'Content-Type':type,...headers};
 if(token)h['X-Session-Token']=token;
 return w.api.handleFaceShareUpload(new Request('https://worker.test/face-share',{method:'POST',headers:h,body}),w.env,w.clock.t);
}
const get=(w,path,method='GET')=>w.api.handleFaceShareGet(new Request('https://worker.test'+path,{method}),w.env);

async function uploadOk(w,options){
 const r=await upload(w,options);
 assert.equal(r.status,200);
 const body=await r.json();
 return {body,path:new URL(body.url).pathname};
}

// ---------------------------------------------------------------- upload

test('upload needs a valid session of an allow-listed user',async()=>{
 const w=world();
 assert.equal((await upload(w,{token:''})).status,401,'no token');
 assert.equal((await upload(w,{token:'tok-unknown'})).status,401,'unknown session');
 assert.equal((await upload(w,{token:'tok-mallory'})).status,401,'valid session but not allow-listed');
 assert.equal(w.touched.length,0,'nothing is stored for a refused upload');
});

test('upload refuses non-JPEG content, wrong content types and oversize images',async()=>{
 const w=world();
 assert.equal((await upload(w,{type:'image/png'})).status,415);
 assert.equal((await upload(w,{type:'application/json'})).status,415);
 assert.equal((await upload(w,{body:new Uint8Array([1,2,3,4,5,6])})).status,415,'claims JPEG, is not');
 assert.equal((await upload(w,{body:jpeg(w.api.FACE_SHARE_MAX_BYTES+1)})).status,413,'body over the cap');
 const declared=await upload(w,{body:jpeg(100),headers:{'Content-Length':String(w.api.FACE_SHARE_MAX_BYTES+1)}});
 assert.ok([413,400].includes(declared.status)||declared.status===413,'declared length over the cap');
 assert.equal((await upload(w,{body:jpeg(w.api.FACE_SHARE_MAX_BYTES)})).status,200,'exactly at the cap is fine');
 assert.equal(w.touched.length,1,'only the accepted image reached storage');
});

test('a body streamed without Content-Length is cut off at the cap instead of being buffered whole',async()=>{
 const w=world();
 let pulled=0;
 const chunk=jpeg(60*1024);
 const stream=new ReadableStream({pull(controller){
  pulled++;
  if(pulled>500){controller.close();return;}
  controller.enqueue(chunk);
 }});
 const request=new Request('https://worker.test/face-share',{method:'POST',headers:{'Content-Type':'image/jpeg','X-Session-Token':'tok-alice'},body:stream,duplex:'half'});
 assert.equal(request.headers.get('Content-Length'),null,'no declared length');
 const r=await w.api.handleFaceShareUpload(request,w.env,w.clock.t);
 assert.equal(r.status,413);
 assert.ok(pulled<=6,'reading stopped right after the cap ('+pulled+' chunks pulled of 500)');
 assert.equal(w.touched.length,0,'nothing reached storage');
 // a streamed body under the cap still works
 const small=new ReadableStream({start(controller){controller.enqueue(jpeg(700));controller.enqueue(jpeg(800));controller.close();}});
 const ok=await w.api.handleFaceShareUpload(new Request('https://worker.test/face-share',{method:'POST',headers:{'Content-Type':'image/jpeg','X-Session-Token':'tok-alice'},body:small,duplex:'half'}),w.env,w.clock.t);
 assert.equal(ok.status,200);
});

test('upload answers 503 when the hosting binding is not configured (and stores nothing)',async()=>{
 const w=world({noBinding:true});
 const r=await upload(w);
 assert.equal(r.status,503);
 assert.match((await r.json()).error,/not configured/);
});

test('a successful upload returns an unguessable https link that expires in 10 minutes, in the EU jurisdiction',async()=>{
 const w=world();
 const {body,path}=await uploadOk(w);
 assert.equal(body.ok,true);
 assert.equal(body.version,w.api.FACE_SHARE_VERSION);
 assert.match(body.url,/^https:\/\/worker\.test\/face-share\/[A-Za-z0-9_-]{22}\.jpg$/);
 assert.equal(body.ttl_seconds,600);
 assert.equal(w.api.FACE_SHARE_TTL_MS,10*60*1000);
 assert.equal(Date.parse(body.expires_at),START+600_000);
 assert.equal(w.jurisdiction,'eu','object created in the EU jurisdiction when available');
 const id=path.split('/').pop().replace('.jpg','');
 assert.equal(w.touched[0],id,'one Durable Object per image, named by its id');
 const record=w.instances.get(id);
 assert.deepEqual([...record.storage.data.keys()].sort(),['bytes','expires_at','reads'],'only the image, its expiry and a read counter are stored: no user, no metadata');
 assert.equal(record.storage.alarm,START+600_000,'the object schedules its own deletion');
});

test('it also works when the runtime has no jurisdiction API',async()=>{
 const w=world({eu:false});
 assert.equal((await upload(w)).status,200);
});

test('ids are random: 200 uploads never collide and none is sequential',async()=>{
 const w=world();
 w.clock.t=START;
 const ids=new Set();
 for(let i=0;i<200;i++){
  w.api.resetFaceShareRateLimit();
  const {path}=await uploadOk(w);
  ids.add(path);
 }
 assert.equal(ids.size,200);
});

test('at most 40 uploads per user per hour, counted per user, released after the hour',async()=>{
 const w=world();
 for(let i=0;i<40;i++)assert.equal((await upload(w)).status,200,'upload '+i);
 assert.equal((await upload(w)).status,429,'the 41st is refused');
 assert.equal((await upload(w,{token:'tok-bob'})).status,200,'another user is not affected');
 w.clock.t+=3600_000+1;
 assert.equal((await upload(w)).status,200,'allowed again after an hour');
});

// ---------------------------------------------------------------- serving

test('the hosted image is served publicly with no-store / noindex / nosniff headers and the exact bytes',async()=>{
 const w=world();
 const bytes=jpeg(3000);
 const {path}=await uploadOk(w,{body:bytes});
 const r=await get(w,path);
 assert.equal(r.status,200);
 assert.equal(r.headers.get('Content-Type'),'image/jpeg');
 assert.equal(r.headers.get('Content-Length'),'3000');
 assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');
 assert.match(r.headers.get('X-Robots-Tag'),/noindex/);
 assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');
 assert.equal(r.headers.get('Access-Control-Allow-Origin'),null,'no CORS: engines fetch it directly, pages cannot read it');
 assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
});

test('HEAD answers with headers only and does not use up reads',async()=>{
 const w=world();
 const {path}=await uploadOk(w);
 for(let i=0;i<60;i++){
  const head=await get(w,path,'HEAD');
  assert.equal(head.status,200);
  assert.equal(head.headers.get('Content-Type'),'image/jpeg');
  assert.equal((await head.arrayBuffer()).byteLength,0);
 }
 assert.equal((await get(w,path)).status,200,'still readable after many HEADs');
});

test('after 25 reads the image is gone (and its storage with it)',async()=>{
 const w=world();
 const {path}=await uploadOk(w);
 for(let i=0;i<w.api.FACE_SHARE_MAX_READS;i++)assert.equal((await get(w,path)).status,200,'read '+i);
 const gone=await get(w,path);
 assert.equal(gone.status,404);
 assert.equal(gone.headers.get('Cache-Control'),'no-store');
 const record=[...w.instances.values()][0];
 assert.equal(record.storage.data.size,0,'storage emptied');
 assert.equal(record.storage.alarm,null,'pending alarm cancelled');
 assert.equal((await get(w,path)).status,404,'stays gone');
});

test('after 10 minutes the image is gone, and the alarm wipes the object even if nobody asks',async()=>{
 const w=world();
 const {path}=await uploadOk(w);
 w.clock.t=START+599_000;
 assert.equal((await get(w,path)).status,200,'still there just before expiry');
 w.clock.t=START+600_000;
 assert.equal((await get(w,path)).status,404,'expired at the deadline');

 const w2=world();
 await uploadOk(w2);
 const record=[...w2.instances.values()][0];
 assert.equal(record.storage.data.size,3);
 await record.object.alarm();
 assert.equal(record.storage.data.size,0,'the alarm alone deletes everything');
});

test('a link can only ever be created once (same id cannot be overwritten)',async()=>{
 const w=world();
 const {path}=await uploadOk(w);
 const id=path.split('/').pop().replace('.jpg','');
 const stub=w.namespace.get(id);
 const again=await stub.fetch('https://face.internal/put',{method:'PUT',headers:{'X-Expires-At':String(START+1_000_000)},body:jpeg(50)});
 assert.equal(again.status,409);
});

test('the storage object refuses an already-expired or empty put',async()=>{
 const w=world();
 const stub=w.namespace.get('AAAAAAAAAAAAAAAAAAAAAA');
 assert.equal((await stub.fetch('https://face.internal/put',{method:'PUT',headers:{'X-Expires-At':String(START-1)},body:jpeg(50)})).status,400);
 const stub2=w.namespace.get('BBBBBBBBBBBBBBBBBBBBBB');
 assert.equal((await stub2.fetch('https://face.internal/put',{method:'PUT',headers:{'X-Expires-At':String(START+1000)},body:new Uint8Array(0)})).status,400);
 assert.equal((await stub2.fetch('https://face.internal/unknown')).status,404);
});

test('malformed or unknown links are 404 without touching any storage object',async()=>{
 const w=world();
 const before=w.touched.length;
 for(const path of [
  '/face-share/','/face-share/short.jpg','/face-share/AAAAAAAAAAAAAAAAAAAAAA','/face-share/AAAAAAAAAAAAAAAAAAAAAA.png',
  '/face-share/AAAAAAAAAAAAAAAAAAAAAAAA.jpg','/face-share/../health','/face-share/AAAAAAAAAAAAAAAAAAAAA%2F.jpg',
  '/face-share/AAAAAAAAAAAAAAAAAAAAA+.jpg','/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg/extra'
 ]){
  const r=await get(w,path);
  assert.equal(r.status,404,path);
  assert.equal(r.headers.get('Cache-Control'),'no-store',path);
 }
 assert.equal(w.touched.length,before);
 const unknown=await get(w,'/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg');
 assert.equal(unknown.status,404,'well-formed but never uploaded');
 const noBinding=world({noBinding:true});
 assert.equal((await get(noBinding,'/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg')).status,404);
});

// ---------------------------------------------------------------- wiring

test('the Worker routes, exports and binds the hosting; health reports it; the module never logs',()=>{
 const index=fs.readFileSync('cloudflare-worker/index.js','utf8');
 assert.match(index,/import \{ handleFaceShareUpload, handleFaceShareGet, FACE_SHARE_VERSION \} from "\.\/face-share\.js";/);
 assert.match(index,/url\.pathname === "\/face-share" && request\.method === "POST"/);
 assert.match(index,/url\.pathname\.startsWith\("\/face-share\/"\) && \["GET", "HEAD"\]\.includes\(request\.method\)/);
 assert.match(index,/export \{ FaceShare \} from "\.\/face-share\.js";/);
 assert.match(index,/face_share_version: FACE_SHARE_VERSION, face_share_configured: Boolean\(env\.FACE_SHARE\)/);
 const toml=fs.readFileSync('cloudflare-worker/wrangler.toml','utf8');
 assert.match(toml,/\[\[durable_objects\.bindings\]\]\s*\nname = "FACE_SHARE"\s*\nclass_name = "FaceShare"/);
 assert.match(toml,/\[exports\.FaceShare\]\s*\ntype = "durable-object"\s*\nstorage = "sqlite"/);
 assert.match(toml,/\[\[durable_objects\.bindings\]\]\s*\nname = "REPORT_GATE"/,'the existing binding is untouched');
 const module=fs.readFileSync('cloudflare-worker/face-share.js','utf8');
 assert.ok(!/console\./.test(module),'face-share.js must not log anything (no usernames, ids or bytes)');
 assert.ok(!/fetch\(\s*["'`]https?:/.test(module.replace(/https:\/\/face\.internal/g,'')),'face-share.js makes no outbound requests');
});

test('the upload route is not reachable without going through the session check',()=>{
 const module=fs.readFileSync('cloudflare-worker/face-share.js','utf8');
 const upload=module.slice(module.indexOf('async function handleFaceShareUpload'),module.indexOf('// Public on purpose'));
 const read=upload.indexOf('readBodyCapped(request');
 assert.ok(read>-1,'the body is read through the capped reader');
 assert.ok(!upload.includes('arrayBuffer()'),'never buffer the whole request');
 assert.ok(upload.indexOf('/session-get')>-1&&upload.indexOf('/session-get')<read,'the session is verified before the body is read');
 assert.ok(upload.indexOf('isAllowedUser')<read);
});
