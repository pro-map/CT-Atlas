const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/ip-intelligence.js','utf8').replace(/^import[^\n]+\n/gm,'').replace(/export /g,'');
const rdap={name:'TEST-NET',status:['active'],country:'DE',startAddress:'8.8.8.0',endAddress:'8.8.8.255',entities:[{roles:['registrant'],vcardArray:['vcard',[
 ['fn',{},'text','Example Network'],['adr',{label:'Operator HQ, Berlin, Germany'},'text',['','','','','','','']]
]],entities:[{roles:['abuse'],vcardArray:['vcard',[['fn',{},'text','Abuse Desk'],['email',{},'text','abuse@example.net']]]}]}]};
function harness({ipinfo,ipinfoStatus=200,lite,liteStatus=200,proxy={network:{},detections:{}},proxyStatus='ok',proxyHttp=200,proxyIP='8.8.8.8',proxyMessage='',ipapi,ipapiStatus=200,whois,ianaStatus=200,rdapStatus=200,asns=[65001],holder,registryData=rdap,fail=[],redirect,limit=200,geoCountry='US',gateReply,gateThrow}={}){
 const calls=[],gate=[];
 const context=vm.createContext({Response,Request,URL,AbortSignal,TextDecoder,TextEncoder,Uint8Array,console,
  parseTarget:(v,publicIP)=>{const parsed=publicIP(v);return parsed?{kind:'ip',parsed}:null;},
  cleanText:(v,n=700)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n),corsHeaders:()=>({'Content-Type':'application/json','Access-Control-Allow-Origin':'https://ct-atlas.com'}),isAllowedUser:n=>n==='analyst',
  gateCall:async(env,path,body)=>{
   if(path===gateThrow)throw new Error('Durable Object reset because its code was updated');
   if(path==='/session-get')return Response.json({username:body.session_token},{status:body.session_token==='analyst'?200:401});
   gate.push(JSON.parse(JSON.stringify(body)));return new Response(JSON.stringify(gateReply||{}),{status:limit});
  },
  fetch:async(url,options={})=>{
   calls.push({url,options});const u=new URL(url);
   if(fail.some(s=>url.includes(s)))throw new Error('private provider detail must never leak');
   if(u.hostname==='api.ipapi.is')return Response.json(ipapi||{error:'Unavailable'},{status:ipapiStatus});
   if(u.pathname.includes('/whois/'))return Response.json(whois||{status:'error'});
   if(u.hostname==='data.iana.org')return Response.json({services:[[['8.0.0.0/8','2000::/3'],['https://rdap.arin.net/registry/']]]},{status:ianaStatus});
   if(u.hostname==='rdap.arin.net')return redirect?new Response(null,{status:302,headers:{Location:redirect}}):Response.json({startAddress:'8.8.8.0',endAddress:'8.8.8.255',...registryData},{status:rdapStatus});
   if(u.hostname==='api.ipinfo.io')return u.pathname.includes('/lite/')?Response.json({ip:'8.8.8.8',...lite},{status:liteStatus}):Response.json({ip:'8.8.8.8',...ipinfo},{status:ipinfoStatus});
   if(u.hostname==='proxycheck.io')return Response.json({status:proxyStatus,message:proxyMessage,[proxyIP]:proxy},{status:proxyHttp});
   if(u.pathname.includes('as-overview'))return Response.json({status:'ok',data:{holder}});
   if(u.pathname.includes('network-info'))return Response.json({status:'ok',data:{asns,prefix:'8.8.8.0/24'}});
   if(u.pathname.includes('abuse-contact'))return Response.json({status:'ok',data:{abuse_contacts:['abuse@example.net','network@example.net']}});
   if(u.pathname.includes('maxmind'))return Response.json({status:'ok',data:{result_time:'2026-10-02T12:00:00',located_resources:[{locations:[{country:geoCountry,city:'Example City',latitude:40,longitude:-75}]}]}});
   throw new Error('Unexpected endpoint '+url);
  }});
 vm.runInContext(source+'\nglobalThis.api={parseIP,publicIP,registration,whoisRegistration,serviceContact,lookupIP,handleIPIntelligence};',context);
 return {api:context.api,calls,gate,async request(ip='8.8.8.8',token='analyst',env={}){return context.api.handleIPIntelligence(new Request('https://api/ip-intelligence/lookup',{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify({ip})}),env);}};
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
 assert.equal(data.privacy.service,'Proton VPN');assert.equal(data.operator.name,'Hosting Co');
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

