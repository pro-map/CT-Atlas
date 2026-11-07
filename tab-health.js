(function(){
"use strict";

// "Health status" button + panel of the Crypto tab. Data comes from the Worker's
// /health/status, which really reaches each dependency (see
// cloudflare-worker/health-status.js). The tab passes its scope with
// <script src="tab-health.js" data-health-scope="crypto">.

const API="https://ct-report-generator.fairpeace.workers.dev";
const REFRESH_MS=60000;
// The Worker's probes run in parallel and stop themselves; this only ends a hung request.
const FETCH_TIMEOUT_MS=45000;
const script=document.currentScript;
const scope=String((script&&script.dataset.healthScope)||"").toLowerCase();

const LABELS={
  operational:"Operational",degraded:"Degraded",down:"Unavailable",
  not_configured:"Not configured",configured:"Configured · not probed",unknown:"Checking…"
};
// How bad each state is for the tab's overall verdict (-1 = no data yet).
const RANK={operational:0,configured:0,unknown:-1,not_configured:1,degraded:1,down:2};
const OVERALL={0:["operational","All systems operational"],1:["degraded","Degraded"],2:["down","Outage"]};

// Verdict: a section flagged outageIfAllDown whose rows are all down means "Outage"
// (the tab cannot do its main job). Any other row that is down / degraded / not
// configured, or a monitor run that failed or is overdue, means "Degraded".
const SCOPES={
  crypto:{
    title:"CRYPTO INTELLIGENCE",
    sections:[
      {title:"ON-CHAIN DATA PROVIDERS",outageIfAllDown:true,rows:[
        {key:"bitcoin",label:"Bitcoin · Blockstream"},
        {key:"evm",label:"EVM chains · Etherscan V2"},
        {key:"tron",label:"TRON · TronGrid"}
      ]},
      {title:"SCREENING",rows:[{key:"sanctions",label:"Sanctions list · OFAC SDN"}]}
    ],
    facts:(versions,data)=>[
      ["Analysis backend",versions.crypto],
      ["Sanctions screening",versions.sanctions],
      ["Automatic monitoring","Every 6 hours"+(versions.crypto_monitor?" · "+versions.crypto_monitor:"")],
      ["Last monitor run",data.monitor_run&&data.monitor_run.summary]
    ]
  }
};

let state={phase:"idle",data:null,error:"",checkedAt:0};
let timer=null;
let button=null;
let panel=null;

const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

function componentOf(row,components){return components[row.key]||{status:"unknown"};}

function detailFor(key,component){
  const parts=[];
  if(component.block_height)parts.push("Block "+Number(component.block_height).toLocaleString("en-GB"));
  if(key==="sanctions"&&component.address_count){
    parts.push(Number(component.address_count).toLocaleString("en-GB")+" addresses"+(component.published?" · published "+component.published:""));
  }
  if(typeof component.latency_ms==="number"&&component.status!=="not_configured"&&component.status!=="configured"){
    parts.push(component.latency_ms+" ms");
  }
  if(component.error)parts.push(component.error);
  return parts.join(" · ");
}

function rowHtml(label,component,key){
  const status=LABELS[component.status]?component.status:"unknown";
  const detail=detailFor(key,component);
  return '<div class="th-row"><div class="th-row-main"><span>'+esc(label)+'</span>'+
    '<strong class="th-'+esc(status)+'">'+esc(LABELS[status])+'</strong></div>'+
    (detail?'<div class="th-detail">'+esc(detail)+'</div>':"")+'</div>';
}

function computeOverall(config,data){
  const components=data.components||{};
  let worst=-1;
  for(const section of config.sections){
    const ranks=[];
    for(const row of section.rows){
      const rank=RANK[componentOf(row,components).status];
      ranks.push(rank);
      // One down component caps at "Degraded"; the section rule below decides "Outage".
      worst=Math.max(worst,rank===2?1:rank);
    }
    if(section.outageIfAllDown&&ranks.length&&ranks.every(rank=>rank===2))return 2;
  }
  // A monitor run that failed, in full or in part, or that no later run has followed in time, leaves
  // watched wallets unread: "Degraded", as for a degraded component. Analysis still works, so never "Outage".
  const run=data.monitor_run;
  if(run&&(run.status==="failed"||run.status==="degraded"||run.stale===true))worst=Math.max(worst,1);
  return worst;
}

function overallState(config){
  // A refresh in progress keeps showing the last known verdict; only a failed
  // check (or no data yet) changes it.
  if(state.phase==="error")return ["down","Status unavailable"];
  if(!state.data)return ["unknown","Checking…"];
  const worst=computeOverall(config,state.data);
  return OVERALL[worst]||["unknown","Checking…"];
}

function renderPanel(){
  if(!panel)return;
  const config=SCOPES[scope];
  const [tone,headline]=overallState(config);
  const components=(state.data&&state.data.components)||{};
  const versions=(state.data&&state.data.versions)||{};
  let html='<div class="th-banner th-banner-'+esc(tone)+'"><span class="th-dot"></span><strong>'+esc(headline)+'</strong></div>';

  if(state.phase==="error"){
    html+='<div class="th-warning">Unable to reach the CT Atlas API ('+esc(state.error||"network error")+'). '+
      'The tab may still work if only this status check failed.</div>';
  }
  if(state.data){
    for(const section of config.sections){
      html+='<div class="th-section"><div class="th-section-title">'+esc(section.title)+'</div>'+
        section.rows.map(row=>rowHtml(row.label,componentOf(row,components),row.key)).join("")+'</div>';
    }
    const facts=(config.facts?config.facts(versions,state.data):[]).filter(([,value])=>value);
    if(facts.length){
      html+='<div class="th-section"><div class="th-section-title">DETAILS</div>'+
        facts.map(([name,value])=>'<div class="th-row"><div class="th-row-main"><span>'+esc(name)+'</span><strong>'+esc(value)+'</strong></div></div>').join("")+'</div>';
    }
  }
  const stamp=state.checkedAt?new Date(state.checkedAt).toLocaleTimeString("en-GB"):"—";
  const age=state.data&&state.data.cached?" · cached "+Number(state.data.age_seconds||0)+"s":"";
  html+='<div class="th-foot"><span>Checked '+esc(stamp)+esc(age)+'</span>'+
    '<button type="button" class="th-refresh" id="tabHealthRefresh"'+(state.phase==="loading"?" disabled":"")+'>'+(state.phase==="loading"?"CHECKING…":"REFRESH")+'</button></div>'+
    '<div class="th-note">Checks run from the CT Atlas Worker and are cached for up to 60 seconds. '+
    '"Configured · not probed" means credentials are present but are not exercised, to save API quota. '+
    'A reachable service does not guarantee every request will succeed.</div>';
  panel.querySelector(".th-body").innerHTML=html;
  panel.querySelector("#tabHealthRefresh")?.addEventListener("click",()=>refresh(true));
  updateButton(tone,headline);
}

function updateButton(tone,headline){
  if(!button)return;
  button.dataset.state=tone;
  button.title=headline+" — click for details";
}

async function refresh(force){
  if(state.phase==="loading")return;
  state.phase="loading";
  if(panelOpen())renderPanel();
  const controller=new AbortController();
  const abortTimer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
  try{
    // REFRESH asks the Worker for a fresh run instead of its cached answer.
    const response=await fetch(API+"/health/status"+(force===true?"?refresh=1":""),{cache:"no-store",signal:controller.signal});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json();
    if(!data||!data.components)throw new Error("Unexpected response");
    state={phase:"ready",data,error:"",checkedAt:Date.now()};
  }catch(error){
    state={phase:"error",data:state.data,error:error&&error.name==="AbortError"?"timed out":String(error&&error.message||error),checkedAt:Date.now()};
  }finally{clearTimeout(abortTimer);}
  renderPanel();
}

function panelOpen(){return Boolean(panel&&!panel.hidden);}

function openPanel(){
  panel.hidden=false;
  button.setAttribute("aria-expanded","true");
  renderPanel();
  refresh();
  clearInterval(timer);
  timer=setInterval(()=>refresh(),REFRESH_MS);
}

function closePanel(){
  panel.hidden=true;
  button.setAttribute("aria-expanded","false");
  clearInterval(timer);
  button.focus();
}

function build(){
  const config=SCOPES[scope];
  if(!config)return;

  button=document.createElement("button");
  button.type="button";
  button.id="tabHealthButton";
  button.className="th-button";
  button.dataset.state="unknown";
  button.setAttribute("aria-haspopup","dialog");
  button.setAttribute("aria-expanded","false");
  button.innerHTML='<span class="th-dot"></span><span>HEALTH</span>';

  const mainLink=document.querySelector('a[href="main.html"]');
  const group=document.createElement("div");
  group.className="th-group";
  if(mainLink&&mainLink.parentNode){
    mainLink.parentNode.insertBefore(group,mainLink);
    group.append(button,mainLink);
  }else{
    (document.querySelector("header")||document.body).appendChild(group);
    group.append(button);
  }

  panel=document.createElement("div");
  panel.id="tabHealthPanel";
  panel.className="th-panel";
  panel.hidden=true;
  panel.setAttribute("role","dialog");
  panel.setAttribute("aria-label",config.title+" health status");
  panel.innerHTML='<div class="th-head"><div><div class="th-title">HEALTH STATUS</div><div class="th-subtitle">'+esc(config.title)+'</div></div>'+
    '<button type="button" class="th-close" aria-label="Close">×</button></div><div class="th-body"></div>';
  document.body.appendChild(panel);

  button.addEventListener("click",()=>panelOpen()?closePanel():openPanel());
  panel.querySelector(".th-close").addEventListener("click",closePanel);
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&panelOpen())closePanel();});
  document.addEventListener("click",event=>{
    if(panelOpen()&&!panel.contains(event.target)&&!button.contains(event.target))closePanel();
  });

  // Colour the button before the panel is ever opened, without competing with page start-up.
  setTimeout(()=>refresh(),600);
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build);
else build();
})();
