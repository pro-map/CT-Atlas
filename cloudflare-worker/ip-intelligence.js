import { parseTarget, lookupDomain } from "./domain-intelligence.js";
import { cleanText, corsHeaders, gateCall, isAllowedUser } from "./shared.js";

export const IP_INTELLIGENCE_VERSION = "ip-intelligence-v4-domain-input";
const RIRS = new Set(["rdap.arin.net", "rdap.db.ripe.net", "rdap.apnic.net", "rdap.lacnic.net", "rdap.afrinic.net"]);
const bootstrapCache = new Map();
const text = value => cleanText(value, 500);
const list = value => Array.isArray(value) ? value : [];
const bool = value => typeof value === "boolean" ? value : null;

// A deliberately conservative public-unicast scope; no URLs, hostnames, ports or tunnels.
export function parseIP(value) {
  if (typeof value !== "string" || value.length > 45 || value !== value.trim()) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split(".");
    if (parts.some(p => Number(p) > 255 || String(Number(p)) !== p)) return null;
    return { ip: value, bits: 32, number: parts.reduce((n,p) => n * 256n + BigInt(p), 0n) };
  }
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(":")) return null;
  try {
    const ip = new URL("https://[" + value + "]/").hostname.slice(1,-1);
    const sides = ip.split("::"), left = sides[0] ? sides[0].split(":") : [], right = sides[1] ? sides[1].split(":") : [];
    const parts = sides.length === 2 ? [...left, ...Array(8-left.length-right.length).fill("0"), ...right] : left;
    if (parts.length !== 8) return null;
    return { ip, bits: 128, number: parts.reduce((n,p) => n * 65536n + BigInt("0x"+p), 0n) };
  } catch { return null; }
}
function inRange(parsed, cidr) {
  const [address, length] = cidr.split("/"), base = parseIP(address), bits = Number(length);
  return base && base.bits === parsed.bits && bits >= 0 && bits <= parsed.bits &&
    parsed.number >> BigInt(parsed.bits-bits) === base.number >> BigInt(parsed.bits-bits);
}
export function publicIP(value) {
  const parsed = parseIP(value);
  if (!parsed) return null;
  const excluded = parsed.bits === 32 ? ["0.0.0.0/8","10.0.0.0/8","100.64.0.0/10","127.0.0.0/8","169.254.0.0/16","172.16.0.0/12","192.0.0.0/24","192.0.2.0/24","192.88.99.0/24","192.168.0.0/16","198.18.0.0/15","198.51.100.0/24","203.0.113.0/24","224.0.0.0/3"] : ["2001::/23","2001:db8::/32","2002::/16","3fff::/20"];
  if (parsed.bits === 128 && !inRange(parsed,"2000::/3")) return null;
  return excluded.some(cidr => inRange(parsed,cidr)) ? null : parsed;
}
function trustedRdap(value) {
  try { const u = new URL(value); return u.protocol === "https:" && RIRS.has(u.hostname) && !u.port && !u.username && !u.password; } catch { return false; }
}
async function boundedJSON(response, max = 1000000, allowError = false) {
  if (!response.ok && !allowError) { await response.body?.cancel(); throw new Error("http_"+response.status); }
  if (!response.body) throw new Error("source_unavailable");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function getJSON(url, options = {}, rdap = false) {
  for (let hop=0; hop<4; hop++) {
    if (rdap && !trustedRdap(url)) throw new Error("untrusted_registry");
    const response = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (response.status >= 300 && response.status < 400 && rdap) {
      const location = response.headers.get("Location"); await response.body?.cancel();
      if (!location) throw new Error("invalid_redirect");
      url = new URL(location,url).href; continue;
    }
    return { data: await boundedJSON(response), url };
  }
  throw new Error("too_many_redirects");
}
function failureCode(error) {
  const code = String(error?.message || "");
  return /^(?:http_[1-5][0-9]{2}|invalid_response|ip_mismatch|source_error|source_unavailable|no_registry|untrusted_registry|invalid_redirect|too_many_redirects|response_too_large)$/.test(code) ? code : error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "source_unavailable";
}
// Return fixed diagnostic categories only; provider errors may echo credentials or URLs.
async function attributionJSON(url, options = {}) {
  const response = await fetch(url, {...options, redirect:"manual", signal:AbortSignal.timeout(8000)});
  let data;
  try { data = await boundedJSON(response,1000000,true); }
  catch (error) { if (response.ok) throw error; }
  if (!response.ok || data?.error || ["denied","error"].includes(data?.status)) {
    const error = new Error(response.ok ? "source_error" : "http_"+response.status);
    const message = String(data?.message || data?.error || "").slice(0,2000).toLowerCase();
    const code = data?.error_code;
    error.category = code === "ERR_FORBIDDEN_INVALID_API_KEY" ? "credentials" :
      code === "ERR_FORBIDDEN_API_KEY_REQUIRED" || /using a proxy server|sign.?up for an account/.test(message) ? "key_required" :
      response.status === 429 || /queries exhausted|quota|query allowance|query limit/.test(message) ? "quota" :
      /api key.*(?:invalid|disabled)|invalid.*api key/.test(message) ? "credentials" : "";
    throw error;
  }
  return {data,url};
}
function sourceDiagnostic(name, error, env) {
  const reason = failureCode(error);
  if (name === "Proxycheck.io" || name === "ipapi.is") {
    const key = name === "Proxycheck.io" ? "PROXYCHECK_API_KEY" : "IPAPI_IS_KEY";
    if (error.category === "quota" || reason === "http_429") return "Provider quota or rate limit reached. Check the account dashboard and retry after the reset; other sources remain usable.";
    if (error.category === "credentials") return "Provider rejected or disabled the API key. Verify the Worker Secret "+key+" and the provider account.";
    if (error.category === "key_required") return "Provider requires an account key for this request origin. Configure the Worker Secret "+key+".";
    if (["http_401","http_403"].includes(reason)) return env[key] ? "Provider denied access. Verify "+key+", account permissions and origin restrictions; the exact cause was not supplied." : "Provider denied unauthenticated access. Configure the free account key as Worker Secret "+key+"; the exact cause was not supplied.";
  }
  if (name === "RIR RDAP") return (error.stage === "bootstrap" ? "IANA registry discovery failed. " : "Regional registry lookup failed. ")+"RIPEstat WHOIS is tried as a separate fallback; the original failure remains recorded.";
  return "";
}
async function ipinfoLookup(parsed, env) {
  const options = { headers: { Authorization: "Bearer "+String(env.IPINFO_TOKEN).trim() } };
  const check = result => {
    if (parseIP(result.data?.ip)?.ip !== parsed.ip) throw new Error("ip_mismatch");
    return result;
  };
  try {
    const result = check(await getJSON("https://api.ipinfo.io/lookup/"+encodeURIComponent(parsed.ip), options));
    if (!result.data.as && !result.data.geo && !result.data.anonymous) throw new Error("invalid_response");
    return { ...result, data: { ...result.data, access: "lookup" } };
  } catch (error) {
    // A Lite token can be valid while the paid lookup endpoint refuses access.
    // Do not retry quota, network, response-integrity or server failures as Lite.
    if (!["http_401","http_402","http_403","http_404"].includes(failureCode(error))) throw error;
    const result = check(await getJSON("https://api.ipinfo.io/lite/"+encodeURIComponent(parsed.ip), options));
    const data = result.data;
    return { ...result, sourceName: "IPinfo Lite", data: { access: "lite", ip: data.ip,
      as: { name: text(data.as_name), asn: /^AS[0-9]+$/.test(data.asn || "") ? data.asn : "", domain: text(data.as_domain) },
      geo: { country: text(data.country), country_code: text(data.country_code) },
      is_anycast: bool(data.is_anycast ?? data.anycast) } };
  }
}
async function proxycheckLookup(parsed, env) {
  const url = new URL("https://proxycheck.io/v3/"+encodeURIComponent(parsed.ip));
  url.searchParams.set("ver","24-June-2026");
  // Disable the provider's optional positive-detection dashboard log.
  url.searchParams.set("tag","0");
  if (env.PROXYCHECK_API_KEY) url.searchParams.set("key",String(env.PROXYCHECK_API_KEY).trim());
  const result = await attributionJSON(url.href);
  if (!["ok","warning"].includes(result.data?.status)) throw new Error("source_error");
  const key = Object.keys(result.data).find(k => parseIP(k)?.ip === parsed.ip);
  if (!key) throw new Error("ip_mismatch");
  const data = result.data[key];
  if (!data || typeof data !== "object" || !data.network || !data.detections) throw new Error("invalid_response");
  // Never expose the credential-bearing request URL or an unfiltered status message.
  return { url:"https://proxycheck.io/api/", data:{...data,api_warning:result.data.status === "warning"} };
}
async function ipapiLookup(parsed, env) {
  const result = await attributionJSON("https://api.ipapi.is/", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q:parsed.ip,key:String(env.IPAPI_IS_KEY).trim()})});
  const data = result.data;
  if (parseIP(data?.ip)?.ip !== parsed.ip) throw new Error("ip_mismatch");
  if (data.vpn?.ip && parseIP(data.vpn.ip)?.ip !== parsed.ip) throw new Error("ip_mismatch");
  // A minimal/anonymous reply is never interpreted as a negative VPN assessment.
  const limited = typeof data.company === "string" || typeof data.asn === "string" || Boolean(data.docs);
  if (!limited && !data.asn && !data.company && ![data.is_vpn,data.is_proxy,data.is_tor].some(v=>typeof v === "boolean")) throw new Error("invalid_response");
  return {url:"https://ipapi.is/developers.html",data:{...data,access:limited ? "limited" : "api_key"}};
}
function providerWebsite(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port || parseIP(u.hostname) ||
        !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(u.hostname) || /\.(?:local|internal|localhost|test|example|invalid)$/i.test(u.hostname)) return "";
    // A website supplied by the attribution source is a lead, not a verified legal portal.
    return u.origin+"/";
  } catch { return ""; }
}
function privacyAssessment(info, proxy, ipapi, warnings) {
  const assessments = [];
  if (info && info.access !== "lite") assessments.push({source:"IPinfo",vpn:bool(info.anonymous?.is_vpn),proxy:bool(info.anonymous?.is_proxy),tor:bool(info.anonymous?.is_tor),relay:bool(info.anonymous?.is_relay),hosting:bool(info.is_hosting),anycast:bool(info.is_anycast),services:text(info.anonymous?.name)?[{name:text(info.anonymous.name),url:""}]:[]});
  if (proxy) assessments.push({source:"Proxycheck.io",vpn:bool(proxy.detections.vpn),proxy:bool(proxy.detections.proxy),tor:bool(proxy.detections.tor),relay:null,hosting:bool(proxy.detections.hosting),anycast:null,
    services:[proxy.operator,...list(proxy.operator?.additional_operators),...list(proxy.additional_operators)].filter(o=>o&&text(o.name)).slice(0,10).map(o=>({name:text(o.name),url:providerWebsite(o.url)})),
    confidence:typeof proxy.detections.confidence === "number" && proxy.detections.confidence >= 0 && proxy.detections.confidence <= 100 ? proxy.detections.confidence : null,
    last_seen:text(proxy.detections.last_seen),data_time:text(proxy.last_updated)});
  if (ipapi?.access === "api_key") assessments.push({source:"ipapi.is",vpn:bool(ipapi.is_vpn),proxy:bool(ipapi.is_proxy),tor:bool(ipapi.is_tor),relay:null,hosting:bool(ipapi.is_datacenter),anycast:null,
    services:ipapi.is_vpn === true && text(ipapi.vpn?.service) ? [{name:text(ipapi.vpn.service),url:providerWebsite(ipapi.vpn.url)}] : [],last_seen:text(ipapi.vpn?.last_seen_str)});
  const privacy = {source:assessments.map(a=>a.source).join(" + ") || "Not available",assessments,conflicts:[],services:[],service:""};
  for (const field of ["vpn","proxy","tor","relay","hosting","anycast"]) {
    const values = [...new Set(assessments.map(a=>a[field]).filter(v=>typeof v === "boolean"))];
    privacy[field] = values.length === 1 ? values[0] : null;
    if (values.length > 1) privacy.conflicts.push(field);
  }
  if (privacy.anycast === null && info?.access === "lite") privacy.anycast = bool(info.is_anycast);
  for (const a of assessments) for (const s of a.services) {
    const name = serviceContact(s.name)?.name || s.name;
    const existing = privacy.services.find(c=>c.name.toLowerCase() === name.toLowerCase());
    if (existing) { if (!existing.sources.includes(a.source)) existing.sources.push(a.source); if (!existing.url) existing.url=s.url; }
    else privacy.services.push({...s,name,sources:[a.source]});
  }
  if (privacy.services.length === 1) privacy.service=privacy.services[0].name;
  if (privacy.services.length > 1) warnings.push("Multiple intermediary providers are reported: "+privacy.services.map(s=>s.name).join(", ")+". Attribution must be resolved before choosing a recipient.");
  if (privacy.conflicts.length) warnings.push("Detection sources disagree on "+privacy.conflicts.join(", ")+". Conflicting fields are unresolved; review each source assessment.");
  if (privacy.vpn === null && !privacy.conflicts.includes("vpn")) warnings.push("VPN detection data is unavailable. The network operator and its published contacts can still be identified.");
  return privacy;
}
async function registry(parsed, expand = true) {
  const key = parsed.bits, now = Date.now(); let bootstrap = bootstrapCache.get(key);
  if (!bootstrap || bootstrap.until < now) {
    let result;
    try { result = await getJSON("https://data.iana.org/rdap/ipv"+(key === 32 ? "4" : "6")+".json"); }
    catch (error) { error.stage="bootstrap"; throw error; }
    bootstrap = { data: result.data, until: now+86400000 }; bootstrapCache.set(key,bootstrap);
  }
  let base = "", longest = -1;
  for (const [ranges, urls] of list(bootstrap.data.services)) for (const cidr of ranges) {
    if (inRange(parsed,cidr) && Number(cidr.split("/")[1]) > longest) {
      const candidate = urls.find(trustedRdap);
      if (candidate) { base = candidate; longest = Number(cidr.split("/")[1]); }
    }
  }
  if (!base) throw new Error("no_registry");
  const result = await getJSON(base+"ip/"+encodeURIComponent(parsed.ip),{},true);
  const start = parseIP(result.data?.startAddress), end = parseIP(result.data?.endAddress);
  if (!start || !end || start.bits !== parsed.bits || end.bits !== parsed.bits || parsed.number < start.number || parsed.number > end.number) throw new Error("ip_mismatch");
  // Some RIRs return entity references instead of contact cards. Resolve at most three.
  let count = 0;
  for (const entity of list(result.data.entities)) {
    const href = list(entity.links).find(l => l.rel === "self" && trustedRdap(l.href))?.href;
    if (expand && !entity.vcardArray && href && count++ < 3) {
      try { const expanded = await getJSON(href,{},true); Object.assign(entity,expanded.data); } catch { /* partial registration remains useful */ }
    }
  }
  return result;
}
export function registration(data) {
  const contacts = []; let remaining = 40;
  function walk(entities, depth=0) {
    if (depth > 3) return;
    for (const entity of list(entities)) {
      if (--remaining < 0) return;
      const fields = list(entity.vcardArray?.[1]);
      const field = name => fields.filter(f => f[0] === name);
      const value = name => field(name).map(f => text(Array.isArray(f[3]) ? f[3].flat().filter(Boolean).join(", ") : f[3])).filter(Boolean);
      const address = field("adr").map(f => text(f[1]?.label || list(f[3]).flat().filter(Boolean).join(", "))).filter(Boolean).join("; ");
      const roles = list(entity.roles).map(text);
      if (fields.length) contacts.push({ name: value("org")[0] || value("fn")[0] || text(entity.handle), roles, address, source: "RIR RDAP",
        emails: value("email").filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).slice(0,4), phones: value("tel").slice(0,3) });
      walk(entity.entities,depth+1);
    }
  }
  walk(data.entities);
  return { source:"RIR RDAP", name: text(data.name), handle: text(data.handle), country: text(data.country), start: text(data.startAddress), end: text(data.endAddress),
    registrant: contacts.find(c => c.roles.includes("registrant"))?.name || "", contacts,
    updated_at: text(list(data.events).find(e => e.eventAction === "last changed")?.eventDate) };
}

