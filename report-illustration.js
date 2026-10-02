/* The picture at the top of a Report Generator or Deep Search report: the
   best photo among the articles the report cites, found by the Worker's
   /report-illustration from the report's illustration_candidates, with the
   cited article's headline as its title and the outlet as its credit.
   Shared by index.html (Report Generator) and deep-search.js; the PDF
   exports read the <img data-pdf-image> it leaves in the container. */
(function(){
"use strict";

const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
const pending=new WeakMap();

function esc(value){
  return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

function shortDate(value){
  const date=new Date(value||"");
  return Number.isNaN(date.getTime())?"":date.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
}

function credit(item){
  return ["Photo: "+(item.source||"cited article"),item.source_id?"cited as ["+item.source_id+"]":"",shortDate(item.date)]
    .filter(Boolean).join(" · ");
}

function figureHtml(apiBase,item){
  const caption=(item.title||"")+" — "+credit(item);
  return `<figure class="ct-report-illustration">
    <img src="${esc(apiBase+item.image_path)}" alt="${esc(item.photo_caption||item.title||"Photo from a cited article")}"
      title="${esc(item.photo_caption||"")}" crossorigin="anonymous" loading="eager"
      data-pdf-image data-pdf-caption="${esc(caption)}">
    <figcaption data-pdf-skip>
      <strong class="ct-report-illustration-title">${esc(item.title||"")}</strong>
      <span class="ct-report-illustration-credit">${esc(credit(item))}${item.article_url?` · <a href="${esc(item.article_url)}" target="_blank" rel="noopener noreferrer">open article</a>`:""}</span>
    </figcaption>
  </figure>`;
}

// Fills `container` with the report's picture; empties it when the report has
// no candidate, no usable picture, or the image does not load. Resolves to
// the illustration shown, or null. A later call on the same container wins.
function load(container,candidates,apiBase){
  if(!container)return Promise.resolve(null);
  const list=Array.isArray(candidates)?candidates.filter(item=>item&&item.url):[];
  container.innerHTML="";
  if(!list.length){pending.delete(container);return Promise.resolve(null);}
  container.innerHTML='<div class="ct-report-illustration-loading">Finding a photo from the cited articles…</div>';
  const promise=fetch(String(apiBase||"")+"/report-illustration",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-Session-Token":String(sessionStorage.getItem(TOKEN_KEY)||"")},
    body:JSON.stringify({user_id:String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase(),candidates:list})
  })
  .then(response=>response.ok?response.json():null)
  .then(payload=>{
    if(pending.get(container)!==promise)return null;
    const item=payload?.illustration;
    if(!item?.image_path){container.innerHTML="";return null;}
    container.innerHTML=figureHtml(String(apiBase||""),item);
    const image=container.querySelector("img");
    return new Promise(resolve=>{
      const done=ok=>{
        if(!ok&&pending.get(container)===promise)container.innerHTML="";
        resolve(ok?item:null);
      };
      if(image.complete&&image.naturalWidth)done(true);
      else{image.addEventListener("load",()=>done(true),{once:true});image.addEventListener("error",()=>done(false),{once:true});}
    });
  })
  .catch(()=>{if(pending.get(container)===promise)container.innerHTML="";return null;});
  pending.set(container,promise);
  return promise;
}

// For the PDF exports: waits (at most `timeoutMs`) for a picture still loading.
function ready(container,timeoutMs=8000){
  const promise=container&&pending.get(container);
  if(!promise)return Promise.resolve(null);
  return Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve(null),timeoutMs))]);
}

const style=document.createElement("style");
style.textContent=`
.ct-report-illustration{margin:0 0 14px;border:1px solid rgba(127,160,180,.35);background:rgba(0,0,0,.25)}
.ct-report-illustration img{display:block;width:100%;max-height:340px;object-fit:cover}
.ct-report-illustration figcaption{padding:8px 10px 9px;font-size:10px;line-height:1.45;opacity:.95}
.ct-report-illustration-title{display:block;margin-bottom:3px;font-size:11px}
.ct-report-illustration-credit{display:block;font-size:9px;opacity:.75}
.ct-report-illustration-credit a{color:inherit}
.ct-report-illustration-loading{margin:0 0 12px;padding:9px 10px;border:1px dashed rgba(127,160,180,.35);font-size:9px;opacity:.7}
@media(max-width:640px){.ct-report-illustration img{max-height:220px}}`;
document.head.appendChild(style);

window.CTAtlasIllustration={load,ready};
})();
