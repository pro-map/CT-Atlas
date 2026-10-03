(function(){
"use strict";
const root=document.documentElement;
const facts=[
 {topic:"CT institutions · 2004",text:"The UN Security Council created the Counter-Terrorism Committee Executive Directorate (CTED) in 2004 through resolution 1535, to support the committee's work.",source:"UN Security Council",url:"https://www.un.org/securitycouncil/ctc/content/security-council-resolutions"},
 {topic:"Remembrance · Madrid",text:"Europe's 11 March remembrance day for victims of terrorism was established following the Madrid train bombings of 11 March 2004.",source:"Council of the European Union",url:"https://www.consilium.europa.eu/en/documents-publications/library/library-blog/posts/european-day-of-remembrance-of-the-victims-of-terrorism/"},
 {topic:"Investigations · 2001",text:"The FBI named its September 11 investigation PENTTBOM. The name refers to Pennsylvania, the Pentagon and the Twin Towers; investigators followed more than 500,000 leads.",source:"FBI · 9/11 Investigation",url:"https://www.fbi.gov/history/cases-and-criminals/911-investigation"},
 {topic:"Historical record · 1993",text:"The World Trade Center was attacked before September 11: the bombing on 26 February 1993 killed six people.",source:"FBI · World Trade Center Bombing 1993",url:"https://www.fbi.gov/history/cases-and-criminals/world-trade-center-bombing-1993"},
 {topic:"Historical record · 1995",text:"The Oklahoma City bombing on 19 April 1995 killed 168 people. The FBI describes it as the deadliest act of homegrown terrorism in US history.",source:"FBI · The Oklahoma City Bombing",url:"https://www.fbi.gov/news/stories/25-years-after-oklahoma-city-bombing-041520"}
];
let nextFact=Math.floor(Math.random()*facts.length),observer,navigationTimer;
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
 for(const id of ["hubUser","fiUser","socialUser"]){
  const label=document.getElementById(id);
  if(label && /VERIFYING SESSION/.test(label.textContent))return false;
 }
 const workspace=document.getElementById("workspace");
 if(document.body.dataset.ctTab==="darkweb" && workspace?.hidden)return false;
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
 if(url.origin!==location.origin||!/(?:^|\/)(?:main|index|crypto|darkweb|facial|social)\.html$/.test(url.pathname))return;
 if(url.pathname===location.pathname&&url.search===location.search)return;
 showLoading();
});
window.addEventListener("pageshow",event=>{if(event.persisted)ready();});
function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
const active=new Set();
function begin(anchor){
 // PDF assembly nested inside report generation reuses that report's card.
 if(!anchor&&active.size)return ()=>{};
 const token={};active.add(token);
 let card,finished=false;
 const trigger=document.activeElement;
 const timer=setTimeout(()=>{
  if(finished)return;
  card=element("aside",null,"ct-wait-card"+(anchor?"":" ct-wait-floating"));
  card.setAttribute("aria-label","Did you know? While your result is prepared");
  const heading=element("div","DID YOU KNOW?","ct-wait-heading");
  const topic=element("div",null,"ct-wait-topic");
  const text=element("p",null,"ct-wait-text");
  const footer=element("div",null,"ct-wait-footer");
  const source=element("a");source.target="_blank";source.rel="noopener noreferrer";
  const next=element("button","NEXT FACT →");next.type="button";
  const paint=()=>{const fact=facts[nextFact++ % facts.length];topic.textContent=fact.topic;text.textContent=fact.text;source.textContent="Source: "+fact.source+" ↗";source.href=fact.url;};
  next.onclick=paint;paint();footer.append(source,next);
  card.append(heading,topic,text,footer,element("div","Your result will appear as soon as it is ready.","ct-wait-note"));
  if(anchor?.isConnected)anchor.insertAdjacentElement("afterend",card);else{card.classList.add("ct-wait-floating");document.body.append(card);}
 },1200);
 return ()=>{
  finished=true;clearTimeout(timer);active.delete(token);
  if(card?.contains(document.activeElement)&&trigger?.isConnected){
   requestAnimationFrame(()=>{if(!trigger.disabled && document.activeElement===document.body)trigger.focus({preventScroll:true});});
  }
  card?.remove();
 };
}
window.CTAtlasUI={ready,begin};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