function ipNumber(number, bits) {
  if (bits === 32) return [24,16,8,0].map(n=>Number(number >> BigInt(n) & 255n)).join(".");
  return parseIP([112,96,80,64,48,32,16,0].map(n=>(number >> BigInt(n) & 65535n).toString(16)).join(":"))?.ip || "";
}
function resourceRange(value) {
  const pair = String(value || "").trim().split(/\s*-\s*/);
  if (pair.length === 2) {
    const start=parseIP(pair[0]),end=parseIP(pair[1]);
    return start && end && start.bits === end.bits && start.number <= end.number ? {start,end} : null;
  }
  const [ip,prefix] = String(value || "").trim().split("/"), base=parseIP(ip);
  if (!base) return null;
  const length=prefix === undefined ? base.bits : /^\d+$/.test(prefix) ? Number(prefix) : -1;
  if (length < 0 || length > base.bits) return null;
  const shift=BigInt(base.bits-length), start=(base.number >> shift) << shift, end=start+(1n << shift)-1n;
  return {start:parseIP(ipNumber(start,base.bits)),end:parseIP(ipNumber(end,base.bits))};
}
const containsIP = (range,parsed) => range && range.start.bits === parsed.bits && range.start.number <= parsed.number && range.end.number >= parsed.number;
function whoisRegistration(payload, parsed) {
  if (payload?.status !== "ok" || !containsIP(resourceRange(payload.data?.resource),parsed)) throw new Error("ip_mismatch");
  // Ignore IRR route objects: their maintainer is not necessarily the allocation holder.
  const records=list(payload.data.records).slice(0,50).map(record=>{
    const fields=new Map();
    for (const entry of list(record).slice(0,100)) {
      const key=text(entry.key).toLowerCase(); if (!fields.has(key)) fields.set(key,[]);
      fields.get(key).push(text(entry.value));
    }
    const values=key=>fields.get(key)||[], first=(...keys)=>keys.map(k=>values(k)[0]).find(Boolean)||"";
    return {fields,values,first,range:resourceRange(first("netrange","inetnum","inet6num","cidr"))};
  });
  const networks=records.filter(r=>r.range), matching=networks.filter(r=>containsIP(r.range,parsed)).sort((a,b)=>{
    const x=a.range.end.number-a.range.start.number,y=b.range.end.number-b.range.start.number; return x<y?-1:x>y?1:0;
  });
  const net=matching[0]; if (!net) throw new Error("invalid_response");
  // Only associate separate contact records when the response has a single allocation.
  const related=networks.length === 1 ? records : [net];
  const organisation=related.find(r=>r.first("orgname","org-name"));
  const contacts=[];
  for (const r of related) {
    const name=r.first("orgabusename","orgtechname","orgname","org-name","role","person");
    const emails=[...r.values("orgabuseemail"),...r.values("orgtechemail"),...r.values("abuse-mailbox"),...r.values("e-mail")].filter(v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).slice(0,4);
    const phones=[...r.values("orgabusephone"),...r.values("orgtechphone"),...r.values("phone")].slice(0,3);
    const address=[...r.values("address"),r.first("city"),r.first("stateprov"),r.first("postalcode"),r.first("country")].filter(Boolean).join(", ");
    const roles=r.first("orgabuseemail","abuse-mailbox") ? ["abuse"] : r.first("orgname","org-name") ? ["registrant"] : ["technical"];
    if (name || emails.length || address) contacts.push({name:name||"Registry contact",emails,phones,address,roles,source:"RIPEstat WHOIS"});
  }
  return {source:"RIPEstat WHOIS",name:net.first("netname"),handle:net.first("nethandle"),country:net.first("country")||organisation?.first("country")||"",
    start:net.range.start.ip,end:net.range.end.ip,registrant:organisation?.first("orgname","org-name")||net.first("organization")||"",contacts,
    updated_at:net.first("last-modified","updated"),data_time:text(payload.data.query_time)};
}

