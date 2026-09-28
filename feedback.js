(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const FEEDBACK_VERSION="feedback-v3-tab-feedback";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
let backendReady=false;

function token(){return String(sessionStorage.getItem(TOKEN_KEY)||"");}
function user(){return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();}

function ensureCss(){
  if(document.getElementById("feedbackCss"))return;
  const link=document.createElement("link");
  link.id="feedbackCss";
  link.rel="stylesheet";
  link.href="feedback.css?v=20260928";
  document.head.appendChild(link);
}

function ratingScale(){
  return [1,2,3,4,5].map(function(value){
    return '<label class="fb-scale-opt"><input type="radio" name="fbOverallRating" value="'+value+'"><span>'+value+'</span></label>';
  }).join("");
}

function inject(){
  ensureCss();
  const button=document.getElementById("feedbackButton");
  if(!button||document.getElementById("feedbackPanel"))return;

  document.body.insertAdjacentHTML("beforeend",
    '<div id="feedbackPanel" aria-hidden="true">'+
      '<div id="feedbackWindow" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle">'+
        '<div id="feedbackHeader">'+
          '<div>'+
            '<div id="feedbackTitle">SEND FEEDBACK / REPORT BUG</div>'+
            '<div id="feedbackSubtitle">Choose a workspace and send an overall rating, a comment, a bug report, or both.</div>'+
          '</div>'+
          '<button id="feedbackClose" type="button" aria-label="Close feedback">×</button>'+
        '</div>'+
        '<div id="feedbackBody">'+
          '<label class="fb-field">'+
            '<span>WORKSPACE / TAB</span>'+
            '<select id="fbWorkspace">'+
              '<option value="general">General · all CT Atlas</option>'+
              '<option value="map">Intelligence Map</option>'+
              '<option value="crypto">Crypto Intelligence</option>'+
              '<option value="facial">Facial Intelligence</option>'+
              '<option value="social">Social Media (Beta)</option>'+
            '</select>'+
          '</label>'+
          '<label class="fb-toggle"><input id="fbIncludeRating" type="checkbox"><span>Include an overall evaluation</span></label>'+
          '<div id="fbRatingFields" class="fb-reveal" hidden>'+
            '<div class="fb-prompt">How would you rate this workspace overall?</div>'+
            '<div class="fb-scale" role="radiogroup" aria-label="Overall evaluation from one to five">'+ratingScale()+'</div>'+
            '<div class="fb-hint">1 = poor · 5 = excellent</div>'+
          '</div>'+
          '<label class="fb-toggle"><input id="fbIncludeText" type="checkbox"><span>Add a comment or report a bug</span></label>'+
          '<div id="fbTextFields" class="fb-reveal" hidden>'+
            '<label class="fb-field">'+
              '<span>MESSAGE TYPE</span>'+
              '<select id="fbFeedbackType"><option value="comment">Comment</option><option value="bug">Report a bug</option></select>'+
            '</label>'+
            '<label class="fb-field">'+
              '<span>COMMENT OR BUG DESCRIPTION</span>'+
              '<textarea id="fbDescription" maxlength="3000" placeholder="Describe your comment or the bug, including what you expected and what happened."></textarea>'+
            '</label>'+
          '</div>'+
          '<div id="feedbackBackendStatus" class="fb-backend-status" aria-live="polite">Checking feedback service…</div>'+
          '<button id="feedbackSubmit" class="fb-submit" type="button">SEND</button>'+
          '<div id="feedbackStatus" class="fb-status" aria-live="polite"></div>'+
        '</div>'+
      '</div>'+
    '</div>');

  button.addEventListener("click",open);
  document.getElementById("feedbackClose")?.addEventListener("click",close);
  document.getElementById("feedbackSubmit")?.addEventListener("click",submit);
  document.getElementById("feedbackPanel")?.addEventListener("click",function(event){
    if(event.target.id==="feedbackPanel")close();
  });
  document.getElementById("fbIncludeRating")?.addEventListener("change",function(){
    document.getElementById("fbRatingFields").hidden=!this.checked;
  });
  document.getElementById("fbIncludeText")?.addEventListener("change",function(){
    document.getElementById("fbTextFields").hidden=!this.checked;
  });
  checkBackend();
}

async function checkBackend(){
  const status=document.getElementById("feedbackBackendStatus");
  const submitButton=document.getElementById("feedbackSubmit");
  try{
    const response=await fetch(API_BASE+"/health",{cache:"no-store"});
    const payload=await response.json().catch(function(){return {};});
    backendReady=Boolean(response.ok&&payload.feedback_version===FEEDBACK_VERSION);
  }catch(_){backendReady=false;}
  if(submitButton)submitButton.disabled=!backendReady;
  if(status){
    status.textContent=backendReady
      ?"Feedback service ready. Your message is sent to the CT Atlas administrator."
      :"Feedback service is updating or unavailable. Please try again shortly.";
    status.className=backendReady?"fb-backend-status ready":"fb-backend-status warning";
  }
}

function open(){
  const panel=document.getElementById("feedbackPanel");
  panel?.classList.add("open");
  panel?.setAttribute("aria-hidden","false");
  checkBackend();
  document.getElementById("fbWorkspace")?.focus();
}

function close(){
  const panel=document.getElementById("feedbackPanel");
  panel?.classList.remove("open");
  panel?.setAttribute("aria-hidden","true");
}

function setStatus(message,type){
  const status=document.getElementById("feedbackStatus");
  if(!status)return;
  status.textContent=message;
  status.className="fb-status"+(type?" "+type:"");
}

function ratingValue(){
  const checked=document.querySelector('input[name="fbOverallRating"]:checked');
  return checked?Number(checked.value):null;
}

async function submit(){
  if(!backendReady){
    setStatus("Feedback service is not ready yet. Please try again shortly.","warning");
    checkBackend();
    return;
  }

  const username=user();
  const sessionToken=token();
  if(!username||!sessionToken){
    setStatus("Sending feedback requires an authenticated CT Atlas session. Sign in again.","error");
    return;
  }

  const includeRating=Boolean(document.getElementById("fbIncludeRating")?.checked);
  const includeText=Boolean(document.getElementById("fbIncludeText")?.checked);
  if(!includeRating&&!includeText){
    setStatus("Choose an overall evaluation, a comment or bug report, or both.","warning");
    return;
  }

  const rating=includeRating?ratingValue():null;
  if(includeRating&&!rating){
    setStatus("Select an overall rating from 1 to 5.","warning");
    return;
  }

  const description=includeText?String(document.getElementById("fbDescription")?.value||"").trim():"";
  if(includeText&&!description){
    setStatus("Write a comment or describe the bug before sending.","warning");
    return;
  }

  const button=document.getElementById("feedbackSubmit");
  const payload={
    user_id:username,
    kind:includeRating?"evaluation":"issue",
    workspace:String(document.getElementById("fbWorkspace")?.value||"general"),
    rating:rating,
    feedback_type:includeText?String(document.getElementById("fbFeedbackType")?.value||"comment"):"",
    description:description
  };

  if(button){button.disabled=true;button.textContent="SENDING…";}
  setStatus("Sending…","working");

  try{
    const response=await fetch(API_BASE+"/feedback",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Session-Token":sessionToken},
      body:JSON.stringify(payload)
    });
    const result=await response.json().catch(function(){return {};});
    if(!response.ok){
      const retry=Number(result.retry_after_seconds||0);
      throw new Error((result.error||"Sending feedback failed.")+(retry?" Retry in approximately "+Math.ceil(retry/60)+" minute(s).":""));
    }

    setStatus("Thank you. Your feedback has been sent.","success");
    document.getElementById("fbIncludeRating").checked=false;
    document.getElementById("fbIncludeText").checked=false;
    document.getElementById("fbRatingFields").hidden=true;
    document.getElementById("fbTextFields").hidden=true;
    document.querySelectorAll('#feedbackPanel input[name="fbOverallRating"]').forEach(function(input){input.checked=false;});
    document.getElementById("fbDescription").value="";
  }catch(error){
    setStatus(error?.message||"Sending feedback failed.","error");
  }finally{
    if(button){button.disabled=!backendReady;button.textContent="SEND";}
  }
}

document.addEventListener("keydown",function(event){if(event.key==="Escape")close();});
document.addEventListener("DOMContentLoaded",inject);
if(document.readyState!=="loading")inject();
})();