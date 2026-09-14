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

function refreshAdminButton(){
  const button=document.getElementById("adminUsageButton");
  if(button)button.hidden=!isAdmin();
}

function injectAdminUi(){
  if(document.getElementById("adminUsagePanel")){
    refreshAdminButton();
    return;
  }

  const launcher=document.getElementById("healthStatusLauncher");
  if(launcher){
    const button=document.createElement("button");
    button.id="adminUsageButton";
    button.type="button";
    button.textContent="Admin Usage";
    button.hidden=!isAdmin();
    launcher.appendChild(button);
  }

  document.body.insertAdjacentHTML("beforeend",`
    <div id="adminUsagePanel" aria-hidden="true">
      <div id="adminUsageWindow" role="dialog" aria-modal="true" aria-labelledby="adminUsageTitle">
        <div id="adminUsageHeader">
          <div>
            <div id="adminUsageTitle">ADMIN · USAGE STATISTICS</div>
            <div id="adminUsageSubtitle">Per-user activity · no search terms are stored</div>
          </div>
          <button id="adminUsageClose" type="button" aria-label="Close admin usage statistics">×</button>
        </div>
        <div id="adminUsageBody">
          <div id="adminUsagePeriods">
            <button type="button" class="admin-period active" data-period="today">TODAY</button>
            <button type="button" class="admin-period" data-period="7">7 DAYS</button>
            <button type="button" class="admin-period" data-period="30">30 DAYS</button>
            <button type="button" class="admin-period" data-period="all">ALL TIME</button>
          </div>
          <div id="adminUsageSummary">
            <div class="admin-usage-metric"><span>ACTIVE USERS</span><strong id="adminActiveUsers">—</strong></div>
            <div class="admin-usage-metric"><span>SEARCHES</span><strong id="adminSearches">—</strong></div>
            <div class="admin-usage-metric"><span>REPORT REQUESTS</span><strong id="adminReportRequests">—</strong></div>
            <div class="admin-usage-metric"><span>AI REPORTS</span><strong id="adminAiReports">—</strong></div>
            <div class="admin-usage-metric"><span>QUIZ ANSWERS</span><strong id="adminQuizAnswers">—</strong></div>
            <div class="admin-usage-metric"><span>QUIZ CORRECT</span><strong id="adminQuizCorrect">—</strong></div>
            <div class="admin-usage-metric"><span>QUIZ INCORRECT</span><strong id="adminQuizIncorrect">—</strong></div>
            <div class="admin-usage-metric"><span>QUIZ SCORE</span><strong id="adminQuizScore">—</strong></div>
          </div>
          <div id="adminUsageStatus">Select a period to load usage statistics.</div>
          <div class="admin-usage-table-wrap">
            <table id="adminUsageTable">
              <thead>
                <tr>
                  <th>USER</th><th>LOGINS</th><th>SEARCHES</th><th>REPORTS</th><th>AI</th><th>CACHE</th><th>QUIZ</th><th>CORRECT</th><th>INCORRECT</th><th>SCORE</th><th>LAST ACTIVE</th>
                </tr>
              </thead>
              <tbody id="adminUsageRows"></tbody>
            </table>
          </div>
          <div id="adminQuizHistorySection">
            <div id="adminQuizHistoryTitle">QUIZ ANSWER HISTORY</div>
            <div id="adminQuizHistoryStatus">Select a period to load recorded quiz attempts.</div>
            <div class="admin-usage-table-wrap">
              <table id="adminQuizHistoryTable">
                <thead>
                  <tr><th>DATE</th><th>USER</th><th>CATEGORY</th><th>QUESTION</th><th>ANSWER GIVEN</th><th>CORRECT ANSWER</th><th>RESULT</th><th>ANSWERED</th><th>SOURCE</th></tr>
                </thead>
                <tbody id="adminQuizHistoryRows"></tbody>
              </table>
            </div>
          </div>
          <div id="adminUsageNote">
            Temporary test-phase report limits: 5 report requests per user per day and at least 20 minutes between requests. Admin is exempt. Search text itself is not transmitted or retained.
          </div>
        </div>
      </div>
    </div>`);

  document.getElementById("adminUsageButton")?.addEventListener("click",openAdmin);
  document.getElementById("adminUsageClose")?.addEventListener("click",closeAdmin);
  document.getElementById("adminUsagePanel")?.addEventListener("click",event=>{
    if(event.target.id==="adminUsagePanel")closeAdmin();
  });
  document.querySelectorAll(".admin-period").forEach(button=>{
    button.addEventListener("click",function(){
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

function lastActive(value){
  if(!value)return "—";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "—";
  return date.toLocaleString("en-GB",{
    day:"2-digit",
    month:"2-digit",
    hour:"2-digit",
    minute:"2-digit"
  });
}


async function loadQuizHistory(period,currentToken){
  const status=document.getElementById("adminQuizHistoryStatus");
  const rows=document.getElementById("adminQuizHistoryRows");

  if(!currentToken){
    if(status)status.textContent="Admin quiz history requires an authenticated Worker session. Sign in again.";
    if(rows)rows.innerHTML="";
    return;
  }

  if(status)status.textContent="Loading recorded quiz attempts…";

  try{
    const response=await nativeFetch(
      API_BASE+"/quiz-history?period="+encodeURIComponent(period),
      {
        method:"GET",
        headers:{"X-Session-Token":currentToken}
      }
    );
    const payload=await response.json();

    if(!response.ok){
      throw new Error(payload.error||"Unable to load quiz history.");
    }

    const answers=Array.isArray(payload.answers)?payload.answers:[];
    if(rows){
      rows.innerHTML=answers.length?answers.map(item=>{
        const result=item.correct===true
          ? "<span class=\"quiz-result-correct\">CORRECT</span>"
          : "<span class=\"quiz-result-wrong\">INCORRECT</span>";
        const sourceUrl=String(item.source_url||"");
        const source=/^https:\/\//i.test(sourceUrl)
          ? "<a href=\""+escapeCell(sourceUrl)+"\" target=\"_blank\" rel=\"noopener noreferrer\">SOURCE ↗</a>"
          : "—";
        return "<tr>"+
          "<td>"+escapeCell(item.quiz_date||"—")+"</td>"+
          "<td>"+escapeCell(item.username||"—")+"</td>"+
          "<td>"+escapeCell(item.category||"—")+"</td>"+
          "<td class=\"admin-quiz-question\">"+escapeCell(item.question||"Question not stored for this attempt")+"</td>"+
          "<td>"+escapeCell(item.selected_answer||"—")+"</td>"+
          "<td class=\"admin-quiz-correct\">"+escapeCell(item.correct_answer||"—")+"</td>"+
          "<td>"+result+"</td>"+
          "<td>"+escapeCell(lastActive(item.answered_at))+"</td>"+
          "<td>"+source+"</td>"+
        "</tr>";
      }).join(""):"<tr><td colspan=\"9\">No recorded quiz attempts for this period.</td></tr>";
    }

    if(status){
      status.textContent="Updated "+new Date().toLocaleTimeString("en-GB",{
        hour:"2-digit",
        minute:"2-digit"
      })+" · "+(payload.period_label||period)+" · "+Number(payload.total||answers.length)+" attempts";
    }
  }catch(error){
    if(status)status.textContent=error.message||"Unable to load quiz history.";
    if(rows)rows.innerHTML="";
  }
}

async function loadAdmin(period){
  if(!isAdmin())return;

  const status=document.getElementById("adminUsageStatus");
  const rows=document.getElementById("adminUsageRows");
  const historyStatus=document.getElementById("adminQuizHistoryStatus");
  const historyRows=document.getElementById("adminQuizHistoryRows");
  const currentToken=token();

  if(!currentToken){
    if(status)status.textContent="Admin statistics require an authenticated Worker session. Sign in again.";
    if(rows)rows.innerHTML="";
    if(historyStatus)historyStatus.textContent="Admin quiz history requires an authenticated Worker session. Sign in again.";
    if(historyRows)historyRows.innerHTML="";
    return;
  }

  if(status)status.textContent="Loading usage statistics…";
  loadQuizHistory(period,currentToken);

  try{
    const response=await nativeFetch(
      API_BASE+"/usage-stats?period="+encodeURIComponent(period),
      {
        method:"GET",
        headers:{"X-Session-Token":currentToken}
      }
    );
    const payload=await response.json();

    if(!response.ok){
      throw new Error(payload.error||"Unable to load usage statistics.");
    }

    const summary=payload.summary||{};
    document.getElementById("adminActiveUsers").textContent=Number(summary.active_users||0);
    document.getElementById("adminSearches").textContent=Number(summary.searches||0);
    document.getElementById("adminReportRequests").textContent=Number(summary.report_requests||0);
    document.getElementById("adminAiReports").textContent=Number(summary.reports_generated||0);
    const quizAnswers=Number(summary.quiz_answers||0);
    const quizCorrect=Number(summary.quiz_correct||0);
    document.getElementById("adminQuizAnswers").textContent=quizAnswers;
    document.getElementById("adminQuizCorrect").textContent=quizCorrect;
    document.getElementById("adminQuizIncorrect").textContent=Number(summary.quiz_incorrect||0);
    document.getElementById("adminQuizScore").textContent=quizAnswers?Math.round(100*quizCorrect/quizAnswers)+"%":"—";

    if(rows){
      rows.innerHTML=(payload.users||[]).map(item=>`
        <tr>
          <td>${escapeCell(item.username||"")}</td>
          <td>${Number(item.logins||0)}</td>
          <td>${Number(item.searches||0)}</td>
          <td>${Number(item.report_requests||0)}</td>
          <td>${Number(item.reports_generated||0)}</td>
          <td>${Number(item.cached_reports||0)}</td>
          <td>${Number(item.quiz_answers||0)}</td>
          <td>${Number(item.quiz_correct||0)}</td>
          <td>${Number(item.quiz_incorrect||0)}</td>
          <td>${Number(item.quiz_answers||0)?Math.round(100*Number(item.quiz_correct||0)/Number(item.quiz_answers||0))+"%":"—"}</td>
          <td>${escapeCell(lastActive(item.last_activity))}</td>
        </tr>`).join("");
    }

    if(status){
      status.textContent="Updated "+new Date().toLocaleTimeString("en-GB",{
        hour:"2-digit",
        minute:"2-digit"
      })+" · "+(payload.period_label||period);
    }
  }catch(error){
    if(status)status.textContent=error.message||"Unable to load usage statistics.";
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
