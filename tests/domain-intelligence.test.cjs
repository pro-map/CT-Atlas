const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const strip=file=>fs.readFileSync(file,'utf8').replace(/^import[^\n]+\n/gm,'').replace(/export /g,'');
const ipContext=vm.createContext({URL,cleanText:(v,n=700)=>String(v||'').trim().slice(0,n)});
vm.runInContext(strip('cloudflare-worker/ip-intelligence.js')+'\nglobalThis.publicIP=publicIP;',ipContext);
const publicIP=ipContext.publicIP;
const domainSource=strip('cloudflare-worker/domain-data.js')+'\n'+strip('cloudflare-worker/domain-intelligence.js');
const record=(id='123',name='example.com')=>({ldhName:name,status:['active'],events:[{eventAction:'registration',eventDate:'2000-01-01T00:00:00Z'}],nameservers:[{ldhName:'ns.example.net'}],entities:[{roles:['registrar'],publicIds:[{type:'IANA Registrar ID',identifier:id}],vcardArray:['vcard',[
 ['fn',{},'text','Example Registrar'],['adr',{label:'1 Registry Street, Example City'},'text',[]],['url',{},'uri','https://registrar.example.net/']
]],entities:[{roles:['abuse'],vcardArray:['vcard',[['fn',{},'text','Registrar Abuse'],['email',{},'text','abuse@example.net'],['tel',{},'uri','tel:+1-555-0100']]]}]}]});
const network=ip=>({ip,family:ip.includes(':')?'IPv6':'IPv4',status:'complete',queried_at:'2026-10-03T00:00:00Z',operator:{name:'Example Hosting Network',asns:['AS65001'],prefix:'',source:'Synthetic test'},privacy:{source:'Synthetic test',assessments:[]},registration:null,geolocation:null,provider_contacts:[],contacts:[],sources:[{name:'Synthetic IP source',url:'https://example.net/',status:'available',retrieved_at:'2026-10-03T00:00:00Z'}],warnings:[],limitations:['Hosting does not identify the subscriber.']});
function harness(options={}){
 const calls=[],enriched=[];
 const fetch=async (url,init={})=>{
  calls.push({url:String(url),init});const u=new URL(url);
  if(['dns.google','cloudflare-dns.com'].includes(u.hostname)){
   const host=u.searchParams.get('name'),type=Number(u.searchParams.get('type'));
   if(options.dns){const value=options.dns({host,type,provider:u.hostname});if(value instanceof Response)return value;if(value!==undefined)return Response.json(value);}
   return Response.json({Status:0,Question:[{name:host+'.',type}],Answer:type===1?[{name:host,type,TTL:120,data:'8.8.8.8'}]:type===28?[{name:host,type,TTL:120,data:'2606:4700:4700::1111'}]:type===2?[{name:host,type,TTL:120,data:'ns.example.net.'}]:[{name:host,type,TTL:120,data:'10 mail.example.net.'}]});
  }
  if(options.failMetadata&&['data.iana.org','www.iana.org'].includes(u.hostname))return new Response('',{status:503});
  if(u.hostname==='data.iana.org')return Response.json({services:[[['com','uk'],['https://rdap.registry.net/']]]});
  if(u.hostname==='www.iana.org')return new Response('ID,Registrar Name,Status,RDAP Base URL\n123,"Example Registrar, Inc",Accredited,https://rdap.registrar.net/v1/\n');
  if(options.redirect&&u.hostname==='rdap.registry.net')return new Response(null,{status:302,headers:{Location:options.redirect}});
  if(['rdap.registry.net','rdap.verisign.com'].includes(u.hostname))return Response.json(options.registry||record(options.failMetadata?'0':'123'),{status:options.registryStatus||200});
  if(u.hostname==='rdap.registrar.net')return Response.json(options.registrar||record());
  throw new Error('Unexpected fetch: '+u.href);
 };
 const ctx=vm.createContext({URL,Response,AbortSignal,TextDecoder,Uint8Array,fetch});
 vm.runInContext(domainSource+'\nglobalThis.api={parseTarget,registeredDomain,lookupDomain};',ctx);
 return {api:ctx.api,calls,enriched,fetch,async lookup(value='https://www.example.com/private?token=not-forwarded#fragment'){
  const target=ctx.api.parseTarget(value,publicIP);assert.ok(target);
  return ctx.api.lookupDomain(target,{}, {publicIP,lookupIP:async(p,env,opts)=>{enriched.push({ip:p.ip,opts});return network(p.ip);}});
 }};
}

