(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
const $=id=>document.getElementById(id);
let state=null,view="latest",busy=false,enriching=false;
let archiveItems=new Map(),archiveCursor="",archiveEpoch=null,archiveExpanded=false,archivePage=1,archivePageCursors=[""];
let policyDirty=false,storageDirty=false,feedFingerprint="",outletOptions="",feedCount=0,searchTimer=null,lastSearchKey="",enrichTimer=null;
const previewCache=new Map(),openOriginals=new Set(),originalTexts=new Map();
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
// Search folding: no diacritics, Turkish dotted/dotless i as i, lowercase, single spaces.
const fold=value=>String(value||"").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu,"").replace(/ı/g,"i").replace(/\s+/g," ");
const declaredLanguage=item=>/^[a-z]{2,3}$/.test(item.source_language||"")?item.source_language:"";
// The collector's declared language; otherwise Arabic only for Arabic-script text; otherwise unknown (no lang).
function sourceLanguage(item){return declaredLanguage(item)||(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/.test([item.title,item.excerpt,item.original_text].join(" "))?"ar":"");}
function languageName(code){try{const name=new Intl.DisplayNames(["en"],{type:"language"}).of(code);if(name&&name.toLowerCase()!==code)return name;}catch(_){}return code.toUpperCase();}
const englishOriginal=item=>item.title_en_kind==="original"&&!!item.title_en;
// English text the outlet translated itself: no CT Atlas title translation, but never presented as an English original.
const OUTLET_TRANSLATION_NOTE="English version published by the outlet (its own, possibly automatic, translation; not verified by CT Atlas)";
const outletTranslation=item=>englishOriginal(item)&&item.source_translation==="outlet";
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
// Loaded source texts survive feed re-renders; a changed content hash loads again.
function originalText(item){
 const hash=item.content_hash||"",cached=originalTexts.get(item.id);if(cached?.hash===hash)return cached.promise;
 const entry={hash};entry.promise=getPublication(item).then(full=>{entry.text=full.original_text||"";return entry.text;});
 entry.promise.catch(()=>{if(originalTexts.get(item.id)===entry)originalTexts.delete(item.id);});originalTexts.set(item.id,entry);return entry.promise;
}
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
 const lang=sourceLanguage(item);
 const title=node("h1",item.title);title.dir="auto";if(lang)title.lang=lang;doc.body.append(title);
 const english=node("section",undefined,"english"),outletText=outletTranslation(item);
 // The outlet's own English version is labelled as such; an English original is shown once, as the title above.
 if(outletText)english.append(node("h2","English title · outlet translation"),node("p",OUTLET_TRANSLATION_NOTE+". The title above is that English version, not an English original; CT Atlas did not translate it."));
 else if(englishOriginal(item))english.append(node("h2","English title"),node("p","The original title above is in English and is not translated."));
 else english.append(node("h2","English title · machine translation"),node("p",item.title_en_kind==="translation"?item.title_en:"English translation pending"));
 english.append(node("h2","English overview · AI-generated"),node("p",item.overview_en||"English overview pending AI enrichment."));doc.body.append(english);
 const original=node("section");original.append(node("h2",(outletText?"Source text":"Original source text")+(lang?" · "+languageName(lang):"")+(outletText?" · outlet translation, not the original":"")));const body=node("p",item.original_text||item.excerpt||item.title);body.dir="auto";if(lang)body.lang=lang;original.append(body);doc.body.append(original);
 const source=node("section",undefined,"source");source.append(node("h2","Provenance"),...(outletText?[node("p","Text: "+OUTLET_TRANSLATION_NOTE+".")]:[]),node("p","Source: "+item.url),node("p","Publication date: "+item.published_at+" · Source date: "+(item.source_date||"")),node("p","Text status: "+(item.text_status||"excerpt")+" · First collected: "+date(item.first_seen)),node("p","Exported: "+new Date().toISOString()));
 for(const file of item.attachments||[])source.append(node("p",file.type.toUpperCase()+": "+file.title+"\n"+file.url+(file.sha256?"\nSHA-256: "+file.sha256:"")+"\n"+(file.stored_in_atlas?"PDF available in authenticated Atlas storage; original file is not embedded in this export.":file.acquired?"Downloaded on the collector computer; upload to Atlas pending or unavailable.":"Original file not acquired.")));
 source.append(node("p","Source claims are preserved for analysis and are not independently verified. The English overview describes supplied page text; it does not analyse the attached PDF, video or audio."));doc.body.append(source);
 return "<!doctype html>\n"+doc.documentElement.outerHTML;
}
function exportButton(item,format,outlet){const button=node("button","EXPORT "+format.toUpperCase(),"copy");button.onclick=async()=>{button.disabled=true;try{const full=await getPublication(item);downloadFile(format==="html"?exportDocument(full,outlet):JSON.stringify({outlet:outlet?.name,exported_at:new Date().toISOString(),...full,...(outletTranslation(full)?{source_translation_note:OUTLET_TRANSLATION_NOTE+". Here title_en_kind \"original\" means only that CT Atlas did not translate the title; the text is not an English original."}:{})},null,2),format==="html"?"text/html;charset=utf-8":"application/json;charset=utf-8","CT-Atlas-publication-"+item.published_at+"-"+item.id.slice(0,12)+"."+format);}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};return button;}
function renderFeed(){
 const outletId=$("outletFilter").value,type=$("typeFilter").value,query=fold($("search").value.trim());
 const outlets=new Map(state.outlets.map(o=>[o.id,o]));
 const sourceRows=view==="latest"?[...archiveItems.values()]:view==="legacy"?state.items.filter(i=>!i.publication_version):state.items;
 const rows=[...sourceRows].sort((a,b)=>(b.published_at||"").localeCompare(a.published_at||"")).filter(i=>(!outletId||i.outlet_id===outletId)&&(!type||i.type===type)&&(!query||fold([i.title,i.title_en,i.overview_en,i.excerpt,outlets.get(i.outlet_id)?.name,...(i.keyword_matches||[])].join(" ")).includes(query))&&(view!=="alerts"||unread(i)&&i.keyword_matches?.length));
 feedCount=rows.length;
 $("feedPagination").hidden=view!=="latest";
 $("prevPage").hidden=view!=="latest"||archivePage<=1;
 $("nextPage").hidden=view!=="latest"||!archiveCursor;
 $("pageStatus").textContent="Page "+archivePage;
 const status=view==="latest"?"Page "+archivePage+" · "+rows.length+" publication"+(rows.length===1?"":"s")+" shown · 50 publications maximum per page. Filters apply to this page.":view==="alerts"?"Unreviewed items matching outlet alert keywords, within the latest "+(state.retention_limit||500)+" feed items.":"Earlier generic collection results, within the latest "+(state.retention_limit||500)+" feed items.";
 if($("archiveStatus").textContent!==status)$("archiveStatus").textContent=status;
 // Unchanged data keeps the existing cards: open source texts, focus and scroll position stay.
 const fingerprint=JSON.stringify([view,state.seen_through,[...outlets.values()].map(o=>[o.id,o.name]),rows]);
 if(fingerprint===feedFingerprint&&$("feed").childNodes.length)return;
 feedFingerprint=fingerprint;
 const focused=$("feed").contains(document.activeElement)?document.activeElement:null,focusCard=focused?.closest("article")?.id||"";
 const focusIndex=focusCard?[...document.getElementById(focusCard).querySelectorAll("button,summary,a")].indexOf(focused):-1;
 previewObserver?.disconnect();
 previewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){loadPreview(entry.target);previewObserver.unobserve(entry.target);}});
 $("feed").replaceChildren();
 if(!rows.length){$("feed").append(empty(view==="alerts"?"No unreviewed keyword alerts":"No publications to display",view==="alerts"?"Unreviewed items that match an outlet's alert keywords appear here.":state.outlets.length?"Run the updated collector for a structured outlet or adjust your filters. Previous generic results remain in OTHER MATERIAL.":"Register an outlet in OUTLETS, then connect the Tor collector."));return;}
 for(const item of rows){
  const article=node("article",undefined,"item"),head=node("div",undefined,"item-head");
  head.append(node("span",outlets.get(item.outlet_id)?.name||"Outlet"),node("span",item.publication_version?categoryLabel(item.category):item.type,"pill"));
  const declared=declaredLanguage(item),lang=sourceLanguage(item),english=englishOriginal(item),outletText=outletTranslation(item);
  if(declared){const chip=node("span",declared.toUpperCase(),"pill lang");chip.title=(outletText?"Collected language: ":"Source language: ")+languageName(declared)+(outletText?" (outlet translation)":"");head.append(chip);}
  if(outletText){const chip=node("span","OUTLET TRANSLATION","pill outlet-translation");chip.title=OUTLET_TRANSLATION_NOTE;head.append(chip);}
  if(unread(item))head.append(node("span","UNREVIEWED","pill new"));
  if(item.baseline)head.append(node("span","BASELINE","pill"));
  if(item.keyword_matches?.length)head.append(node("span","KEYWORDS: "+item.keyword_matches.join(", "),"pill alert"));
  const foot=node("div",undefined,"item-foot");foot.append(node("span","First detected: "+date(item.first_seen)),copy(item.url,"COPY ONION URL"));
  if(!item.publication_version)foot.append(node("span",item.acquired?"Acquired on collector · "+(item.bytes===null?"size unavailable":(item.bytes/1048576).toFixed(1)+" MB"):"Link discovered · file not acquired"));
  article.id="item-"+item.id;
  const title=node("h3",item.publication_version?item.title:item.title_en||"English title pending AI enrichment");title.dir="auto";
  if(item.publication_version){if(lang)title.lang=lang;title.className="source-title";}
  const heading=node("div",undefined,"publication-heading"),titles=node("div",undefined,"publication-titles");titles.append(title);
  // An English original is its own English title: shown once, never as a translation.
  if(!english){const original=node("p",item.publication_version?(item.title_en_kind==="translation"?item.title_en:"English translation pending"):readableTitle(item.title),"original-title");original.dir=item.publication_version?"ltr":"auto";if(item.publication_version){original.lang="en";titles.append(node("span","ENGLISH · MACHINE TRANSLATION","translation-label"));}titles.append(original);}
  else if(outletText)titles.append(node("p",OUTLET_TRANSLATION_NOTE+".","translation-note"));
  heading.append(publicationVisual(item),titles);
  article.append(head,heading,node("p","Publication: "+(item.published_at||"Unknown")+" · Date evidence: "+(item.date_basis||"unknown")));
  if(item.publication_version){const overview=node("div",undefined,"english-overview");overview.append(node("strong","ENGLISH OVERVIEW · AI"),node("p",item.overview_en||(outletText?"Pending AI enrichment. The outlet's English text remains available.":"Pending AI enrichment. Original source text remains available.")));article.append(overview);}
  if(item.publication_version){
   const detail=node("details",undefined,"original-publication"),summary=node("summary",outletText?"READ OUTLET'S ENGLISH TEXT":"READ ORIGINAL TEXT"),body=node("p","Open to load source text","source-text");body.dir="auto";if(lang)body.lang=lang;detail.append(summary,body);
   const cached=originalTexts.get(item.id),ready=cached?.hash===(item.content_hash||"")&&cached.text!==undefined;if(ready)body.textContent=cached.text;
   const load=async()=>{try{body.textContent=await originalText(item);}catch(error){body.textContent=error.message;}};
   if(openOriginals.has(item.id)){detail.open=true;if(!ready)void load();}
   detail.ontoggle=()=>{if(!detail.open){openOriginals.delete(item.id);return;}openOriginals.add(item.id);void load();};article.append(detail);
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
 const restored=focusCard&&document.getElementById(focusCard);if(restored)(restored.querySelectorAll("button,summary,a")[focusIndex]||restored.querySelector("summary,button"))?.focus({preventScroll:true});
}
// Briefing sources open the card that holds them, whatever the current view or filters.
async function revealSource(id){
 const shown=()=>!$("feedView").hidden&&document.getElementById("item-"+id);
 try{
  if(!shown()){
   const card=state.items.find(i=>i.id===id);
   if(!archiveItems.has(id)&&!card){const{original_text,...record}=await getPublication({id});if(!record.publication_version)throw new Error("This source is no longer retained in the feed.");archiveItems.set(id,record);}
   else if(card?.publication_version&&!archiveItems.has(id))archiveItems.set(id,card);
   setView(archiveItems.has(id)?"latest":"legacy");
   if(!shown()){$("search").value="";$("outletFilter").value="";$("typeFilter").value="";renderFeed();}
  }
  const target=shown();if(!target)throw new Error("This source could not be displayed.");
  target.tabIndex=-1;target.classList.add("revealed");setTimeout(()=>target.classList.remove("revealed"),2500);
  target.scrollIntoView({behavior:"smooth",block:"start"});target.focus({preventScroll:true});
 }catch(error){$("message").textContent=error.message;}
}
function editOutlet(outlet){$("outletName").value=outlet.name;$("outletUrl").value=outlet.url;$("keywords").value=outlet.keywords.join(", ");$("enabled").checked=outlet.enabled;$("outletForm").scrollIntoView({behavior:"smooth"});}
function render(){
 $("storageForm").hidden=!state.admin;
 const storage=state.files_storage;
 if(storage){$("storageStatus").textContent=storage.configured?storage.files+" PDFs in Atlas · "+(storage.stored_bytes/1e9).toFixed(3)+" GB stored · "+(storage.reserved_bytes/1e9).toFixed(3)+" GB reserved for transfers · "+(storage.limit_bytes/1e9).toFixed(2)+" GB limit":"Private PDF storage is not activated yet. Downloaded PDFs remain on the collector computer.";
 if(!storageDirty&&!$("storageForm").contains(document.activeElement))$("storageLimit").value=storage.limit_bytes/1e9;}
 $("collectionForm").hidden=!state.admin;$("enrichNow").hidden=!state.admin;
 $("outletFilterWrap").hidden=!state.admin;
 $("markSeen").hidden=!state.admin;
 for(const button of document.querySelectorAll("[data-view]"))button.hidden=!state.admin&&button.dataset.view!=="latest";
 // Unsaved admin edits are never replaced by a background refresh.
 if(!policyDirty&&!$("collectionForm").contains(document.activeElement))fillPolicy();
 $("discardCollection").hidden=!policyDirty;
 $("pauseCollection").textContent=state.policy?.paused?"RESUME":"PAUSE";
 const today=new Date().toISOString().slice(0,10),through=state.policy?.through||"",recrawl=state.outlets.filter(o=>o.period_backfill).length;
 const periodNote=!through?"":through<today?" · PERIOD ENDED: publications dated after "+through+" are not stored. Extend Through and SAVE; the archive is kept.":Date.parse(through)-Date.parse(today)<=30*86400000?" · The period ends on "+through+". Extend Through and SAVE before then; the archive is kept.":"";
 $("collectionState").textContent=(state.policy?.paused?"PAUSED":"ACTIVE")+" · "+(state.policy?.from||"")+" → "+through+" · Undated items awaiting local review: "+state.outlets.reduce((n,o)=>n+Number(o.undated_count||0),0)+(recrawl?" · Re-crawling "+recrawl+" outlet(s) for the widened period":"")+periodNote;
 $("collectionState").classList.toggle("warning",!!periodNote);
 $("aiSummary").textContent=state.summary?.text||"No AI briefing yet. Dated publications are needed first.";
 $("aiSummary").title=state.summary?"Generated: "+date(state.summary.generated_at)+" · Based on up to 20 latest dated publications":"";
 $("aiSources").replaceChildren();
 for(const source of state.summary?.sources||[]){const link=node("a","["+source.number+"] "+readableTitle(source.title)+" · "+source.published_at);link.href="#item-"+source.id;link.dir="auto";link.onclick=event=>{event.preventDefault();void revealSource(source.id);};$("aiSources").append(link);}
 $("outletCount").textContent=state.outlets.filter(o=>o.enabled).length;
 $("newCount").textContent=state.unread_count;$("alertCount").textContent=state.keyword_alert_count;
 const last=state.outlets.map(o=>o.last_scan).filter(Boolean).sort().pop();$("lastCheck").textContent=last?date(last):"Not connected";
 $("snapshot").textContent="Feed updated: "+date(state.generated_at)+(through&&through<today?" · Collection period ended on "+through+"; newer publications are not collected":"");
 $("outletForm").hidden=!state.admin;
 $("connectionStatus").textContent=state.collector_configured?"Collector credential configured. A collector check is still required to confirm connection.":"Collector credential has not been configured on the Worker yet.";
 // Rebuild the outlet filter only when outlets change, so an open selector stays open.
 const options=JSON.stringify(state.outlets.map(o=>[o.id,o.name]));
 if(options!==outletOptions){outletOptions=options;const selected=$("outletFilter").value;$("outletFilter").replaceChildren(node("option","All outlets"));$("outletFilter").firstChild.value="";for(const outlet of state.outlets){const option=node("option",outlet.name);option.value=outlet.id;$("outletFilter").append(option);}$("outletFilter").value=selected;}
 $("outlets").replaceChildren();
 for(const outlet of state.outlets){
  const article=node("article",undefined,"outlet"),top=node("div",undefined,"outlet-top");
  const stale=!outlet.last_scan||Date.now()-Date.parse(outlet.last_scan)>45*60000;
  const status=!outlet.enabled?"PAUSED":!outlet.last_scan?"AWAITING COLLECTOR":stale?"STALE":outlet.truncated?"CRAWL LIMIT REACHED":outlet.failed_pages?"PAGES NEED RETRY":outlet.pending_pages?"CRAWL IN PROGRESS":outlet.scan_ok?"LAST CHECK SUCCEEDED":"LAST CHECK FAILED";
  top.append(node("h3",outlet.name),node("span",status,"pill"));
  article.append(top,node("code",outlet.url),node("p","Last attempt: "+date(outlet.last_scan)+" · Last completed scan: "+date(outlet.last_success)),node("p","Alert keywords: "+(outlet.keywords.join(", ")||"None")));
  article.append(node("p","Phase: "+(outlet.collection_phase||"backfill")+" · Pages scanned: "+Number(outlet.pages_scanned||0)+" · Pending: "+Number(outlet.pending_pages||0)+" · Failed: "+Number(outlet.failed_pages||0)));
  if(outlet.truncated)article.append(node("p","A crawl limit was reached. Coverage is incomplete; inspect collector limits before treating the inventory as complete."));
  if(outlet.period_backfill)article.append(node("p","Re-crawling for the widened collection period since "+date(outlet.period_backfill.requested_at)+". Existing records are kept; newly found publications are stored without alerts until the re-crawl completes."));
  if(outlet.last_out_of_period)article.append(node("p","Last upload: "+Number(outlet.last_out_of_period)+" item(s) refused because their date is outside the collection period or invalid."));
  const actions=node("div",undefined,"actions");actions.append(copy(outlet.url,"COPY ONION URL"));
  if(state.admin){const edit=node("button","EDIT OUTLET","copy");edit.onclick=()=>editOutlet(outlet);actions.append(edit);}
  article.append(actions);$("outlets").append(article);
 }
 if(!state.outlets.length)$("outlets").append(empty("No outlets registered",state.admin?"Add the known listing URLs below. They will be stored behind CT Atlas authentication.":"Ask the administrator to register the monitored outlets."));
 renderFeed();
}
// Admin search history: one record per settled search (text, outlet name, material, view and
// result count). Never the onion address, publication content, previews or files.
function searchSnapshot(){
 const text=$("search").value.replace(/\s+/g," ").trim().slice(0,200),outletId=$("outletFilter").value,material=$("typeFilter").value;
 if(!["latest","legacy","alerts"].includes(view)||(text.length<2&&!outletId&&!material))return null;
 const outlet=outletId?String((state?.outlets||[]).find(o=>o.id===outletId)?.name||"").slice(0,120):"";
 let oldest="";
 if(view==="latest"&&archiveExpanded)for(const item of archiveItems.values()){const day=String(item.published_at||"").slice(0,10);if(day&&(!oldest||day<oldest))oldest=day;}
 return {text,view,outlet,material,results:feedCount,...(oldest?{loaded_back_to:oldest}:{})};
}
function recordSearch(){
 clearTimeout(searchTimer);searchTimer=null;
 if(!["latest","legacy","alerts"].includes(view))return;
 const snapshot=state?searchSnapshot():null;
 if(!snapshot){lastSearchKey="";return;}
 const key=JSON.stringify([snapshot.text.toLowerCase(),snapshot.view,snapshot.outlet,snapshot.material]);
 const username=String(sessionStorage.getItem("ct_map_username")||"").trim().toLowerCase();
 if(key===lastSearchKey||!username||!token())return;
 lastSearchKey=key;
 fetch(API+"/usage-record",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json","X-Session-Token":token()},body:JSON.stringify({username,action:"darkweb_search",details:snapshot})}).catch(()=>{});
}
function scheduleSearchRecord(){clearTimeout(searchTimer);searchTimer=setTimeout(recordSearch,1500);}
function fillPolicy(){if(!state?.policy)return;$("collectFrom").value=state.policy.from;$("collectThrough").value=state.policy.through;$("collectPages").value=state.policy.pages_per_scan;$("collectPreviews").checked=state.policy.previews;}
function setView(name){
 if(state&&!state.admin&&name!=="latest")name="latest";
 view=name;for(const b of document.querySelectorAll("[data-view]")){const active=b.dataset.view===name;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));}
 $("feedView").hidden=!["latest","alerts","legacy"].includes(view);$("outletsView").hidden=view!=="outlets";$("setupView").hidden=view!=="setup";if(state)renderFeed();
}
async function refresh(skipEnrich=false){
 if(busy)return;busy=true;$("refresh").disabled=true;
 try{
  state=await api("/darkweb/feed");
  const epoch=state.policy?.epoch;
  if(archiveEpoch!==epoch){archiveItems.clear();archiveCursor="";archiveExpanded=false;archiveEpoch=epoch;archivePage=1;archivePageCursors=[""];}
  if(archivePage===1||!archiveItems.size){
   const archive=await api("/darkweb/archive");
   if(archiveEpoch!==archive.epoch){archiveEpoch=archive.epoch;archivePage=1;archivePageCursors=[""];}
   archiveItems=new Map(archive.items.map(item=>[item.id,item]));archiveCursor=archive.next_cursor;archiveExpanded=false;archivePage=1;archivePageCursors=[""];
  }
  render();$("message").textContent="";if(!skipEnrich&&state.admin)void enrich();
 }catch(error){$("message").textContent=error.message;}finally{busy=false;$("refresh").disabled=false;}
}
async function loadArchivePage(cursor,pageNumber){
 const result=await api("/darkweb/archive"+(cursor?"?cursor="+encodeURIComponent(cursor):""));
 if(result.epoch!==archiveEpoch){archivePage=1;archivePageCursors=[""];archiveItems.clear();await refresh(true);return;}
 archiveItems=new Map(result.items.map(item=>[item.id,item]));archiveCursor=result.next_cursor;archivePage=pageNumber;archiveExpanded=archivePage>1;feedFingerprint="";renderFeed();
 $("feedView").scrollIntoView?.({behavior:"smooth",block:"start"});
}
function readableTitle(value){let title=String(value||"");try{title=decodeURIComponent(title);}catch(_){}if(title.startsWith("/"))title=title.split("/").pop();return title.replace(/_/g," ");}
async function loadPreview(image){try{const id=image.dataset.itemId;let data=previewCache.get(id);if(!data){data=(await api("/darkweb/preview?id="+encodeURIComponent(id))).preview;if(data)previewCache.set(id,data);}if(/^data:image\/jpeg;base64,/.test(data||""))image.src=data;else image.alt="Preview unavailable";}catch(_){image.alt="Preview temporarily unavailable";}}
function enrichStatus(result){
 if(result.waiting)return result.reason==="daily_limit"?"Daily AI enrichment limit reached ("+result.daily_limit+" requests per Pacific day). Pending records continue tomorrow.":result.reason==="backoff"?"AI enrichment paused after an unsuccessful attempt. Next attempt allowed after "+date(result.retry_at)+".":"AI work is rate-limited. Try again in a minute.";
 if(result.cached)return "English titles, overviews and briefing are up to date.";
 if(result.enriched===undefined)return "No dated publications to enrich yet.";
 if(result.enriched||result.summary_updated)return "AI enrichment updated "+result.enriched+" record(s)"+(result.summary_updated?" and the briefing":"")+". Each request handles up to 10 pending publications.";
 return "The AI answer was not usable; the next attempt is delayed. Original texts remain available.";
}
// Enrichment starts on the first admin load. When stored untranslated records remain,
 // the admin page continues the bounded backfill one batch at a time without exposing
 // any collection or translation control to ordinary analysts.
