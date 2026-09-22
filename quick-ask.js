(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
let backendReady=false;
let lastPayload=null;

function esc(value){
  return String(value??"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function token(){return String(sessionStorage.getItem(TOKEN_KEY)||"");}
function user(){return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();}

function fmtDate(value){
  if(!value)return "";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return String(value);
  return date.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
}

function ensureCss(){
  if(document.getElementById("quickAskCss"))return;
  const link=document.createElement("link");
  link.id="quickAskCss";
  link.rel="stylesheet";
  link.href="quick-ask.css?v=1";
  document.head.appendChild(link);
}

// Anchors off the small "Download Map" layer button (static markup, always
// present) so CT Atlas AI sits at that same small size, right beside it.
function findAnchor(){
  return document.getElementById("downloadMapButton");
}

function inject(){
  ensureCss();
  if(document.getElementById("quickAskPanel"))return;

  const anchor=findAnchor();
  if(!anchor){setTimeout(inject,150);return;}

  if(!document.getElementById("quickAskButton")){
    const button=document.createElement("button");
    button.id="quickAskButton";
    button.type="button";
    button.className="layer-button";
    button.textContent="CT ATLAS AI";
    anchor.insertAdjacentElement("afterend",button);
  }

  document.body.insertAdjacentHTML("beforeend",`
    <div id="quickAskPanel" aria-hidden="true">
      <div id="quickAskWindow" role="dialog" aria-modal="true" aria-labelledby="quickAskTitle">
        <div id="quickAskHeader">
          <div>
            <div id="quickAskTitle">CT ATLAS AI</div>
            <div id="quickAskSubtitle">Gemini-based CT Atlas AI for quick counter-terrorism questions -- not for long analyses. Use Deep Search or the Report Generator for in-depth work.</div>
          </div>
          <button id="quickAskClose" type="button" aria-label="Close CT Atlas AI">×</button>
        </div>
        <div id="quickAskBody">
          <label class="qa-field">
            <span>QUESTION</span>
            <textarea id="quickAskQuestion" rows="3" maxlength="400" placeholder="Example: What is the current threat in Iraq? Quick info on the recent attack in Bamako?"></textarea>
          </label>
          <button id="quickAskRun" type="button">ASK</button>
          <div id="quickAskStatus"></div>

          <div id="quickAskAnswerBlock" hidden>
            <div id="quickAskAnswerTopline">
              <div id="quickAskGroundBadge"></div>
              <div id="quickAskActions">
                <button id="quickAskCopy" type="button">COPY</button>
                <button id="quickAskPdf" type="button">DOWNLOAD PDF</button>
              </div>
            </div>
            <div id="quickAskAnswerText"></div>
            <div id="quickAskCitedEvents"></div>
          </div>

          <div id="quickAskDisclaimer">
            CT Atlas AI is a fast assistant based on Gemini for quick counter-terrorism questions. It is not Deep Search or the Report Generator and is not meant for long analyses. Answers may draw on general knowledge as well as CT Atlas data, are not verified intelligence, and should be independently checked before operational use.
          </div>
        </div>
      </div>
    </div>`);

  document.getElementById("quickAskButton")?.addEventListener("click",open);
  document.getElementById("quickAskClose")?.addEventListener("click",close);
  document.getElementById("quickAskPanel")?.addEventListener("click",event=>{if(event.target.id==="quickAskPanel")close();});
  document.getElementById("quickAskRun")?.addEventListener("click",run);
  document.getElementById("quickAskCopy")?.addEventListener("click",copyAnswer);
  document.getElementById("quickAskPdf")?.addEventListener("click",downloadAnswerPdf);
  document.getElementById("quickAskQuestion")?.addEventListener("keydown",event=>{
    if((event.ctrlKey||event.metaKey)&&event.key==="Enter")run();
  });
  checkBackend();
}

async function checkBackend(){
  const button=document.getElementById("quickAskButton");
  if(!button)return;
  try{
    const response=await fetch(API_BASE+"/health",{cache:"no-store"});
    const payload=await response.json().catch(()=>({}));
    backendReady=Boolean(response.ok&&payload.quick_ask_version);
  }catch(_){backendReady=false;}
  button.textContent="CT ATLAS AI";
  if(backendReady){
    button.disabled=false; button.title="Fast Gemini-based CT Atlas AI for quick counter-terrorism questions -- not for long analyses.";
  }else{
    button.disabled=true;
    button.title="CT Atlas AI backend is not currently available.";
  }
}

function open(){
  const panel=document.getElementById("quickAskPanel");
  panel?.classList.add("open"); panel?.setAttribute("aria-hidden","false");
  setTimeout(()=>document.getElementById("quickAskQuestion")?.focus(),30);
}
function close(){
  const panel=document.getElementById("quickAskPanel");
  panel?.classList.remove("open"); panel?.setAttribute("aria-hidden","true");
}
function setStatus(message,type=""){
  const status=document.getElementById("quickAskStatus");
  if(!status)return;
  status.textContent=message; status.className=type?"qa-status "+type:"qa-status";
}

function render(payload){
  lastPayload=payload;
  const block=document.getElementById("quickAskAnswerBlock");
  if(block)block.hidden=false;

  const citedEvents=Array.isArray(payload.cited_events)?payload.cited_events:[];
  const grounded=Boolean(payload.grounded_in_ct_atlas_data)&&citedEvents.length>0;

  const badge=document.getElementById("quickAskGroundBadge");
  if(badge){
    badge.textContent=grounded?"GROUNDED IN CT ATLAS DATA":"GENERAL KNOWLEDGE · NOT FROM CT ATLAS DATABASE";
    badge.className="qa-badge "+(grounded?"grounded":"general");
  }

  const answerBox=document.getElementById("quickAskAnswerText");
  if(answerBox)answerBox.textContent=String(payload.answer||"");

  const citedBox=document.getElementById("quickAskCitedEvents");
  if(citedBox){
    citedBox.innerHTML=citedEvents.length?(
      `<div class="qa-cited-head">CT ATLAS RECORDS USED</div>`+
      citedEvents.map(item=>`
        <div class="qa-cited-item">
          <span class="qa-cited-title">${esc(item.title||item.id||"Untitled event")}</span>
          <span class="qa-cited-meta">${esc(item.country||"")}${item.date?` · ${esc(fmtDate(item.date))}`:""}${item.source?` · ${esc(item.source)}`:""}</span>
          ${item.url?`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">OPEN</a>`:""}
        </div>`).join("")
    ):"";
  }
}

async function copyAnswer(){
  if(!lastPayload)return;
  const question=String(document.getElementById("quickAskQuestion")?.value||"").trim();
  const cited=Array.isArray(lastPayload.cited_events)?lastPayload.cited_events:[];
  const sources=cited.map(item=>{
    const label=String(item.title||item.id||"Untitled event");
    return label+(item.url?"\n"+String(item.url):"");
  }).join("\n\n");
  const text="CT ATLAS AI\n\nQUESTION\n"+question+"\n\nANSWER\n"+String(lastPayload.answer||"")+(sources?"\n\nCT ATLAS RECORDS USED\n"+sources:"");
  try{
    await navigator.clipboard.writeText(text);
    setStatus("Question and answer copied to clipboard.","success");
  }catch(_){
    setStatus("Clipboard access was unavailable.","warning");
  }
}

async function downloadAnswerPdf(){
  if(!lastPayload)return;
  const button=document.getElementById("quickAskPdf");
  const original=button?.textContent||"DOWNLOAD PDF";
  const pdf=window.CTAtlasPdf;
  if(!pdf){setStatus("PDF export is not available. Reload CT Atlas and retry.","error");return;}
  if(button){button.disabled=true;button.textContent="BUILDING PDF…";}
  try{
    const question=String(document.getElementById("quickAskQuestion")?.value||"").trim();
    const cited=Array.isArray(lastPayload.cited_events)?lastPayload.cited_events:[];
    const grounded=Boolean(lastPayload.grounded_in_ct_atlas_data)&&cited.length>0;
    const blocks=[
      {text:"QUESTION",type:"heading"},
      {text:question,type:"question"},
      {text:grounded?"GROUNDED IN CT ATLAS DATA":"GENERAL KNOWLEDGE · NOT FROM CT ATLAS DATABASE",type:"badge"},
      {text:"ANSWER",type:"heading"},
      {text:String(lastPayload.answer||""),type:"body"}
    ];
    if(cited.length){
      blocks.push({text:"CT ATLAS RECORDS USED",type:"heading"});
      cited.forEach(item=>{
        const lines=[
          String(item.title||item.id||"Untitled event"),
          [item.country||"",item.date?fmtDate(item.date):"",item.source||""].filter(Boolean).join(" · ")
        ];
        if(item.url)lines.push(String(item.url));
        blocks.push({text:lines.filter(Boolean).join("\n"),type:"source"});
      });
    }
    const stamp=new Date().toISOString().replace(/[:T]/g,"-").slice(0,16);
    await pdf.download({
      filename:"CT-Atlas-AI-"+stamp+"-"+pdf.safeFilename(question.slice(0,55),"Question"),
      eyebrow:"CT ATLAS · AI QUESTION",
      title:"CT ATLAS AI",
      meta:new Date().toLocaleString("en-GB"),
      blocks,
      footer:document.getElementById("quickAskDisclaimer")?.textContent||"AI-assisted answer. Independently verify before operational use."
    });
    setStatus("PDF downloaded successfully.","success");
  }catch(error){
    setStatus(error?.message||"PDF download failed.","error");
  }finally{
    if(button){button.disabled=false;button.textContent=original;}
  }
}

async function run(){
  if(!backendReady){setStatus("CT Atlas AI backend is not available.","warning");return;}
  const question=String(document.getElementById("quickAskQuestion")?.value||"").trim();
  const username=user(), sessionToken=token(), button=document.getElementById("quickAskRun");
  if(question.length<4){setStatus("Enter a question.","warning");return;}
  if(!username||!sessionToken){setStatus("CT Atlas AI requires an authenticated CT Atlas session. Sign in again.","error");return;}

  if(button){button.disabled=true;button.textContent="THINKING…";}
  const block=document.getElementById("quickAskAnswerBlock");
  if(block)block.hidden=true;
  lastPayload=null;
  setStatus("Asking CT Atlas AI…","working");

  try{
    const response=await fetch(API_BASE+"/quick-ask",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Session-Token":sessionToken},
      body:JSON.stringify({user_id:username,question})
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const retry=Number(payload.retry_after_seconds||0);
      throw new Error((payload.error||"CT Atlas AI failed.")+(retry?` Retry in approximately ${Math.ceil(retry/60)} minute(s).`:""));
    }
    render(payload);
    setStatus(payload.cached?"Answer retrieved from cache.":"CT Atlas AI answered.","success");
  }catch(error){setStatus(error?.message||"CT Atlas AI failed.","error");}
  finally{if(button){button.disabled=false;button.textContent="ASK";}}
}

document.addEventListener("keydown",event=>{if(event.key==="Escape")close();});
document.addEventListener("DOMContentLoaded",inject);
if(document.readyState!=="loading")inject();
})();