test('the gate shares a daily budget for the keyed providers and forgets the previous day',async()=>{
 let now=Date.parse('2026-10-04T10:00:00Z'),queue=Promise.resolve();const values=new Map();
 const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},
  async delete(keys){for(const k of [].concat(keys))values.delete(k);},async list({prefix}){return new Map([...values].filter(([k])=>k.startsWith(prefix)));},
  transaction(fn){const next=queue.then(()=>fn(storage));queue=next.catch(()=>{});return next;}};
 class FakeDate extends Date { static now(){ return now; } }
 const context=vm.createContext({Request,Response,URL,Date:FakeDate,isAllowedUser:name=>['analyst','other'].includes(name)});
 const gateSource=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'').replace('export class ReportGate','class ReportGate');
 vm.runInContext(gateSource+'\nglobalThis.Gate=ReportGate;',context);
 const gate=new context.Gate({storage},{});
 const call=async(username,keyed=true)=>(await gate.fetch(new Request('https://gate/ip-intelligence-limit',{method:'POST',body:JSON.stringify({username,keyed})}))).json();
 assert.deepEqual(await call('analyst'),{ok:true,keyed:true});
 assert.deepEqual(await call('analyst',false),{ok:true},'requests without keyed providers behave as before');
 values.set('ip-intelligence:keyed:2026-10-04:analyst',300);
 assert.deepEqual(await call('analyst'),{ok:true,keyed:false},'one analyst cannot use up the shared quota');
 assert.deepEqual(await call('other'),{ok:true,keyed:true});
 values.set('ip-intelligence:keyed:2026-10-04',800);
 assert.deepEqual(await call('other'),{ok:true,keyed:false},'the global daily budget holds');
 now=Date.parse('2026-10-05T00:05:00Z');
 assert.deepEqual(await call('analyst'),{ok:true,keyed:true},'a new day starts a new budget');
 assert.ok(![...values.keys()].some(k=>k.startsWith('ip-intelligence:keyed:2026-10-04')),'the previous day is forgotten');
});