function scheduleEnrich(result){
 if(enrichTimer){clearTimeout(enrichTimer);enrichTimer=null;}
 if(!state?.admin||result?.cached||result?.reason==="daily_limit")return;
 if(result?.waiting&&result.retry_at){
  const retry=Date.parse(result.retry_at);if(Number.isFinite(retry))enrichTimer=setTimeout(()=>{if(!document.hidden)void enrich();},Math.max(65000,retry-Date.now()+2000));return;
 }
 if((result?.pending||0)>0||(result?.enriched||0)>0)enrichTimer=setTimeout(()=>{if(!document.hidden)void enrich();},65000);
}
async function enrich(){if(enriching||!state?.admin||(!state.items.length&&!archiveItems.size))return;enriching=true;$("enrichNow").disabled=true;$("aiStatus").textContent="Translating stored source titles and preparing English overviews…";try{const result=await api("/darkweb/enrich",{});$("aiStatus").textContent=enrichStatus(result);if(result.enriched||result.summary_updated)await refresh(true);scheduleEnrich(result);}catch(error){$("aiStatus").textContent=error.message;}finally{enriching=false;$("enrichNow").disabled=false;}}
async function saveCollection(reset=false,pause=state.policy.paused,storedPeriod=false){
 const finishSound=window.CTAtlasSound?.begin();
 const source=storedPeriod?state.policy:{from:$("collectFrom").value,through:$("collectThrough").value,pages_per_scan:Number($("collectPages").value),previews:$("collectPreviews").checked};
 const body={from:source.from,through:source.through,pages_per_scan:source.pages_per_scan,previews:source.previews,paused:pause,reset};
 try{const result=await api("/darkweb/policy",body);finishSound?.("success");if(!storedPeriod)policyDirty=false;previewCache.clear();await refresh(true);if(result.recrawl)$("message").textContent="Period widened to "+body.from+" → "+body.through+". The archive is kept; outlets re-crawl for the newly covered dates.";}catch(error){finishSound?.("error");$("message").textContent=error.message;}
}
$("collectionForm").addEventListener("input",()=>{policyDirty=true;$("discardCollection").hidden=false;});
$("collectionForm").addEventListener("change",()=>{policyDirty=true;$("discardCollection").hidden=false;});
$("storageForm").addEventListener("input",()=>{storageDirty=true;});
$("discardCollection").onclick=()=>{policyDirty=false;fillPolicy();$("discardCollection").hidden=true;};
$("collectionForm").onsubmit=event=>{
 event.preventDefault();const from=$("collectFrom").value,through=$("collectThrough").value,prior=state.policy,today=new Date().toISOString().slice(0,10);
 if(from>prior.from||through<prior.through){$("message").textContent="Narrowing the period from "+prior.from+" → "+prior.through+" to "+from+" → "+through+" requires RESET, which deletes the archive. Widening the period keeps it.";return;}
 const recrawl=from<prior.from||(through>prior.through&&prior.through<today);
 if((from!==prior.from||through!==prior.through)&&!confirm("Widen the collection period from "+prior.from+" → "+prior.through+" to "+from+" → "+through+"?\n\nNothing is deleted: the archive already collected is kept."+(recrawl?" Outlets re-crawl their pages to collect the newly covered dates; publications found during that re-crawl are stored without alerts.":"")))return;
 void saveCollection();
};
$("storageForm").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button");button.disabled=true;const finishSound=window.CTAtlasSound?.begin();try{await api("/darkweb/storage-policy",{limit_bytes:Math.round(Number($("storageLimit").value)*1e9)});finishSound?.("success");storageDirty=false;await refresh(true);}catch(error){finishSound?.("error");$("message").textContent=error.message;}finally{button.disabled=false;}};
$("pauseCollection").onclick=()=>saveCollection(false,!state.policy.paused,true);
$("resetCollection").onclick=()=>{
 const from=$("collectFrom").value,through=$("collectThrough").value;
 if(!from||!through||from>through){$("message").textContent="Choose a valid From and Through period first.";return;}
 if(confirm("RESET DELETES THE ARCHIVE.\n\nEvery feed result, structured publication, English translation and overview, and the briefing collected so far will be deleted. Collection then restarts from scratch for "+from+" → "+through+".\n\nOutlet settings, local evidence files and stored PDFs are kept (stored PDFs still count towards the storage limit). To extend the period without deleting anything, use SAVE (KEEPS ARCHIVE) instead."))void saveCollection(true,false);
};
$("enrichNow").onclick=enrich;
for(const button of document.querySelectorAll("[data-view]"))button.onclick=()=>{setView(button.dataset.view);if(["latest","legacy","alerts"].includes(view))scheduleSearchRecord();};
$("nextPage").onclick=async()=>{if(!archiveCursor)return;const button=$("nextPage"),cursor=archiveCursor;button.disabled=true;archivePageCursors[archivePage]=cursor;try{await loadArchivePage(cursor,archivePage+1);}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};
$("prevPage").onclick=async()=>{if(archivePage<=1)return;const button=$("prevPage"),target=archivePage-1,cursor=archivePageCursors[target-1]||"";button.disabled=true;try{await loadArchivePage(cursor,target);}catch(error){$("message").textContent=error.message;}finally{button.disabled=false;}};
for(const id of ["search","outletFilter","typeFilter"])$(id).addEventListener("input",()=>{if(state)renderFeed();scheduleSearchRecord();});
$("search").addEventListener("keydown",event=>{if(event.key==="Enter")recordSearch();});
$("search").addEventListener("blur",()=>{if(searchTimer)recordSearch();});
globalThis.addEventListener?.("pagehide",()=>{if(searchTimer)recordSearch();});\ndocument.addEventListener?.("visibilitychange",()=>{if(!document.hidden&&state?.admin&&!enriching)void enrich();});
$("refresh").onclick=()=>refresh(true);
// Marking reviewed is per analyst but covers every outlet, view and filter; say so first.
$("markSeen").onclick=async()=>{
 if(!state||busy)return;const snapshot=state;
 if(!snapshot.unread_count){$("message").textContent="There are no unreviewed items to mark.";return;}
 if(!confirm("Mark ALL "+snapshot.unread_count+" unreviewed item(s) across all outlets as reviewed, including "+snapshot.keyword_alert_count+" keyword alert(s)?\n\nThis covers everything collected up to "+date(snapshot.generated_at)+", including items hidden by the current view or filters. It applies to your account only."))return;
 try{await api("/darkweb/seen",{through:snapshot.generated_at});await refresh(true);}catch(error){$("message").textContent=error.message;}
};
$("outletForm").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button[type=submit]");button.disabled=true;const finishSound=window.CTAtlasSound?.begin();try{await api("/darkweb/outlet",{name:$("outletName").value,url:$("outletUrl").value,keywords:$("keywords").value,enabled:$("enabled").checked});finishSound?.("success");event.target.reset();await refresh(true);}catch(error){finishSound?.("error");$("message").textContent=error.message;}finally{button.disabled=false;}};
(async()=>{if(!token()){location.replace("index.html");return;}try{const session=await api("/session-check");sessionStorage.setItem("ct_map_username",session.username);$("user").textContent=session.username.toUpperCase();$("workspace").hidden=false;await refresh();setInterval(()=>{if(!document.hidden)refresh(true);},60000);}catch(error){$("workspace").hidden=false;$("message").textContent=error.message;}})();
})();
