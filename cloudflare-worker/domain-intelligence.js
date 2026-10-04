import { DOMAIN_DATA_DATE, PSL_ICANN_RULES, DNS_BOOTSTRAP, REGISTRAR_BOOTSTRAP } from './domain-data.js';

export const DOMAIN_INTELLIGENCE_VERSION = 'domain-intelligence-v2-not-registered';
const rules = new Set(PSL_ICANN_RULES), cache = new Map();
const list = v => Array.isArray(v) ? v : [];
const text = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,600) : '';
const stamp = () => new Date().toISOString();
const MAX_AUTO_IPS = 2;
function publicHost(host) {
  return host.length <= 253 && host.includes('.') && host.split('.').every(l=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(l)) &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|arpa|home|lan|alt)$/i.test(host) && !/^\d+(?:\.\d+)*$/.test(host);
}
export function registeredDomain(host) {
  const labels=host.toLowerCase().split('.'); let length=1;
  for(let i=0;i<labels.length;i++) {
    const suffix=labels.slice(i).join('.');
    if(rules.has('!'+suffix)) return labels.slice(-(labels.length-i)).join('.');
    if(rules.has(suffix)) length=Math.max(length,labels.length-i);
    if(i>0 && rules.has('*.'+suffix)) length=Math.max(length,labels.length-i+1);
  }
  return labels.length>length ? labels.slice(-(length+1)).join('.') : '';
}
// No request ever visits the submitted website. Only its canonical hostname leaves this parser.
export function parseTarget(value, publicIP) {
  if(typeof value !== 'string' || !value || value.length>1024 || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  const ip=publicIP(value); if(ip) return {kind:'ip',parsed:ip};
  if(/^\d+(?:\.\d+)*$/.test(value) || value.includes(':')&&!/^https?:\/\//i.test(value)) return null;
  try {
    const hasScheme=/^https?:\/\//i.test(value), u=new URL(hasScheme?value:'https://'+value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port) return null;
    const host=u.hostname.toLowerCase().replace(/\.$/,'');
    const literal=publicIP(host.startsWith('[')?host.slice(1,-1):host);
    if(literal) {
      // Without a scheme, 'a.b.c.d/24' or 'a.b.c.d/x' is a range or junk, not one address.
      if(!hasScheme)return null;
      const authority=value.split('://')[1].split(/[/?#]/)[0].toLowerCase();
      if(authority!==literal.ip && authority!=='['+literal.ip+']') return null;
      return {kind:'ip',parsed:literal};
    }
    if(!publicHost(host) || !registeredDomain(host)) return null;
    return {kind:'domain',host,registered_domain:registeredDomain(host)};
  } catch { return null; }
}
function safeURL(value) {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&publicHost(u.hostname)?u.href:'';}catch{return '';}
}
async function readText(response, max=1000000) {
  if(!response.ok){await response.body?.cancel();throw new Error('http_'+response.status);}
  if(!response.body) throw new Error('empty_response');
  const reader=response.body.getReader(),parts=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('response_too_large');}parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  return new TextDecoder().decode(bytes);
}
async function get(url, options={}) {
  const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(8000)});
  return JSON.parse(await readText(response));
}
function errorCode(error) {
  const value=String(error?.message||'');
  return /^(http_\d{3}|dns_\d+|invalid_dns|invalid_response|domain_mismatch|registrar_mismatch|untrusted_redirect|no_rdap_service|response_too_large)$/.test(value)?value:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'source_unavailable';
}
function csvRows(csv) {
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n')){row.push(value.replace(/\r$/,''));value='';if(c==='\n'){rows.push(row);row=[];}}else value+=c;}
  if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row);}return rows;
}
async function metadata(kind, sources, warnings) {
  const url=kind==='dns'?'https://data.iana.org/rdap/dns.json':'https://www.iana.org/assignments/registrar-ids/registrar-ids-1.csv';
  let entry=cache.get(kind);
  if(!entry||entry.until<Date.now()) {
    try {
      const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)}),raw=await readText(response);
      const data=kind==='dns'?JSON.parse(raw):Object.fromEntries(csvRows(raw).slice(1).filter(r=>/^\d+$/.test(r[0])&&r[2]==='Accredited'&&safeURL(r[3])).map(r=>[r[0],{name:text(r[1]),url:r[3]}]));
      if(kind==='dns'?!Array.isArray(data.services):!Object.keys(data).length)throw new Error('invalid_response');
      entry={data,until:Date.now()+86400000,retrieved_at:stamp()};
    } catch(error) {entry={data:kind==='dns'?DNS_BOOTSTRAP:REGISTRAR_BOOTSTRAP,until:Date.now()+300000,retrieved_at:stamp(),reason:errorCode(error),snapshot:true};}
    cache.set(kind,entry);
  }
  sources.push({name:kind==='dns'?'IANA domain bootstrap':'IANA registrar directory',url,status:entry.snapshot?'snapshot':'available',reason:entry.reason||'',data_date:entry.snapshot?DOMAIN_DATA_DATE:'',retrieved_at:entry.retrieved_at});
  if(entry.snapshot)warnings.push('Live '+(kind==='dns'?'domain':'registrar')+' discovery unavailable; using the IANA endpoint snapshot dated '+DOMAIN_DATA_DATE+'. Returned domain records are still checked against the requested domain.');
  return entry.data;
}
async function rdapAt(base, domain) {
  base=safeURL(base);if(!base)throw new Error('no_rdap_service');
  const permitted=new URL(base);let url=new URL('domain/'+encodeURIComponent(domain),base.endsWith('/')?base:base+'/').href;
  for(let hop=0;hop<3;hop++) {
    const u=new URL(url);
    if(!safeURL(url)||u.origin!==permitted.origin||!u.pathname.startsWith(permitted.pathname))throw new Error('untrusted_redirect');
    const r=await fetch(url,{redirect:'manual',headers:{Accept:'application/rdap+json, application/json'},signal:AbortSignal.timeout(8000)});
    if(r.status>=300&&r.status<400){const location=r.headers.get('Location');await r.body?.cancel();if(!location)throw new Error('untrusted_redirect');url=new URL(location,url).href;continue;}
    if(r.status===404){await r.body?.cancel();const error=new Error('http_404');error.url=url;throw error;}
    const data=JSON.parse(await readText(r));
    if(text(data.ldhName).toLowerCase().replace(/\.$/,'')!==domain)throw new Error('domain_mismatch');
    return {data,url};
  }
  throw new Error('untrusted_redirect');
}
function entityContact(entity, source) {
  const card=list(entity.vcardArray?.[1]),values=name=>card.filter(f=>f[0]===name).map(f=>text(Array.isArray(f[3])?f[3].flat().filter(Boolean).join(', '):f[3])).filter(Boolean);
  const addresses=card.filter(f=>f[0]==='adr').map(f=>text(f[1]?.label||list(f[3]).flat().filter(Boolean).join(', '))).filter(Boolean);
  return {name:values('org')[0]||values('fn')[0]||text(entity.handle),roles:list(entity.roles).map(text),address:addresses.join('; '),
    emails:values('email').filter(v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).slice(0,4),phones:values('tel').slice(0,3),url:values('url').map(safeURL).find(Boolean)||'',source,
    scope:'Published registration contact. Abuse/technical channels and postal addresses are not automatically accepted channels for legal service. Legal jurisdiction must be verified.'};
}
function registrarRecord(data, source) {
  const entities=list(data.entities).filter(e=>list(e.roles).includes('registrar'));
  if(entities.length!==1)return null;
  const entity=entities[0],contact=entityContact(entity,source);
  const id=text(list(entity.publicIds).find(p=>/iana registrar id/i.test(p.type))?.identifier);
  const contacts=[contact];let remaining=12;
  function walk(items,depth=0){if(depth>2)return;for(const e of list(items)){if(--remaining<0)return;if(list(e.roles).some(r=>['abuse','technical','administrative'].includes(r)))contacts.push(entityContact(e,source));walk(e.entities,depth+1);}}
  walk(entity.entities);
  return {name:contact.name,id:/^\d+$/.test(id)?id:'',contacts,source};
}
async function domainRegistration(target,sources,warnings) {
  let registryResult;
  try {
    const bootstrap=await metadata('dns',sources,warnings),tld=target.registered_domain.split('.').at(-1);
    const base=list(bootstrap.services).find(([names])=>list(names).includes(tld))?.[1]?.find(safeURL);
    if(!base)throw new Error('no_rdap_service');
    registryResult=await rdapAt(base,target.registered_domain);
    sources.push({name:'Domain registry RDAP',url:registryResult.url,status:'available',retrieved_at:stamp()});
  }catch(error){
    // A registry 404 is a dated answer (not registered at lookup time), not an outage.
    if(errorCode(error)==='http_404'&&error.url){
      const at=stamp(),domain=target.registered_domain;
      sources.push({name:'Domain registry RDAP',url:error.url,status:'available',result:'not_found',retrieved_at:at});
      warnings.push('The registry reports no registration for '+domain+' at '+at+' (RDAP 404).');
      return {name:domain,not_found:true,registrar:null,registry_url:error.url,status:['not registered at lookup time'],events:[],nameservers:[],dnssec:null,
        lookup_url:'https://lookup.icann.org/en/lookup?name='+encodeURIComponent(domain),
        scope:'The domain registry reports this domain as not registered at lookup time (RDAP 404). Check the spelling. An expired or deleted domain may have been registered earlier; historical registration needs a separate source.'};
    }
    sources.push({name:'Domain registry RDAP',url:'https://www.iana.org/assignments/rdap-dns',status:'unavailable',reason:errorCode(error),retrieved_at:stamp()});warnings.push('Domain registration unavailable ('+errorCode(error)+'). DNS and IP results remain independent.');return null;
  }
  let registrar=registrarRecord(registryResult.data,'Domain registry RDAP');
  if(registrar?.id) {
    const endpoints=await metadata('registrar',sources,warnings),entry=endpoints[registrar.id];
    if(entry?.url)try {
      const detail=await rdapAt(entry.url,target.registered_domain),r=registrarRecord(detail.data,'Registrar RDAP');
      if(!r || r.id!==registrar.id)throw new Error('registrar_mismatch');
      registrar={...r,contacts:[...r.contacts,...registrar.contacts].filter((c,i,a)=>a.findIndex(x=>x.name===c.name&&x.address===c.address&&x.emails.join()===c.emails.join()&&x.phones.join()===c.phones.join())===i)};
      sources.push({name:'Registrar RDAP',url:detail.url,status:'available',retrieved_at:stamp()});
    }catch(error){sources.push({name:'Registrar RDAP',url:entry.url,status:'unavailable',reason:errorCode(error),retrieved_at:stamp()});warnings.push('Registrar details unavailable; registry-supplied registrar contacts are retained.');}
  }
  const d=registryResult.data;
  return {name:target.registered_domain,registrar,registry_url:registryResult.url,status:list(d.status).map(text).slice(0,20),
    events:list(d.events).slice(0,15).map(e=>({action:text(e.eventAction),date:text(e.eventDate)})),nameservers:list(d.nameservers).slice(0,20).map(n=>text(n.ldhName).toLowerCase()),dnssec:typeof d.secureDNS?.delegationSigned==='boolean'?d.secureDNS.delegationSigned:null,
    lookup_url:'https://lookup.icann.org/en/lookup?name='+encodeURIComponent(target.registered_domain),
    scope:'The registrar may hold domain registration/account records. It may differ from the reseller, DNS provider and host. Public registration data may be redacted or use a privacy service.'};
}
async function dnsQuery(host,type,sources) {
  const providers=[['Google Public DNS','https://dns.google/resolve'],['Cloudflare DNS','https://cloudflare-dns.com/dns-query']];
  const label={1:'A',28:'AAAA',2:'NS',15:'MX'}[type]||String(type);
  for(const [name,base] of providers) {
    const url=new URL(base);url.searchParams.set('name',host);url.searchParams.set('type',String(type));
    if(base.includes('dns.google'))url.searchParams.set('edns_client_subnet','0.0.0.0/0');
    try {
      const data=await get(url.href,{headers:{Accept:'application/dns-json'}});
      if(![0,3].includes(data.Status))throw new Error('dns_'+Number(data.Status));
      if(!list(data.Question).some(q=>text(q.name).toLowerCase().replace(/\.$/,'')===host&&q.type===type)||data.TC)throw new Error('invalid_dns');
      sources.push({name:name+' '+label,url:url.href,status:'available',dns_status:data.Status,retrieved_at:stamp()});
      return data;
    }catch(error){sources.push({name:name+' '+label,url:url.href,status:'unavailable',reason:errorCode(error),retrieved_at:stamp()});}
  }
  return null;
}
function dnsRecords(data,host,types) {
  const answers=list(data?.Answer).slice(0,100),allowed=new Set([host]),out=[];
  // Follow only a bounded CNAME chain in this resolver answer; never fetch its websites.
  for(let i=0;i<8;i++){let changed=false;for(const r of answers){const owner=text(r.name).toLowerCase().replace(/\.$/,'');const dest=text(r.data).toLowerCase().replace(/\.$/,'');if(r.type===5&&allowed.has(owner)&&publicHost(dest)&&!allowed.has(dest)){allowed.add(dest);changed=true;}}if(!changed)break;}
  for(const r of answers)if(allowed.has(text(r.name).toLowerCase().replace(/\.$/,''))&&types.includes(r.type))out.push({type:r.type,name:text(r.name).toLowerCase().replace(/\.$/,''),value:r.type===15&&/^0\s+\.$/.test(text(r.data))?'0 .':text(r.data).replace(/\.$/,''),ttl:Number.isInteger(r.TTL)&&r.TTL>=0?r.TTL:null});
  return out;
}
export async function lookupDomain(target,env,{publicIP,lookupIP}) {
  const sources=[],warnings=[];
  const [a,aaaa,ns,mx,registration]=await Promise.all([dnsQuery(target.host,1,sources),dnsQuery(target.host,28,sources),dnsQuery(target.registered_domain,2,sources),dnsQuery(target.registered_domain,15,sources),domainRegistration(target,sources,warnings)]);
  const addresses=[],cnames=[];
  for(const [data,type] of [[a,1],[aaaa,28]])for(const r of dnsRecords(data,target.host,[type,5])) {
    if(r.type===5){if(!cnames.includes(r.value))cnames.push(r.value);continue;}
    const parsed=publicIP(r.value);
    if(!parsed){warnings.push('A non-public or special-use DNS address was excluded from IP enrichment.');continue;}
    if((type===1&&parsed.bits!==32)||(type===28&&parsed.bits!==128))continue;
    if(!addresses.some(v=>v.ip===parsed.ip))addresses.push({ip:parsed.ip,family:parsed.bits===32?'IPv4':'IPv6',ttl:r.ttl});
  }
  const address_count=addresses.length; if(addresses.length>16){addresses.length=16;warnings.push('DNS address display capped at 16 entries.');}
  const chosen=[addresses.find(v=>v.family==='IPv4'),addresses.find(v=>v.family==='IPv6')].filter(Boolean);
  for(const address of addresses)if(chosen.length<MAX_AUTO_IPS&&!chosen.includes(address))chosen.push(address);
  // lookupIP returns null when the caller's lookup limit refuses that IP analysis.
  const results=await Promise.all(chosen.map(item=>lookupIP(publicIP(item.ip),env,{expandRegistry:false}))),networks=results.filter(Boolean);
  if(networks.length<results.length)warnings.push('The per-minute lookup limit was reached before '+(results.length-networks.length)+' DNS address(es) could be analysed. Wait one minute, then select them below.');
  const nxdomain=a?.Status===3&&aaaa?.Status===3;
  if(!addresses.length)warnings.push(nxdomain?'The hostname does not exist according to DNS (NXDOMAIN).':'No usable public IP address was returned; domain registration may still be available.');
  if(addresses.length>networks.length)warnings.push('Automatically enriched '+networks.length+' of '+addresses.length+' displayed IPs. Select another address to investigate it.');
  const nameservers=dnsRecords(ns,target.registered_domain,[2]).map(r=>r.value),mail_exchangers=dnsRecords(mx,target.registered_domain,[15]).map(r=>r.value);
  return {kind:'domain',version:DOMAIN_INTELLIGENCE_VERSION,host:target.host,registered_domain:target.registered_domain,queried_at:stamp(),registration,
    dns:{addresses,address_count,cnames,nameservers,mail_exchangers,scope:'A/AAAA describe the submitted hostname. NS/MX describe the registered domain and may differ for delegated subdomains.'},networks,sources,warnings:[...new Set(warnings)],
    status:registration?.not_found&&!addresses.length?'not_found':!registration&&!addresses.length&&!nxdomain?'unavailable':warnings.length||sources.some(s=>s.status!=='available')||networks.some(n=>n.status!=='complete')?'partial':'complete',
    limitations:['An IP returned by DNS can belong to a CDN, reverse proxy or shared host; it does not establish the hidden origin server, website owner or owner\'s access ISP.','DNS hosting, mail hosting, domain registration and web hosting are separate roles. Nameservers do not establish that the same provider serves the website.','Current DNS/registration records are not historical evidence. Preserve the original URL and observation time in the case file; the URL path/query/fragment are not sent to lookup providers.','Registrar registration contacts and country fields do not establish a verified legal-request channel or legal jurisdiction. Confirm the receiving entity and process.','Registrable-domain rules use the ICANN section of the Public Suffix List dated '+DOMAIN_DATA_DATE+'. For hosted subdomains, the registrar may hold records for the platform domain rather than its individual user.']};
}