// Exact aliases only: a network owner or an ASN never implies a VPN service.
const DIRECTORY = [
  { aliases: ["protonvpn","proton vpn"], name: "Proton VPN", kind: "law enforcement", country: "Switzerland", email: "legal@proton.me", url: "https://proton.me/legal/law-enforcement" },
  { aliases: ["nordvpn","nord vpn"], name: "NordVPN", kind: "policy contact — confirm the legal channel", country: "", email: "inquiries@nordvpn.com", url: "https://my.nordaccount.com/legal/privacy-policy/", policy_url:"https://nordvpn.com/contact-us/", scope:"Confirm the current legal-request provisions and receiving entity in the provider policy before submitting case information." },
  { aliases: ["mullvad","mullvad vpn"], name: "Mullvad VPN", kind: "general support — ask for the legal channel", country: "Sweden", address: "Mullvad VPN AB, Box 53049, 400 14 Gothenburg, Sweden", email: "support@mullvadvpn.net", url: "https://mullvad.net/en/help/privacy-policy" },
  { aliases: ["expressvpn","express vpn"], name: "ExpressVPN", kind: "provider policy — legal contact not verified", country: "", email: "", url: "https://www.expressvpn.com/trust" },
  { aliases: ["ivpn"], name: "IVPN", kind: "law enforcement", country: "Gibraltar", email: "legal@ivpn.net", address:"IVPN Limited, 5 Secretary’s Lane, GX11 1AA, Gibraltar", url:"https://www.ivpn.net/en/legal-process-guidelines/", scope:"The published procedure requires requests from an authority with jurisdiction in Gibraltar, an official agency email, and service of a duplicate hard copy. Follow the linked procedure for cross-border routing." },
  { aliases: ["private internet access","privateinternetaccess","pia"], name: "Private Internet Access", kind:"law enforcement / legal department", country:"United States", email:"legal@privateinternetaccess.com", address:"PIA Private Internet Access, Inc., Attn: Legal Department, 2590 Welton Street, Suite 200, Denver, CO 80205, United States", url:"https://www.privateinternetaccess.com/privacy-policy", policy_url:"https://clients.privateinternetaccess.com/contact-us", scope:"See the Law Enforcement Requests section and verify the current receiving entity and service requirements." },
  { aliases: ["surfshark","surfshark vpn"], name:"Surfshark", kind:"general support — ask for the legal channel", email:"support@surfshark.com", country:"", url:"https://surfshark.com/terms-of-service", scope:"General support only. The separately published DSA contact is not treated as a general law-enforcement disclosure mailbox." }
];
// Jurisdiction comes from provider legal sources, never server geolocation or RIR country.
const JURISDICTIONS = {
  "Cisco":[{country:"United States",country_code:"US",entity:"Cisco Systems, Inc.",address:"170 West Tasman Dr., San Jose, CA 95134, United States",source_url:"https://www.cisco.com/c/en/us/about/legal/privacy-full.html",scope:"Published company address, not a verified address for service of legal process. Cisco's law-enforcement guidelines require compliance with US law and may require an international assistance channel for foreign requests. Use the government data request portal to confirm the responsible entity and procedure."}],
  "Proton VPN":[{country:"Switzerland",country_code:"CH",entity:"Proton AG",address:"Route de la Galaise 32, 1228 Plan-les-Ouates, Switzerland",source_url:"https://proton.me/legal/dpa",scope:"Swiss entity. The company address is not a substitute for the law-enforcement procedure; foreign requests may require Swiss authorities."}],
  "NordVPN":[{country:"Panama",country_code:"PA",entity:"nordvpn S.A.",address:"PH F&F TOWER, 50th Street & 56th Street, Suite #32-D, Floor 32, Panama City, Republic of Panama",source_url:"https://nordvpn.com/ja/contact-us/",scope:"Published company entity/address. Confirm the receiving entity and applicable process through the legal-policy contact."}],
  "Mullvad VPN":[{country:"Sweden",country_code:"SE",entity:"Mullvad VPN AB",address:"Box 53049, 400 14 Gothenburg, Sweden",source_url:"https://mullvad.net/en/help/privacy-policy",scope:"Published Swedish company and postal contact. General support must confirm the legal-request channel."}],
  "ExpressVPN":[{country:"British Virgin Islands",country_code:"VG",entity:"Express Technologies Ltd.",address:"",source_url:"https://www.expressvpn.com/privacy-policy",scope:"The provider states that demands for its personal data are subject to BVI jurisdiction. A postal address for legal service has not been verified in the reviewed source."}],
  "IVPN":[{country:"Gibraltar",country_code:"GI",entity:"IVPN Limited",address:"5 Secretary’s Lane, GX11 1AA, Gibraltar",source_url:"https://www.ivpn.net/en/legal-process-guidelines/",scope:"Use the provider's Gibraltar legal-process guidelines, including its agency-jurisdiction and duplicate hard-copy requirements."}],
  "Private Internet Access":[{country:"United States",country_code:"US",entity:"PIA Private Internet Access, Inc.",address:"Attn: Legal Department, 2590 Welton Street, Suite 200, Denver, CO 80205, United States",source_url:"https://www.privateinternetaccess.com/privacy-policy",scope:"US entity and published legal-department address. Follow the current Law Enforcement Requests procedure."}],
  "Surfshark":[{country:"Netherlands",country_code:"NL",entity:"Surfshark B.V.",address:"Kabelweg 57, 1014BA Amsterdam, Netherlands",source_url:"https://surfshark.com/privacy",scope:"The provider identifies its Netherlands entity and jurisdiction. The listed support mailbox is a routing contact, not a verified disclosure channel."}],
  "Cloudflare":[{country:"United States",country_code:"US",entity:"Cloudflare, Inc.",address:"101 Townsend St., San Francisco, CA 94107, United States",source_url:"https://www.cloudflare.com/privacypolicy/",scope:"Company address. The separate law-enforcement guidance describes US process and cross-border requests; use that procedure to confirm service."}],
  "Google":[{country:"United States",country_code:"US",entity:"Google LLC",address:"c/o Custodian of Records, 1600 Amphitheatre Parkway, Mountain View, CA 94043, United States",source_url:"https://support.google.com/faqs/answer/6151275?hl=en",scope:"Possible receiving entity; this address is published for civil-process information. Criminal law-enforcement requests must use LERS and confirm the relevant service/entity."},{country:"Ireland",country_code:"IE",entity:"Google Ireland Limited",address:"c/o Custodian of Records, Gordon House, Barrow Street, Dublin 4, Ireland",source_url:"https://support.google.com/faqs/answer/6151275?hl=en",scope:"Alternative entity for relevant EEA/Swiss consumer-service data. Entity selection cannot be determined from an IP alone. Confirm in LERS; do not apply civil-service instructions to a criminal request."}],
  "Microsoft":[{country:"United States",country_code:"US",entity:"Microsoft Corporation",address:"One Microsoft Way, Redmond, WA 98052, United States",source_url:"https://www.microsoft.com/en-us/servicesagreement",scope:"Published US company address, not a substitute for service through the law-enforcement portal. Confirm the service and responsible entity."},{country:"Ireland",country_code:"IE",entity:"Microsoft Ireland Operations Limited",address:"",source_url:"https://www.microsoft.com/en-us/corporate-responsibility/reports/government-requests/customer-data",scope:"Microsoft identifies this Irish entity for EU online-service infrastructure. Confirm the receiving entity and address through the law-enforcement portal; an IP alone does not resolve jurisdiction."}]
};
export function serviceContact(name) {
  const match = DIRECTORY.find(d => d.aliases.includes(String(name||"").trim().toLowerCase()));
  if (!match) return null;
  const { aliases, ...entry } = match;
  return { ...entry, jurisdictions:JURISDICTIONS[entry.name] || [], checked_on: "2026-10-03", basis: "Exact match to a named intermediary service reported by the attribution source; independently verify before contacting." };
}
function enquiryTarget(operator, privacy, contacts, routes) {
  const names=privacy.services.map(s=>s.name), ambiguous=names.length>1 || privacy.conflicts.length>0 || (!names.length && operator.attribution_conflict);
  const primary=ambiguous ? null : names.length===1 ? routes.find(c=>c.target_type==="intermediary") : routes.find(c=>c.target_type==="network");
  const registryContact=!ambiguous && names.length===0 ? contacts.find(c=>c.roles.includes("abuse")&&c.emails.length) || contacts.find(c=>c.emails.length || c.address) : null;
  return {
    name:names.length ? names.join(" / ") : operator.name,
    type:names.length ? "VPN / intermediary provider" : "Network operator / allocation holder",
    status:ambiguous ? "Attribution requires verification" : primary ? primary.kind : registryContact ? "Registry contact — request the legal channel" : "Contact not available",
    basis:names.length ? "Named by "+[...new Set(privacy.services.flatMap(s=>s.sources))].join(" + ")+". The network owner may only host the service." : "Based on "+operator.source+". Confirm whether this operator serves the subscriber or an intermediary.",
    email:primary?.email || registryContact?.emails?.[0] || "", phone:registryContact?.phones?.[0] || "", address:primary?.address || registryContact?.address || "",
    url:primary?.url || "", country:primary?.country || "", scope:primary?.scope || "",
    jurisdictions:primary?.jurisdictions || [],
    contact_source:primary ? (primary.checked_on ? "Reviewed provider directory · "+primary.checked_on : primary.basis) : registryContact?.source || "",
    records_to_request:operator.service_context && !names.length && privacy.vpn !== true && privacy.proxy !== true && privacy.tor !== true ? "Subject to applicable process and available records: identify the customer organisation using this mail service and request relevant message-trace records using the original Message-ID and exact UTC timestamp. A mail relay IP does not establish the sender's access ISP or home address." : "Subject to the provider's applicable process and available records: subscriber/account holder identity, service or installation postal address, and allocation/session records linking the observed IP, exact time, timezone and source port to that account.",
    subscriber_scope:names.length || privacy.vpn === true || privacy.proxy === true || privacy.tor === true ? "This is an intermediary endpoint. The access ISP behind it is not identified. The enquiry must first establish the service/customer relationship and whether relevant connection records exist." : operator.service_context || "This is a potential records holder, not a confirmed subscriber match. Establish whether it allocated the IP to an end subscriber, a reseller or a hosted service at the incident time.",
    ambiguous
  };
}
function coordinates(lat,lon) {
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 ? { latitude:lat, longitude:lon } : { latitude:null, longitude:null };
}
export async function lookupIP(parsed, env, options = {}) {
  const sources = [], warnings = [];
  const ripe = endpoint => "https://stat.ripe.net/data/"+endpoint+"/data.json?resource="+encodeURIComponent(parsed.ip)+"&sourceapp=ct-atlas";
  async function source(name, task, publicURL) {
    try {
      const result = await task();
      // RIPEstat uses a status string; RDAP uses an array such as ["active"].
      if (typeof result.data?.status === "string" && result.data.status !== "ok") throw new Error("source_error");
      sources.push({ name: result.sourceName || name, url: publicURL || result.url, status:"available", retrieved_at:new Date().toISOString() });
      return result.data;
    } catch (error) {
      const reason=failureCode(error),action=sourceDiagnostic(name,error,env);
      sources.push({name,url:publicURL || "https://data.iana.org/rdap/",status:"unavailable",reason,action,stage:name === "RIR RDAP" ? error.stage === "bootstrap" ? "bootstrap" : "registry" : "",retrieved_at:new Date().toISOString()});
      warnings.push(name+" unavailable ("+reason+"). "+(action || "Its fields are unknown.")); return null;
    }
  }
  const [rdap, network, abuse, geoData, info, proxy, ipapi] = await Promise.all([
    source("RIR RDAP",()=>registry(parsed,options.expandRegistry !== false)),
    source("RIPEstat routing",()=>getJSON(ripe("network-info")),ripe("network-info")),
    source("RIPEstat abuse contacts",()=>getJSON(ripe("abuse-contact-finder")),ripe("abuse-contact-finder")),
    source("RIPEstat / MaxMind GeoLite2",()=>getJSON(ripe("maxmind-geo-lite")),ripe("maxmind-geo-lite")),
    env.IPINFO_TOKEN ? source("IPinfo",()=>ipinfoLookup(parsed,env),"https://ipinfo.io/"+encodeURIComponent(parsed.ip)) : null,
    env.PROXYCHECK_ENABLED === "false" ? null : source("Proxycheck.io",()=>proxycheckLookup(parsed,env),"https://proxycheck.io/api/"),
    env.IPAPI_IS_ENABLED !== "false" && env.IPAPI_IS_KEY ? source("ipapi.is",()=>ipapiLookup(parsed,env),"https://ipapi.is/developers.html") : null
  ]);
  if (proxy?.api_warning) warnings.push("Proxycheck.io returned data with an account/quota warning. Check the provider dashboard; future queries may be limited.");
  if (!env.IPAPI_IS_KEY && env.IPAPI_IS_ENABLED !== "false") sources.push({name:"ipapi.is",url:"https://ipapi.is/developers.html",status:"not_configured",action:"Optional independent VPN and contact source. Add the free account key as Worker Secret IPAPI_IS_KEY to enable it.",retrieved_at:new Date().toISOString()});
  if (ipapi?.access === "limited") warnings.push("ipapi.is returned only a limited response. VPN flags and detailed contacts are unavailable; verify the IPAPI_IS_KEY account.");
  let reg = rdap ? registration(rdap) : null;
  if (!reg) reg = await source("RIPEstat WHOIS",async()=>{const result=await getJSON(ripe("whois"));return {...result,data:whoisRegistration(result.data,parsed)};},ripe("whois"));
  const meaningfulGeo = g => g && typeof g.country === "string" && /^[A-Za-z]{2}/.test(g.country) && !["unknown","zz","xx"].includes(g.country.toLowerCase());
  const enrichedGeo = info?.access !== "lite" && meaningfulGeo(info?.geo) ? info.geo : null;
  const fallbackGeo = geoData?.data?.located_resources?.[0]?.locations?.[0];
  // GeoLite may return country "?" and coordinates 0,0 to mean unknown.
  const liteGeo = info?.access === "lite" && meaningfulGeo(info.geo) ? info.geo : null;
  const proxyGeo=proxy?.location?.country_name ? {country:proxy.location.country_name,country_code:proxy.location.country_code,city:proxy.location.city_name,region:proxy.location.region_name,timezone:proxy.location.timezone,latitude:proxy.location.latitude,longitude:proxy.location.longitude} : null;
  const ipapiGeo=ipapi?.access === "api_key" ? {...ipapi.location,region:ipapi.location?.state} : ipapi ? {country:ipapi.country,city:ipapi.city,region:ipapi.region,timezone:ipapi.timezone,latitude:ipapi.lat,longitude:ipapi.lon} : null;
  const rawGeo = enrichedGeo || (meaningfulGeo(fallbackGeo) ? fallbackGeo : null) || (meaningfulGeo(proxyGeo) ? proxyGeo : null) || (meaningfulGeo(ipapiGeo) ? ipapiGeo : null) || liteGeo;
  const geo = rawGeo ? { country:text(rawGeo.country), country_code:text(rawGeo.country_code), city:text(rawGeo.city), region:text(rawGeo.region), timezone:text(rawGeo.timezone),
    ...coordinates(rawGeo.latitude,rawGeo.longitude), radius_km: typeof rawGeo.radius === "number" && rawGeo.radius >= 0 ? rawGeo.radius : null,
    source: enrichedGeo ? "IPinfo" : rawGeo === liteGeo ? "IPinfo Lite (country only)" : rawGeo === proxyGeo ? "Proxycheck.io" : rawGeo === ipapiGeo ? "ipapi.is" : "RIPEstat / MaxMind GeoLite2", data_time:text(enrichedGeo ? enrichedGeo.last_changed : rawGeo === liteGeo || rawGeo === ipapiGeo ? "" : rawGeo === proxyGeo ? proxy.last_updated : geoData?.data?.result_time) } : null;
  if (!geo) warnings.push("Geolocation is unknown in the consulted sources. No location is inferred from the registration address.");
  const privacy = privacyAssessment(info,proxy,ipapi,warnings);
  const contacts = reg?.contacts ? [...reg.contacts] : [];
  if (ipapi?.access === "api_key" && ipapi.abuse && containsIP(resourceRange(ipapi.company?.network),parsed)) {
    const a=ipapi.abuse,email=text(a.email);
    contacts.push({name:text(a.name)||"Network abuse contact",roles:["abuse"],source:"ipapi.is (WHOIS-derived)",address:text(a.address),phones:text(a.phone)?[text(a.phone)]:[],emails:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?[email]:[]});
  }
  for (const email of list(abuse?.data?.abuse_contacts).slice(0,8)) if (typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !contacts.some(c => c.emails.includes(email))) contacts.push({ name:"Network abuse contact", roles:["abuse"], source:"RIPEstat abuse contacts", address:"", phones:[], emails:[email] });
  const asns = list(network?.data?.asns).map(n => /^\d+$/.test(String(n)) ? "AS"+n : "").filter(Boolean).slice(0,10);
  let asOverview = null;
  const ipapiASN=ipapi?.access === "api_key" && /^\d+$/.test(String(ipapi.asn?.asn)) ? "AS"+ipapi.asn.asn : "";
  const ipapiHolder=ipapi?.access === "api_key" ? text(ipapi.asn?.org) : "";
  if (!text(info?.as?.name) && !reg?.registrant && !text(proxy?.network?.provider) && !ipapiHolder && asns.length === 1) {
    const url = "https://stat.ripe.net/data/as-overview/data.json?resource="+asns[0]+"&sourceapp=ct-atlas";
    asOverview = await source("RIPEstat ASN holder",()=>getJSON(url),url);
  }
  const holder = text(asOverview?.data?.holder);
  const extraASN=[info?.as?.asn,proxy?.network?.asn,ipapiASN].find(n=>/^AS[0-9]+$/.test(n||""));
  const operator = { name:text(info?.as?.name) || reg?.registrant || text(proxy?.network?.provider) || ipapiHolder || holder || reg?.name || "Unknown", asns:asns.length ? asns : extraASN ? [extraASN] : [], domain:text(info?.as?.domain)||text(ipapi?.asn?.domain), type:text(info?.as?.type) || text(proxy?.network?.type)||text(ipapi?.asn?.type), prefix:text(network?.data?.prefix) || text(proxy?.network?.range)||text(ipapi?.asn?.route), source:info?.as?.name ? info.access === "lite" ? "IPinfo Lite" : "IPinfo" : reg?.registrant ? reg.source : proxy?.network?.provider ? "Proxycheck.io" : ipapiHolder ? "ipapi.is" : holder ? "RIPEstat ASN holder" : reg?.name ? reg.source : "Not available" };
  const reportedASNs=[...new Set([info?.as?.asn,proxy?.network?.asn,ipapiASN].filter(n=>/^AS[0-9]+$/.test(n||"")))];
  operator.attribution_conflict=asns.length>1 || reportedASNs.length>1 || (asns.length>0 && reportedASNs.some(n=>!asns.includes(n)));
  if (operator.attribution_conflict) warnings.push("Network ASN attribution is ambiguous. Routing: "+(asns.join(", ")||"not available")+"; IPinfo: "+(text(info?.as?.asn)||"not available")+"; Proxycheck.io: "+(text(proxy?.network?.asn)||"not available")+"; ipapi.is: "+(ipapiASN||"not available")+". Verify network ownership and observation times before choosing a recipient.");
  const legal = [];
  // ASN matching supplies an orientation lead, never a claim about which legal entity holds logs.
  if (operator.asns.includes("AS13335")) legal.push({name:"Cloudflare", kind:"law enforcement", country:"", email:"lawenforcement@cloudflare.com", url:"https://www.cloudflare.com/trust-hub/law-enforcement/", checked_on:"2026-10-03", basis:"AS13335 routing match; confirm the relevant service and legal entity."});
  if (operator.asns.includes("AS15169")) legal.push({name:"Google", kind:"law enforcement request portal (LERS)", country:"", email:"", url:"https://lers.google.com/", policy_url:"https://support.google.com/legal/answer/13967303?hl=en", checked_on:"2026-10-03", basis:"AS15169 network match; confirm the relevant Google service and receiving legal entity. A resolver address does not identify an Internet subscriber."});
  if (operator.asns.includes("AS8075")) legal.push({name:"Microsoft",kind:"law enforcement request portal",country:"",email:"",url:"https://v2.leportal.microsoft.com/",policy_url:"https://www.microsoft.com/en-us/corporate-responsibility/reports/government-requests/customer-data",checked_on:"2026-10-03",basis:"AS8075 network match; confirm the relevant Microsoft service and receiving legal entity."});
  if (operator.asns.includes("AS30238")) {
    legal.push({name:"Cisco",kind:"law enforcement request portal",country:"United States",email:"governmentdatademands@cisco.com",url:"https://privacyrequest.cisco.com/governmentdatarequest",policy_url:"https://www.cisco.com/c/dam/en_us/about/doing_business/trust-center/docs/law-enforcement-guidelines.pdf",checked_on:"2026-10-03",basis:"AS30238 Cisco IronPort network match; confirm the customer organisation and responsible Cisco entity.",scope:"Submit requests through the portal. The published email is a fallback for your contact details if the portal cannot be used, not an instruction to email evidence. Cisco asks authorities to seek data from the relevant customer first."});
    if (!operator.attribution_conflict) operator.service_context="Cisco IronPort email-security network. If this IP was extracted from an email Received header, it identifies a mail relay, not the sender's Internet connection or access ISP. Confirm the service and customer organisation.";
  }
  for (const route of legal) {route.target_type="network";route.jurisdictions=JURISDICTIONS[route.name] || [];}
  const intermediaryRoutes=privacy.services.map(s=>{
    const entry=serviceContact(s.name);
    return entry ? {...entry,target_type:"intermediary",basis:entry.basis+" Attribution: "+s.sources.join(" + ")+"."} : {name:s.name,target_type:"intermediary",kind:s.url?"Provider website — legal channel not verified":"Legal contact not yet verified",url:s.url,email:"",country:"",checked_on:"",basis:"Service attribution and website supplied by "+s.sources.join(" + ")+"; this is not a verified legal-request route."};
  });
  legal.unshift(...intermediaryRoutes);
  const enquiry=enquiryTarget(operator,privacy,contacts,legal);
  return { version:IP_INTELLIGENCE_VERSION, ip:parsed.ip, family:parsed.bits === 32 ? "IPv4" : "IPv6", queried_at:new Date().toISOString(),
    status: !sources.some(s => s.status === "available") ? "unavailable" : warnings.length ? "partial" : "complete",
    enrichment: { ipinfo_access: info?.access || (env.IPINFO_TOKEN ? "unavailable" : "not_configured"), ipapi_is_access:env.IPAPI_IS_ENABLED === "false" ? "disabled" : ipapi?.access || (env.IPAPI_IS_KEY ? "unavailable" : "not_configured"), proxycheck_access:proxy ? env.PROXYCHECK_API_KEY ? "api_key" : "unregistered" : env.PROXYCHECK_ENABLED === "false" ? "disabled" : "unavailable" },
    operator, enquiry, registration:reg, geolocation:geo, privacy, contacts, provider_contacts:legal, sources, warnings,
    limitations:["Current public metadata, not a reconstruction of the network at the incident time.","IP geolocation is approximate and does not identify a person, household or street address. VPN/proxy results concern the exit server; anycast may have multiple locations.","Registration country, server location and the provider's legal jurisdiction are different. Verify the responsible legal entity before a request.","VPN flags are provider assessments. Not detected is not proof of absence. This lookup cannot trace a subscriber behind a VPN.","Registry postal addresses belong to listed network contacts, not the subscriber. Abuse contacts are not necessarily authorized to receive legal requests."] };
}
function reply(body,status,env) { return new Response(JSON.stringify(body),{status,headers:{...corsHeaders(env),"Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff"}}); }
export async function handleIPIntelligence(request,env) {
  if (new URL(request.url).pathname !== "/ip-intelligence/lookup" || request.method !== "POST") return reply({error:"Unsupported IP Intelligence operation."},405,env);
  const token = cleanText(request.headers.get("X-Session-Token"),160);
  if (!token) return reply({error:"Authenticated session required."},401,env);
  const sessionResponse = await gateCall(env,"/session-get",{session_token:token});
  const session = await sessionResponse.json().catch(()=>({}));
  if (!sessionResponse.ok || !isAllowedUser(session.username,env)) return reply({error:"Session expired."},401,env);
  let body;
  try { body = await boundedJSON(new Response(request.body),2048); } catch { return reply({error:"Send a JSON object containing one IP, domain or web address (maximum 2 KB)."},400,env); }
  const target = parseTarget(body?.target ?? body?.ip,publicIP);
  if (!target) return reply({error:"Enter a public IP, domain or HTTP(S) web address (maximum 1024 characters). Credentials, nonstandard ports, private addresses and special-use names are excluded."},400,env);
  const limit = await gateCall(env,"/ip-intelligence-limit",{username:session.username});
  if (!limit.ok) return reply({error:"Lookup limit reached. Wait one minute and retry."},429,env);
  return reply(target.kind === "domain" ? await lookupDomain(target,env,{publicIP,lookupIP}) : await lookupIP(target.parsed,env),200,env);
}