test('Lite access recovers an operator after lookup auth/tier errors, preserving precise fallback location',async()=>{
 for(const ipinfoStatus of [401,402,403,404]){
  const h=harness({ipinfoStatus,lite:{as_name:'Google LLC',asn:'AS15169',as_domain:'google.com',country:'United States',country_code:'US'},asns:[15169],proxy:{network:{},detections:{vpn:false}}});
  const data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'test-secret'})).json();
  assert.equal(data.operator.name,'Google LLC');assert.equal(data.operator.source,'IPinfo Lite');assert.equal(data.enrichment.ipinfo_access,'lite');
  assert.equal(data.geolocation.city,'Example City');assert.equal(data.geolocation.latitude,40);
  assert.equal(data.privacy.vpn,false);assert.equal(data.enquiry.url,'https://lers.google.com/');
  assert.equal(data.sources.find(s=>s.name==='IPinfo Lite').status,'available');
  assert.equal(h.calls.filter(c=>c.url.includes('api.ipinfo.io')).length,2);
  assert.ok(!JSON.stringify(data).includes('test-secret'));
 }
});
test('IPinfo quota and mismatched-IP errors are not disguised by a Lite retry',async()=>{
 for(const options of [{ipinfoStatus:429},{ipinfo:{ip:'1.1.1.1',as:{name:'Wrong network'}}}]){
  const h=harness(options),data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'test-secret'})).json();
  assert.ok(!h.calls.some(c=>c.url.includes('/lite/')));assert.equal(data.operator.name,'Example Network');
  assert.equal(data.sources.find(s=>s.name==='IPinfo').reason,options.ipinfoStatus?'http_429':'ip_mismatch');
 }
});
test('network holder fallback recovers a name when registration has no organisation',async()=>{
 const h=harness({registryData:{name:'CRYPTIC-RANGE'},holder:'Example ISP SA'}),data=await(await h.request()).json();
 assert.equal(data.operator.name,'Example ISP SA');assert.equal(data.operator.source,'RIPEstat ASN holder');
 assert.equal(data.enquiry.name,'Example ISP SA');assert.equal(data.enquiry.email,'abuse@example.net');
 assert.match(data.enquiry.status,/Registry contact/);
});
test('Proxycheck VPN attribution takes priority over hosting ownership and works without a key',async()=>{
 const h=harness({proxy:{network:{provider:'Datacenter Co',type:'Hosting'},detections:{vpn:true,proxy:false,hosting:true,confidence:95,last_seen:'2026-10-03T10:00:00Z'},operator:{name:'IVPN',url:'https://www.ivpn.net/'}}});
 const data=await(await h.request()).json();
 assert.equal(data.operator.name,'Example Network');assert.equal(data.privacy.service,'IVPN');
 assert.equal(data.enquiry.name,'IVPN');assert.equal(data.enquiry.email,'legal@ivpn.net');assert.equal(data.enquiry.country,'Gibraltar');assert.match(data.enquiry.scope,/jurisdiction in Gibraltar/);
 assert.equal(data.provider_contacts[0].target_type,'intermediary');assert.equal(data.enrichment.proxycheck_access,'unregistered');
 const call=h.calls.find(c=>c.url.includes('proxycheck.io'));
 assert.equal(new URL(call.url).searchParams.get('tag'),'0');assert.ok(!new URL(call.url).searchParams.has('key'));
 assert.ok(!h.calls.some(c=>c.url.startsWith('https://www.ivpn.net')));
});
test('contradicting assessments remain visible and do not produce a false negative or a certain recipient',async()=>{
 const h=harness({ipinfo:{as:{name:'Host'},anonymous:{is_vpn:false,name:'ProtonVPN'}},proxy:{network:{},detections:{vpn:true},operator:{name:'IVPN',url:'https://www.ivpn.net/'}}});
 const data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.privacy.vpn,null);assert.ok(data.privacy.conflicts.includes('vpn'));assert.equal(data.privacy.services.length,2);
 assert.equal(data.privacy.service,'');assert.equal(data.enquiry.ambiguous,true);assert.equal(data.enquiry.email,'');
 assert.equal(data.privacy.assessments[0].vpn,false);assert.equal(data.privacy.assessments[1].vpn,true);
 assert.ok(data.warnings.some(w=>w.includes('disagree')));
});
test('additional operators are retained and exact aliases deduplicate across sources',async()=>{
 let h=harness({proxy:{network:{},detections:{vpn:true},operator:{name:'IVPN',additional_operators:[{name:'ProtonVPN'}]}}});
 let data=await(await h.request()).json();assert.equal(data.privacy.services.length,2);assert.equal(data.enquiry.ambiguous,true);
 h=harness({ipinfo:{as:{name:'Host'},anonymous:{is_vpn:true,name:'ProtonVPN'}},proxy:{network:{},detections:{vpn:true},operator:{name:'Proton VPN'}}});
 data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.privacy.services.length,1);assert.equal(data.privacy.services[0].sources.length,2);assert.equal(data.enquiry.email,'legal@proton.me');
});
test('unknown providers are named without inventing legal contacts; unsafe websites are not exposed or fetched',async()=>{
 for(const url of ['https://127.0.0.1/admin','https://localhost/','javascript:alert(1)','https://user:pass@vpn.example.org/','https://vpn.local/']){
  const h=harness({proxy:{network:{},detections:{vpn:true},operator:{name:'New VPN',url}}}),data=await(await h.request()).json();
  assert.equal(data.enquiry.name,'New VPN');assert.equal(data.enquiry.email,'');assert.equal(data.enquiry.url,'');assert.match(data.enquiry.status,/not yet verified/);
  assert.ok(!h.calls.some(c=>c.url===url));
 }
 const h=harness({proxy:{network:{},detections:{vpn:true},operator:{name:'New VPN',url:'https://newvpn.org/path?tracking=1'}}}),data=await(await h.request()).json();
 assert.equal(data.enquiry.url,'https://newvpn.org/');assert.match(data.enquiry.status,/legal channel not verified/);
});
test('Proxycheck failures and mismatched IPs preserve registry data and unknown VPN; optional key stays server side',async()=>{
 for(const options of [{proxyHttp:429},{proxyStatus:'denied'},{proxyIP:'1.1.1.1'}]){
  const h=harness(options),data=await(await h.request('8.8.8.8','analyst',{PROXYCHECK_API_KEY:'private-key'})).json();
  assert.equal(data.privacy.vpn,null);assert.equal(data.operator.name,'Example Network');assert.equal(data.enrichment.proxycheck_access,'unavailable');
  assert.ok(!JSON.stringify(data).includes('private-key'));assert.equal(data.sources.find(s=>s.name==='Proxycheck.io').status,'unavailable');
 }
 const h=harness(),data=await(await h.request('8.8.8.8','analyst',{PROXYCHECK_API_KEY:'private-key'})).json();
 assert.equal(data.enrichment.proxycheck_access,'api_key');assert.ok(!JSON.stringify(data).includes('private-key'));
 assert.equal(new URL(h.calls.find(c=>c.url.includes('proxycheck.io')).url).searchParams.get('key'),'private-key');
 const disabled=harness();await disabled.request('8.8.8.8','analyst',{PROXYCHECK_ENABLED:'false'});assert.ok(!disabled.calls.some(c=>c.url.includes('proxycheck.io')));
});
test('Proxycheck warning responses retain data and report the warning without leaking raw messages',async()=>{
 const h=harness({proxyStatus:'warning',proxy:{network:{},detections:{vpn:false}}}),data=await(await h.request()).json();
 assert.equal(data.privacy.vpn,false);assert.ok(data.warnings.some(w=>w.includes('account/quota')));
});
test('report foregrounds the enquiry recipient, policy scope, and source-level attribution',async()=>{
 const h=harness({proxy:{network:{},detections:{vpn:true},operator:{name:'IVPN'}}}),data=await(await h.request()).json(),context={window:{}};
 vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 const report=context.window.CTAtlasIPReport.build(data,{}),body=report.blocks.map(b=>b.text).join('\n');
 for(const expected of ['WHO TO CONTACT','IVPN','legal@ivpn.net','Gibraltar','5 Secretary’s Lane','Proxycheck.io: VPN Detected','subscriber/account holder identity','installation postal address','access ISP behind it is not identified'])assert.ok(body.includes(expected),expected);
 assert.match(context.window.CTAtlasIPReport.overview(data).contact,/Enquiry target: IVPN/);
});
test('Proxycheck supplies a location fallback when RIPEstat is unavailable, without inventing an accuracy radius',async()=>{
 const h=harness({fail:['maxmind'],proxy:{network:{},detections:{},location:{country_name:'United States',country_code:'US',city_name:'Mountain View',latitude:37.422,longitude:-122.085},last_updated:'2026-10-03T18:00:00Z'}});
 const data=await(await h.request()).json();assert.equal(data.geolocation.source,'Proxycheck.io');assert.equal(data.geolocation.city,'Mountain View');assert.equal(data.geolocation.radius_km,null);
});
test('conflicting network ASNs do not silently choose a legal recipient',async()=>{
 const h=harness({asns:[15169],ipinfo:{as:{name:'Different owner',asn:'AS13335'}},proxy:{network:{},detections:{vpn:false}}});
 const data=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(data.operator.attribution_conflict,true);assert.equal(data.enquiry.ambiguous,true);assert.equal(data.enquiry.url,'');assert.equal(data.enquiry.email,'');
 assert.ok(data.warnings.some(w=>w.includes('AS15169')&&w.includes('AS13335')));
});
test('jurisdiction and postal address come from the named provider, independently of IP/registration country',async()=>{
 const h=harness({proxy:{network:{},detections:{vpn:true},operator:{name:'ProtonVPN'}}}),data=await(await h.request()).json();
 assert.equal(data.registration.country,'DE');assert.equal(data.geolocation.country,'US');
 assert.equal(data.enquiry.jurisdictions[0].country_code,'CH');assert.match(data.enquiry.jurisdictions[0].address,/Route de la Galaise/);
 const context={window:{}};vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 const report=context.window.CTAtlasIPReport.build(data,{}),flags=report.blocks.filter(b=>b.type==='image');
 assert.ok(flags.some(b=>b.caption.includes('Switzerland')&&b.inline===true));
 assert.ok(flags.every(b=>b.src.startsWith('data:image/svg+xml;')));
 for(const code of ['CH','SE','PA','NL','VG','GI','US','IE'])assert.ok(context.window.CTAtlasIPReport.flagSource(code).startsWith('data:'));
 assert.equal(context.window.CTAtlasIPReport.flagSource('ZZ'),'');
});
test('unknown jurisdictions are explicit and multi-entity networks preserve the alternatives',async()=>{
 let h=harness(),data=await(await h.request()).json();assert.equal(data.enquiry.jurisdictions.length,0);
 const context={window:{}};vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 assert.match(context.window.CTAtlasIPReport.enquiryLines(data).join('\n'),/Jurisdiction: Not verified/);
 h=harness({asns:[15169]});data=await(await h.request()).json();
 assert.deepEqual(data.enquiry.jurisdictions.map(j=>j.country_code),['US','IE']);
 assert.match(data.enquiry.jurisdictions[1].scope,/cannot be determined from an IP alone/);
});

