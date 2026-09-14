(function(){
"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
let session="", panel=null, trigger=null, busy=false, quiz=null, pending=null, answered=false, loadedForSession="";
const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const identity=()=>document.body.classList.contains("locked")?"":sessionStorage.getItem("ct_map_session_token")||"";
async function api(path,body){
  const token=session;
  const r=await fetch(API+path,{method:body?"POST":"GET",cache:"no-store",headers:{"X-Session-Token":token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(token!==identity())throw new Error("Session changed.");
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||"Unable to confirm your answer.");
  return data;
}
function result(){return panel?.querySelector(".daily-quiz-result");}
function status(message){const node=result();if(!node)return;node.textContent=message;node.classList.add("visible");}
function lock(value){panel?.querySelectorAll(".daily-quiz-option").forEach(button=>button.disabled=value);}
function showAnswer(answer){
  answered=true;pending=null;lock(true);
  panel?.querySelectorAll(".daily-quiz-option").forEach((button,index)=>{
    if(answer.quiz_id===quiz.id&&index===answer.correct_index)button.classList.add("correct");
    else if(answer.quiz_id===quiz.id&&index===answer.selected_index)button.classList.add("wrong");
  });
  const node=result();
  if(!node)return;
  node.innerHTML="<strong>"+(answer.correct?"Correct.":"Incorrect.")+"</strong> First answer recorded. "+esc(answer.explanation||"");
  if(/^https:\/\//i.test(answer.source_url||""))node.innerHTML+="<br><a class=\"daily-quiz-source\" href=\""+esc(answer.source_url)+"\" target=\"_blank\" rel=\"noopener noreferrer\">VERIFY SOURCE ↗</a>";
  node.classList.add("visible");
}
function retry(fn){
  const button=document.createElement("button");button.type="button";button.className="daily-quiz-option daily-quiz-retry";button.textContent="RETRY CONFIRMATION";
  button.addEventListener("click",()=>{button.remove();fn();});
  result()?.appendChild(button);
}
async function submit(index){
  if(busy||answered||!quiz)return;
  busy=true;pending=index;lock(true);status("Saving your first answer…");
  try{showAnswer(await api("/quiz-answer",{quiz_id:quiz.id,selected_index:pending}));}
  catch(error){status(error.message+" No result is confirmed on this screen yet.");retry(()=>submit(pending));}
  finally{busy=false;}
}
async function load(){
  if(busy||!panel)return;
  busy=true;status("Loading your quiz and recorded attempt…");
  try{
    const data=await api("/quiz-state");quiz=data.quiz;
    panel.querySelector(".daily-quiz-question").textContent=quiz.question;
    panel.querySelector(".daily-quiz-head span:last-child").textContent=quiz.date;
    const options=panel.querySelector(".daily-quiz-options");
    options.innerHTML=quiz.options.map((option,index)=>"<button class=\"daily-quiz-option\" type=\"button\" data-index=\""+index+"\">"+esc(option)+"</button>").join("");
    options.querySelectorAll("button").forEach((button,index)=>button.addEventListener("click",()=>submit(index)));
    if(data.answered)showAnswer(data.answer);
    else status("Your first answer and score are visible to the administrator. Educational quiz, not a secure exam.");
  }catch(error){status(error.message);retry(load);}
  finally{busy=false;}
}
function openQuiz(){
  if(!panel)return;
  panel.classList.add("open");panel.setAttribute("aria-hidden","false");
  if(!quiz&&!busy)load();
}
function closeQuiz(){
  if(!panel)return;
  panel.classList.remove("open");panel.setAttribute("aria-hidden","true");
}
function cleanup(){
  panel?.remove();trigger?.remove();panel=null;trigger=null;quiz=null;pending=null;answered=false;loadedForSession="";
}
function ensureUi(){
  const launcher=document.getElementById("healthStatusLauncher");
  if(!launcher)return false;
  if(!document.getElementById("dailyQuizCss")){
    const link=document.createElement("link");link.id="dailyQuizCss";link.rel="stylesheet";link.href="daily-quiz.css?v=3";document.head.appendChild(link);
  }
  trigger=document.getElementById("dailyQuizButton");
  if(!trigger){
    trigger=document.createElement("button");trigger.id="dailyQuizButton";trigger.type="button";trigger.textContent="QUIZ OF THE DAY";trigger.setAttribute("aria-haspopup","dialog");
    launcher.insertBefore(trigger,launcher.firstChild);trigger.addEventListener("click",openQuiz);
  }
  panel=document.getElementById("dailyQuizPanel");
  if(!panel){
    document.body.insertAdjacentHTML("beforeend","<div id=\"dailyQuizPanel\" aria-hidden=\"true\"><div id=\"dailyQuizWindow\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"dailyQuizTitle\"><div id=\"dailyQuizHeader\"><div><div id=\"dailyQuizTitle\">QUIZ OF THE DAY</div><div id=\"dailyQuizSubtitle\">CT Atlas · daily terrorism knowledge check</div></div><button id=\"dailyQuizClose\" type=\"button\" aria-label=\"Close quiz\">×</button></div><div id=\"dailyQuizBody\"><div class=\"daily-quiz-head\"><span>QUESTION</span><span></span></div><div class=\"daily-quiz-question\"></div><div class=\"daily-quiz-options\"></div><div class=\"daily-quiz-result visible\" aria-live=\"polite\"></div></div></div></div>");
    panel=document.getElementById("dailyQuizPanel");
    document.getElementById("dailyQuizClose")?.addEventListener("click",closeQuiz);
    panel?.addEventListener("click",event=>{if(event.target===panel)closeQuiz();});
  }
  return true;
}
function check(){
  const token=identity();
  if(token!==session){cleanup();session=token;}
  if(!token)return;
  if(!ensureUi())return;
  if(loadedForSession!==token&&!busy){loadedForSession=token;load();}
}
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeQuiz();});
setInterval(check,1000);check();
})();