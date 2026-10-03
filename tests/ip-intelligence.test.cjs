const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/ip-intelligence.js','utf8').replace(/^import[^\n]+\n/,'').replace(/export /g,'');
const rdap={name:'TEST-NET',status:['active'],country:'DE',startAddress:'8.8.8.0',endAddress:'8.8.8.255',entities:[{roles:['registrant'],vcardArray:['vcard',[
 ['fn',{},'text','Example Network'],['adr',{label:'Operator HQ, Berlin, Germany'},'text',['','','','','','','']]
]],entities:[{roles:['abuse'],vcardArray:['vcard',[['fn',{},'text','Abuse Desk'],['email',{},'text','abuse@example.net']]]}]}]};
function harness({ipinfo,fail=[],redirect,limit=200,geoCountry='US'}={}){
 const calls=[];
 const context=vm.createContext({Response,Request,URL,AbortSignal,TextDecoder,TextEncoder,Uint8Array,console,
  cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),corsHeaders:()=>({'Content-Type':'application/json'}),isAllowedUser:n=>n==='analyst',
  gateCall:async(env,path,body)=>path==='/session-get'?Response.json({username:body.session_token},{status:body.session_token==='analyst'?200:401}):new Response('{}',{status:limit}),
  fetch:async(url,options={})=>{
   calls.push({url,options});const u=new URL(url);
   if(fail.some(s=>url.includes(s)))throw new Error('private provider detail must never leak');
   if(u.hostname==='data.iana.org')return Response.json({services:[[['8.0.0.0/8','2000::/3'],['https://rdap.arin.net/registry/']]]});
   if(u.hostname==='rdap.arin.net')return redirect?new Response(null,{status:302,headers:{Location:redirect}}):Response.json(rdap);
   if(u.hostname==='api.ipinfo.io')return Response.json(ipinfo||{});
   if(u.pathname.includes('network-info'))return Response.json({status:'ok',data:{asns:[15169],prefix:'8.8.8.0/24'}});
   if(u.pathname.includes('abuse-contact'))return Response.json({status:'ok',data:{abuse_contacts:['abuse@example.net','network@example.net']}});
   if(u.pathname.includes('maxmind'))return Response.json({status:'ok',data:{result_time:'2026-10-02T12:00:00',located_resources:[{locations:[{country:geoCountry,city:'Example City',latitude:40,longitude:-75}]}]}});
   throw new Error('Unexpected endpoint '+url);
  }});
 vm.runInContext(source+'\nglobalThis.api={parseIP,publicIP,registration,serviceContact,lookupIP,handleIPIntelligence};',context);
 return {api:context.api,calls,async request(ip='8.8.8.8',token='analyst',env={}){return context.api.handleIPIntelligence(new Request('https://api/ip-intelligence/lookup',{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify({ip})}),env);}};
}
test('IPv4/IPv6 validation rejects URLs, local, mapped, documentation, multicast and ambiguous forms',()=>{
 const {api}=harness();
 for(const bad of ['localhost','https://8.8.8.8','8.8.8.8:80','8.8.8.0/24','08.8.8.8','0x08080808','134744072','1.2.3.256','127.0.0.1','10.1.2.3','100.64.1.1','169.254.169.254','172.31.1.2','192.168.1.2','192.0.2.4','198.18.0.1','198.51.100.2','203.0.113.4','224.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','::ffff:808:808','fc00::1','fe80::1','ff00::1','2001:db8::1','2002:808:808::1','3fff::1','[2001:4860::1]','2001:4860::1%eth0',' 8.8.8.8'])assert.equal(api.publicIP(bad),null,bad);
 assert.equal(api.publicIP('8.8.8.8').bits,32);
 assert.equal(api.publicIP('2001:4860:4860:0000:0000:0000:0000:8888').ip,'2001:4860:4860::8888');
 assert.equal(api.publicIP('2606:4700:4700::1111').bits,128);
});
test('authentication, invalid input and rate limiting stop all provider calls',async()=>{
 for(const options of [{token:''},{token:'other'},{ip:'127.0.0.1'},{limit:429}]){
  const h=harness(options),r=await h.request(options.ip||'8.8.8.8',options.token??'analyst');
  assert.equal(r.status,options.limit|| (options.ip?400:401));assert.equal(h.calls.length,0);
 }
});
test('oversized request and wrong method fail without lookup',async()=>{
 const h=harness();
 let r=await h.api.handleIPIntelligence(new Request('https://api/ip-intelligence/lookup',{method:'POST',headers:{'X-Session-Token':'analyst'},body:' '.repeat(3000)}),{});
 assert.equal(r.status,400);assert.equal(h.calls.length,0);
 r=await h.api.handleIPIntelligence(new Request('https://api/ip-intelligence/lookup'),{});assert.equal(r.status,405);
});
test('base lookup separates registration, estimated location and legal contacts; missing VPN is unknown',async()=>{
 const h=harness(),response=await h.request(),data=await response.json();
 assert.equal(response.headers.get('Cache-Control'),'no-store, private');
 assert.equal(data.registration.country,'DE');assert.equal(data.geolocation.country,'US');
 assert.equal(data.operator.name,'Example Network');assert.equal(data.privacy.vpn,null);
 assert.equal(data.contacts.length,3);assert.equal(data.provider_contacts.length,0);
 assert.equal(data.contacts[2].source,'RIPEstat abuse contacts');
 assert.equal(data.geolocation.radius_km,null);assert.equal(data.status,'partial');
 assert.ok(h.calls.every(c=>!c.url.startsWith('https://8.8.8.8')));
});
test('VPN service is distinct from hosting ASN; key never appears in output or URL',async()=>{
 const h=harness({ipinfo:{ip:'8.8.8.8',as:{name:'Hosting Co',asn:'AS15169',type:'hosting'},anonymous:{name:'ProtonVPN',is_vpn:true,is_proxy:false},is_hosting:true,geo:{country:'France',latitude:48,longitude:2,radius:80}}});
 const r=await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'secret-test-token'}),data=await r.json();
 assert.equal(data.privacy.service,'ProtonVPN');assert.equal(data.operator.name,'Hosting Co');
 assert.equal(data.provider_contacts[0].email,'legal@proton.me');assert.equal(data.provider_contacts[0].country,'Switzerland');
 assert.equal(data.geolocation.country,'France');assert.equal(data.registration.country,'DE');
 assert.equal(data.geolocation.radius_km,80);assert.equal(data.privacy.tor,null);
 assert.ok(!JSON.stringify(data).includes('secret-test-token'));assert.ok(!h.calls.some(c=>c.url.includes('secret-test-token')));
 assert.equal(h.calls.find(c=>c.url.includes('api.ipinfo.io')).options.headers.Authorization,'Bearer secret-test-token');
});
test('an empty privacy payload and hosting flag never imply no VPN or a named VPN',async()=>{
 const h=harness({ipinfo:{as:{name:'NordVPN Hosting reseller'},is_hosting:true}}),data=await (await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.privacy.vpn,null);assert.equal(data.privacy.service,'');assert.equal(data.provider_contacts.length,0);
 assert.equal(h.api.serviceContact('Mullvad VPN reseller'),null);
});
test('untrusted registry redirect never contacts a supplied host',async()=>{
 for(const redirect of ['https://127.0.0.1/admin','https://evil.example/','http://rdap.arin.net/registry/ip/8.8.8.8','https://rdap.arin.net:8443/']){
  const h=harness({redirect}),data=await(await h.request()).json();
  assert.equal(data.registration,null);assert.ok(!h.calls.some(c=>c.url===redirect));
  assert.equal(data.operator.name,'Unknown');assert.equal(data.status,'partial');
 }
});
test('provider outages preserve other sources and never become negative detections',async()=>{
 const h=harness({fail:['api.ipinfo.io','maxmind']}),data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.geolocation,null);assert.equal(data.privacy.vpn,null);assert.equal(data.operator.name,'Example Network');
 assert.ok(data.sources.some(s=>s.name==='IPinfo'&&s.status==='unavailable'));assert.ok(!JSON.stringify(data).includes('private provider detail'));
});
test('all sources failing is explicitly unavailable',async()=>{
 const h=harness({fail:['https://']}),data=await(await h.request()).json();assert.equal(data.status,'unavailable');
});
test('unknown location placeholders are not plotted; empty enrichment keeps a valid fallback',async()=>{
 let h=harness({geoCountry:'?'}),data=await(await h.request()).json();assert.equal(data.geolocation,null);
 h=harness({ipinfo:{geo:{}}});data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.geolocation.country,'US');assert.equal(data.geolocation.source,'RIPEstat / MaxMind GeoLite2');
});
test('report preserves incident fields, contact scope, sources, uncertainty and Unicode',async()=>{
 const h=harness(),data=await(await h.request()).json(),context={window:{}};
 vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 const report=context.window.CTAtlasIPReport.build(data,{reference:'Case-123',observed_at:'2025-06-03T12:13:14Z',source_port:'0',protocol:'UDP',notes:'مراجعة <script>alert(1)</script>'});
 const body=report.blocks.map(b=>b.text).join('\n');
 for(const value of ['Case-123','2025-06-03T12:13:14Z','Source port: 0','abuse@example.net','Operator HQ, Berlin','Unknown / not assessed','not a person','RIPEstat','مراجعة'])assert.ok(body.includes(value),value);
 assert.equal(context.window.CTAtlasIPReport.known(false),'Not detected by source');
});
test('hub, Worker, exports and mirror ship the same sixth workspace',()=>{
 for(const file of ['ip.html','ip.js','ip.css','ip-report.js','ip-intelligence.svg']){
  assert.ok(fs.existsSync(file));assert.ok(fs.readFileSync('tools/deploy_mirror.sh','utf8').includes(file));
  assert.ok(fs.readFileSync('.github/workflows/deploy-current-ct-atlas-ui.yml','utf8').includes(file));
 }
 assert.match(fs.readFileSync('cloudflare-worker/index.js','utf8'),/return handleIPIntelligence\(request, env\)/);
 const ui=fs.readFileSync('ip.js','utf8');assert.doesNotMatch(ui,/innerHTML|localStorage|IPINFO_TOKEN/);
 assert.match(ui,/JSON.stringify\(\{\.\.\.result,incident:incident\(\)\}/);
});
test('transactional lookup budget handles concurrent requests and resets after a minute',async()=>{
 let now=100000,queue=Promise.resolve();const values=new Map();
 const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},transaction(fn){const next=queue.then(()=>fn(storage));queue=next.catch(()=>{});return next;}};
 const context=vm.createContext({Request,Response,URL,Date:{now:()=>now},isAllowedUser:name=>name==='analyst'});
 const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'').replace('export class ReportGate','class ReportGate');
 vm.runInContext(gateSource+'\nglobalThis.Gate=ReportGate;',context);
 const gate=new context.Gate({storage},{});
 const call=()=>gate.fetch(new Request('https://gate/ip-intelligence-limit',{method:'POST',body:JSON.stringify({username:'analyst'})}));
 const results=await Promise.all(Array.from({length:10},call));
 assert.equal(results.filter(r=>r.status===200).length,6);assert.equal(results.filter(r=>r.status===429).length,4);
 assert.deepEqual([...values.keys()],['ip-intelligence:limit:analyst']);
 assert.deepEqual(Object.keys(values.values().next().value).sort(),['count','until']);
 now+=60001;assert.equal((await call()).status,200);
});