const whoisFixture={status:'ok',data:{resource:'8.8.8.0/24',query_time:'2026-10-03T20:00:00Z',records:[
 [{key:'NetRange',value:'8.8.8.0 - 8.8.8.255'},{key:'NetName',value:'EXAMPLE'},{key:'Organization',value:'Example ISP'}],
 [{key:'OrgName',value:'Example ISP'},{key:'Address',value:'1 Example Street'},{key:'City',value:'Test City'},{key:'Country',value:'GB'}],
 [{key:'OrgAbuseName',value:'Network desk'},{key:'OrgAbuseEmail',value:'abuse@example.net'},{key:'OrgAbusePhone',value:'+44 000'}]
],irr_records:[[{key:'descr',value:'Unrelated route maintainer'}]]}};
const ipapiFixture={ip:'8.8.8.8',is_vpn:true,is_proxy:false,is_tor:false,is_datacenter:true,
 asn:{asn:65001,org:'Example Network',type:'hosting',domain:'example.net',route:'8.8.8.0/24'},
 company:{name:'Example Network',network:'8.8.8.0 - 8.8.8.255'},
 abuse:{name:'Network Desk',email:'abuse@example.net',address:'1 Example Street',phone:'+44 000'},
 location:{country:'United Kingdom',country_code:'GB',city:'London',latitude:51.5,longitude:-0.1},
 vpn:{ip:'8.8.8.8',service:'ProtonVPN',url:'https://protonvpn.com/',last_seen_str:'2026-10-03T12:00:00Z'}};

