(function(){
"use strict";
const known=value=>value===true?"Detected":value===false?"Not detected by source":"Unknown / not assessed";
const show=value=>value===undefined||value===null||value===""?"Not available":String(value);
function sections(result,incident={}){
 const r=result,g=r.geolocation,p=r.privacy,o=r.operator,reg=r.registration;
 return [
  {title:"INVESTIGATION CONTEXT",lines:["IP: "+r.ip+" ("+r.family+")","Lookup time (UTC): "+r.queried_at,"Coverage: "+r.status,"Case reference: "+show(incident.reference),"Observed time (UTC, analyst supplied): "+show(incident.observed_at),"Source port: "+show(incident.source_port)+" · Protocol: "+show(incident.protocol)]},
  {title:"NETWORK / OPERATOR",lines:["Network operator: "+o.name+" · Source: "+o.source,"Routing ASN: "+show(o.asns.join(", "))+" · Prefix: "+show(o.prefix),"Network type: "+show(o.type)+" · Operator domain: "+show(o.domain),"Registry name: "+show(reg?.name)+" · Registrant: "+show(reg?.registrant),"Registered range: "+(reg?reg.start+" – "+reg.end:"Not available"),"Registration country (not geolocation or confirmed jurisdiction): "+show(reg?.country),"Registry last changed: "+show(reg?.updated_at)]},
  {title:"APPROXIMATE GEOLOCATION",lines:g?["Country / region / city: "+[g.country,g.region,g.city].filter(Boolean).join(" / "),"Coordinates: "+show(g.latitude)+", "+show(g.longitude),"Accuracy radius (km): "+show(g.radius_km)+" · Timezone: "+show(g.timezone),"Source: "+g.source+" · Source data time: "+show(g.data_time),"IP location estimate, not a person, household or street address."]:["Geolocation unavailable."]},
  {title:"VPN / INTERMEDIARIES",lines:["Privacy service identified by source: "+show(p.service),...[["VPN","vpn"],["Proxy","proxy"],["Tor exit","tor"],["Relay","relay"],["Hosting","hosting"],["Anycast","anycast"]].map(([label,key])=>label+": "+known(p[key])),"Source: "+p.source+". The network operator and a VPN service may be different entities."]},
  {title:"PROVIDER CONTACT ROUTES",lines:r.provider_contacts.length?r.provider_contacts.flatMap(c=>[c.name+" · "+c.kind,"Email: "+show(c.email)+" · Provider country: "+show(c.country),"Postal address: "+show(c.address),"Official page: "+c.url,"Directory checked: "+c.checked_on+" · "+c.basis]):["No verified provider-specific legal route in this directory. Confirm the responsible entity and obtain its current official procedure. Do not assume an abuse mailbox accepts legal requests."]},
  {title:"REGISTRY / TECHNICAL CONTACTS",lines:r.contacts.length?r.contacts.flatMap(c=>[c.name+" · Roles: "+c.roles.join(", "),"Email: "+show(c.emails.join(", "))+" · Phone: "+show(c.phones.join(", ")),"Registry contact postal address: "+show(c.address),"Source: "+(c.source||"RIR RDAP")]):["No contact published by the consulted sources."]},
  {title:"INVESTIGATOR HANDOFF",lines:["Preserve original logs, the public IP, exact observation time and timezone, source port and protocol. Confirm the provider and receiving legal entity through your agency's procedure.",p.vpn===true?"A VPN exit is indicated. Follow the identified VPN provider's current official procedure; this tool cannot reveal the address behind it.":"Establish whether the network serves the subscriber directly or is an intermediary before routing a request.","No request has been sent. Public metadata does not establish identity or the existence of retained logs.","Analyst notes: "+show(incident.notes)]},
  {title:"COVERAGE & LIMITATIONS",lines:[...r.warnings,...r.limitations]},
  {title:"SOURCES",lines:r.sources.map(s=>s.name+" · "+s.status+" · Retrieved: "+s.retrieved_at+"\n"+s.url)}
 ];
}
function build(result,incident){return {filename:"CT-Atlas-IP-"+result.ip,eyebrow:"CT ATLAS · IP INTELLIGENCE",title:"IP investigation brief",meta:result.ip+" · "+result.queried_at,footer:"CT Atlas · Investigator orientation · Current public metadata",blocks:sections(result,incident).flatMap(s=>[{type:"heading",text:s.title},...s.lines.map(text=>({type:"body",text}))])};}
window.CTAtlasIPReport={build,sections,known,show};
})();
