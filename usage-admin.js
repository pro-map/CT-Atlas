(function(){
"use strict";

const API_BASE=(()=>{
  try{return String(REPORT_GENERATOR_API_URL||"").replace(/\/report\/?$/i,"");}
  catch(_){return "https://ct-report-generator.fairpeace.workers.dev";}
})();
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
const COOLDOWN_MS=20*60*1000;
const DAILY_LIMIT=5;

function user(){return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();}
function token(){return String(sessionStorage.getItem(TOKEN_KEY)||"");}
function isAdmin(){return user()==="admin";}

const nativeFetch=window.fetch.bind(window);

window.fetch=async function(input,init){
  const url=typeof input==="string"?input:String(input?.url||"");
  const options=init?{...init}:{};
  const currentToken=token();
  if(currentToken&&/\/report(?:\?|$)/.test(url)){
    const headers=new Headers(options.headers||{});
    headers.set("X-Session-Token",currentToken);
    options.headers=headers;
  }
  return nativeFetch(input,options);
};

function cooldownKey(){return "ct_report_last_success:"+user();}
function remainingMs(){
  if(isAdmin())return 0;
  const last=Number(localStorage.getItem(cooldownKey())||0);
  return last?Math.max(0,COOLDOWN_MS-(Date.now()-last)):0;
}
function mmss(ms){
  const seconds=Math.max(0,Math.ceil(ms/1000));
  return Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
}

function ensureRateRule(){
  const controls=document.getElementById("reportGeneratorControls");
  if(!controls)return null;
  let rule=document.getElementById("reportRateRule");
  if(!rule){
    rule=document.createElement("div");
    rule.id="reportRateRule";
    rule.className="report-rate-rule";
    controls.appendChild(rule);
  }
  return rule;
}

function updateRateRule(){
  const rule=ensureRateRule();
  if(!rule)return;

  if(isAdmin()){
    rule.textContent="Temporary test-phase limits: test users are limited to 5 reports per day, with at least 20 minutes between report requests. The admin account is exempt for testing and administration.";
    rule.classList.remove("cooldown");
    return;
  }

  const remaining=remainingMs();
  if(remaining>0){
    rule.textContent="Temporary test-phase limits: maximum 5 reports per user per day and at least 20 minutes between report requests. Next local request available in "+mmss(remaining)+".";
    rule.classList.add("cooldown");
  }else{
    rule.textContent="Temporary test-phase limits: maximum 5 reports per user per day and at least 20 minutes between report requests. These restrictions are temporary during the testing phase.";
    rule.classList.remove("cooldown");
  }
}

try{
  reportGeneratorUserId=function(){return user();};
}catch(_){}

try{
  const originalGenerate=generateCustomReport;
  generateCustomReport=async function(){
    const status=document.getElementById("reportGeneratorStatus");
    const username=user();

    if(!username){
      if(status){
        status.textContent="No authenticated user is associated with this session.";
        status.className="report-status error";
      }
      return;
    }

    const remaining=remainingMs();
    if(username!=="admin"&&remaining>0){
      if(status){
        status.textContent="Temporary test-phase limit: one report every 20 minutes. Please retry in "+mmss(remaining)+".";
        status.className="report-status warning";
      }
      updateRateRule();
      return;
    }

    await originalGenerate();

    if(status?.classList.contains("success")&&username!=="admin"){
      localStorage.setItem(cooldownKey(),String(Date.now()));
    }

    updateRateRule();
  };
}catch(error){
  console.warn("Report cooldown wrapper unavailable:",error);
}

try{
  const originalOpen=openReportGenerator;
  openReportGenerator=function(){
    originalOpen();
    updateRateRule();
  };
}catch(_){}

async function recordUsage(action,details){
  const username=user();
  if(!API_BASE||!username)return;
  const headers={"Content-Type":"application/json"};
  if(token())headers["X-Session-Token"]=token();
  try{
    await nativeFetch(API_BASE+"/usage-record",{
      method:"POST",
      headers,
      body:JSON.stringify({
        username,
        action,
        client_time:new Date().toISOString(),
        ...(details?{details}:{})
      }),
      keepalive:true
    });
  }catch(error){
    console.warn("Usage analytics unavailable:",error);
  }
}

// Event list searches: one count and one admin-history row per settled search (the text and
// the filters it ran with), recorded after a pause, on Enter, on leaving the box or the page.
function eventListSnapshot(input){
  const text=String(input.value||"").replace(/\s+/g," ").trim().slice(0,200);
  if(text.length<2)return null;
  const details={text};
  try{
    const db=window.CTAtlasDatabase;
    const filters=db&&typeof db.filters==="function"?db.filters():null;
    if(filters){
      for(const name of ["region","topic","actor_group","period_days"])if(filters[name]!==undefined)details[name]=filters[name];
    }
    if(db&&typeof db.label==="function")details.scope=String(db.label()||"");
  }catch(_){}
  const country=document.getElementById("chronologyCountry")?.value||"";
  if(country)details.country=country==="__UNLOCATED__"?"Without location":country;
  const sort=document.getElementById("chronologySort")?.value||"";
  if(sort)details.sort=sort;
  try{if(typeof chronologyFilteredEvents==="function")details.results=chronologyFilteredEvents().length;}catch(_){}
  return details;
}

function attachEventListTracking(){
  const input=document.getElementById("chronologySearch");
  if(!input)return;
  let timer=null,lastKey="";
  const commit=()=>{
    clearTimeout(timer);timer=null;
    const details=eventListSnapshot(input);
    if(!details){lastKey="";return;}
    const key=JSON.stringify([details.text.toLowerCase(),details.region,details.topic,details.actor_group,details.period_days,details.country,details.sort]);
    if(key===lastKey)return;
    lastKey=key;
    recordUsage("event_list_search",details);
  };
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(commit,1500);};
  input.addEventListener("input",schedule);
  input.addEventListener("keydown",event=>{if(event.key==="Enter")commit();});
  input.addEventListener("blur",()=>{if(timer)commit();});
  for(const id of ["chronologyCountry","chronologySort","reportRegion","reportTopic","reportGroup","reportPeriod"]){
    document.getElementById(id)?.addEventListener("change",()=>{if(String(input.value||"").trim().length>=2)schedule();});
  }
  globalThis.addEventListener?.("pagehide",()=>{if(timer)commit();});
}

function escapeCell(value){
  return String(value??"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/\"/g,"&quot;")
    .replace(/'/g,"&#039;");
}


function adminUserLabel(item,fallback=""){
  const username=String(item?.username||fallback||"");
  const displayName=String(item?.display_name||"").trim();
  return displayName?username+" — "+displayName:username;
}

function adminCountCell(value,item,metric){
  const count=Number(value||0);
  const nonzero=Number.isFinite(count)&&count!==0;
  const inner=nonzero&&item&&metric
    ?'<button type="button" class="admin-count-link" data-user="'+escapeCell(adminUsername(item))+'" data-metric="'+escapeCell(metric)+'" data-count="'+count+'" title="Show the details">'+count+'</button>'
    :String(count);
  return '<td'+(nonzero?' class="admin-usage-nonzero"':"")+">"+inner+"</td>";
}

// What each clickable number opens, and how history rows read.
const ADMIN_HISTORY_TITLES={
  all:"ALL ACTIVITY",report_requests:"REPORT REQUESTS",report_generator_requests:"SITUATION REPORT",deep_search_requests:"CUSTOM INTELLIGENCE",
  searches:"SEARCHES",event_list_searches:"EVENT LIST SEARCH",blockchain_searches:"BLOCKCHAIN SEARCH",
  facial_extractions:"FACIAL EXTRACTION",facial_searches:"FACIAL SEARCH",darkweb_searches:"DARK WEB SEARCH",ip_lookups:"IP LOOKUP",
  quick_ask_requests:"QUICK Q&A (RETIRED)","tab:crypto":"CRYPTO OPENED","tab:facial":"FACIAL OPENED","tab:map":"MAP OPENED",
  "tab:darkweb":"DARK WEB OPENED","tab:ip":"IP INTELLIGENCE OPENED"
};
const ADMIN_FEATURE_LABELS={
  report_generator:"SITUATION REPORT",deep_search:"CUSTOM INTELLIGENCE",event_list:"EVENT LIST",blockchain:"BLOCKCHAIN",
  facial_extraction:"FACIAL EXTRACTION",facial_search:"FACIAL SEARCH",darkweb_search:"DARK WEB",ip_lookup:"IP LOOKUP",
  tab_map:"MAP OPENED",tab_crypto:"CRYPTO OPENED",tab_facial:"FACIAL OPENED",tab_darkweb:"DARK WEB OPENED",tab_ip:"IP INTELLIGENCE OPENED"
};
const ADMIN_HISTORY_FIELDS=[
  ["region","Region"],["topic","Category"],["actor_group","Group"],["period_days","Period"],["compare","Comparison"],["scope","Database scope"],
  ["country","Country"],["sort","Sort"],["view","View"],["outlet","Outlet"],["material","Material"],["loaded_back_to","Loaded back to"],
  ["results","Results shown"],["kind","Type"],["chain","Chain"],["chain_hint","Chain selected"],["origin","Origin"],["limit","Transactions"],
  ["registered_domain","Registered domain"],["parent_domain","From domain"],["files","Files"],
  ["videos","Videos"],["bytes","Upload size"],["engines","Engines"],["face","Face"],["period","Period found"],["title","Result"],["outcome","Outcome"]
];
const ADMIN_OUTCOMES={cached:"Served from cache",generated:"Generated",no_events:"No matching events",failed:"Failed"};
const ADMIN_MAIN_FIELD={deep_search:"question",event_list:"text",darkweb_search:"text",blockchain:"query",ip_lookup:"target"};

function adminHistoryValue(name,value){
  if(Array.isArray(value))return value.join(", ");
  if(typeof value==="boolean")return value?"Yes":"No";
  if(name==="period_days")return Number(value)===1?"24 hours":value+" days";
  if(name==="bytes")return (Number(value||0)/1048576).toFixed(1)+" MB";
  if(name==="outcome")return ADMIN_OUTCOMES[value]||String(value);
  if(value==="GLOBAL")return "Global";
  if(value==="ALL")return "All";
  return String(value).replace(/^REGION:/,"Region ");
}

// One history row: [time, feature label, main line, [label, value] details].
function adminHistoryEntry(row){
  const feature=String(row?.feature||"");
  const skip=new Set(["id","at","feature"]);
  let main="";
  const field=ADMIN_MAIN_FIELD[feature];
  if(field&&row[field]){main=String(row[field]);skip.add(field);}
  else if(feature==="report_generator"){
    main=["region","topic","actor_group","period_days"].filter(name=>row[name]!==undefined).map(name=>adminHistoryValue(name,row[name])).join(" · ");
    ["region","topic","actor_group","period_days"].forEach(name=>skip.add(name));
  }else if(feature==="facial_search"){
    main="Face "+(row.face||"?")+" · reverse-image search";skip.add("face");
  }else if(feature==="facial_extraction"){
    main=(row.files||0)+" file(s) analysed";skip.add("files");
  }else if(feature.startsWith("tab_")){
    main="Workspace opened";
  }else if(feature==="event_list"||feature==="darkweb_search"){
    main="(filters only)";
  }
  const details=ADMIN_HISTORY_FIELDS.filter(([name])=>!skip.has(name)&&row[name]!==undefined&&row[name]!==""&&!(Array.isArray(row[name])&&!row[name].length))
    .map(([name,label])=>[label,adminHistoryValue(name,row[name])]);
  let when="";
  try{when=new Date(row.at).toLocaleString("en-GB",{timeZone:"Europe/Paris",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(_){when=String(row?.at||"");}
  return [when,ADMIN_FEATURE_LABELS[feature]||feature.toUpperCase(),main,details];
}

function adminHistoryHtml(rows){
  rows=rows.filter(row=>row.feature!=="social"&&row.feature!=="tab_social");
  if(!rows.length)return '<div class="admin-history-empty">No details recorded for this period.</div>';
  return rows.map(row=>{
    const [when,label,main,details]=adminHistoryEntry(row);
    return '<article class="admin-history-row">'+
      '<div class="admin-history-meta"><time>'+escapeCell(when)+'</time><span class="admin-history-feature">'+escapeCell(label)+'</span></div>'+
      (main?'<div class="admin-history-main">'+escapeCell(main)+'</div>':"")+
      (details.length?'<dl class="admin-history-details">'+details.map(([name,value])=>'<div><dt>'+escapeCell(name)+'</dt><dd>'+escapeCell(value)+'</dd></div>').join("")+'</dl>':"")+
    '</article>';
  }).join("");
}

// A user counts as connected in the selected period when they logged in, opened a workspace
// or used any feature in it -- a session opened the day before still counts once it is used.
const ADMIN_TAB_FIELDS=["crypto","facial","map","darkweb","ip"];
const ADMIN_ACTIVITY_FIELDS=["logins","searches","map_searches","event_list_searches","report_requests","report_generator_requests","deep_search_requests","reports_generated","cached_reports","quick_ask_requests","blockchain_searches","facial_extractions","facial_searches","darkweb_searches","ip_lookups","feedback_submissions","quiz_answers"];

function adminUsername(item){return String(item?.username||"").trim().toLowerCase();}

function adminConnectedUsers(accessUsers,usageUsers){
  const byUser=new Map();
  const note=(item,fields)=>{
    const username=adminUsername(item);
    if(!username)return;
    const entry=byUser.get(username)||{username,display_name:"",logins:0,last_activity:"",connected:false};
    if(item.display_name)entry.display_name=String(item.display_name).trim();
    entry.logins=Math.max(entry.logins,Number(item.logins||0)||0);
    const last=String(item.last_activity||"");
    if(last>entry.last_activity)entry.last_activity=last;
    entry.connected=entry.connected||fields.some(field=>Number(item[field]||0)>0);
    byUser.set(username,entry);
  };
  (accessUsers||[]).forEach(item=>note(item,ADMIN_TAB_FIELDS));
  (usageUsers||[]).forEach(item=>note(item,ADMIN_ACTIVITY_FIELDS));
  return [...byUser.values()].filter(entry=>entry.connected).sort((a,b)=>
    b.last_activity.localeCompare(a.last_activity)||a.username.localeCompare(b.username,"en",{numeric:true}));
}

// Connected users first (most recent first), everyone else after in roster order.
function adminConnectedFirst(users,connected){
  const rank=new Map(connected.map((entry,index)=>[entry.username,index]));
  const order=item=>rank.has(adminUsername(item))?rank.get(adminUsername(item)):connected.length;
  return [...users].map((item,index)=>({item,index})).sort((a,b)=>order(a.item)-order(b.item)||a.index-b.index).map(entry=>entry.item);
}

function adminUserCell(item,isConnected){
  if(!isConnected)return "<td>"+escapeCell(adminUserLabel(item))+"</td>";
  const username=String(item?.username||"");
  const displayName=String(item?.display_name||"").trim();
  return '<td class="admin-user-connected"><span class="admin-connected-dot" aria-hidden="true"></span>'+
    '<strong class="admin-connected-name">'+escapeCell(displayName||username)+'</strong>'+
    (displayName?'<span class="admin-connected-id">'+escapeCell(username)+'</span>':"")+
    '<span class="admin-connected-badge">CONNECTED</span>'+
    '<button type="button" class="admin-history-all" data-user="'+escapeCell(adminUsername(item))+'" data-metric="all" title="Everything this user did in the period">ALL ACTIVITY</button></td>';
}

function adminRowClass(item,connectedNames){
  return connectedNames.has(adminUsername(item))?' class="admin-row-connected"':' class="admin-row-idle"';
}

function adminLastSeen(iso){
  const date=new Date(iso);
  if(!iso||Number.isNaN(date.getTime()))return "";
  return "last seen "+date.toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
}

function adminConnectedChips(connected){
  if(!connected.length)return '<div class="admin-connected-empty">Nobody has connected in this period.</div>';
  return connected.map(entry=>{
    const logins=entry.logins?entry.logins+" login"+(entry.logins===1?"":"s"):"active session";
    const seen=adminLastSeen(entry.last_activity);
    return '<div class="admin-connected-chip">'+
      '<strong>'+escapeCell(entry.display_name||entry.username)+'</strong>'+
      (entry.display_name?'<span>'+escapeCell(entry.username)+'</span>':"")+
      '<em>'+escapeCell(logins+(seen?" · "+seen:""))+'</em>'+
    '</div>';
  }).join("");
}

function renderAdminConnected(connected){
  const panel=document.getElementById("adminConnectedPanel");
  const title=document.getElementById("adminConnectedTitle");
  const list=document.getElementById("adminConnectedList");
  if(!panel||!title||!list)return;
  if(!connected){
    panel.classList.add("is-empty");
    title.textContent="CONNECTED THIS PERIOD";
    list.innerHTML="";
    return;
  }
  panel.classList.toggle("is-empty",!connected.length);
  title.textContent="● CONNECTED THIS PERIOD · "+connected.length+" USER"+(connected.length===1?"":"S");
  list.innerHTML=adminConnectedChips(connected);
}

function refreshAdminButton(){
  const button=document.getElementById("adminUsageButton");
  if(button)button.hidden=!isAdmin();
}

function injectAdminUi(){
  const mount=document.getElementById("mainAdminActions");
  if(!mount)return;

  let button=document.getElementById("adminUsageButton");
  if(!button){
    button=document.createElement("button");
    button.id="adminUsageButton";
    button.type="button";
    button.textContent="ADMIN USAGE STATS";
    mount.appendChild(button);
  }

  if(document.getElementById("adminUsagePanel")){
    refreshAdminButton();
    return;
  }

  document.body.insertAdjacentHTML("beforeend",
    '<div id="adminUsagePanel" aria-hidden="true">'+
      '<div id="adminUsageWindow" role="dialog" aria-modal="true" aria-labelledby="adminUsageTitle">'+
        '<div id="adminUsageHeader">'+
          '<div>'+
            '<div id="adminUsageTitle">ADMIN · USAGE STATISTICS</div>'+
            '<div id="adminUsageSubtitle">Workspace access and feature activity per user</div>'+
          '</div>'+
          '<button id="adminUsageClose" type="button" aria-label="Close admin usage statistics">×</button>'+
        '</div>'+
        '<div id="adminUsageBody">'+
          '<div id="adminUsagePeriods">'+
            '<button type="button" class="admin-period active" data-period="today">TODAY</button>'+
            '<button type="button" class="admin-period" data-period="7">7 DAYS</button>'+
            '<button type="button" class="admin-period" data-period="30">30 DAYS</button>'+
            '<button type="button" class="admin-period" data-period="all">ALL TIME</button>'+
          '</div>'+
          '<div id="adminUsageSummary">'+
            '<div class="admin-usage-metric"><span>ACTIVE USERS</span><strong id="adminActiveUsers">—</strong></div>'+
            '<div class="admin-usage-metric"><span>SEARCHES</span><strong id="adminSearches">—</strong></div>'+
            '<div class="admin-usage-metric"><span>REPORT REQUESTS</span><strong id="adminReportRequests">—</strong></div>'+
            '<div class="admin-usage-metric"><span>AI REPORTS</span><strong id="adminAiReports">—</strong></div>'+
          '</div>'+
          '<div id="adminUsageStatus">Select a period to load usage statistics.</div>'+
          '<div id="adminConnectedPanel" class="admin-connected-panel is-empty" aria-live="polite">'+
            '<div id="adminConnectedTitle" class="admin-connected-title">CONNECTED THIS PERIOD</div>'+
            '<div id="adminConnectedList" class="admin-connected-list"></div>'+
          '</div>'+
          '<div class="admin-usage-section-title">WORKSPACE ACCESS</div>'+
          '<div class="admin-usage-table-wrap">'+
            '<table id="adminUsageTable">'+
              '<thead><tr><th>USER</th><th>CRYPTO</th><th>FACIAL</th><th>MAP</th><th>DARK WEB</th><th>IP INTELLIGENCE</th></tr></thead>'+
              '<tbody id="adminUsageRows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div class="admin-usage-section-title">FEATURE ACTIVITY</div>'+
          '<div class="admin-usage-table-wrap">'+
            '<table id="adminFeatureUsageTable">'+
              '<thead><tr><th>USER</th><th>SITUATION REPORT</th><th>CUSTOM INTELLIGENCE</th><th>EVENT LIST SEARCH</th><th>BLOCKCHAIN SEARCH</th><th>FACIAL EXTRACTION</th><th>FACIAL SEARCH</th><th>DARK WEB SEARCH</th><th>IP LOOKUP</th><th>QUICK Q&amp;A (RETIRED)</th></tr></thead>'+
              '<tbody id="adminFeatureUsageRows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div id="adminUsageNote">Click a number to see the details behind it: the time, what was searched (text, question, address, IP or domain, filters) and the outcome; ALL ACTIVITY lists everything a connected user did in the period. Details are recorded since 6 October 2026 and kept 90 days, so older counts have no detail; a list shows at most the newest 500 entries. The DARK WEB SEARCH and IP LOOKUP counters also start on 6 October 2026. Facial entries hold counts and face labels only, never images. Workspace access counts page openings. Event list searches are counted once per settled search since 6 October 2026 (previously at every typing pause).</div>'+
        '</div>'+
      '</div>'+
      '<div id="adminHistoryPanel" hidden>'+
        '<div id="adminHistoryWindow" role="dialog" aria-modal="true" aria-labelledby="adminHistoryTitle">'+
          '<div id="adminHistoryHeader">'+
            '<div>'+
              '<div id="adminHistoryTitle">DETAILS</div>'+
              '<div id="adminHistorySubtitle"></div>'+
            '</div>'+
            '<button id="adminHistoryClose" type="button" aria-label="Close the details">×</button>'+
          '</div>'+
          '<div id="adminHistoryStatus" aria-live="polite"></div>'+
          '<div id="adminHistoryRows"></div>'+
        '</div>'+
      '</div>'+
    '</div>');

  button.addEventListener("click",openAdmin);
  document.getElementById("adminUsageBody")?.addEventListener("click",event=>{
    const trigger=event.target?.closest?.("[data-metric][data-user]");
    if(trigger)openUsageHistory(trigger);
  });
  document.getElementById("adminHistoryClose")?.addEventListener("click",closeUsageHistory);
  document.getElementById("adminHistoryPanel")?.addEventListener("click",event=>{
    if(event.target.id==="adminHistoryPanel")closeUsageHistory();
  });
  document.getElementById("adminUsageClose")?.addEventListener("click",closeAdmin);
  document.getElementById("adminUsagePanel")?.addEventListener("click",event=>{
    if(event.target.id==="adminUsagePanel")closeAdmin();
  });
  document.querySelectorAll(".admin-period").forEach(periodButton=>{
    periodButton.addEventListener("click",function(){
      document.querySelectorAll(".admin-period").forEach(item=>item.classList.remove("active"));
      this.classList.add("active");
      closeUsageHistory(false);
      loadAdmin(this.dataset.period||"today");
    });
  });
  refreshAdminButton();
}
function openAdmin(){
  if(!isAdmin())return;
  const panel=document.getElementById("adminUsagePanel");
  panel?.classList.add("open");
  panel?.setAttribute("aria-hidden","false");
  loadAdmin(document.querySelector(".admin-period.active")?.dataset.period||"today");
}

// The details behind one clicked number, for the selected period.
let historyTrigger=null,historyRequest=0,adminRenderedPeriod="today",adminLoadRequest=0;
function closeUsageHistory(restoreFocus=true){
  const panel=document.getElementById("adminHistoryPanel");
  if(!panel||panel.hidden)return;
  panel.hidden=true;
  historyRequest++;
  document.getElementById("adminUsageWindow")?.removeAttribute("inert");
  const trigger=historyTrigger;historyTrigger=null;
  if(restoreFocus!==false&&trigger&&document.contains(trigger))trigger.focus();
}

async function openUsageHistory(trigger){
  if(!isAdmin())return;
  const panel=document.getElementById("adminHistoryPanel");
  const title=document.getElementById("adminHistoryTitle");
  const subtitle=document.getElementById("adminHistorySubtitle");
  const status=document.getElementById("adminHistoryStatus");
  const rowsBox=document.getElementById("adminHistoryRows");
  if(!panel||!title||!subtitle||!status||!rowsBox)return;
  const username=String(trigger.dataset.user||"");
  const metric=String(trigger.dataset.metric||"");
  const count=Number(trigger.dataset.count||0);
  const period=adminRenderedPeriod;
  const request=++historyRequest;
  historyTrigger=trigger;
  title.textContent=(ADMIN_HISTORY_TITLES[metric]||metric.toUpperCase())+" · DETAILS";
  subtitle.textContent=username;
  status.textContent="Loading details…";
  rowsBox.innerHTML="";
  panel.hidden=false;
  document.getElementById("adminUsageWindow")?.setAttribute("inert","");
  document.getElementById("adminHistoryClose")?.focus();
  try{
    const query="?period="+encodeURIComponent(period)+"&username="+encodeURIComponent(username)+"&metric="+encodeURIComponent(metric);
    const response=await nativeFetch(API_BASE+"/usage-history"+query,{method:"GET",headers:{"X-Session-Token":token()}});
    const payload=await response.json().catch(()=>({}));
    if(request!==historyRequest)return;
    if(!response.ok)throw new Error(payload.error||"Unable to load the details.");
    const rows=Array.isArray(payload.rows)?payload.rows:[];
    subtitle.textContent=adminUserLabel(payload,username);
    const since=new Date(String(payload.recorded_since||"2026-10-06")+"T12:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
    const parts=[rows.length+" entr"+(rows.length===1?"y":"ies")+(payload.truncated?" (newest shown)":""),payload.period_label||period];
    if(payload.truncated)parts.push("only the newest "+rows.length+" are listed");
    else if(count>rows.length)parts.push((count-rows.length)+" counted without details (before "+since+" or older than "+(payload.retention_days||90)+" days)");
    else parts.push("details kept "+(payload.retention_days||90)+" days");
    status.textContent=parts.join(" · ");
    rowsBox.innerHTML=adminHistoryHtml(rows);
  }catch(error){
    if(request!==historyRequest)return;
    status.textContent=error.message||"Unable to load the details.";
  }
}

function closeAdmin(){
  closeUsageHistory();
  const panel=document.getElementById("adminUsagePanel");
  panel?.classList.remove("open");
  panel?.setAttribute("aria-hidden","true");
}

async function loadAdmin(period){
  if(!isAdmin())return;

  const status=document.getElementById("adminUsageStatus");
  const rows=document.getElementById("adminUsageRows");
  const featureRows=document.getElementById("adminFeatureUsageRows");
  const currentToken=token();

  if(!currentToken){
    if(status)status.textContent="Admin usage statistics require an authenticated Worker session. Sign in again.";
    if(rows)rows.innerHTML="";
    if(featureRows)featureRows.innerHTML="";
    renderAdminConnected(null);
    return;
  }

  if(status)status.textContent="Loading usage statistics…";
  const request=++adminLoadRequest;
  const headers={"X-Session-Token":currentToken};
  const query="?period="+encodeURIComponent(period);

  try{
    const [accessResponse,usageResponse]=await Promise.all([
      nativeFetch(API_BASE+"/tab-access-stats"+query,{method:"GET",headers}),
      nativeFetch(API_BASE+"/usage-stats"+query,{method:"GET",headers})
    ]);
    const [accessPayload,usagePayload]=await Promise.all([accessResponse.json(),usageResponse.json()]);
    if(request!==adminLoadRequest)return;
    if(!accessResponse.ok)throw new Error(accessPayload.error||"Unable to load workspace access.");
    if(!usageResponse.ok)throw new Error(usagePayload.error||"Unable to load feature activity.");

    const accessUsers=Array.isArray(accessPayload.users)?accessPayload.users:[];
    const usageUsers=Array.isArray(usagePayload.users)?usagePayload.users:[];
    const connected=adminConnectedUsers(accessUsers,usageUsers);
    const connectedNames=new Set(connected.map(entry=>entry.username));
    adminRenderedPeriod=period;
    renderAdminConnected(connected);

    if(rows){
      const users=adminConnectedFirst(accessUsers,connected);
      rows.innerHTML=users.map(item=>
        "<tr"+adminRowClass(item,connectedNames)+">"+
          adminUserCell(item,connectedNames.has(adminUsername(item)))+
          adminCountCell(item.crypto,item,"tab:crypto")+
          adminCountCell(item.facial,item,"tab:facial")+
          adminCountCell(item.map,item,"tab:map")+
          adminCountCell(item.darkweb,item,"tab:darkweb")+
          adminCountCell(item.ip,item,"tab:ip")+
        "</tr>"
      ).join("")||'<tr><td colspan="6">No users found for this period.</td></tr>';
    }

    const summary=usagePayload.summary||{};
    const setMetric=(id,value)=>{
      const el=document.getElementById(id);
      if(!el)return;
      const count=Number(value||0);
      el.textContent=count.toLocaleString("en-GB");
      el.classList.toggle("admin-usage-nonzero",Number.isFinite(count)&&count!==0);
    };
    setMetric("adminActiveUsers",summary.active_users);
    setMetric("adminSearches",summary.searches);
    setMetric("adminReportRequests",summary.report_requests);
    setMetric("adminAiReports",summary.reports_generated);

    if(featureRows){
      const users=adminConnectedFirst(usageUsers,connected);
      featureRows.innerHTML=users.map(item=>
        "<tr"+adminRowClass(item,connectedNames)+">"+
          adminUserCell(item,connectedNames.has(adminUsername(item)))+
          adminCountCell(item.report_generator_requests,item,"report_generator_requests")+
          adminCountCell(item.deep_search_requests,item,"deep_search_requests")+
          adminCountCell(item.event_list_searches,item,"event_list_searches")+
          adminCountCell(item.blockchain_searches,item,"blockchain_searches")+
          adminCountCell(item.facial_extractions,item,"facial_extractions")+
          adminCountCell(item.facial_searches,item,"facial_searches")+
          adminCountCell(item.darkweb_searches,item,"darkweb_searches")+
          adminCountCell(item.ip_lookups,item,"ip_lookups")+
          adminCountCell(item.quick_ask_requests,item,"quick_ask_requests")+
        "</tr>"
      ).join("")||'<tr><td colspan="10">No users found for this period.</td></tr>';
    }

    if(status){
      status.textContent="Updated "+new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})+
        " · "+(usagePayload.period_label||accessPayload.period_label||period);
    }
  }catch(error){
    if(request!==adminLoadRequest)return;
    if(status)status.textContent=error.message||"Unable to load usage statistics.";
    if(rows)rows.innerHTML="";
    if(featureRows)featureRows.innerHTML="";
    renderAdminConnected(null);
    ["adminActiveUsers","adminSearches","adminReportRequests","adminAiReports"].forEach(id=>{
      const el=document.getElementById(id);
      if(el){el.textContent="—";el.classList.remove("admin-usage-nonzero");}
    });
  }
}
document.addEventListener("click",event=>{
  if(event.target?.id==="access-button"){
    setTimeout(()=>{
      refreshAdminButton();
      updateRateRule();
    },350);
    setTimeout(()=>{
      refreshAdminButton();
      updateRateRule();
    },1200);
  }
},true);

document.addEventListener("DOMContentLoaded",()=>{
  ensureRateRule();
  updateRateRule();
  injectAdminUi();
  attachEventListTracking();
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    const history=document.getElementById("adminHistoryPanel");
    if(history&&!history.hidden)closeUsageHistory();
    else closeAdmin();
  });
  setInterval(()=>{
    updateRateRule();
    refreshAdminButton();
  },1000);
});

})();