test('WHOIS recovers allocation, address and technical contacts after bootstrap or RDAP HTTP 525',async()=>{
 for(const outage of [{ianaStatus:525},{rdapStatus:525}]){
  const h=harness({...outage,whois:whoisFixture});const d=await(await h.request()).json();
  assert.equal(d.registration.source,'RIPEstat WHOIS');assert.equal(d.operator.name,'Example ISP');
  assert.equal(d.operator.source,'RIPEstat WHOIS');assert.equal(d.registration.country,'GB');
  assert.ok(d.contacts.some(c=>c.address.includes('1 Example Street')));assert.equal(d.enquiry.email,'abuse@example.net');
  const failed=d.sources.find(s=>s.name==='RIR RDAP');assert.equal(failed.reason,'http_525');assert.equal(failed.stage,outage.ianaStatus?'bootstrap':'registry');
  assert.match(failed.action,/WHOIS/);assert.equal(d.status,'partial');
 }
});
test('WHOIS validates resource and allocation and never interprets unrelated IRR routes as ownership',()=>{
 const {api}=harness();const parsed=api.parseIP('8.8.8.8');
 assert.throws(()=>api.whoisRegistration({...whoisFixture,data:{...whoisFixture.data,resource:'1.1.1.0/24'}},parsed),/ip_mismatch/);
 assert.throws(()=>api.whoisRegistration({status:'ok',data:{resource:'8.8.8.8',records:[],irr_records:whoisFixture.data.records}},parsed),/invalid_response/);
 const d=api.whoisRegistration({status:'ok',data:{resource:'2606:4700::/32',records:[[{key:'inet6num',value:'2606:4700::/32'},{key:'netname',value:'V6-NET'},{key:'country',value:'NL'}]]}},api.parseIP('2606:4700:4700::1111'));
 assert.equal(d.name,'V6-NET');assert.equal(d.start,'2606:4700::');assert.equal(d.end,'2606:4700:ffff:ffff:ffff:ffff:ffff:ffff');
 const mixed={...whoisFixture,data:{...whoisFixture.data,records:[...whoisFixture.data.records,[{key:'inetnum',value:'1.1.1.0 - 1.1.1.255'},{key:'netname',value:'OTHER'}]]}};
 assert.equal(api.whoisRegistration(mixed,parsed).contacts.length,0);
});
test('RDAP mismatched allocation is rejected and a separately validated WHOIS fallback is used',async()=>{
 const h=harness({registryData:{startAddress:'1.1.1.0',endAddress:'1.1.1.255'},whois:whoisFixture});const d=await(await h.request()).json();
 assert.equal(d.sources.find(s=>s.name==='RIR RDAP').reason,'ip_mismatch');assert.equal(d.registration.source,'RIPEstat WHOIS');
});
test('independent ipapi VPN and postal contact survive Proxycheck denial; credentials stay in POST body',async()=>{
 const h=harness({proxyHttp:403,proxyMessage:'Your access to the API has been blocked due to using a proxy server. private-key',ipapi:ipapiFixture});
 const d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'private-key'})).json();
 assert.equal(d.privacy.vpn,true);assert.equal(d.privacy.service,'Proton VPN');assert.equal(d.enquiry.email,'legal@proton.me');
 assert.equal(d.enrichment.ipapi_is_access,'api_key');assert.ok(d.contacts.some(c=>c.source.startsWith('ipapi.is')&&c.address==='1 Example Street'));
 const call=h.calls.find(c=>c.url==='https://api.ipapi.is/');assert.equal(call.options.method,'POST');
 assert.deepEqual(JSON.parse(call.options.body),{q:'8.8.8.8',key:'private-key'});assert.ok(!h.calls.some(c=>c.url.includes('private-key')));
 assert.ok(!JSON.stringify(d).includes('private-key'));assert.match(d.sources.find(s=>s.name==='Proxycheck.io').action,/PROXYCHECK_API_KEY/);
});
test('ipapi is not called without a configured key or when explicitly disabled',async()=>{
 for(const env of [{},{IPAPI_IS_KEY:'key',IPAPI_IS_ENABLED:'false'}]){
  const h=harness();const d=await(await h.request('8.8.8.8','analyst',env)).json();assert.ok(!h.calls.some(c=>c.url.includes('api.ipapi.is')));
  assert.equal(d.enrichment.ipapi_is_access,env.IPAPI_IS_ENABLED?'disabled':'not_configured');
 }
});
test('ipapi limited, mismatched, quota and invalid-key results do not imply no VPN or leak error details',async()=>{
 const cases=[
  {ipapi:{ip:'8.8.8.8',company:'Example Network',asn:'AS65001 Example Network',docs:'https://ipapi.is/free-tier.html',is_vpn:false}},
  {ipapi:{...ipapiFixture,ip:'1.1.1.1'}},
  {ipapi:{...ipapiFixture,vpn:{...ipapiFixture.vpn,ip:'1.1.1.1'}}},
  {ipapiStatus:429,ipapi:{error:'private-key',error_code:'ERR_QUOTA_EXCEEDED'}},
  {ipapiStatus:403,ipapi:{error:'private-key',error_code:'ERR_FORBIDDEN_INVALID_API_KEY'}}
 ];
 for(const options of cases){const h=harness(options),d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'private-key'})).json();
  assert.equal(d.privacy.vpn,null);assert.equal(d.privacy.service,'');assert.ok(!JSON.stringify(d).includes('private-key'));
  if(options.ipapiStatus===429)assert.match(d.sources.find(s=>s.name==='ipapi.is').action,/quota/);
  if(options.ipapiStatus===403)assert.match(d.sources.find(s=>s.name==='ipapi.is').action,/rejected or disabled/);
 }
});
test('ipapi negative conflict stays unresolved and nonboolean detections stay unknown',async()=>{
 let h=harness({ipapi:ipapiFixture,proxy:{network:{},detections:{vpn:false}}});let d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'key'})).json();
 assert.equal(d.privacy.vpn,null);assert.equal(d.enquiry.ambiguous,true);assert.equal(d.enquiry.email,'');assert.ok(d.privacy.conflicts.includes('vpn'));
 h=harness({ipapi:{...ipapiFixture,is_vpn:'ambiguous-provider-value'}});d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'key'})).json();assert.equal(d.privacy.vpn,null);assert.equal(d.privacy.service,'');
});
test('ipapi supplies fallback ASN/geolocation and rejects contacts from unrelated allocation',async()=>{
 const h=harness({fail:['rdap.arin.net','network-info','maxmind'],ipapi:{...ipapiFixture,is_vpn:false,vpn:null,company:{network:'1.1.1.0/24'}}});
 const d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'key'})).json();
 assert.equal(d.operator.name,'Example Network');assert.equal(d.operator.source,'ipapi.is');assert.deepEqual(d.operator.asns,['AS65001']);
 assert.equal(d.geolocation.source,'ipapi.is');assert.equal(d.geolocation.city,'London');assert.ok(!d.contacts.some(c=>c.source.startsWith('ipapi.is')));
});
test('Cisco has an official police portal, scoped fallback email, US jurisdiction/flag and mail-relay guidance in PDF',async()=>{
 const h=harness({asns:[30238],ipinfoStatus:403,lite:{asn:'AS30238',as_name:'Cisco Systems Ironport Division',as_domain:'cisco.com',country:'United States'},rdapStatus:525,proxyHttp:403});
 const d=await(await h.request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(d.enquiry.url,'https://privacyrequest.cisco.com/governmentdatarequest');assert.equal(d.enquiry.email,'governmentdatademands@cisco.com');assert.equal(d.enquiry.jurisdictions[0].country_code,'US');
 assert.match(d.enquiry.records_to_request,/Message-ID/);assert.match(d.enquiry.subscriber_scope,/mail relay/);
 const context={window:{}};vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 const report=context.window.CTAtlasIPReport.build(d,{}),text=report.blocks.map(b=>b.text||b.caption).join('\n');
 for(const term of ['170 West Tasman','United States','governmentdatademands@cisco.com','Message-ID','PROXYCHECK_API_KEY','IPAPI_IS_KEY','RIPEstat WHOIS'])assert.ok(text.includes(term),term);
 assert.ok(report.blocks.some(b=>b.inline&&b.caption.includes('United States')));
});
const reportApi=()=>{const context={window:{}};vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);return context.window.CTAtlasIPReport;};
test('reviewed legal routes are never filled with registry abuse details and name the contact owner',async()=>{
 for(const asn of [15169,8075,13335,30238]){
  const h=harness({asns:[asn],proxy:{network:{},detections:{vpn:false}}}),d=await(await h.request()).json(),e=d.enquiry,route=d.provider_contacts[0];
  assert.equal(e.email,route.email||'',asn);assert.equal(e.phone,'',asn);assert.equal(e.address,route.address||'',asn);
  assert.equal(e.contact_source,'Reviewed provider directory · 2026-10-03');assert.equal(e.checked_on,'2026-10-03');assert.equal(e.contact_entity,route.name);
  assert.ok(!/abuse@example\.net|Operator HQ/.test(JSON.stringify(e)),'registry details leaked into the '+route.name+' route');
  const lines=reportApi().enquiryLines(d).join('\n');
  assert.ok(!lines.includes('abuse@example.net'));assert.ok(lines.includes('Contact belongs to: '+route.name));
  assert.ok(d.contacts.some(c=>c.emails.includes('abuse@example.net')),'registry contacts stay listed separately');
 }
});
test('only routing-relevant disagreements block the recipient; hosting and proxy conflicts with an agreed VPN do not',async()=>{
 const env={IPINFO_TOKEN:'key'};
 let d=await(await harness({ipinfo:{as:{name:'Host'},anonymous:{is_vpn:true,name:'ProtonVPN'},is_hosting:false},proxy:{network:{},detections:{vpn:true,hosting:true},operator:{name:'Proton VPN'}}}).request('8.8.8.8','analyst',env)).json();
 assert.deepEqual([...d.privacy.conflicts],['hosting']);assert.equal(d.enquiry.ambiguous,false);assert.equal(d.enquiry.email,'legal@proton.me');
 assert.ok(d.warnings.some(w=>w.includes('disagree on hosting')));
 d=await(await harness({ipinfo:{as:{name:'Host'},anonymous:{is_vpn:true,is_proxy:false,name:'ProtonVPN'}},proxy:{network:{},detections:{vpn:true,proxy:true},operator:{name:'Proton VPN'}}}).request('8.8.8.8','analyst',env)).json();
 assert.deepEqual([...d.privacy.conflicts],['proxy']);assert.equal(d.enquiry.ambiguous,false);assert.equal(d.enquiry.email,'legal@proton.me');
 d=await(await harness({asns:[15169],ipinfo:{as:{name:'Google LLC',asn:'AS15169'},anonymous:{is_vpn:false},is_hosting:true},proxy:{network:{},detections:{vpn:false,hosting:false}}}).request('8.8.8.8','analyst',env)).json();
 assert.deepEqual([...d.privacy.conflicts],['hosting']);assert.equal(d.enquiry.ambiguous,false);assert.equal(d.enquiry.url,'https://lers.google.com/');
 // Without a named service, a proxy disagreement can still change the recipient.
 d=await(await harness({ipinfo:{as:{name:'Host'},anonymous:{is_vpn:false,is_proxy:true}},proxy:{network:{},detections:{vpn:false,proxy:false}}}).request('8.8.8.8','analyst',env)).json();
 assert.deepEqual([...d.privacy.conflicts],['proxy']);assert.equal(d.enquiry.ambiguous,true);assert.equal(d.enquiry.email,'');
});
test('a registry contact says which organisation owns it and flags a reallocated range',async()=>{
 const registrant=name=>({name:'NET-CUSTOMER',entities:[{roles:['registrant'],vcardArray:['vcard',[['fn',{},'text',name],['adr',{label:'9 Customer Road'},'text',[]]]],
  entities:[{roles:['abuse'],vcardArray:['vcard',[['fn',{},'text','Customer Abuse'],['email',{},'text','abuse@reseller.example']]]}]}]});
 let d=await(await harness({registryData:registrant('Small Hosting Reseller LLC'),ipinfo:{as:{name:'Big Transit ISP',asn:'AS65001'}}}).request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(d.operator.name,'Big Transit ISP');assert.equal(d.enquiry.name,'Big Transit ISP');assert.equal(d.enquiry.email,'abuse@reseller.example');
 assert.equal(d.enquiry.contact_entity,'Small Hosting Reseller LLC');assert.equal(d.enquiry.contact_name,'Customer Abuse');
 assert.match(d.enquiry.status,/different organisation/);assert.match(d.enquiry.basis,/Small Hosting Reseller LLC.*reallocated/);
 assert.ok(reportApi().enquiryLines(d).includes('Contact belongs to: Small Hosting Reseller LLC · Customer Abuse'));
 d=await(await harness({registryData:registrant('BIG TRANSIT ISP'),ipinfo:{as:{name:'Big Transit ISP',asn:'AS65001'}}}).request('8.8.8.8','analyst',{IPINFO_TOKEN:'key'})).json();
 assert.equal(d.enquiry.status,'Registry contact — request the legal channel');assert.equal(d.enquiry.contact_entity,'BIG TRANSIT ISP');assert.doesNotMatch(d.enquiry.basis,/differs/);
 d=await(await harness()).request().then(r=>r.json());
 assert.equal(d.enquiry.email,'abuse@example.net');assert.equal(d.enquiry.contact_entity,'Example Network');assert.equal(d.enquiry.contact_name,'Abuse Desk');
});
test('RIPE-format WHOIS fallback never turns a country code into a postal address',async()=>{
 const {api}=harness(),inetnum=[{key:'inetnum',value:'8.8.8.0 - 8.8.8.255'},{key:'netname',value:'EXAMPLE-NL'},{key:'descr',value:'Example customer'},{key:'country',value:'NL'},{key:'admin-c',value:'AB1-RIPE'},{key:'tech-c',value:'AB1-RIPE'}];
 const d=api.whoisRegistration({status:'ok',data:{resource:'8.8.8.0/24',records:[inetnum,
  [{key:'person',value:'Example Admin'},{key:'country',value:'NL'},{key:'nic-hdl',value:'AB1-RIPE'}],
  [{key:'role',value:'Example NOC'},{key:'address',value:'Keizersgracht 1'},{key:'address',value:'Amsterdam'},{key:'phone',value:'+31 20 000'},{key:'abuse-mailbox',value:'noc@example.nl'}]]}},api.parseIP('8.8.8.8'));
 assert.deepEqual([...d.contacts.map(c=>c.name)],['Example NOC']);assert.equal(d.contacts[0].address,'Keizersgracht 1, Amsterdam');assert.deepEqual([...d.contacts[0].roles],['abuse']);
 const h=harness({rdapStatus:525,whois:{status:'ok',data:{resource:'8.8.8.0/24',records:[inetnum]}}}),r=await(await h.request()).json();
 assert.equal(r.registration.source,'RIPEstat WHOIS');assert.equal(r.registration.country,'NL');
 assert.ok(!r.contacts.some(c=>c.source==='RIPEstat WHOIS'||c.address==='NL'));assert.notEqual(r.enquiry.address,'NL');
});
test('unverified provider websites are labelled as such in the report; reviewed entries keep the procedure label',async()=>{
 let d=await(await harness({proxy:{network:{},detections:{vpn:true},operator:{name:'New VPN',url:'https://newvpn.org/path'}}}).request()).json();
 assert.equal(d.enquiry.checked_on,'');let lines=reportApi().enquiryLines(d).join('\n');
 assert.ok(lines.includes('Provider website (unverified, not a legal channel): https://newvpn.org/'));assert.ok(!lines.includes('Contact / procedure:'));
 d=await(await harness({proxy:{network:{},detections:{vpn:true},operator:{name:'IVPN'}}}).request()).json();lines=reportApi().enquiryLines(d).join('\n');
 assert.equal(d.enquiry.checked_on,'2026-10-03');assert.ok(lines.includes('Contact / procedure: https://www.ivpn.net/en/legal-process-guidelines/'));
});
test('IP lookups take a per-minute slot; a gate reply withholding the keyed providers skips Proxycheck and ipapi.is',async()=>{
 let h=harness();await h.request();assert.deepEqual(h.gate,[{username:'analyst',keyed:true}]);
 h=harness({gateReply:{ok:true,keyed:false},ipapi:ipapiFixture});
 const d=await(await h.request('8.8.8.8','analyst',{IPAPI_IS_KEY:'key'})).json();
 assert.ok(!h.calls.some(c=>c.url.includes('proxycheck.io')||c.url.includes('api.ipapi.is')));
 assert.deepEqual(d.sources.filter(s=>s.status==='budget_reserved').map(s=>s.name),['Proxycheck.io','ipapi.is']);
 assert.equal(d.enrichment.proxycheck_access,'budget_reserved');assert.equal(d.enrichment.ipapi_is_access,'budget_reserved');
 assert.equal(d.privacy.vpn,null);assert.ok(d.warnings.some(w=>w.includes('Daily budget')));assert.equal(d.operator.name,'Example Network');
 // Nothing keyed is configured: no budget is requested.
 h=harness();await h.request('8.8.8.8','analyst',{PROXYCHECK_ENABLED:'false'});assert.deepEqual(h.gate,[{username:'analyst'}]);
});
test('a gate or Durable Object failure returns a retryable 503 with CORS and no internal detail',async()=>{
 for(const path of ['/session-get','/ip-intelligence-limit']){
  const h=harness({gateThrow:path}),r=await h.request(),body=await r.json();
  assert.equal(r.status,503);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://ct-atlas.com');
  assert.match(body.error,/temporarily unavailable\. Retry shortly/);assert.ok(!JSON.stringify(body).includes('Durable Object'));assert.equal(h.calls.length,0);
 }
});
test('IP ranges get a specific message; other invalid input keeps the general one',async()=>{
 for(const range of ['185.220.101.0/24','2001:4860::/32']){const r=await harness().request(range);assert.equal(r.status,400);assert.match((await r.json()).error,/ranges \(CIDR\) are not supported\. Enter one address/);}
 const r=await harness().request('bad.cafe/1');assert.equal(r.status,400);assert.doesNotMatch((await r.json()).error,/CIDR/);
});

// Minimal DOM for ip.js: every element records text, children, validity and listeners.
function pageHarness(responses){
 const elements=new Map(),downloads=[],requests=[],pdfs=[];
 class El{
  constructor(tag,id){Object.assign(this,{tagName:tag,id,children:[],textContent:'',hidden:false,value:'',className:'',disabled:false,valid:true,listeners:{},open:false});}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  addEventListener(type,fn){this.listeners[type]=fn;}
  setAttribute(k,v){this[k]=v;}
  checkValidity(){return this.valid;}
  reportValidity(){this.reported=true;return this.valid;}
  closest(selector){return selector==='details'?elements.get('incidentDetails'):null;}
  click(){if(this.tagName==='a')downloads.push(this.download);}
  remove(){}
  get text(){return [this.textContent,...this.children.map(c=>c.text)].join('\n');}
 }
 elements.set('incidentDetails',new El('details','incidentDetails'));
 const document={getElementById:id=>{if(!elements.has(id))elements.set(id,new El('div',id));return elements.get(id);},createElement:tag=>new El(tag),body:new El('body')};
 class PageURL extends URL{static createObjectURL(){return 'blob:test';}static revokeObjectURL(){}}
 const window={},context=vm.createContext({window,document,URL:PageURL,Blob,setTimeout:()=>0,location:{replace(){}},
  sessionStorage:{getItem:()=>'token',setItem(){},removeItem(){}},
  fetch:async url=>{requests.push(url);return Response.json(url.endsWith('/session-check')?{ok:true,username:'analyst'}:responses.shift());}});
 vm.runInContext(fs.readFileSync('ip-report.js','utf8'),context);
 window.CTAtlasPdf={download:async doc=>{pdfs.push(doc);}};
 vm.runInContext(fs.readFileSync('ip.js','utf8'),context);
 const $=document.getElementById;
 return {$,downloads,requests,pdfs,async submit(value){$('ipAddress').value=value;await $('lookupForm').listeners.submit({preventDefault(){}});},click:id=>$(id).listeners.click()};
}
test('IP page: ranges are refused before a request, an unregistered domain is not an outage, website labels follow verification',async()=>{
 const notFound={kind:'domain',host:'nx-unregistered-zzz.com',registered_domain:'nx-unregistered-zzz.com',queried_at:'2026-10-04T00:00:00Z',status:'not_found',
  registration:{name:'nx-unregistered-zzz.com',not_found:true,registrar:null,status:['not registered at lookup time'],events:[],nameservers:[],registry_url:'https://rdap.verisign.com/com/v1/domain/nx-unregistered-zzz.com',lookup_url:'https://lookup.icann.org/en/lookup?name=nx-unregistered-zzz.com',scope:'The domain registry reports this domain as not registered at lookup time (RDAP 404).'},
  dns:{addresses:[],address_count:0,cnames:[],nameservers:[],mail_exchangers:[],scope:'A/AAAA describe the submitted hostname.'},networks:[],sources:[],warnings:['The hostname does not exist according to DNS (NXDOMAIN).'],limitations:['Current records only.']};
 const unverified=await(await harness({proxy:{network:{},detections:{vpn:true},operator:{name:'New VPN',url:'https://newvpn.org/path'}}}).request()).json();
 const reviewed=await(await harness({proxy:{network:{},detections:{vpn:true},operator:{name:'IVPN'}}}).request()).json();
 const page=pageHarness([notFound,unverified,reviewed]);
 await page.submit('185.220.101.0/24');
 assert.match(page.$('status').textContent,/CIDR\) are not supported/);assert.ok(!page.requests.some(u=>u.includes('/ip-intelligence/')));
 await page.submit('nx-unregistered-zzz.com');
 assert.match(page.$('status').textContent,/not registered/);assert.doesNotMatch(page.$('status').textContent,/Retry/);
 assert.match(page.$('resultTime').textContent,/· NOT FOUND$/);assert.match(page.$('domainScope').textContent,/not registered at lookup time/);
 await page.submit('9.9.9.9');let card=page.$('enquiryContact').text;
 assert.ok(card.includes('PROVIDER WEBSITE · NOT A VERIFIED LEGAL CHANNEL ↗'));assert.ok(!card.includes('OPEN CONTACT / PROCEDURE'));assert.ok(card.includes('Contact belongs to: New VPN'));
 await page.submit('9.9.9.10');card=page.$('enquiryContact').text;
 assert.ok(card.includes('OPEN CONTACT / PROCEDURE ↗'));assert.ok(card.includes('Contact belongs to: IVPN'));
});
test('IP page exports ignore the search box and open the incident panel on an invalid incident field',async()=>{
 const data=await(await harness().request()).json(),page=pageHarness([data]);
 await page.submit('8.8.8.8');page.$('ipAddress').value='';page.$('ipAddress').valid=false;
 page.click('exportJson');await page.click('exportPdf');assert.equal(page.downloads.length,1);assert.equal(page.pdfs.length,1);
 page.$('sourcePort').valid=false;page.click('exportJson');await page.click('exportPdf');
 assert.equal(page.downloads.length,1);assert.equal(page.pdfs.length,1);
 assert.equal(page.$('incidentDetails').open,true);assert.equal(page.$('sourcePort').reported,true);assert.equal(page.$('ipAddress').reported,undefined);
 assert.match(page.$('status').textContent,/incident details/);
});
