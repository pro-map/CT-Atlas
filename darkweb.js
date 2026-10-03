(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
const $=id=>document.getElementById(id);
let state=null,view="latest",busy=false;
const token=()=>sessionStorage.getItem("ct_map_session_token")||"";
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function date(value){return value?new Date(value).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Never";}
async function api(path,body){
 const response=await fetch(API+path,{method:body===undefined?"GET":"POST",cache:"no-store",headers:{"X-Session-Token":token(),...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json().catch(()=>({}));
 if(response.status===401){sessionStorage.removeItem("ct_map_session_token");location.replace("index.html");throw new Error("Please sign in again.");}
 if(!response.ok)throw new Error(data.error||"The request could not be completed.");
 return data;
}
function unread(item){return !item.baseline&&item.first_seen>(state.seen_through||"");}
function empty(title,text){const el=node("div",undefined,"empty");el.append(node("h2",title),node("p",text));return el;}
function copy(value,label){const button=node("button",label,"copy");button.type="button";button.onclick=async()=>{try{await navigator.clipboard.writeText(value);button.textContent="COPIED";setTimeout(()=>button.textContent=label,1500);}catch(_){$("message").textContent="Clipboard unavailable. Select and copy the URL in the outlet listing.";}};return button;}
function renderFeed(){
 const outletId=$("outletFilter").value,type=$("typeFilter").value,query=$("search").value.trim().toLowerCase();
 const outlets=new Map(state.outlets.map(o=>[o.id,o]));
 const rows=state.items.filter(i=>(!outletId||i.outlet_id===outletId)&&(!type||i.type===type)&&(!query||[i.title,i.excerpt,outlets.get(i.outlet_id)?.name,...(i.keyword_matches||[])].join(" ").toLowerCase().includes(query))&&(view!=="alerts"||unread(i)));
 $("feed").replaceChildren();
 if(!rows.length){$("feed").append(empty(view==="alerts"?"No unreviewed material":"No material to display",state.outlets.length?"Start the Tor collector or adjust your filters. The first complete scan establishes an inventory baseline.":"The administrator can register the three outlets in OUTLETS, then connect the Tor collector."));return;}
 for(const item of rows){
  const article=node("article",undefined,"item"),head=node("div",undefined,"item-head");
  head.append(node("span",outlets.get(item.outlet_id)?.name||"Outlet"),node("span",item.type,"pill"));
  if(unread(item))head.append(node("span","UNREVIEWED","pill new"));
  if(item.baseline)head.append(node("span","BASELINE","pill"));
  if(item.keyword_matches?.length)head.append(node("span","KEYWORDS: "+item.keyword_matches.join(", "),"pill alert"));
  const foot=node("div",undefined,"item-foot");foot.append(node("span","First detected: "+date(item.first_seen)),copy(item.url,"COPY ONION URL"));
  foot.append(node("span",item.acquired?"Acquired on collector · "+(item.bytes===null?"size unavailable":(item.bytes/1048576).toFixed(1)+" MB"):"Link discovered · file not acquired"));
  article.append(head,node("h3",item.title));
  if(item.excerpt)article.append(node("p",item.excerpt,"excerpt"));
  article.append(foot);
  if(item.source_page)article.append(copy(item.source_page,"COPY SOURCE PAGE"));
  if(item.sha256)article.append(node("p","Content SHA-256: "+item.sha256,"hash"));
  $("feed").append(article);
 }
}
function editOutlet(outlet){$("outletName").value=outlet.name;$("outletUrl").value=outlet.url;$("keywords").value=outlet.keywords.join(", ");$("enabled").checked=outlet.enabled;$("outletForm").scrollIntoView({behavior:"smooth"});}
function render(){
 $("outletCount").textContent=state.outlets.filter(o=>o.enabled).length;
 $("newCount").textContent=state.unread_count;$("alertCount").textContent=state.keyword_alert_count;
 const last=state.outlets.map(o=>o.last_scan).filter(Boolean).sort().pop();$("lastCheck").textContent=last?date(last):"Not connected";
 $("snapshot").textContent="Feed updated: "+date(state.generated_at);
 $("outletForm").hidden=!state.admin;
 $("connectionStatus").textContent=state.collector_configured?"Collector credential configured. A collector check is still required to confirm connection.":"Collector credential has not been configured on the Worker yet.";
 const selected=$("outletFilter").value;$("outletFilter").replaceChildren(node("option","All outlets"));$("outletFilter").firstChild.value="";
 $("outlets").replaceChildren();
 for(const outlet of state.outlets){
  const option=node("option",outlet.name);option.value=outlet.id;$("outletFilter").append(option);
  const article=node("article",undefined,"outlet"),top=node("div",undefined,"outlet-top");
  const stale=!outlet.last_scan||Date.now()-Date.parse(outlet.last_scan)>45*60000;
  const status=!outlet.enabled?"PAUSED":!outlet.last_scan?"AWAITING COLLECTOR":stale?"STALE":outlet.truncated?"CRAWL LIMIT REACHED":outlet.failed_pages?"PAGES NEED RETRY":outlet.pending_pages?"CRAWL IN PROGRESS":outlet.scan_ok?"LAST CHECK SUCCEEDED":"LAST CHECK FAILED";
  top.append(node("h3",outlet.name),node("span",status,"pill"));
  article.append(top,node("code",outlet.url),node("p","Last attempt: "+date(outlet.last_scan)+" · Last completed scan: "+date(outlet.last_success)),node("p","Alert keywords: "+(outlet.keywords.join(", ")||"None")));
  article.append(node("p","Pages scanned: "+Number(outlet.pages_scanned||0)+" · Pending: "+Number(outlet.pending_pages||0)+" · Failed: "+Number(outlet.failed_pages||0)));
  if(outlet.truncated)article.append(node("p","A crawl limit was reached. Coverage is incomplete; inspect collector limits before treating the inventory as complete."));
  const actions=node("div",undefined,"actions");actions.append(copy(outlet.url,"COPY ONION URL"));
  if(state.admin){const edit=node("button","EDIT OUTLET","copy");edit.onclick=()=>editOutlet(outlet);actions.append(edit);}
  article.append(actions);$("outlets").append(article);
 }
 if(!state.outlets.length)$("outlets").append(empty("No outlets registered",state.admin?"Add the known listing URLs below. They will be stored behind CT Atlas authentication.":"Ask the administrator to register the monitored outlets."));
 $("outletFilter").value=selected;
 renderFeed();
}
async function refresh(){if(busy)return;busy=true;$("refresh").disabled=true;try{state=await api("/darkweb/feed");render();$("message").textContent="";}catch(error){$("message").textContent=error.message;}finally{busy=false;$("refresh").disabled=false;}}
for(const button of document.querySelectorAll("[data-view]"))button.onclick=()=>{view=button.dataset.view;for(const b of document.querySelectorAll("[data-view]")){b.classList.toggle("active",b===button);b.setAttribute("aria-pressed",String(b===button));}$("feedView").hidden=!["latest","alerts"].includes(view);$("outletsView").hidden=view!=="outlets";$("setupView").hidden=view!=="setup";if(state)renderFeed();};
for(const id of ["search","outletFilter","typeFilter"])$(id).addEventListener("input",()=>{if(state)renderFeed();});
$("refresh").onclick=refresh;
$("markSeen").onclick=async()=>{if(!state||busy)return;try{await api("/darkweb/seen",{through:state.generated_at});await refresh();}catch(error){$("message").textContent=error.message;}};
$("outletForm").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button[type=submit]");button.disabled=true;try{await api("/darkweb/outlet",{name:$("outletName").value,url:$("outletUrl").value,keywords:$("keywords").value,enabled:$("enabled").checked});event.target.reset();await refresh();}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};
(async()=>{if(!token()){location.replace("index.html");return;}try{const session=await api("/session-check");sessionStorage.setItem("ct_map_username",session.username);$("user").textContent=session.username.toUpperCase();$("workspace").hidden=false;await refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);}catch(error){$("workspace").hidden=false;$("message").textContent=error.message;}})();
})();
