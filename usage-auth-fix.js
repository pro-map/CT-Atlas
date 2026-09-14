(function(){
"use strict";

const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
const EXPIRY_KEY="ct_map_session_expires";
const priorFetch=window.fetch.bind(window);
const protectedPath=/\/((?:session-check|session-revoke|login|report|deep-search|quick-ask|feedback|usage-record|usage-stats|quiz-state|quiz-answer|quiz-history|quiz-answer-record))(?:\?|$)/;

function sessionToken(){
  return String(sessionStorage.getItem(TOKEN_KEY)||"");
}

function currentUser(){
  return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();
}

function refreshAdminUsageButton(){
  const button=document.getElementById("adminUsageButton");
  if(button) button.hidden=currentUser()!=="admin";
}

function lockLocalSession(){
  sessionStorage.removeItem("ct_map_authorized");
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
  document.body.classList.add("locked");
  const screen=document.getElementById("access-screen");
  if(screen) screen.style.display="flex";
  const label=document.getElementById("sessionUserLabel");
  if(label) label.textContent="";
  const error=document.getElementById("access-error");
  if(error) error.textContent="Session expired. Please sign in again.";
}

window.fetch=async function(input,init){
  const url=typeof input==="string"?input:String(input?.url||"");
  const options=init?{...init}:{};
  const token=sessionToken();

  if(token&&protectedPath.test(url)&&!/\/session-revoke(?:\?|$)/.test(url)){
    const headers=new Headers(options.headers||{});
    headers.set("X-Session-Token",token);
    options.headers=headers;
  }

  const response=await priorFetch(input,options);
  if(response.status===401&&protectedPath.test(url)&&!/\/auth-login(?:\?|$)/.test(url)){
    lockLocalSession();
    refreshAdminUsageButton();
  }
  return response;
};

function loadDeepSearch(){
  if(document.getElementById("deepSearchClientScript"))return;
  const script=document.createElement("script");
  script.id="deepSearchClientScript";
  script.src="deep-search.js?v=2";
  script.defer=true;
  document.head.appendChild(script);
}

function loadQuickAsk(){
  if(document.getElementById("quickAskClientScript"))return;
  const script=document.createElement("script");
  script.id="quickAskClientScript";
  script.src="quick-ask.js?v=2";
  script.defer=true;
  document.head.appendChild(script);
}

function loadFeedback(){
  if(document.getElementById("feedbackClientScript"))return;
  const script=document.createElement("script");
  script.id="feedbackClientScript";
  script.src="feedback.js?v=2";
  script.defer=true;
  document.head.appendChild(script);
}

function loadDailyQuiz(){
  if(document.getElementById("dailyQuizClientScript"))return;
  const script=document.createElement("script");
  script.id="dailyQuizClientScript";
  script.src="daily-quiz.js?v=4";
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
