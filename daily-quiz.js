(function(){
'use strict';
const API='https://ct-report-generator.fairpeace.workers.dev';
let session='', box=null, busy=false, quiz=null, pending=null, answered=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const identity=()=>document.body.classList.contains('locked')?'':sessionStorage.getItem('ct_map_session_token')||'';
async function api(path,body){
  const token=session;
  const r=await fetch(API+path,{method:body?'POST':'GET',cache:'no-store',
    headers:{'X-Session-Token':token,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(token!==identity())throw new Error('Session changed.');
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||'Unable to confirm your answer.');
  return data;
}
function status(message){box.querySelector('.daily-quiz-result').textContent=message;box.querySelector('.daily-quiz-result').classList.add('visible');}
function lock(value){box.querySelectorAll('.daily-quiz-option').forEach(b=>b.disabled=value);}
function showAnswer(a){
  answered=true;pending=null;lock(true);
  box.querySelectorAll('.daily-quiz-option').forEach((b,i)=>{
    if(a.quiz_id===quiz.id && i===a.correct_index)b.classList.add('correct');
    else if(a.quiz_id===quiz.id && i===a.selected_index)b.classList.add('wrong');
  });
  const result=box.querySelector('.daily-quiz-result');
  result.innerHTML=`<strong>${a.correct?'Correct.':'Incorrect.'}</strong> First answer recorded. ${esc(a.explanation||'')}`;
  if(/^https:\/\//i.test(a.source_url||''))result.innerHTML+=`<br><a class="daily-quiz-source" href="${esc(a.source_url)}" target="_blank" rel="noopener noreferrer">VERIFY SOURCE ↗</a>`;
  result.classList.add('visible');
}
function retry(fn){
  const button=document.createElement('button');button.type='button';button.className='daily-quiz-option';button.textContent='RETRY CONFIRMATION';
  button.addEventListener('click',()=>{button.remove();fn();});box.querySelector('.daily-quiz-result').appendChild(button);
}
async function submit(index){
  if(busy||answered)return;
  busy=true;pending=index;lock(true);status('Saving your first answer…');
  try{showAnswer(await api('/quiz-answer',{quiz_id:quiz.id,selected_index:pending}));}
  catch(e){status(e.message+' No result is confirmed on this screen yet.');retry(()=>submit(pending));}
  finally{busy=false;}
}
async function load(){
  if(busy)return;busy=true;status('Loading your quiz and recorded attempt…');
  try{
    const data=await api('/quiz-state');quiz=data.quiz;
    box.querySelector('.daily-quiz-question').textContent=quiz.question;
    box.querySelector('.daily-quiz-head span').textContent=quiz.date;
    const options=box.querySelector('.daily-quiz-options');
    options.innerHTML=quiz.options.map((o,i)=>`<button class="daily-quiz-option" type="button" data-index="${i}">${esc(o)}</button>`).join('');
    options.querySelectorAll('button').forEach((b,i)=>b.addEventListener('click',()=>submit(i)));
    if(data.answered)showAnswer(data.answer);
    else status('Your first answer and score are visible to the administrator. Educational quiz, not a secure exam.');
  }catch(e){status(e.message);retry(load);}
  finally{busy=false;}
}
function check(){
  const token=identity();
  if(token===session && box)return;
  if(busy)return;
  if(box){box.remove();box=null;}session=token;answered=false;pending=null;
  const host=document.getElementById('deepSearchButton');
  if(!token||!host)return;
  if(!document.getElementById('dailyQuizCss')){
    const link=document.createElement('link');link.id='dailyQuizCss';link.rel='stylesheet';link.href='daily-quiz.css?v=2';document.head.appendChild(link);
  }
  box=document.createElement('section');box.id='dailyQuiz';box.setAttribute('aria-label','Quiz of the Day');
  box.innerHTML='<div class="daily-quiz-head">Quiz of the Day <span></span></div><div class="daily-quiz-question"></div><div class="daily-quiz-options"></div><div class="daily-quiz-result visible" aria-live="polite"></div>';
  host.insertAdjacentElement('afterend',box);load();
}
setInterval(check,1000);check();
})();
