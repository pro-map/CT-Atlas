(function(){
"use strict";

// "Health status" button + panel shared by the Crypto, Social and Facial tabs.
// Data comes from the Worker's /health/status, which really reaches each
// dependency (see cloudflare-worker/health-status.js). Each tab passes its scope
// with <script src="tab-health.js" data-health-scope="crypto|social|facial">.

const API="https://ct-report-generator.fairpeace.workers.dev";
const REFRESH_MS=60000;
const FETCH_TIMEOUT_MS=15000;
const script=document.currentScript;
const scope=String((script&&script.dataset.healthScope)||"").toLowerCase();

const LABELS={
  operational:"Operational",degraded:"Degraded",down:"Unavailable",
  not_configured:"Not configured",configured:"Configured · not probed",unknown:"Checking…"
};
// How bad each state is for the tab's overall verdict (-1 = no data yet).
const RANK={operational:0,configured:0,unknown:-1,not_configured:1,degraded:1,down:2};
const OVERALL={0:["operational","All systems operational"],1:["degraded","Degraded"],2:["down","Outage"],3:["down","Not configured"]};

// Verdict: a critical row that is down, or a section flagged outageIfAllDown whose
// rows are all down, means "Outage" (the tab cannot do its main job). Any other
// required row that is down / degraded / not configured means "Degraded".
// A row with unconfiguredIsOutage that is not configured reads "Not configured".
// Optional rows never change the verdict.
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
    facts:versions=>[
      ["Analysis backend",versions.crypto],
      ["Sanctions screening",versions.sanctions],
      ["Automatic monitoring","Every 6 hours"+(versions.crypto_monitor?" · "+versions.crypto_monitor:"")]
    ]
  },
  social:{
    title:"SOCIAL INTELLIGENCE",
    sections:[
      {title:"INVESTIGATION",rows:[
        {key:"agent",label:"SOCMINT ADK agent",critical:true},
        {key:"agent_search",label:"Public-web search (agent)",derived:"agent_search"},
        {key:"gemini",label:"Gemini fallback",optional:true},
        {key:"brave",label:"Worker web-search fallback · Brave",optional:true}
      ]},
      {title:"SCREENING",rows:[{key:"sanctions",label:"Sanctions list · wallets in reports"}]}
    ],
    collectors:true,
    facts:versions=>[["Report engine",versions.social],["Sanctions screening",versions.sanctions]]
  },
  facial:{
    title:"FACIAL INTELLIGENCE",
    sections:[{title:"ANALYSIS",rows:[{key:"visual",label:"Facial Intelligence service",critical:true,unconfiguredIsOutage:true}]}],
    facts:(versions,components)=>[
      ["Service version",components.visual&&components.visual.version],
      ["Face detection",components.visual&&components.visual.face_detection],
      ["OCR",components.visual&&components.visual.ocr],
      ["Identity recognition",components.visual&&components.visual.status!=="down"&&components.visual.status!=="not_configured"
        ?(components.visual.identity_recognition===false?"Disabled (by design)":"ENABLED — unexpected"):""]
    ]
  }
};

// Free collectors need no key; key-based ones depend on the agent's configuration.
const COLLECTORS=[
  ["FREE COLLECTORS · NO KEY",[
    ["telegram_channel_reader","Telegram public channels"],["bluesky_public","Bluesky"],["mastodon_public","Mastodon"],
    ["fourchan_public","4chan"],["odysee_public","Odysee"],["wayback_captures","Internet Archive captures"],
    ["sherlock_username_discovery","Username discovery"]
  ]],
  ["KEY-BASED COLLECTORS",[
    ["youtube_api","YouTube"],["reddit_oauth","Reddit"],["twitch_api","Twitch"],["flickr_api","Flickr"],
    ["tumblr_api","Tumblr"],["x_api","X (paid API tier)"],["groq_whisper","Media transcription (Groq)"]
  ]]
];

