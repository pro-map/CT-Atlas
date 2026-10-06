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

async function recordUsage(action){
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
        client_time:new Date().toISOString()
      })
    });
  }catch(error){
    console.warn("Usage analytics unavailable:",error);
  }
}

function attachSearchTracking(id,action){
  const input=document.getElementById(id);
  if(!input)return;
  let timer=null;
  input.addEventListener("input",function(){
    clearTimeout(timer);
    const value=String(this.value||"").trim();
    if(value.length<2)return;
    timer=setTimeout(()=>recordUsage(action),800);
  });
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

function adminCountCell(value){
  const count=Number(value||0);
  return '<td'+(Number.isFinite(count)&&count!==0?' class="admin-usage-nonzero"':"")+">"+count+"</td>";
}

// A user counts as connected in the selected period when they logged in, opened a workspace
// or used any feature in it -- a session opened the day before still counts once it is used.
const ADMIN_TAB_FIELDS=["crypto","facial","map","social","darkweb","ip"];
const ADMIN_ACTIVITY_FIELDS=["logins","searches","map_searches","event_list_searches","report_requests","report_generator_requests","deep_search_requests","reports_generated","cached_reports","quick_ask_requests","social_intel_requests","blockchain_searches","facial_extractions","facial_searches","feedback_submissions","quiz_answers"];

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
    '<span class="admin-connected-badge">CONNECTED</span></td>';
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
              '<thead><tr><th>USER</th><th>CRYPTO</th><th>FACIAL</th><th>MAP</th><th>SOCIAL</th><th>DARK WEB</th><th>IP INTELLIGENCE</th></tr></thead>'+
              '<tbody id="adminUsageRows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div class="admin-usage-section-title">FEATURE ACTIVITY</div>'+
          '<div class="admin-usage-table-wrap">'+
            '<table id="adminFeatureUsageTable">'+
              '<thead><tr><th>USER</th><th>SITUATION REPORT</th><th>CUSTOM INTELLIGENCE</th><th>QUICK Q&amp;A (RETIRED)</th><th>BLOCKCHAIN SEARCH</th><th>SOCIAL MEDIA SEARCH</th><th>FACIAL EXTRACTION</th><th>FACIAL SEARCH</th></tr></thead>'+
              '<tbody id="adminFeatureUsageRows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div id="adminUsageNote">Workspace access counts page openings. Feature counts are per user and selected period; they record usage totals only, not search terms, questions, addresses, images or report contents. Blockchain and Facial counters begin with this update; earlier Situation Report (Report Generator), Custom Intelligence (Deep Search), retired quick Q&A and Social Media counts retain their existing history.</div>'+
        '</div>'+
      '</div>'+
    '</div>');

  button.addEventListener("click",openAdmin);
  document.getElementById("adminUsageClose")?.addEventListener("click",closeAdmin);
  document.getElementById("adminUsagePanel")?.addEventListener("click",event=>{
    if(event.target.id==="adminUsagePanel")closeAdmin();
  });
  document.querySelectorAll(".admin-period").forEach(periodButton=>{
    periodButton.addEventListener("click",function(){
      document.querySelectorAll(".admin-period").forEach(item=>item.classList.remove("active"));
      this.classList.add("active");
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

function closeAdmin(){
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
  const headers={"X-Session-Token":currentToken};
  const query="?period="+encodeURIComponent(period);

  try{
    const [accessResponse,usageResponse]=await Promise.all([
      nativeFetch(API_BASE+"/tab-access-stats"+query,{method:"GET",headers}),
      nativeFetch(API_BASE+"/usage-stats"+query,{method:"GET",headers})
    ]);
    const [accessPayload,usagePayload]=await Promise.all([accessResponse.json(),usageResponse.json()]);
    if(!accessResponse.ok)throw new Error(accessPayload.error||"Unable to load workspace access.");
    if(!usageResponse.ok)throw new Error(usagePayload.error||"Unable to load feature activity.");

    const accessUsers=Array.isArray(accessPayload.users)?accessPayload.users:[];
    const usageUsers=Array.isArray(usagePayload.users)?usagePayload.users:[];
    const connected=adminConnectedUsers(accessUsers,usageUsers);
    const connectedNames=new Set(connected.map(entry=>entry.username));
    renderAdminConnected(connected);

    if(rows){
      const users=adminConnectedFirst(accessUsers,connected);
      rows.innerHTML=users.map(item=>
        "<tr"+adminRowClass(item,connectedNames)+">"+
          adminUserCell(item,connectedNames.has(adminUsername(item)))+
          adminCountCell(item.crypto)+
          adminCountCell(item.facial)+
          adminCountCell(item.map)+
          adminCountCell(item.social)+
          adminCountCell(item.darkweb)+
          adminCountCell(item.ip)+
        "</tr>"
      ).join("")||'<tr><td colspan="7">No users found for this period.</td></tr>';
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
          adminCountCell(item.report_generator_requests)+
          adminCountCell(item.deep_search_requests)+
          adminCountCell(item.quick_ask_requests)+
          adminCountCell(item.blockchain_searches)+
          adminCountCell(item.social_intel_requests)+
          adminCountCell(item.facial_extractions)+
          adminCountCell(item.facial_searches)+
        "</tr>"
      ).join("")||'<tr><td colspan="8">No users found for this period.</td></tr>';
    }

    if(status){
      status.textContent="Updated "+new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})+
        " · "+(usagePayload.period_label||accessPayload.period_label||period);
    }
  }catch(error){
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
  attachSearchTracking("searchInput","map_search");
  attachSearchTracking("chronologySearch","event_list_search");
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape")closeAdmin();
  });
  setInterval(()=>{
    updateRateRule();
    refreshAdminButton();
  },1000);
});

})();

