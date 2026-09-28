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
    button.textContent="ADMIN TAB ACCESS";
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
            '<div id="adminUsageTitle">ADMIN · TAB ACCESS</div>'+
            '<div id="adminUsageSubtitle">Workspace opens per user</div>'+
          '</div>'+
          '<button id="adminUsageClose" type="button" aria-label="Close tab access statistics">×</button>'+
        '</div>'+
        '<div id="adminUsageBody">'+
          '<div id="adminUsagePeriods">'+
            '<button type="button" class="admin-period active" data-period="today">TODAY</button>'+
            '<button type="button" class="admin-period" data-period="7">7 DAYS</button>'+
            '<button type="button" class="admin-period" data-period="30">30 DAYS</button>'+
            '<button type="button" class="admin-period" data-period="all">ALL TIME</button>'+
          '</div>'+
          '<div id="adminUsageStatus">Select a period to load tab access.</div>'+
          '<div class="admin-usage-table-wrap">'+
            '<table id="adminUsageTable">'+
              '<thead><tr><th>USER</th><th>CRYPTO</th><th>FACIAL</th><th>MAP</th><th>SOCIAL</th></tr></thead>'+
              '<tbody id="adminUsageRows"></tbody>'+
            '</table>'+
          '</div>'+
          '<div id="adminUsageNote">Counts begin with this update. Each opened workspace page adds one. Searches, questions, reports, and their contents are not included in these statistics.</div>'+
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
  const currentToken=token();

  if(!currentToken){
    if(status)status.textContent="Admin tab access requires an authenticated Worker session. Sign in again.";
    if(rows)rows.innerHTML="";
    return;
  }

  if(status)status.textContent="Loading tab access…";

  try{
    const response=await nativeFetch(
      API_BASE+"/tab-access-stats?period="+encodeURIComponent(period),
      {method:"GET",headers:{"X-Session-Token":currentToken}}
    );
    const payload=await response.json();

    if(!response.ok)throw new Error(payload.error||"Unable to load tab access.");

    if(rows){
      const users=Array.isArray(payload.users)?payload.users:[];
      rows.innerHTML=users.map(item=>
        "<tr>"+
          "<td>"+escapeCell(adminUserLabel(item))+"</td>"+
          "<td>"+Number(item.crypto||0)+"</td>"+
          "<td>"+Number(item.facial||0)+"</td>"+
          "<td>"+Number(item.map||0)+"</td>"+
          "<td>"+Number(item.social||0)+"</td>"+
        "</tr>"
      ).join("")||'<tr><td colspan="5">No users found for this period.</td></tr>';
    }

    if(status){
      status.textContent="Updated "+new Date().toLocaleTimeString("en-GB",{
        hour:"2-digit",
        minute:"2-digit"
      })+" · "+(payload.period_label||period);
    }
  }catch(error){
    if(status)status.textContent=error.message||"Unable to load tab access.";
    if(rows)rows.innerHTML="";
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