let state={phase:"idle",data:null,error:"",checkedAt:0};
let timer=null;
let button=null;
let panel=null;

const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

// A derived row reports a fact carried inside another component's payload.
function resolve(row,components){
  if(row.derived==="agent_search"){
    const agent=components.agent;
    if(!agent||agent.status==="not_configured")return {status:"not_configured"};
    if(agent.status==="down")return {status:"unknown",detail:"Agent unreachable"};
    const provider=String(agent.search_provider||"disabled");
    return provider==="disabled"
      ?{status:"degraded",detail:"No independent search provider: discovery relies on known URLs and native collectors"}
      :{status:"configured",detail:"Provider: "+provider};
  }
  return components[row.key]||{status:"unknown"};
}

function detailFor(key,component){
  if(component.detail)return component.detail;
  const parts=[];
  if(component.block_height)parts.push("Block "+Number(component.block_height).toLocaleString("en-GB"));
  if(key==="sanctions"&&component.address_count){
    parts.push(Number(component.address_count).toLocaleString("en-GB")+" addresses"+(component.published?" · published "+component.published:""));
  }
  if(component.version)parts.push(component.version);
  if(component.model)parts.push(component.model);
  if(typeof component.latency_ms==="number"&&component.status!=="not_configured"&&component.status!=="configured"){
    parts.push(component.latency_ms+" ms");
  }
  if(component.error)parts.push(component.error);
  return parts.join(" · ");
}

function rowHtml(label,component,optional,key){
  const status=LABELS[component.status]?component.status:"unknown";
  const detail=detailFor(key,component);
  return '<div class="th-row"><div class="th-row-main"><span>'+esc(label)+(optional?' <em>optional</em>':"")+'</span>'+
    '<strong class="th-'+esc(status)+'">'+esc(LABELS[status])+'</strong></div>'+
    (detail?'<div class="th-detail">'+esc(detail)+'</div>':"")+'</div>';
}

function computeOverall(config,components){
  let worst=-1;
  for(const section of config.sections){
    const ranks=[];
    for(const row of section.rows){
      if(row.optional)continue;
      const status=resolve(row,components).status;
      const rank=RANK[status];
      ranks.push(rank);
      // No fallback exists for this row: the tab cannot work at all without it.
      if(status==="not_configured"&&row.unconfiguredIsOutage)return 3;
      if(rank===2&&row.critical)return 2;
      // A down component that is not critical caps at "Degraded".
      worst=Math.max(worst,rank===2?1:rank);
    }
    if(section.outageIfAllDown&&ranks.length&&ranks.every(rank=>rank===2))return 2;
  }
  return worst;
}

function overallState(config){
  // A refresh in progress keeps showing the last known verdict; only a failed
  // check (or no data yet) changes it.
  if(state.phase==="error")return ["down","Status unavailable"];
  if(!state.data)return ["unknown","Checking…"];
  const worst=computeOverall(config,state.data.components||{});
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
        section.rows.map(row=>rowHtml(row.label,resolve(row,components),row.optional,row.key)).join("")+'</div>';
    }
    if(config.collectors){
      const flags=(components.agent&&components.agent.collectors)||null;
      if(flags){
        for(const [title,items] of COLLECTORS){
          html+='<div class="th-section"><div class="th-section-title">'+esc(title)+'</div>'+items.map(([flag,label])=>{
            const on=flags[flag]===true;
            return '<div class="th-row"><div class="th-row-main"><span>'+esc(label)+'</span><strong class="th-'+(on?"operational":"not_configured")+'">'+
              (on?"Available":"Not configured")+'</strong></div></div>';
          }).join("")+'</div>';
        }
      }
    }
    const facts=(config.facts?config.facts(versions,components):[]).filter(([,value])=>value);
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
    const response=await fetch(API+"/health/status",{cache:"no-store",signal:controller.signal});
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
