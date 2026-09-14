(function(){
"use strict";

function esc(value){
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function ensureCss(){
  if(document.getElementById("dailyQuizCss"))return;
  const link=document.createElement("link");
  link.id="dailyQuizCss"; link.rel="stylesheet"; link.href="daily-quiz.css?v=1";
  document.head.appendChild(link);
}

async function inject(){
  if(document.getElementById("dailyQuiz"))return;
  ensureCss();
  let quiz;
  try{
    const response=await fetch("daily-quiz.json?ts="+Date.now(),{cache:"no-store"});
    if(!response.ok)throw new Error("Quiz unavailable");
    quiz=await response.json();
    if(!quiz.question||!Array.isArray(quiz.options)||quiz.options.length!==3)throw new Error("Invalid quiz");
  }catch(error){console.warn("Daily quiz unavailable:",error);return;}

  const host=document.getElementById("deepSearchButton")||document.getElementById("reportGeneratorButton");
  if(!host)return;
  const box=document.createElement("section");
  box.id="dailyQuiz";
  box.setAttribute("aria-label","Quiz of the Day");
  box.innerHTML=`
    <div class="daily-quiz-head">Quiz of the Day <span>${esc(quiz.category||"CT knowledge")}</span></div>
    <div class="daily-quiz-question">${esc(quiz.question)}</div>
    <div class="daily-quiz-options">${quiz.options.map((option,index)=>`<button class="daily-quiz-option" type="button" data-index="${index}">${esc(option)}</button>`).join("")}</div>
    <div class="daily-quiz-result" aria-live="polite"></div>`;
  host.insertAdjacentElement("afterend",box);

  box.querySelectorAll(".daily-quiz-option").forEach(button=>button.addEventListener("click",()=>{
    const chosen=Number(button.dataset.index);
    const correct=Number(quiz.correct_index);
    box.querySelectorAll(".daily-quiz-option").forEach((item,index)=>{
      item.disabled=true;
      if(index===correct)item.classList.add("correct");
      else if(index===chosen)item.classList.add("wrong");
    });
    const result=box.querySelector(".daily-quiz-result");
    const verdict=chosen===correct?"Correct.":"Incorrect.";
    const source=quiz.source_url?`<a class="daily-quiz-source" href="${esc(quiz.source_url)}" target="_blank" rel="noopener noreferrer">VERIFY SOURCE ↗</a>`:"";
    result.innerHTML=`<strong>${verdict}</strong> ${esc(quiz.explanation||"")}<br>${source}`;
    result.classList.add("visible");
  }));
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(inject,80));
else setTimeout(inject,80);
})();
