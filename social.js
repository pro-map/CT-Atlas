(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
const $=id=>document.getElementById(id);
const STATUS={found:"FOUND",not_found:"NOT FOUND",unavailable:"UNAVAILABLE",unknown:"OTHER RESULT"};
let results=null,configured=false,busy=false,verified=false;
const inputs={
  email:{label:"EMAIL ADDRESS",placeholder:"name@example.com",hint:"Enter one email address.",type:"email",mode:"email"},
  phone:{label:"PHONE NUMBER",placeholder:"+33123456789",hint:"Include the international +country code.",type:"tel",mode:"tel"},
  username:{label:"USERNAME",placeholder:"username",hint:"Enter a handle, without a profile URL.",type:"text",mode:"text"},
  name:{label:"FULL NAME",placeholder:"First name Last name",hint:"Exact name matching is enabled to reduce unrelated results.",type:"text",mode:"text"},
  wallet:{label:"CRYPTO WALLET",placeholder:"Wallet address",hint:"Enter one cryptocurrency wallet address.",type:"text",mode:"text"}
};
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el;}
function status(message,type=""){ $("socialStatus").textContent=message;$("socialStatus").className="social-status"+(type?" "+type:""); }
function token(){return sessionStorage.getItem("ct_map_session_token")||"";}
function headers(){return {"Content-Type":"application/json","X-Session-Token":token()};}
function safeUrl(value){try{const url=new URL(String(value||""));return ["https:","http:"].includes(url.protocol)&&!url.username&&!url.password?url.href:"";}catch{return "";}}
function valueText(value){return typeof value==="boolean"?(value?"Yes":"No"):typeof value==="object"?JSON.stringify(value,null,2):String(value??"");}
function clearSession(){for(const key of ["ct_map_session_token","ct_map_username","ct_map_session_expires","ct_map_authorized"])sessionStorage.removeItem(key);location.replace("index.html");}
function buttons(){ $("osintSearch").disabled=!verified||!configured||busy;$("osintSearch").textContent=busy?"SEARCHING…":"SEARCH";for(const id of ["osintType","osintQuery"])$(id).disabled=busy;for(const id of ["osintClear","osintJson","osintPdf"])$(id).disabled=!results||busy; }
function updateType(){const config=inputs[$("osintType").value];$("osintQueryLabel").textContent=config.label;$("osintQuery").type=config.type;$("osintQuery").inputMode=config.mode;$("osintQuery").placeholder=config.placeholder;$("osintInputHint").textContent=config.hint;$("osintQuery").value="";}
async function connection(){
  try{
    const response=await fetch(API+"/social-osint/status",{headers:headers(),cache:"no-store",signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(response.status===401){clearSession();return;}
    if(!response.ok)throw new Error(data.error||"Connection status unavailable.");
    configured=data.configured===true && data.connection!=="rejected";
    const badge=$("osintConnection");badge.className=configured?"connected":"pending";
    badge.textContent=!data.configured?"Awaiting API key":data.connection==="rejected"?"API access rejected":data.connection==="verified"?"API connected":"API configured · status unavailable";
    $("osintCredits").textContent="Credits: "+(Number.isFinite(data.credits)?data.credits:"not available");
    if(!results)status(!data.configured?"The interface is ready. An administrator must connect the OSINT Industries API key before searching.":data.connection==="rejected"?"The provider rejected the API credentials. Ask the administrator to check the connection.":"Ready to search. Standard searches use your shared OSINT Industries account credits.",configured?"":"warning");
  }catch(error){configured=false;$("osintConnection").textContent="Connection unavailable";$("osintConnection").className="pending";if(!results)status(error.message,"error");}
  buttons();
}
function field(label,value){const row=node("div",undefined,"card-field");row.append(node("dt",label));const dd=node("dd");const text=valueText(value),url=safeUrl(text);if(url){const a=node("a",text);a.href=url;a.target="_blank";a.rel="noopener noreferrer";dd.append(a);}else dd.textContent=text;row.append(dd);return row;}
function renderCard(card){
  const article=node("article",undefined,"result-card"),heading=node("div",undefined,"card-heading");
  heading.append(node("span",card.module.slice(0,1).toUpperCase(),"platform-icon"),node("h3",card.module),node("span",STATUS[card.status]||"OTHER RESULT","result-badge "+card.status));article.append(heading);
  const picture=safeUrl(card.picture_url);if(picture){const image=node("img");image.src=picture;image.alt="Profile picture returned by "+card.module;image.className="profile-picture";image.loading="lazy";image.referrerPolicy="no-referrer";image.addEventListener("error",()=>image.remove());article.append(image);}
  const details=node("dl",undefined,"card-fields");for(const item of card.fields||[])details.append(field(item.label,item.value));article.append(details);
  if(card.profile_url){const link=node("a","OPEN SOURCE PROFILE ↗","profile-link");const url=safeUrl(card.profile_url);if(url){link.href=url;link.target="_blank";link.rel="noopener noreferrer";article.append(link);}}
  if(card.reliable_source!==null)article.append(node("p",card.reliable_source?"Provider marks this source as reliable.":"Provider does not mark this source as reliable.","card-note"));
  if(card.origin)article.append(node("p","Search basis: "+card.origin,"card-note"));
  const raw=node("details"),summary=node("summary","FULL SOURCE RESPONSE"),pre=node("pre",JSON.stringify(card.evidence,null,2));raw.append(summary,pre);article.append(raw);return article;
}
function render(){
  $("osintResults").replaceChildren();if(!results)return;
  const filter=$("osintFilter").value,text=$("osintResultSearch").value.trim().toLowerCase();
  const cards=results.cards.filter(card=>(filter==="all"||card.status===filter)&&(!text||JSON.stringify(card).toLowerCase().includes(text)));
  $("osintEmpty").hidden=cards.length>0;
  if(!cards.length){$("osintEmpty").replaceChildren(node("h3",results.cards.length?"No results match this filter":"No module results were returned"),node("p",results.cards.length?"Change the filter to see the other results. This does not run another search.":"No returned results does not establish that an account is absent. Some modules may be unavailable or exceed the search window."));}
  for(const card of cards)$("osintResults").append(renderCard(card));
  $("osintToolbar").hidden=false;$("osintCounts").replaceChildren();
  for(const [label,value] of [["matches",results.matches],["modules",results.modules_returned],["unavailable",results.unavailable],["shown",cards.length]]){const item=node("span",undefined,"count");item.append(node("strong",value),document.createTextNode(" "+label));$("osintCounts").append(item);}
}
async function search(event){
  event.preventDefault();if(busy||!configured||!verified)return;
  busy=true;buttons();status("Searching OSINT Industries… modules can take around 60 seconds. Keep this page open.");
  const query=$("osintQuery").value.trim(),type=$("osintType").value;
  try{
    const response=await fetch(API+"/social-osint/search",{method:"POST",headers:headers(),cache:"no-store",body:JSON.stringify({type,query,request_id:crypto.randomUUID()}),signal:AbortSignal.timeout(90000)});
    const data=await response.json();
    if(response.status===401){clearSession();return;}
    if(!response.ok)throw new Error(data.error||"The search could not be completed.");
    if(!Array.isArray(data.cards))throw new Error("The server returned an unreadable result.");
    results=data;$("osintFilter").value="all";$("osintResultSearch").value="";
    $("osintResultMeta").textContent=inputs[data.type].label+": "+data.query+" · "+new Date(data.searched_at).toLocaleString("en-GB",{timeZone:"Europe/Paris"})+" Paris time";
    render();status("Search completed. "+data.matches+" match(es) across "+data.modules_returned+" returned modules.","success");
    await connection();
  }catch(error){status(error.name==="TimeoutError"?"The response timed out. A submitted search may have used a credit; it was not retried automatically.":error.message,"error");}
  finally{busy=false;buttons();}
}
function filename(extension){return "CT-Atlas-Social-"+results.type+"-"+results.searched_at.slice(0,10)+"."+extension;}
function downloadJSON(){if(!results)return;const blob=new Blob([JSON.stringify(results,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=node("a");a.href=url;a.download=filename("json");document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function downloadPDF(){
  if(!results)return;const button=$("osintPdf");button.disabled=true;
  try{
    if(!window.CTAtlasPdf?.download)throw new Error("PDF export is unavailable. Download JSON instead.");
    const blocks=[{type:"body",text:"Provider: OSINT Industries\nQuery type: "+results.type+"\nQuery: "+results.query+"\nSearch time: "+results.searched_at+"\nReturned modules: "+results.modules_returned+"\nMatches: "+results.matches}];
    for(const card of results.cards){blocks.push({type:"heading",text:card.module+" — "+(STATUS[card.status]||"OTHER RESULT")});for(const item of card.fields)blocks.push({type:"body",text:item.label+": "+valueText(item.value)});if(card.profile_url)blocks.push({type:"source",text:card.profile_url});if(card.origin)blocks.push({type:"body",text:"Search basis: "+card.origin});}
    blocks.push({type:"body",text:$("osintResults").parentElement.querySelector(".results-note").textContent+" Full source responses are available in the JSON export."});
    await window.CTAtlasPdf.download({title:"Social Intelligence — OSINT Industries",eyebrow:"CT ATLAS",meta:"Downloaded from the Social workspace",blocks,filename:filename("pdf")});
  }catch(error){status(error.message,"error");}finally{buttons();}
}
function clear(){results=null;$("osintResults").replaceChildren();$("osintToolbar").hidden=true;$("osintEmpty").hidden=false;$("osintEmpty").replaceChildren(node("h3","Ready for a new search"),node("p","Your previous results have been cleared from this page."));$("osintResultMeta").textContent="Results will appear here after a search.";status("Results cleared.");buttons();}
async function boot(){
  $("osintForm").addEventListener("submit",search);$("osintType").addEventListener("change",updateType);$("osintFilter").addEventListener("change",render);$("osintResultSearch").addEventListener("input",render);$("osintClear").addEventListener("click",clear);$("osintJson").addEventListener("click",downloadJSON);$("osintPdf").addEventListener("click",downloadPDF);
  try{
    if(!token()){location.replace("index.html");return;}
    const response=await fetch(API+"/session-check",{headers:headers(),cache:"no-store",signal:AbortSignal.timeout(10000)}),data=await response.json();
    if(!response.ok||!data.ok||!data.username){clearSession();return;}
    $("socialUser").textContent=String(data.username).toUpperCase();verified=true;await connection();
  }catch{status("Unable to verify your session. Return to MAIN and sign in again.","error");}
  finally{document.documentElement.classList.remove("ct-loading");clearTimeout(window.ctLoadingFallback);window.CTAtlasUI?.ready();buttons();}
}
boot();
})();
