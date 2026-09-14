(function(){
"use strict";
const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const TOKEN_EXPIRY_KEY="ct_map_session_expires";
const USER_KEY="ct_map_username";
let secureAuthPromise=null;
const priorFetch=window.fetch.bind(window);

function sessionToken(){
  return String(sessionStorage.getItem(TOKEN_KEY)||"");
}

function currentUser(){
  return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();
}

function refreshAdminUsageButton(){
  const button=document.getElementById("adminUsageButton");
  if(button){
    button.hidden=currentUser()!=="admin";
  }
}

function scheduleAdminButtonRefresh(){
  [0,50,250,750,1500].forEach(delay=>setTimeout(refreshAdminUsageButton,delay));
}

async function secureWorkerAuth(){
  const username=String(document.getElementById("access-username")?.value||"").trim().toLowerCase();
  const password=String(document.getElementById("access-password")?.value||"");
  if(!username||!password)return null;
  if(secureAuthPromise)return secureAuthPromise;

  secureAuthPromise=(async()=>{
    try{
      const response=await priorFetch(API_BASE+"/auth-login",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          username,
          password,
          client_time:new Date().toISOString(),
          user_agent:navigator.userAgent
        })
      });
      const payload=await response.json().catch(()=>({}));
      if(response.ok&&payload.session_token){
        sessionStorage.setItem(TOKEN_KEY,String(payload.session_token));
        if(payload.expires_at){
          sessionStorage.setItem(TOKEN_EXPIRY_KEY,String(payload.expires_at));
        }
        scheduleAdminButtonRefresh();
        return String(payload.session_token);
      }
    }catch(error){
      console.warn("Secure Worker authentication unavailable:",error);
    }finally{
      setTimeout(()=>{secureAuthPromise=null;},600);
    }
    return null;
  })();

  return secureAuthPromise;
}

document.addEventListener("click",event=>{
  if(event.target?.id==="access-button"){
    secureWorkerAuth();
    scheduleAdminButtonRefresh();
  }
},true);

document.addEventListener("keydown",event=>{
  if(event.key==="Enter"&&event.target?.id==="access-password"){
    secureWorkerAuth();
    scheduleAdminButtonRefresh();
  }
},true);

window.fetch=async function(input,init){
  const url=typeof input==="string"?input:String(input?.url||"");
  const options=init?{...init}:{};
  if(/\/login(?:\?|$)/.test(url)&&secureAuthPromise){
    try{await secureAuthPromise;}catch(_){}
  }
  const token=sessionToken();
  if(token&&(/\/login(?:\?|$)/.test(url)||/\/(?:report|deep-search|quick-ask|feedback)(?:\?|$)/.test(url))){
    const headers=new Headers(options.headers||{});
    headers.set("X-Session-Token",token);
    options.headers=headers;
  }
  return priorFetch(input,options);
};

function loadDeepSearch(){
  if(document.getElementById("deepSearchClientScript"))return;
  const script=document.createElement("script");
  script.id="deepSearchClientScript";
  script.src="deep-search.js?v=1";
  script.defer=true;
  document.head.appendChild(script);
}

function loadQuickAsk(){
  if(document.getElementById("quickAskClientScript"))return;
  const script=document.createElement("script");
  script.id="quickAskClientScript";
  script.src="quick-ask.js?v=1";
  script.defer=true;
  document.head.appendChild(script);
}

function loadFeedback(){
  if(document.getElementById("feedbackClientScript"))return;
  const script=document.createElement("script");
  script.id="feedbackClientScript";
  script.src="feedback.js?v=1";
  script.defer=true;
  document.head.appendChild(script);
}

function loadDailyQuiz(){
  if(document.getElementById("dailyQuizClientScript"))return;
  const script=document.createElement("script");
  script.id="dailyQuizClientScript";
  script.src="daily-quiz.js?v=1";
  script.defer=true;
  document.head.appendChild(script);
}

document.addEventListener("DOMContentLoaded",()=>{
  refreshAdminUsageButton();
  loadDeepSearch();
  loadDailyQuiz();
  loadQuickAsk();
  loadFeedback();
  setInterval(refreshAdminUsageButton,1000);
});
})();
