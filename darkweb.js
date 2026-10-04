(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
const $=id=>document.getElementById(id);
let state=null,view="latest",busy=false,enriching=false;
let archiveItems=new Map(),archiveCursor="",archiveEpoch=null,archiveExpanded=false;
const previewCache=new Map();
let previewObserver;
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
const categoryLabel=value=>({news:"NEWS / COMMUNIQUÉ",naba:"MAGAZINE",videos:"VIDEO PUBLICATION",audios:"AUDIO STATEMENT"}[value]||"PUBLICATION");
function publicationVisual(item){
 const frame=node("div",undefined,"publication-visual"),placeholder=node("div",undefined,"preview-placeholder");
 const label=({pdf:"PDF",video:"VIDEO",audio:"AUDIO",image:"IMAGE",page:"NEWS"}[item.type]||"FILE");
 placeholder.setAttribute("role","img");placeholder.setAttribute("aria-label",label+" document icon; source preview unavailable");placeholder.title=item.preview_status||"Source preview pending or unavailable";
 const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 32 32");svg.setAttribute("aria-hidden","true");
 const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",item.type==="video"?"M7 6h18v20H7z M13 11l8 5-8 5z":item.type==="audio"?"M13 23V8l13-3v15 M13 8l13-3 M13 23c0 4-8 4-8 0s8-4 8 0 M26 20c0 4-8 4-8 0s8-4 8 0":"M8 3h11l6 6v20H8z M19 3v7h6 M12 16h9 M12 21h9");svg.append(path);placeholder.append(svg,node("span",label));frame.append(placeholder);
 if(item.has_preview){const image=node("img",undefined,"publication-preview");image.alt="Source publication preview";image.dataset.itemId=item.id;image.loading="lazy";image.onload=()=>{image.classList.add("loaded");placeholder.hidden=true;};image.onerror=()=>{image.classList.remove("loaded");placeholder.hidden=false;};frame.append(image);previewObserver.observe(image);}
 return frame;
}
async function getPublication(item){return (await api("/darkweb/item?id="+encodeURIComponent(item.id))).item;}
function downloadFile(content,mime,name){const url=URL.createObjectURL(new Blob([content],{type:mime}));const link=node("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function pdfButton(item,file,open=false){
 const button=node("button",open?"OPEN PDF":"DOWNLOAD PDF","copy");button.type="button";
 button.onclick=async()=>{let tab;button.disabled=true;try{
  if(open){tab=window.open("about:blank","_blank");if(!tab)throw new Error("Allow a new tab, or use DOWNLOAD PDF.");tab.opener=null;tab.document.title="CT Atlas PDF";tab.document.body.textContent="Loading PDF…";}
  const response=await fetch(API+"/darkweb/file?id="+encodeURIComponent(item.id)+"&sha256="+encodeURIComponent(file.sha256),{cache:"no-store",headers:{"X-Session-Token":token()}});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||"PDF unavailable. Please sign in again if your session expired.");}
  const blob=await response.blob();
  if(open){const url=URL.createObjectURL(blob);tab.location.replace(url);setTimeout(()=>URL.revokeObjectURL(url),300000);}
  else{let name=String(file.title||item.title||"CT-Atlas-document").replace(/[\\/:*?"<>|\u0000-\u001f]/g,"_").slice(0,180);if(!/\.pdf$/i.test(name))name+=".pdf";downloadFile(blob,"application/pdf",name);}
 }catch(error){if(tab)tab.close();$("message").textContent=error.message;}finally{button.disabled=false;}};
 return button;
}
function exportDocument(item,outlet){
 const doc=document.implementation.createHTMLDocument("CT Atlas — publication record");
 const meta=doc.createElement("meta");meta.setAttribute("charset","utf-8");doc.head.prepend(meta);
 const csp=doc.createElement("meta");csp.httpEquiv="Content-Security-Policy";csp.content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";doc.head.append(csp);
 const style=doc.createElement("style");style.textContent="body{max-width:900px;margin:45px auto;padding:0 24px;color:#18242f;font:16px/1.8 Arial,sans-serif}h1{font-size:23px}h2{font-size:14px;text-transform:uppercase;color:#456}p{white-space:pre-wrap;overflow-wrap:anywhere}.source{font-size:12px}.english{padding:18px;background:#eef3f5;border-left:3px solid #527987}header{border-bottom:2px solid #243d50;margin-bottom:24px}section{margin:28px 0}@media print{body{margin:0}section{break-inside:auto}}";doc.head.append(style);
 const header=node("header");header.append(node("strong","CT ATLAS · SOURCE PUBLICATION"),node("p",(outlet?.name||"Outlet")+" · "+item.published_at));doc.body.append(header);
 const title=node("h1",item.title);title.dir="auto";doc.body.append(title);
 const english=node("section",undefined,"english");english.append(node("h2","English title · machine translation"),node("p",item.title_en_kind==="translation"?item.title_en:"English translation pending"),node("h2","English overview · AI-generated"),node("p",item.overview_en||"English overview pending AI enrichment."));doc.body.append(english);
 const original=node("section");original.append(node("h2","Original source text · Arabic"));const body=node("p",item.original_text||item.excerpt||item.title);body.dir="auto";body.lang="ar";original.append(body);doc.body.append(original);
 const source=node("section",undefined,"source");source.append(node("h2","Provenance"),node("p","Source: "+item.url),node("p","Publication date: "+item.published_at+" · Source date: "+(item.source_date||"")),node("p","Text status: "+(item.text_status||"excerpt")+" · First collected: "+date(item.first_seen)),node("p","Exported: "+new Date().toISOString()));
 for(const file of item.attachments||[])source.append(node("p",file.type.toUpperCase()+": "+file.title+"\n"+file.url+(file.sha256?"\nSHA-256: "+file.sha256:"")+"\n"+(file.stored_in_atlas?"PDF available in authenticated Atlas storage; original file is not embedded in this export.":file.acquired?"Downloaded on the collector computer; upload to Atlas pending or unavailable.":"Original file not acquired.")));
 source.append(node("p","Source claims are preserved for analysis and are not independently verified. The English overview describes supplied page text; it does not analyse the attached PDF, video or audio."));doc.body.append(source);
 return "<!doctype html>\n"+doc.documentElement.outerHTML;
}
function exportButton(item,format,outlet){const button=node("button","EXPORT "+format.toUpperCase(),"copy");button.onclick=async()=>{button.disabled=true;try{const full=await getPublication(item);downloadFile(format==="html"?exportDocument(full,outlet):JSON.stringify({outlet:outlet?.name,exported_at:new Date().toISOString(),...full},null,2),format==="html"?"text/html;charset=utf-8":"application/json;charset=utf-8","CT-Atlas-publication-"+item.published_at+"-"+item.id.slice(0,12)+"."+format);}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};return button;}
function renderFeed(){
 const outletId=$("outletFilter").value,type=$("typeFilter").value,query=$("search").value.trim().toLowerCase();
 const outlets=new Map(state.outlets.map(o=>[o.id,o]));
 const sourceRows=view==="latest"?[...archiveItems.values()]:view==="legacy"?state.items.filter(i=>!i.publication_version):state.items;
 const rows=[...sourceRows].sort((a,b)=>(b.published_at||"").localeCompare(a.published_at||"")).filter(i=>(!outletId||i.outlet_id===outletId)&&(!type||i.type===type)&&(!query||[i.title,i.title_en,i.overview_en,i.excerpt,outlets.get(i.outlet_id)?.name,...(i.keyword_matches||[])].join(" ").toLowerCase().includes(query))&&(view!=="alerts"||unread(i)));
 $("loadMore").hidden=view!=="latest"||!archiveCursor;
 $("archiveStatus").textContent=view==="latest"?archiveItems.size+" publications loaded · Filters apply to loaded publications. Load older records to extend the search.":"Latest retained material from other collection profiles.";
 previewObserver?.disconnect();
 previewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){loadPreview(entry.target);previewObserver.unobserve(entry.target);}});
 $("feed").replaceChildren();
 if(!rows.length){$("feed").append(empty(view==="alerts"?"No unreviewed material":"No publications to display",state.outlets.length?"Run the updated collector for a structured outlet or adjust your filters. Previous generic results remain in OTHER MATERIAL.":"Register an outlet in OUTLETS, then connect the Tor collector."));return;}
 for(const item of rows){
  const article=node("article",undefined,"item"),head=node("div",undefined,"item-head");
  head.append(node("span",outlets.get(item.outlet_id)?.name||"Outlet"),node("span",item.publication_version?categoryLabel(item.category):item.type,"pill"));
  if(unread(item))head.append(node("span","UNREVIEWED","pill new"));
  if(item.baseline)head.append(node("span","BASELINE","pill"));
  if(item.keyword_matches?.length)head.append(node("span","KEYWORDS: "+item.keyword_matches.join(", "),"pill alert"));
  const foot=node("div",undefined,"item-foot");foot.append(node("span","First detected: "+date(item.first_seen)),copy(item.url,"COPY ONION URL"));
  if(!item.publication_version)foot.append(node("span",item.acquired?"Acquired on collector · "+(item.bytes===null?"size unavailable":(item.bytes/1048576).toFixed(1)+" MB"):"Link discovered · file not acquired"));
  article.id="item-"+item.id;
  const title=node("h3",item.publication_version?item.title:item.title_en||"English title pending AI enrichment");title.dir="auto";
  if(item.publication_version){title.lang="ar";title.className="arabic-title";}
  const original=node("p",item.publication_version?(item.title_en_kind==="translation"?item.title_en:"English translation pending"):readableTitle(item.title),"original-title");original.dir=item.publication_version?"ltr":"auto";if(item.publication_version)original.lang="en";
  const heading=node("div",undefined,"publication-heading"),titles=node("div",undefined,"publication-titles");titles.append(title);if(item.publication_version)titles.append(node("span","ENGLISH · MACHINE TRANSLATION","translation-label"));titles.append(original);heading.append(publicationVisual(item),titles);
  article.append(head,heading,node("p","Publication: "+(item.published_at||"Unknown")+" · Date evidence: "+(item.date_basis||"unknown")));
  if(item.publication_version){const overview=node("div",undefined,"english-overview");overview.append(node("strong","ENGLISH OVERVIEW · AI"),node("p",item.overview_en||"Pending AI enrichment. Original source text remains available."));article.append(overview);}
  if(item.publication_version){
   const detail=node("details",undefined,"original-publication"),summary=node("summary","READ ORIGINAL ARABIC TEXT"),body=node("p","Open to load source text","source-text");body.dir="auto";body.lang="ar";detail.append(summary,body);let loaded=false;
   detail.ontoggle=async()=>{if(!detail.open||loaded)return;try{const full=await getPublication(item);body.textContent=full.original_text;loaded=true;}catch(error){body.textContent=error.message;}};article.append(detail);
   if(item.text_status!=="complete")article.append(node("p",item.text_status==="truncated"?"Source text exceeds the collection limit; this record is incomplete.":"Listing captured · full publication page pending.","record-status"));
   if(item.attachments_truncated)article.append(node("p","Some attachments exceed the per-publication limit.","record-status"));
   for(const file of item.attachments||[]){const attachment=node("div",undefined,"attachment");attachment.append(node("strong",file.type.toUpperCase()+" · "+file.title),node("p",file.stored_in_atlas?"Available in Atlas · "+(file.bytes/1048576).toFixed(1)+" MB":file.acquired?"Downloaded on collector · Atlas upload pending or unavailable · "+(file.bytes/1048576).toFixed(1)+" MB":"File identified · download pending or unavailable"),copy(file.url,"COPY FILE URL"));if(file.type==="pdf"&&file.stored_in_atlas)attachment.append(pdfButton(item,file,true),pdfButton(item,file));if(file.sha256)attachment.append(node("code",file.sha256));article.append(attachment);}
   foot.append(exportButton(item,"html",outlets.get(item.outlet_id)),exportButton(item,"json",outlets.get(item.outlet_id)));
  }else if(item.excerpt){const excerpt=node("p",item.excerpt,"excerpt");excerpt.dir="auto";article.append(excerpt);}
  article.append(foot);
  if(item.source_page)article.append(copy(item.source_page,"COPY SOURCE PAGE"));
  if(item.sha256)article.append(node("p","Content SHA-256: "+item.sha256,"hash"));
  $("feed").append(article);
 }
}
function editOutlet(outlet){$("outletName").value=outlet.name;$("outletUrl").value=outlet.url;$("keywords").value=outlet.keywords.join(", ");$("enabled").checked=outlet.enabled;$("outletForm").scrollIntoView({behavior:"smooth"});}
function render(){
 $("storageForm").hidden=!state.admin;
 const storage=state.files_storage;
 if(storage){$("storageStatus").textContent=storage.configured?storage.files+" PDFs in Atlas · "+(storage.stored_bytes/1e9).toFixed(3)+" GB stored · "+(storage.reserved_bytes/1e9).toFixed(3)+" GB reserved for transfers · "+(storage.limit_bytes/1e9).toFixed(2)+" GB limit":"Private PDF storage is not activated yet. Downloaded PDFs remain on the collector computer.";
 if(!$("storageForm").contains(document.activeElement))$("storageLimit").value=storage.limit_bytes/1e9;}
 $("collectionForm").hidden=!state.admin;$("enrichNow").hidden=!state.admin;
 if(state.policy&&!$("collectionForm").contains(document.activeElement)){
  $("collectFrom").value=state.policy.from;$("collectThrough").value=state.policy.through;$("collectPages").value=state.policy.pages_per_scan;$("collectPreviews").checked=state.policy.previews;
 }
 $("pauseCollection").textContent=state.policy?.paused?"RESUME":"PAUSE";
 $("collectionState").textContent=(state.policy?.paused?"PAUSED":"ACTIVE")+" · "+(state.policy?.from||"")+" → "+(state.policy?.through||"")+" · Undated items awaiting local review: "+state.outlets.reduce((n,o)=>n+Number(o.undated_count||0),0);
 $("aiSummary").textContent=state.summary?.text||"No AI briefing yet. Dated publications are needed first.";
 $("aiSummary").title=state.summary?"Generated: "+date(state.summary.generated_at)+" · Based on up to 20 latest dated publications":"";
 $("aiSources").replaceChildren();
 for(const source of state.summary?.sources||[]){const link=node("a","["+source.number+"] "+readableTitle(source.title)+" · "+source.published_at);link.href="#item-"+source.id;link.dir="auto";$("aiSources").append(link);}
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
  article.append(node("p","Phase: "+(outlet.collection_phase||"backfill")+" · Pages scanned: "+Number(outlet.pages_scanned||0)+" · Pending: "+Number(outlet.pending_pages||0)+" · Failed: "+Number(outlet.failed_pages||0)));
  if(outlet.truncated)article.append(node("p","A crawl limit was reached. Coverage is incomplete; inspect collector limits before treating the inventory as complete."));
  const actions=node("div",undefined,"actions");actions.append(copy(outlet.url,"COPY ONION URL"));
  if(state.admin){const edit=node("button","EDIT OUTLET","copy");edit.onclick=()=>editOutlet(outlet);actions.append(edit);}
  article.append(actions);$("outlets").append(article);
 }
 if(!state.outlets.length)$("outlets").append(empty("No outlets registered",state.admin?"Add the known listing URLs below. They will be stored behind CT Atlas authentication.":"Ask the administrator to register the monitored outlets."));
 $("outletFilter").value=selected;
 renderFeed();
}
async function refresh(skipEnrich=false){if(busy)return;busy=true;$("refresh").disabled=true;try{const [feed,archive]=await Promise.all([api("/darkweb/feed"),api("/darkweb/archive")]);state=feed;if(archiveEpoch!==archive.epoch){archiveItems.clear();archiveExpanded=false;archiveEpoch=archive.epoch;}for(const item of archive.items)archiveItems.set(item.id,item);if(!archiveExpanded)archiveCursor=archive.next_cursor;render();$("message").textContent="";if(!skipEnrich&&state.admin)void enrich();}catch(error){$("message").textContent=error.message;}finally{busy=false;$("refresh").disabled=false;}}
function readableTitle(value){let title=String(value||"");try{title=decodeURIComponent(title);}catch(_){}if(title.startsWith("/"))title=title.split("/").pop();return title.replace(/_/g," ");}
async function loadPreview(image){try{const id=image.dataset.itemId;let data=previewCache.get(id);if(!data){data=(await api("/darkweb/preview?id="+encodeURIComponent(id))).preview;if(data)previewCache.set(id,data);}if(/^data:image\/jpeg;base64,/.test(data||""))image.src=data;else image.alt="Preview unavailable";}catch(_){image.alt="Preview temporarily unavailable";}}
async function enrich(){if(enriching||!state?.admin||!state.items.length)return;enriching=true;$("enrichNow").disabled=true;$("aiStatus").textContent="Translating Arabic titles and preparing English overviews…";try{const result=await api("/darkweb/enrich",{});$("aiStatus").textContent=result.waiting?"AI work is rate-limited; the next refresh will retry.":"AI enrichment updated. Each batch handles up to 10 pending publications.";if(!result.waiting)await refresh(true);}catch(error){$("aiStatus").textContent=error.message;}finally{enriching=false;$("enrichNow").disabled=false;}}
async function saveCollection(reset=false,pause=state.policy.paused){
 const finishSound=window.CTAtlasSound?.begin();
 const body={from:$("collectFrom").value,through:$("collectThrough").value,pages_per_scan:Number($("collectPages").value),previews:$("collectPreviews").checked,paused:pause,reset};
 try{await api("/darkweb/policy",body);finishSound?.("success");previewCache.clear();await refresh();}catch(error){finishSound?.("error");$("message").textContent=error.message;}
}
$("collectionForm").onsubmit=event=>{event.preventDefault();void saveCollection();};
$("storageForm").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button");button.disabled=true;const finishSound=window.CTAtlasSound?.begin();try{await api("/darkweb/storage-policy",{limit_bytes:Math.round(Number($("storageLimit").value)*1e9)});finishSound?.("success");await refresh(true);}catch(error){finishSound?.("error");$("message").textContent=error.message;}finally{button.disabled=false;}};
$("pauseCollection").onclick=()=>saveCollection(false,!state.policy.paused);
$("resetCollection").onclick=()=>{if(confirm("Delete current feed results and restart collection for the selected period? Outlet settings, local evidence files and stored PDFs will be kept. Stored PDFs still count towards the storage limit."))void saveCollection(true,false);};
$("enrichNow").onclick=enrich;
for(const button of document.querySelectorAll("[data-view]"))button.onclick=()=>{view=button.dataset.view;for(const b of document.querySelectorAll("[data-view]")){b.classList.toggle("active",b===button);b.setAttribute("aria-pressed",String(b===button));}$("feedView").hidden=!["latest","alerts","legacy"].includes(view);$("outletsView").hidden=view!=="outlets";$("setupView").hidden=view!=="setup";if(state)renderFeed();};
$("loadMore").onclick=async()=>{const button=$("loadMore");button.disabled=true;try{const result=await api("/darkweb/archive?cursor="+encodeURIComponent(archiveCursor));if(result.epoch!==archiveEpoch){await refresh();return;}for(const item of result.items)archiveItems.set(item.id,item);archiveCursor=result.next_cursor;archiveExpanded=true;renderFeed();}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};
for(const id of ["search","outletFilter","typeFilter"])$(id).addEventListener("input",()=>{if(state)renderFeed();});
$("refresh").onclick=()=>refresh();
$("markSeen").onclick=async()=>{if(!state||busy)return;try{await api("/darkweb/seen",{through:state.generated_at});await refresh();}catch(error){$("message").textContent=error.message;}};
$("outletForm").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button[type=submit]");button.disabled=true;const finishSound=window.CTAtlasSound?.begin();try{await api("/darkweb/outlet",{name:$("outletName").value,url:$("outletUrl").value,keywords:$("keywords").value,enabled:$("enabled").checked});finishSound?.("success");event.target.reset();await refresh();}catch(error){finishSound?.("error");$("message").textContent=error.message;}finally{button.disabled=false;}};
(async()=>{if(!token()){location.replace("index.html");return;}try{const session=await api("/session-check");sessionStorage.setItem("ct_map_username",session.username);$("user").textContent=session.username.toUpperCase();$("workspace").hidden=false;await refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);}catch(error){$("workspace").hidden=false;$("message").textContent=error.message;}})();
})();
