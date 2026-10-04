(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev",$=id=>document.getElementById(id);
const token=()=>sessionStorage.getItem("ct_map_session_token")||"";
const {known,show,overview,missingLegalRoute,assessmentLines,flagSource,contactOwner}=window.CTAtlasIPReport;
const CIDR_INPUT=/^(?:(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}|[0-9a-f.:]*:[0-9a-f.:]*\/\d{1,3})$/i;
let result=null,busy=false,selectedIP="";
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function link(label,url){const a=node("a",label);a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.referrerPolicy="no-referrer";return a;}
function safeLink(label,value){try{const u=new URL(value);if(u.protocol==="https:"&&!u.username&&!u.password)return link(label,u.href);}catch(_){}return node("span",label);}
function fields(id,rows){$(id).replaceChildren(...rows.flatMap(([label,value])=>[node("dt",label),node("dd",show(value))]));}
function incident(){return {reference:$("caseReference").value.trim(),observed_at:$("observedAt").value?$("observedAt").value+"Z":"",source_port:$("sourcePort").value,protocol:$("protocol").value,notes:$("notes").value.trim()};}
async function request(path,body){
 const response=await fetch(API+path,{method:body?"POST":"GET",cache:"no-store",headers:{"X-Session-Token":token(),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>({}));
 if(response.status===401){sessionStorage.removeItem("ct_map_session_token");location.replace("index.html");throw new Error("Session expired. Please sign in again.");}
 if(!response.ok)throw new Error(data.error||"The lookup could not be completed. Please retry.");return data;
}
function appendJurisdictions(parent,contact){
 if(!contact.jurisdictions?.length){parent.append(node("p","Jurisdiction: Not verified. Do not infer it from the IP location.","fine"));return;}
 for(const j of contact.jurisdictions){
  const row=node("p",undefined,"jurisdiction-row"),src=flagSource(j.country_code);
  if(src){const flag=node("img");flag.src=src;flag.alt=j.country+" flag";flag.width=24;flag.height=18;flag.className="country-flag";row.append(flag);}
  row.append(node("strong","Jurisdiction: "+j.country+" ("+j.country_code+") — "+j.entity));parent.append(row,node("p","Published entity/contact address: "+(j.address||"Not verified in the reviewed source")),node("p",j.scope,"fine"));
  const source=node("p");source.append(safeLink("JURISDICTION / ADDRESS SOURCE ↗",j.source_url));parent.append(source);
 }
}
function renderIP(r){
 const summary=overview(r);$("operatorSummary").textContent=summary.operator;$("contactSummary").textContent=summary.contact;$("vpnSummary").textContent=summary.vpn;
 const e=r.enquiry;$("enquiryContact").replaceChildren();
 if(e){for(const value of [e.basis,e.subscriber_scope,e.records_to_request&&"Information to request: "+e.records_to_request,contactOwner(e),e.email&&"Email: "+e.email,e.phone&&"Phone: "+e.phone,e.address&&"Published contact address: "+e.address,e.scope,e.contact_source])if(value)$("enquiryContact").append(node("p",value));if(e.url)$("enquiryContact").append(safeLink(e.checked_on?"OPEN CONTACT / PROCEDURE ↗":"PROVIDER WEBSITE · NOT A VERIFIED LEGAL CHANNEL ↗",e.url));appendJurisdictions($("enquiryContact"),e);}
 $("detectionSources").replaceChildren(...assessmentLines(r.privacy).map(s=>node("p",s)));
 if(!r.privacy.assessments?.length)$("detectionSources").append(node("p","No VPN detection source returned usable data."));
 $("warnings").hidden=!r.warnings.length;$("warnings").replaceChildren(...r.warnings.map(w=>node("p",w)));
 fields("network",[["NETWORK OPERATOR",r.operator.name],["ASN / ROUTING PREFIX",[...r.operator.asns,r.operator.prefix].filter(Boolean).join(" · ")],["NETWORK TYPE",r.operator.type],["OPERATOR DOMAIN",r.operator.domain],["REGISTERED NAME",r.registration?.name],["REGISTRANT",r.registration?.registrant],["REGISTRATION COUNTRY",r.registration?.country],["REGISTRY LAST CHANGED",r.registration?.updated_at],["OPERATOR SOURCE",r.operator.source],["REGISTRATION SOURCE",r.registration?.source],["SERVICE CONTEXT",r.operator.service_context]]);
 const g=r.geolocation;
 fields("geolocation",[["COUNTRY",g?.country],["REGION / CITY",g&&[g.region,g.city].filter(Boolean).join(" / ")],["COORDINATES",g?.latitude!==null&&g?.latitude!==undefined?g.latitude+", "+g.longitude:"Not available"],["ACCURACY RADIUS",g?.radius_km!==null&&g?.radius_km!==undefined?g.radius_km+" km":"Not supplied"],["SOURCE",g?.source],["SOURCE DATA TIME",g?.data_time]]);
 $("mapLink").replaceChildren();
 if(typeof g?.latitude==="number"&&typeof g?.longitude==="number")$("mapLink").append(link("OPEN APPROXIMATE LOCATION ↗","https://www.openstreetmap.org/?mlat="+g.latitude+"&mlon="+g.longitude+"#map=7/"+g.latitude+"/"+g.longitude));
 fields("privacy",[["VPN / INTERMEDIARY PROVIDER",r.privacy.service||summary.vpn],...[['VPN','vpn'],['PROXY','proxy'],['TOR EXIT','tor'],['RELAY','relay'],['HOSTING','hosting'],['ANYCAST','anycast']].map(([l,k])=>[l,r.privacy.conflicts?.includes(k)?"Conflicting assessments":known(r.privacy[k])]),["SOURCE",r.privacy.source]]);
 $("providerContacts").replaceChildren();
 for(const c of r.provider_contacts){const card=node("div",undefined,"contact");card.append(node("h4",c.name),node("span",c.kind+" · "+c.target_type,"pill"));if(c.email)card.append(node("p","Email: "+c.email));appendJurisdictions(card,c);if(c.address)card.append(node("p","Postal address: "+c.address));if(c.url)card.append(safeLink(c.checked_on?"OFFICIAL CONTACT / POLICY ↗":"PROVIDER WEBSITE · VERIFY ↗",c.url));if(c.scope)card.append(node("p",c.scope));if(c.policy_url){const policy=node("p");policy.append(safeLink("PROCEDURE SOURCE ↗",c.policy_url));card.append(policy);}card.append(node("p",(c.checked_on?"Directory checked: "+c.checked_on+" · ":"")+c.basis,"fine"));$("providerContacts").append(card);}
 if(!r.provider_contacts.length)$("providerContacts").append(node("p",missingLegalRoute(r)));
 $("registryContacts").replaceChildren();
 for(const c of r.contacts){const card=node("div",undefined,"contact");card.append(node("h4",c.name),node("span",c.roles.join(" / ")||"Registry contact","pill"),node("p","Email: "+show(c.emails.join(", "))),node("p","Phone: "+show(c.phones.join(", "))),node("p","Postal address: "+show(c.address)),node("p","Source: "+(c.source||"RIR RDAP"),"fine"));$("registryContacts").append(card);}
 if(!r.contacts.length)$("registryContacts").append(node("p","No contact published by the consulted sources."));
 $("nextStep").textContent=r.privacy.vpn===true?"A VPN exit is indicated. Follow the identified VPN provider's official procedure. The address behind the VPN is not available through this lookup.":"Establish whether the network serves the subscriber directly or acts as an intermediary before routing an enquiry.";
 $("sources").replaceChildren();for(const s of r.sources){const row=node("div",undefined,"source-row");row.append(safeLink(s.name+" ↗",s.url),node("small",s.status.toUpperCase()+(s.reason?" ("+s.reason+")":"")+" · Retrieved: "+s.retrieved_at));if(s.action)row.append(node("p",s.action,"fine"));$("sources").append(row);}
 $("limitations").replaceChildren(...r.limitations.map(l=>node("li",l)));
}
function renderSources(id,sources){
 $(id).replaceChildren();for(const s of sources){const row=node("div",undefined,"source-row");row.append(safeLink(s.name+" ↗",s.url),node("small",s.status.toUpperCase()+(s.reason?" ("+s.reason+")":"")+" · "+s.retrieved_at+(s.data_date?" · Snapshot: "+s.data_date:"")));$(id).append(row);}
}
function renderDomain(r){
 const d=r.registration,reg=d?.registrar;
 fields("domainFields",[["SUBMITTED HOSTNAME",r.host],["REGISTERED DOMAIN",r.registered_domain],["REGISTRAR",reg?.name],["IANA REGISTRAR ID",reg?.id],["REGISTRATION STATUS",d?.status.join(", ")],...(d?.events||[]).map(e=>[e.action.toUpperCase(),e.date]),["LEGAL JURISDICTION","Not established by domain registration; verify the receiving legal entity."]]);
 $("domainScope").textContent=d?.scope||"Domain registration unavailable."+(r.dns.addresses.length?" The DNS and IP findings below can still be used.":"");
 $("domainLinks").replaceChildren();for(const [label,url] of [["DOMAIN REGISTRY RECORD ↗",d?.registry_url],["ICANN LOOKUP ↗",d?.lookup_url]])if(url)$("domainLinks").append(safeLink(label,url));
 $("domainContacts").replaceChildren();for(const c of reg?.contacts||[]){const card=node("div",undefined,"contact");card.append(node("h4",c.name||reg.name),node("span",c.roles.join(" / "),"pill"),node("p","Email: "+show(c.emails.join(", "))),node("p","Phone: "+show(c.phones.join(", "))),node("p","Published contact address: "+show(c.address)),node("p",c.scope,"fine"));if(c.url)card.append(safeLink("PUBLISHED CONTACT WEBSITE ↗",c.url));card.append(node("p","Source: "+c.source,"fine"));$("domainContacts").append(card);}
 if(!reg?.contacts?.length)$("domainContacts").append(node("p","No registrar contact returned by the consulted sources."));
 fields("domainDns",[["CNAME ALIASES",r.dns.cnames.join(", ")],["DOMAIN NAMESERVERS",r.dns.nameservers.join(", ")||d?.nameservers.join(", ")],["DOMAIN MAIL EXCHANGERS",r.dns.mail_exchangers.join(", ")]]);
 $("ipCoverage").textContent=r.networks.length+" / "+r.dns.addresses.length+" displayed IPs analysed. "+r.dns.scope;
 $("domainIPs").replaceChildren();for(const address of r.dns.addresses){const analysed=r.networks.some(n=>n.ip===address.ip),button=node("button",address.ip+" · "+address.family+(analysed?"":" · ANALYSE"));button.type="button";button.disabled=busy;button.setAttribute("aria-pressed",String(address.ip===selectedIP));button.addEventListener("click",()=>selectDomainIP(address.ip));$("domainIPs").append(button);}
 const domainWarnings=r.warnings.filter(w=>!w.startsWith("Automatically enriched "));
 if(r.networks.length<r.dns.addresses.length)domainWarnings.push("Additional DNS addresses have not been analysed; select them above to include them in the report.");
 $("domainWarnings").hidden=!domainWarnings.length;$("domainWarnings").replaceChildren(...domainWarnings.map(w=>node("p",w)));
 renderSources("domainSources",r.sources);$("domainLimitations").replaceChildren(...r.limitations.map(l=>node("li",l)));
}
function render(r){
 const domain=r.kind==="domain";$("results").hidden=false;$("domainResults").hidden=!domain;
 $("resultIP").textContent=domain?r.host:r.ip;$("resultTime").textContent=(domain?"DOMAIN":r.family)+" · "+r.queried_at+" · "+r.status.replace(/_/g," ").toUpperCase();
 if(domain){if(!r.networks.some(n=>n.ip===selectedIP))selectedIP=r.networks[0]?.ip||"";renderDomain(r);}
 const network=domain?r.networks.find(n=>n.ip===selectedIP):r;
 $("ipResults").hidden=!network;$("selectedIP").hidden=!domain;$("selectedIP").textContent=domain?"SELECTED IP: "+selectedIP:"";
 if(network)renderIP(network);
}
async function selectDomainIP(ip){
 if(busy||result?.kind!=="domain")return;
 if(result.networks.some(n=>n.ip===ip)){selectedIP=ip;render(result);return;}
 const finishSound=window.CTAtlasSound?.begin();
 busy=true;$("lookupButton").disabled=true;$("exportPdf").disabled=true;$("exportJson").disabled=true;render(result);
 $("status").textContent="Analysing "+ip+"…";const finish=window.CTAtlasUI?.begin($("waitAnchor"));
 try{const network=await request("/ip-intelligence/lookup",{ip});result.networks.push(network);selectedIP=ip;result.status="partial";$("status").textContent="IP added to this domain investigation and its report.";finishSound?.(network.status==="unavailable"?"error":"success");}
 catch(error){finishSound?.("error");$("status").textContent=error.message;}
 finally{busy=false;$("lookupButton").disabled=false;$("exportPdf").disabled=false;$("exportJson").disabled=false;finish?.();render(result);}
}
const DONE={unavailable:"Sources are currently unavailable. Retry shortly.",not_found:"The registry reports this domain as not registered, and DNS returned no address. Check the spelling."};
$("lookupForm").addEventListener("submit",async event=>{
 event.preventDefault();if(busy)return;const target=$("ipAddress").value.trim();
 if(CIDR_INPUT.test(target)){$("status").className="error";$("status").textContent="IP ranges (CIDR) are not supported. Enter one address.";return;}
 busy=true;$("lookupButton").disabled=true;result=null;selectedIP="";$("results").hidden=true;
 $("status").className="";$("status").textContent="Consulting DNS, registration and network intelligence sources…";
 const finishSound=window.CTAtlasSound?.begin();
 const finish=window.CTAtlasUI?.begin($("waitAnchor"));
 try{result=await request("/ip-intelligence/lookup",{ip:target});render(result);$("status").textContent=DONE[result.status]||"Lookup complete. Review source coverage before exporting.";finishSound?.(result.status==="unavailable"?"error":"success");}
 catch(error){finishSound?.("error");$("status").textContent=error.message;$("status").className="error";}
 finally{finish?.();busy=false;$("lookupButton").disabled=false;if(result)render(result);}
});
// Exports need valid incident fields only; the search box may already hold the next target.
function incidentValid(){
 const invalid=["caseReference","observedAt","sourcePort","protocol","notes"].map($).find(el=>!el.checkValidity());
 if(!invalid)return true;
 const details=invalid.closest("details");if(details)details.open=true;
 invalid.reportValidity();$("status").textContent="Correct the incident details before exporting.";return false;
}
$("exportPdf").addEventListener("click",async()=>{
 if(!result||!incidentValid())return;$("exportPdf").disabled=true;
 try{await window.CTAtlasPdf.download(window.CTAtlasIPReport.build(result,incident()));$("status").textContent="PDF report downloaded.";}
 catch(_){$("status").textContent="PDF export failed. Please retry or export JSON.";}finally{$("exportPdf").disabled=false;}
});
$("exportJson").addEventListener("click",()=>{
 if(!result||!incidentValid())return;
 const blob=new Blob([JSON.stringify({...result,incident:incident()},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=node("a");
 a.href=url;a.download="CT-Atlas-"+(result.kind==="domain"?"Domain-"+result.host:"IP-"+result.ip.replace(/:/g,"-"))+".json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function init(){
 if(!token()){location.replace("index.html");return;}
 try{const session=await request("/session-check");if(!session.ok||!session.username)throw new Error("Session verification failed.");sessionStorage.setItem("ct_map_username",session.username);$("user").textContent=session.username.toUpperCase();$("workspace").hidden=false;window.CTAtlasUI?.ready();}
 catch(_){location.replace("index.html");}
}
init();
})();
