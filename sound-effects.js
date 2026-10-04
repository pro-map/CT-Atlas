(function(){
"use strict";
const KEY="ct_atlas_sound_effects";
let enabled=true,context,master,voice=null,lastPlayed=-Infinity,generation=0,request=0,button;
try{enabled=localStorage.getItem(KEY)!=="off";}catch(_){}
function stop(){
 request++;
 if(master&&context){master.gain.cancelScheduledValues(context.currentTime);master.gain.setValueAtTime(0,context.currentTime);}
 if(voice){for(const source of voice.sources){try{source.stop();}catch(_){}source.disconnect();}voice.gain.disconnect();voice=null;}
}
function paint(){
 if(!button)return;
 button.textContent="Sound effects: "+(enabled?"On":"Off");
 button.setAttribute("aria-checked",String(enabled));
 button.title=enabled?"Turn off all interface sounds immediately":"Turn on quiet interface sounds";
}
function setEnabled(value,persist=true){
 enabled=Boolean(value);generation++;stop();lastPlayed=-Infinity;
 if(persist)try{localStorage.setItem(KEY,enabled?"on":"off");}catch(_){}
 paint();
}
async function play(kind="click"){
 if(!enabled||document.hidden||!["click","success","error"].includes(kind))return;
 // Do not queue feedback or stack voices during rapid actions.
 if(performance.now()-lastPlayed<120)return;
 const ticket=++request,epoch=generation;
 try{
  if(!context){
   const Audio=window.AudioContext||window.webkitAudioContext;
   if(!Audio)return;
   context=new Audio();master=context.createGain();master.gain.value=0;master.connect(context.destination);
  }
  if(context.state!=="running")await context.resume();
  if(!enabled||document.hidden||epoch!==generation||ticket!==request||context.state!=="running")return;
  if(performance.now()-lastPlayed<120)return;
  stop();lastPlayed=performance.now();
  const now=context.currentTime,duration=kind==="click"?.06:kind==="success"?.10:.085;
  const gain=context.createGain();gain.connect(master);master.gain.setValueAtTime(.075,now);
  gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.55,now+.003);
  gain.gain.exponentialRampToValueAtTime(.0001,now+duration-.005);gain.gain.linearRampToValueAtTime(0,now+duration);
  // A low, damped transient: no melodic sequence, radar beep or alarm.
  const body=context.createOscillator();body.type="sine";
  body.frequency.setValueAtTime(kind==="click"?190:kind==="success"?290:130,now);
  body.frequency.exponentialRampToValueAtTime(kind==="click"?95:kind==="success"?230:75,now+duration);
  body.connect(gain);
  const current={sources:[body],gain};voice=current;
  body.onended=()=>{body.disconnect();gain.disconnect();if(voice===current)voice=null;};
  body.start(now);body.stop(now+duration);
 }catch(_){stop();} // Unsupported/blocked audio must never affect an action.
}
function begin(){
 const epoch=generation,allowed=enabled;let finished=false;
 void play("click");
 return outcome=>{
  if(finished)return;finished=true;
  // Muting invalidates pending results, even if sound is enabled again later.
  if(allowed&&enabled&&epoch===generation)void play(outcome);
 };
}
function boot(){
 const host=document.querySelector("#sessionActions, .hub-actions, .fi-actions, .social-header-actions, .masthead .actions, header .actions, .crypto-header");
 if(!host)return;
 button=document.createElement("button");button.id="ctSoundEffects";button.type="button";
 button.className="ct-sound-toggle";button.setAttribute("role","switch");button.setAttribute("aria-label","Sound effects");
 button.addEventListener("click",()=>setEnabled(!enabled));paint();host.append(button);
}
// Only explicit module links and workspace view selectors; inputs, maps,
// scrolling, hover, background refreshes and arbitrary buttons stay silent.
document.addEventListener("click",event=>{
 if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const target=event.target instanceof Element?event.target:null;
 const control=target?.closest("[data-view], [data-ct-sound='tab']");
 if(control&&!control.disabled&&control.getAttribute("aria-pressed")!=="true"&&control.getAttribute("aria-selected")!=="true"&&!control.classList.contains("active")){void play();return;}
 if(target?.closest("#mainHubButton")){void play();return;}
 const link=target?.closest("a[href]");
 if(!link||link.hasAttribute("download")||(link.target&&link.target!=="_self"))return;
 const url=new URL(link.href,location.href);
 if(url.origin===location.origin&&/(?:^|\/)(?:main|index|crypto|facial|social|darkweb|ip)\.html$/.test(url.pathname)&&url.href!==location.href)void play();
},true);
window.addEventListener("storage",event=>{if(event.key===KEY||event.key===null)setEnabled(event.newValue!=="off",false);});
window.addEventListener("pagehide",stop);
window.addEventListener("pageshow",()=>{try{const value=localStorage.getItem(KEY)!=="off";if(value!==enabled)setEnabled(value,false);}catch(_){}});
document.addEventListener("visibilitychange",()=>{if(document.hidden)stop();});
window.CTAtlasSound={play,begin,setEnabled,get enabled(){return enabled;}};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
