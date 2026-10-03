import { cleanText, corsHeaders, gateCall, isAllowedUser } from "./shared.js";

export const IP_INTELLIGENCE_VERSION = "ip-intelligence-v1";
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
async function boundedJSON(response, max = 1000000) {
  if (!response.ok || !response.body) throw new Error("source_unavailable");
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
async function registry(parsed) {
  const key = parsed.bits, now = Date.now(); let bootstrap = bootstrapCache.get(key);
  if (!bootstrap || bootstrap.until < now) {
    const result = await getJSON("https://data.iana.org/rdap/ipv"+(key === 32 ? "4" : "6")+".json");
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
  // Some RIRs return entity references instead of contact cards. Resolve at most three.
  let count = 0;
  for (const entity of list(result.data.entities)) {
    const href = list(entity.links).find(l => l.rel === "self" && trustedRdap(l.href))?.href;
    if (!entity.vcardArray && href && count++ < 3) {
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
  return { name: text(data.name), handle: text(data.handle), country: text(data.country), start: text(data.startAddress), end: text(data.endAddress),
    registrant: contacts.find(c => c.roles.includes("registrant"))?.name || "", contacts,
    updated_at: text(list(data.events).find(e => e.eventAction === "last changed")?.eventDate) };
}

// Exact aliases only: a network owner or an ASN never implies a VPN service.
const DIRECTORY = [
  { aliases: ["protonvpn","proton vpn"], name: "Proton VPN", kind: "law enforcement", country: "Switzerland", email: "legal@proton.me", url: "https://proton.me/legal/law-enforcement" },
  { aliases: ["nordvpn","nord vpn"], name: "NordVPN", kind: "general contact — ask for the legal channel", country: "", email: "", url: "https://nordvpn.com/contact-us/" },
  { aliases: ["mullvad","mullvad vpn"], name: "Mullvad VPN", kind: "general support — ask for the legal channel", country: "Sweden", address: "Mullvad VPN AB, Box 53049, 400 14 Gothenburg, Sweden", email: "support@mullvadvpn.net", url: "https://mullvad.net/en/help/privacy-policy" },
  { aliases: ["expressvpn","express vpn"], name: "ExpressVPN", kind: "provider policy — legal contact not verified", country: "", email: "", url: "https://www.expressvpn.com/trust" }
];
export function serviceContact(name) {
  const match = DIRECTORY.find(d => d.aliases.includes(String(name||"").trim().toLowerCase()));
  if (!match) return null;
  const { aliases, ...entry } = match;
  return { ...entry, checked_on: "2026-10-03", basis: "Exact match to the IPinfo privacy service name; independently verify before contacting." };
}
function coordinates(lat,lon) {
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 ? { latitude:lat, longitude:lon } : { latitude:null, longitude:null };
}
export async function lookupIP(parsed, env) {
  const sources = [], warnings = [];
  const ripe = endpoint => "https://stat.ripe.net/data/"+endpoint+"/data.json?resource="+encodeURIComponent(parsed.ip)+"&sourceapp=ct-atlas";
  async function source(name, task, publicURL) {
    try {
      const result = await task();
      // RIPEstat uses a status string; RDAP uses an array such as ["active"].
      if (typeof result.data?.status === "string" && result.data.status !== "ok") throw new Error("source_error");
      sources.push({ name, url: publicURL || result.url, status:"available", retrieved_at:new Date().toISOString() });
      return result.data;
    } catch { sources.push({ name, url: publicURL || "https://data.iana.org/rdap/", status:"unavailable", retrieved_at:new Date().toISOString() }); warnings.push(name+" unavailable; its fields are unknown."); return null; }
  }
  const [rdap, network, abuse, geoData, info] = await Promise.all([
    source("RIR RDAP",()=>registry(parsed)),
    source("RIPEstat routing",()=>getJSON(ripe("network-info")),ripe("network-info")),
    source("RIPEstat abuse contacts",()=>getJSON(ripe("abuse-contact-finder")),ripe("abuse-contact-finder")),
    source("RIPEstat / MaxMind GeoLite2",()=>getJSON(ripe("maxmind-geo-lite")),ripe("maxmind-geo-lite")),
    env.IPINFO_TOKEN ? source("IPinfo",()=>getJSON("https://api.ipinfo.io/lookup/"+encodeURIComponent(parsed.ip),{headers:{Authorization:"Bearer "+env.IPINFO_TOKEN}}),"https://ipinfo.io/"+encodeURIComponent(parsed.ip)) : null
  ]);
  const reg = rdap ? registration(rdap) : null;
  const meaningfulGeo = g => g && typeof g.country === "string" && /^[A-Za-z]{2}/.test(g.country) && !["unknown","zz","xx"].includes(g.country.toLowerCase());
  const enrichedGeo = meaningfulGeo(info?.geo) ? info.geo : null;
  const fallbackGeo = geoData?.data?.located_resources?.[0]?.locations?.[0];
  // GeoLite may return country "?" and coordinates 0,0 to mean unknown.
  const rawGeo = enrichedGeo || (meaningfulGeo(fallbackGeo) ? fallbackGeo : null);
  const geo = rawGeo ? { country:text(rawGeo.country), country_code:text(rawGeo.country_code), city:text(rawGeo.city), region:text(rawGeo.region), timezone:text(rawGeo.timezone),
    ...coordinates(rawGeo.latitude,rawGeo.longitude), radius_km: typeof rawGeo.radius === "number" && rawGeo.radius >= 0 ? rawGeo.radius : null,
    source: enrichedGeo ? "IPinfo" : "RIPEstat / MaxMind GeoLite2", data_time:text(enrichedGeo ? enrichedGeo.last_changed : geoData?.data?.result_time) } : null;
  if (!geo) warnings.push("Geolocation is unknown in the consulted sources. No location is inferred from the registration address.");
  const privacy = { source: info ? "IPinfo" : "Not available", vpn:bool(info?.anonymous?.is_vpn), proxy:bool(info?.anonymous?.is_proxy), tor:bool(info?.anonymous?.is_tor), relay:bool(info?.anonymous?.is_relay), hosting:bool(info?.is_hosting), anycast:bool(info?.is_anycast), service:text(info?.anonymous?.name) };
  if (privacy.vpn === null) warnings.push(env.IPINFO_TOKEN ? "VPN detection not returned. Check the IPinfo token and plan (Plus or equivalent)." : "VPN detection is not configured. Administrator: add an IPINFO_TOKEN for IPinfo Plus or equivalent to the API Worker.");
  const contacts = reg?.contacts || [];
  for (const email of list(abuse?.data?.abuse_contacts).slice(0,8)) if (typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !contacts.some(c => c.emails.includes(email))) contacts.push({ name:"Network abuse contact", roles:["abuse"], source:"RIPEstat abuse contacts", address:"", phones:[], emails:[email] });
  const asns = list(network?.data?.asns).map(n => /^\d+$/.test(String(n)) ? "AS"+n : "").filter(Boolean).slice(0,10);
  const operator = { name:text(info?.as?.name) || reg?.registrant || reg?.name || "Unknown", asns:asns.length ? asns : info?.as?.asn ? [text(info.as.asn)] : [], domain:text(info?.as?.domain), type:text(info?.as?.type), prefix:text(network?.data?.prefix), source:info?.as?.name ? "IPinfo" : "RIR RDAP" };
  const legal = [];
  // ASN matching supplies an orientation lead, never a claim about which legal entity holds logs.
  if (operator.asns.includes("AS13335")) legal.push({name:"Cloudflare", kind:"law enforcement", country:"", email:"lawenforcement@cloudflare.com", url:"https://www.cloudflare.com/trust-hub/law-enforcement/", checked_on:"2026-10-03", basis:"AS13335 routing match; confirm the relevant service and legal entity."});
  const vpnContact = serviceContact(privacy.service);
  if (vpnContact) legal.unshift(vpnContact);
  return { version:IP_INTELLIGENCE_VERSION, ip:parsed.ip, family:parsed.bits === 32 ? "IPv4" : "IPv6", queried_at:new Date().toISOString(),
    status: sources.every(s => s.status === "unavailable") ? "unavailable" : warnings.length ? "partial" : "complete",
    operator, registration:reg, geolocation:geo, privacy, contacts, provider_contacts:legal, sources, warnings,
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
  try { body = await boundedJSON(new Response(request.body),2048); } catch { return reply({error:"Send a JSON object containing one public IP address (maximum 2 KB)."},400,env); }
  const parsed = publicIP(body?.ip);
  if (!parsed) return reply({error:"Enter one public IPv4 or IPv6 address, without a URL, port, subnet, brackets or zone. Private and special-use ranges are excluded."},400,env);
  const limit = await gateCall(env,"/ip-intelligence-limit",{username:session.username});
  if (!limit.ok) return reply({error:"Lookup limit reached. Wait one minute and retry."},429,env);
  return reply(await lookupIP(parsed,env),200,env);
}