test('domain parsing normalizes URL/IDN input, preserves existing IPs and uses ICANN suffix rules',()=>{
 const {api}=harness();
 assert.equal(api.parseTarget('HTTPS://WWW.Example.COM./a?b=c#d',publicIP).host,'www.example.com');
 assert.equal(api.parseTarget('https://bücher.de/über',publicIP).host,'xn--bcher-kva.de');
 assert.equal(api.parseTarget('8.8.8.8',publicIP).kind,'ip');
 assert.equal(api.parseTarget('https://8.8.8.8/dns-query',publicIP).parsed.ip,'8.8.8.8');
 assert.equal(api.parseTarget('https://[2606:4700:4700::1111]/',publicIP).kind,'ip');
 for(const [host,expected] of [['news.example.co.uk','example.co.uk'],['x.city.kawasaki.jp','city.kawasaki.jp'],['a.b.ck','a.b.ck'],['x.www.ck','www.ck'],['user.github.io','github.io'],['co.uk','']])assert.equal(api.registeredDomain(host),expected,host);
});
test('invalid, local, special-use, credentialed and ambiguous inputs are rejected',()=>{
 const {api}=harness();
 for(const value of ['',null,' example.com','example.com ', 'localhost','host.local','hidden.onion','192.168.1.1','http://127.1/','http://0x08080808/','http://134744072/','https://192.0.2.1/','https://[::1]/','ftp://example.com','https://user:pass@example.com/','https://example.com:8443/','example.com:443','https://example.com\\@attacker.net/','https://exam ple.com','co.uk','a'.repeat(64)+'.com','x'.repeat(1025)])assert.equal(api.parseTarget(value,publicIP),null,String(value));
});
test('domain lookup separates registrar and network roles and never visits the submitted website',async()=>{
 const h=harness(),r=await h.lookup();
 assert.equal(r.kind,'domain');assert.equal(r.host,'www.example.com');assert.equal(r.registered_domain,'example.com');
 assert.equal(r.registration.registrar.name,'Example Registrar');assert.equal(r.registration.registrar.id,'123');
 assert.ok(r.registration.registrar.contacts.some(c=>c.emails.includes('abuse@example.net')));
 assert.ok(r.registration.registrar.contacts.some(c=>c.address.includes('Registry Street')));
 assert.equal(r.networks.length,2);assert.ok(h.enriched.every(v=>v.opts.expandRegistry===false));
 assert.equal(r.dns.mail_exchangers[0],'10 mail.example.net');
 assert.ok(h.calls.every(c=>!c.url.includes('not-forwarded')&&!c.url.includes('/private')&&new URL(c.url).hostname!=='www.example.com'));
 assert.ok(r.sources.some(s=>s.name==='Registrar RDAP'&&s.status==='available'));
 assert.ok(r.limitations.some(l=>l.includes('hidden origin')));
 assert.equal(r.registration.registrar.jurisdiction,undefined);
});
test('CNAME answers only enrich related public addresses, retain all DNS IPs and prefer both families',async()=>{
 const h=harness({dns:({host,type})=>type===1?{Status:0,Question:[{name:host,type}],Answer:[
  {name:host,type:5,data:'cdn.example.net.',TTL:60},
  ...['8.8.8.8','1.1.1.1','9.9.9.9','10.0.0.1','192.0.2.1'].map(data=>({name:'cdn.example.net',type:1,data,TTL:45})),
  {name:'unrelated.example.net',type:1,data:'4.2.2.2'}
 ]}:undefined});
 const r=await h.lookup();assert.equal(r.dns.addresses.length,4);assert.equal(r.networks.length,2);
 assert.equal(r.networks[1].family,'IPv6');assert.equal(r.dns.cnames[0],'cdn.example.net');
 assert.ok(!r.dns.addresses.some(a=>a.ip==='4.2.2.2'||a.ip.startsWith('10.')));
 assert.ok(r.warnings.some(w=>w.includes('non-public')));assert.ok(r.warnings.some(w=>w.includes('2 of 4')));
});
test('DNS fallback preserves failure diagnostics and validates the returned question',async()=>{
 const h=harness({dns:({host,type,provider})=>provider==='dns.google'?{Status:0,Question:[{name:'different.example.net',type}],Answer:[{name:host,type:1,data:'4.2.2.2'}]}:undefined});
 const r=await h.lookup();assert.equal(r.dns.addresses[0].ip,'8.8.8.8');
 assert.ok(r.sources.some(s=>s.name==='Google Public DNS 1'&&s.reason==='invalid_dns'));
 assert.ok(r.sources.some(s=>s.name==='Cloudflare DNS A'&&s.status==='available'));
 assert.ok(!r.dns.addresses.some(a=>a.ip==='4.2.2.2'));
});
test('null MX retains its root label instead of displaying an empty mail server',async()=>{
 const r=await harness({dns:({host,type})=>type===15?{Status:0,Question:[{name:host,type}],Answer:[{name:host,type,data:'0 .',TTL:60}]}:undefined}).lookup();
 assert.equal(r.dns.mail_exchangers[0],'0 .');
});
test('NXDOMAIN and unavailable DNS retain independent domain registration without IP enrichment',async()=>{
 for(const mode of ['nxdomain','unavailable']){
  const h=harness({dns:({host,type})=>mode==='nxdomain'?{Status:3,Question:[{name:host,type}]}:new Response('',{status:503})});
  const r=await h.lookup();assert.ok(r.registration);assert.equal(r.networks.length,0);assert.equal(h.enriched.length,0);
  assert.ok(r.warnings.some(w=>w.includes(mode==='nxdomain'?'NXDOMAIN':'No usable public IP')));
  if(mode==='nxdomain')assert.ok(!h.calls.some(c=>c.url.includes('cloudflare-dns.com')));
 }
});
test('domain mismatch and registry failures cannot attach another domain registrar to valid DNS results',async()=>{
 for(const options of [{registry:record('123','different.com')},{registryStatus:503}]){
  const r=await harness(options).lookup();assert.equal(r.registration,null);assert.equal(r.networks.length,2);
  assert.ok(r.sources.some(s=>s.name==='Domain registry RDAP'&&s.status==='unavailable'));
 }
});
test('registrar mismatch retains registry contacts and refuses unrelated registrar records',async()=>{
 const other=record('999');other.entities[0].vcardArray[1][0][3]='Wrong Registrar';
 const r=await harness({registrar:other}).lookup();assert.equal(r.registration.registrar.id,'123');
 assert.equal(r.registration.registrar.name,'Example Registrar');assert.ok(!JSON.stringify(r).includes('Wrong Registrar'));
 assert.ok(r.sources.some(s=>s.name==='Registrar RDAP'&&s.reason==='registrar_mismatch'));
});
test('RDAP redirects cannot visit private hosts or unrelated registry origins',async()=>{
 for(const redirect of ['http://127.0.0.1/admin','https://attacker.net/domain/example.com']){
  const h=harness({redirect}),r=await h.lookup();assert.equal(r.registration,null);
  assert.ok(r.sources.some(s=>s.reason==='untrusted_redirect'));
  assert.ok(!h.calls.some(c=>c.url===redirect));
 }
});
test('IANA outages use explicit dated snapshots rather than losing domain registration',async()=>{
 const r=await harness({failMetadata:true}).lookup();assert.equal(r.registration.name,'example.com');
 assert.ok(r.sources.some(s=>s.status==='snapshot'&&s.data_date==='2026-10-03'));
 assert.ok(r.warnings.some(w=>w.includes('snapshot dated')));
});
test('DNS address bounds limit work and never silently imply every IP was analysed',async()=>{
 const h=harness({dns:({host,type})=>({Status:0,Question:[{name:host,type}],Answer:type===1?Array.from({length:25},(_,i)=>({name:host,type,data:'8.8.8.'+(i+1),TTL:60})):[]})});
 const r=await h.lookup();assert.equal(r.dns.address_count,25);assert.equal(r.dns.addresses.length,16);assert.equal(r.networks.length,2);
 assert.ok(r.warnings.some(w=>w.includes('capped at 16')));
});
test('domain PDF includes registrar, per-IP contacts, unanalysed addresses, evidence time and scope',async()=>{
 const r=await harness().lookup();r.dns.addresses.push({ip:'1.1.1.1',family:'IPv4',ttl:60});
 const context={window:{}};vm.runInNewContext(fs.readFileSync('ip-report.js','utf8'),context);
 const report=context.window.CTAtlasIPReport.build(r,{reference:'Domain-Case-1',observed_at:'2025-01-01T00:00:00Z',notes:'مراجعة'}),body=report.blocks.map(b=>b.text||b.caption).join('\n');
 for(const value of ['Domain-Case-1','2025-01-01','مراجعة','Example Registrar','abuse@example.net','Registry Street','8.8.8.8 / WHO TO CONTACT','Example Hosting Network','1.1.1.1','Not analysed','hidden origin','Synthetic IP source','Legal jurisdiction is not established'])assert.ok(body.includes(value),value);
 assert.equal(report.filename,'CT-Atlas-Domain-www.example.com');
 // Registration-only results still produce a useful report.
 r.networks=[];r.dns.addresses=[];assert.doesNotThrow(()=>context.window.CTAtlasIPReport.build(r,{}));
 r.registration=null;assert.doesNotThrow(()=>context.window.CTAtlasIPReport.build(r,{}));
});
test('authenticated endpoint accepts the existing ip key for a URL, and validates before external lookups',async()=>{
 const h=harness(),calls=[];
 const context=vm.createContext({URL,Response,Request,TextDecoder,Uint8Array,AbortSignal,cleanText:(v,n=700)=>String(v||'').trim().slice(0,n),corsHeaders:()=>({'Content-Type':'application/json'}),isAllowedUser:n=>n==='analyst',parseTarget:h.api.parseTarget,lookupDomain:async target=>{calls.push(target);return {kind:'domain',host:target.host};},gateCall:async(env,path,body)=>path==='/session-get'?Response.json({username:body.session_token},{status:body.session_token==='analyst'?200:401}):Response.json({ok:true})});
 vm.runInContext(strip('cloudflare-worker/ip-intelligence.js')+'\nglobalThis.handler=handleIPIntelligence;',context);
 const request=(ip,token='analyst')=>context.handler(new Request('https://atlas.example.net/ip-intelligence/lookup',{method:'POST',headers:{'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify({ip})}),{});
 assert.equal((await request('https://example.com/path?secret=one')).status,200);assert.equal(calls.length,1);assert.equal(calls[0].host,'example.com');
 assert.equal((await request('https://127.0.0.1/')).status,400);
 assert.equal((await request('https://example.com/','invalid')).status,401);assert.equal(calls.length,1);
});
