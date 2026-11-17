(function(){
"use strict";
const root=document.documentElement;
let observer,navigationTimer;
function ready(){
 root.classList.remove("ct-loading");
 clearTimeout(window.ctLoadingFallback);clearTimeout(navigationTimer);
 observer?.disconnect();
}
function showLoading(){
 root.classList.add("ct-loading");
 clearTimeout(navigationTimer);
 navigationTimer=setTimeout(ready,10000); // A cancelled/failed navigation must not trap the page.
}
function isReady(){
 const label=document.getElementById("hubUser");
 if(label && /VERIFYING SESSION/.test(label.textContent))return false;
 if(document.getElementById("access-screen")){
  try{if(sessionStorage.getItem("ct_map_session_token") && document.body.classList.contains("locked"))return false;}catch(_){}
 }
 return true;
}
function boot(){
 const check=()=>{if(isReady())requestAnimationFrame(()=>requestAnimationFrame(ready));};
 observer=new MutationObserver(check);
 observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["hidden","class","style"]});
 check();
 // This timeout also disconnects the readiness observer on a failed initialization.
 setTimeout(ready,10000);
}
document.addEventListener("click",event=>{
 if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const target=event.target instanceof Element?event.target:null;
 if(target?.closest("#mainHubButton")){showLoading();return;}
 const link=target?.closest("a[href]");
 if(!link||link.hasAttribute("download")||(link.target&&link.target!=="_self"))return;
 const url=new URL(link.href,location.href);
 if(url.origin!==location.origin||!/(?:^|\/)(?:main|index|crypto)\.html$/.test(url.pathname))return;
 if(url.pathname===location.pathname&&url.search===location.search)return;
 showLoading();
});
window.addEventListener("pageshow",event=>{if(event.persisted)ready();});
function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
const active=new Set();
function begin(anchor){
 // PDF assembly nested inside report generation reuses that report's indicator.
 if(!anchor&&active.size)return ()=>{};
 const token={};active.add(token);
 const started=Date.now();
 let card,ticker,finished=false;
 const timer=setTimeout(()=>{
  if(finished)return;
  card=element("aside",null,"ct-wait-card"+(anchor?"":" ct-wait-floating"));
  card.setAttribute("role","status");
  const spinner=element("span",null,"ct-wait-spinner");spinner.setAttribute("aria-hidden","true");
  const body=element("div",null,"ct-wait-body");
  const elapsed=element("span",null,"ct-wait-elapsed");elapsed.setAttribute("aria-hidden","true");
  const tick=()=>{elapsed.textContent=Math.max(1,Math.round((Date.now()-started)/1000))+" s";};
  const note=element("div","Your result will appear as soon as it is ready · ","ct-wait-note");note.append(elapsed);
  body.append(element("div","PREPARING YOUR RESULT","ct-wait-heading"),note);
  card.append(spinner,body);tick();ticker=setInterval(tick,1000);
  if(anchor?.isConnected)anchor.insertAdjacentElement("afterend",card);else{card.classList.add("ct-wait-floating");document.body.append(card);}
 },1200);
 return ()=>{
  finished=true;clearTimeout(timer);clearInterval(ticker);active.delete(token);
  card?.remove();
 };
}
window.CTAtlasUI={ready,begin};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
