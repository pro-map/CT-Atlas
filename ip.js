(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev",$=id=>document.getElementById(id);
const token=()=>sessionStorage.getItem("ct_map_session_token")||"";
const {known,show}=window.CTAtlasIPReport;
let result=null,busy=false;
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
function render(r){
 $("results").hidden=false;$("resultIP").textContent=r.ip;$("resultTime").textContent=r.family+" · "+r.queried_at+" · "+r.status.toUpperCase();
 $("warnings").hidden=!r.warnings.length;$("warnings").replaceChildren(...r.warnings.map(w=>node("p",w)));
 fields("network",[["NETWORK OPERATOR",r.operator.name],["ASN / ROUTING PREFIX",[...r.operator.asns,r.operator.prefix].filter(Boolean).join(" · ")],["NETWORK TYPE",r.operator.type],["OPERATOR DOMAIN",r.operator.domain],["REGISTERED NAME",r.registration?.name],["REGISTRANT",r.registration?.registrant],["REGISTRATION COUNTRY",r.registration?.country],["REGISTRY LAST CHANGED",r.registration?.updated_at],["OPERATOR SOURCE",r.operator.source]]);
 const g=r.geolocation;
 fields("geolocation",[["COUNTRY",g?.country],["REGION / CITY",g&&[g.region,g.city].filter(Boolean).join(" / ")],["COORDINATES",g?.latitude!==null&&g?.latitude!==undefined?g.latitude+", "+g.longitude:"Not available"],["ACCURACY RADIUS",g?.radius_km!==null&&g?.radius_km!==undefined?g.radius_km+" km":"Not supplied"],["SOURCE",g?.source],["SOURCE DATA TIME",g?.data_time]]);
 $("mapLink").replaceChildren();
 if(typeof g?.latitude==="number"&&typeof g?.longitude==="number")$("mapLink").append(link("OPEN APPROXIMATE LOCATION ↗","https://www.openstreetmap.org/?mlat="+g.latitude+"&mlon="+g.longitude+"#map=7/"+g.latitude+"/"+g.longitude));
 fields("privacy",[["PRIVACY SERVICE",r.privacy.service],...[['VPN','vpn'],['PROXY','proxy'],['TOR EXIT','tor'],['RELAY','relay'],['HOSTING','hosting'],['ANYCAST','anycast']].map(([l,k])=>[l,known(r.privacy[k])]),["SOURCE",r.privacy.source]]);
 $("providerContacts").replaceChildren();
 for(const c of r.provider_contacts){const card=node("div",undefined,"contact");card.append(node("h4",c.name),node("span",c.kind,"pill"),node("p","Email: "+show(c.email)),node("p","Provider country: "+show(c.country)),node("p","Postal address: "+show(c.address)),safeLink("OFFICIAL CONTACT / POLICY ↗",c.url),node("p","Directory checked: "+c.checked_on+" · "+c.basis,"fine"));$("providerContacts").append(card);}
 if(!r.provider_contacts.length)$("providerContacts").append(node("p","No verified provider-specific legal route in this directory. Confirm the responsible entity and obtain its official contact procedure. Registry contacts below may assist with routing."));
 $("registryContacts").replaceChildren();
 for(const c of r.contacts){const card=node("div",undefined,"contact");card.append(node("h4",c.name),node("span",c.roles.join(" / ")||"Registry contact","pill"),node("p","Email: "+show(c.emails.join(", "))),node("p","Phone: "+show(c.phones.join(", "))),node("p","Postal address: "+show(c.address)),node("p","Source: "+(c.source||"RIR RDAP"),"fine"));$("registryContacts").append(card);}
 if(!r.contacts.length)$("registryContacts").append(node("p","No contact published by the consulted sources."));
 $("nextStep").textContent=r.privacy.vpn===true?"A VPN exit is indicated. Follow the identified VPN provider's official procedure. The address behind the VPN is not available through this lookup.":"Establish whether the network serves the subscriber directly or acts as an intermediary before routing an enquiry.";
 $("sources").replaceChildren();for(const s of r.sources){const row=node("div",undefined,"source-row");row.append(safeLink(s.name+" ↗",s.url),node("small",s.status.toUpperCase()+" · Retrieved: "+s.retrieved_at));$("sources").append(row);}
 $("limitations").replaceChildren(...r.limitations.map(l=>node("li",l)));
}
$("lookupForm").addEventListener("submit",async event=>{
 event.preventDefault();if(busy)return;busy=true;$("lookupButton").disabled=true;result=null;$("results").hidden=true;
 $("status").className="";$("status").textContent="Consulting network registries and intelligence sources…";
 const finish=window.CTAtlasUI?.begin($("waitAnchor"));
 try{result=await request("/ip-intelligence/lookup",{ip:$("ipAddress").value.trim()});render(result);$("status").textContent=result.status==="unavailable"?"Sources are currently unavailable. Retry shortly.":"Lookup complete. Review source coverage before exporting.";}
 catch(error){$("status").textContent=error.message;$("status").className="error";}
 finally{finish?.();busy=false;$("lookupButton").disabled=false;}
});
$("exportPdf").addEventListener("click",async()=>{
 if(!result||!$("lookupForm").reportValidity())return;$("exportPdf").disabled=true;
 try{await window.CTAtlasPdf.download(window.CTAtlasIPReport.build(result,incident()));$("status").textContent="PDF report downloaded.";}
 catch(_){$("status").textContent="PDF export failed. Please retry or export JSON.";}finally{$("exportPdf").disabled=false;}
});
$("exportJson").addEventListener("click",()=>{
 if(!result||!$("lookupForm").reportValidity())return;
 const blob=new Blob([JSON.stringify({...result,incident:incident()},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=node("a");
 a.href=url;a.download="CT-Atlas-IP-"+result.ip.replace(/:/g,"-")+".json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function init(){
 if(!token()){location.replace("index.html");return;}
 try{const session=await request("/session-check");if(!session.ok||!session.username)throw new Error("Session verification failed.");sessionStorage.setItem("ct_map_username",session.username);$("user").textContent=session.username.toUpperCase();$("workspace").hidden=false;window.CTAtlasUI?.ready();}
 catch(_){location.replace("index.html");}
}
init();
})();
