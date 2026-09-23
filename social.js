(function(){
"use strict";

const API="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
let currentReport=null;
let reports=[];

const $=id=>document.getElementById(id);
const token=()=>String(sessionStorage.getItem(TOKEN_KEY)||"");
const user=()=>String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

function authHeaders(extra={}){
  return {"Content-Type":"application/json","X-Session-Token":token(),...extra};
}

function setStatus(message,type=""){
  const el=$("socialStatus");
  el.textContent=message||"";
  el.className="social-status"+(type?" "+type:"");
}

function listValue(id){
  return String($(id)?.value||"").split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean);
}

function formPayload(){
  return {
    user_id:user(),
    mode:$("socialMode").value,
    target:$("socialTarget").value.trim(),
    usernames:listValue("socialUsernames"),
    keywords:listValue("socialKeywords"),
    platforms:Array.from(document.querySelectorAll('input[name="platform"]:checked')).map(x=>x.value),
    urls:String($("socialUrls").value||"").split(/\n+/).map(x=>x.trim()).filter(Boolean),
    countries_regions:listValue("socialRegions"),
    languages:listValue("socialLanguages"),
    date_from:$("socialFrom").value,
    date_to:$("socialTo").value,
    objective:$("socialObjective").value.trim()
  };
}

function sourceLinks(urls){
  return (urls||[]).map(url=>'<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(url)+'</a>').join("<br>");
}

function renderReport(report){
  currentReport=report;
  $("socialEmpty").hidden=true;
  $("socialReport").hidden=false;
  $("reportTitle").textContent=report.title||"SOCMINT Assessment";
  $("reportMeta").textContent=[
    new Date(report.generated_at||Date.now()).toLocaleString(),
    report.model||"",
    report.discovery_mode||""
  ].filter(Boolean).join(" · ");

  const prose={
    reportExecutive:"executive_assessment",
    reportCoverage:"source_coverage",
    reportIdentity:"identity_alias_findings",
    reportNetwork:"network_associations",
    reportNarrative:"content_narrative",
    reportTimeline:"activity_timeline",
    reportLocations:"locations_travel_signals",
    reportFinancial:"financial_crypto_indicators",
    reportCt:"ct_relevance",
    reportGaps:"analytical_gaps"
  };
  for(const [id,key] of Object.entries(prose)) $(id).textContent=report[key]||"No supported finding.";

  $("reportFindings").innerHTML=(report.key_findings||[]).length
    ? (report.key_findings||[]).map(item=>`
      <div class="finding">
        <div class="finding-top">
          <div class="finding-title">${esc(item.finding)}</div>
          <span class="confidence ${esc(item.confidence)}">${esc(item.confidence)}</span>
        </div>
        <div class="finding-basis">${esc(item.basis)}</div>
        ${(item.source_urls||[]).length?'<div class="finding-basis">'+sourceLinks(item.source_urls)+'</div>':""}
      </div>`).join("")
    : '<div class="empty-state">No supported key findings.</div>';

  $("reportEntities").innerHTML=(report.entities||[]).length
    ? (report.entities||[]).map(item=>`
      <tr>
        <td>${esc(item.type)}</td>
        <td>${esc(item.value)}${(item.source_urls||[]).length?'<div class="finding-basis">'+sourceLinks(item.source_urls)+'</div>':""}</td>
        <td>${esc(item.platform||"—")}</td>
        <td><span class="confidence ${esc(item.confidence)}">${esc(item.confidence)}</span></td>
        <td>${esc(item.basis)}</td>
      </tr>`).join("")
    : '<tr><td colspan="5">No supported entities extracted.</td></tr>';

  $("reportWatchpoints").innerHTML=(report.watchpoints||[]).length
    ? report.watchpoints.map(item=>`
      <div class="watch">
        <div class="watch-title">${esc(item.issue)}</div>
        <div class="watch-indicator"><strong>INDICATOR:</strong> ${esc(item.indicator)}</div>
      </div>`).join("")
    : '<div class="empty-state">No watchpoints generated.</div>';

  $("reportSources").innerHTML=(report.sources||[]).length
    ? report.sources.map(source=>`
      <div class="source-item">
        <a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title||source.url)}</a>
        <div class="source-kind">${esc(source.kind||"public source")}</div>
        ${source.snippet?'<div class="source-snippet">'+esc(source.snippet)+'</div>':""}
      </div>`).join("")
    : '<div class="empty-state">No retrievable public source URLs were returned.</div>';

  window.scrollTo({top:0,behavior:"smooth"});
}

function renderHistory(){
  const box=$("socialHistory");
  if(!reports.length){
    box.innerHTML='<div class="empty-state">No saved SOCMINT reports yet.</div>';
    return;
  }
  box.innerHTML=reports.map(report=>`
    <div class="history-item" data-report-id="${esc(report.id)}">
      <div>
        <div class="history-item-title">${esc(report.title||report.query?.target||"SOCMINT Assessment")}</div>
        <div class="history-item-meta">${esc(new Date(report.generated_at||Date.now()).toLocaleString())} · ${esc(report.query?.target||"")}</div>
      </div>
      <button class="history-delete" data-delete-id="${esc(report.id)}" type="button" title="Delete">×</button>
    </div>`).join("");

  box.querySelectorAll(".history-item").forEach(row=>{
    row.addEventListener("click",event=>{
      if(event.target.closest("[data-delete-id]")) return;
      const report=reports.find(x=>x.id===row.dataset.reportId);
      if(report) renderReport(report);
    });
  });
  box.querySelectorAll("[data-delete-id]").forEach(button=>{
    button.addEventListener("click",async event=>{
      event.stopPropagation();
      await deleteReport(button.dataset.deleteId);
    });
  });
}

async function loadWorkspace(){
  const response=await fetch(API+"/social-workspace?user_id="+encodeURIComponent(user()),{
    headers:{"X-Session-Token":token()},
    cache:"no-store"
  });
  if(!response.ok) return;
  const payload=await response.json().catch(()=>({}));
  reports=Array.isArray(payload?.workspace?.reports)?payload.workspace.reports:[];
  renderHistory();
}

async function deleteReport(id){
  try{
    const response=await fetch(API+"/social-workspace",{
      method:"POST",headers:authHeaders(),
      body:JSON.stringify({user_id:user(),report_id:id})
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(payload.error||"Unable to delete report.");
    reports=Array.isArray(payload?.workspace?.reports)?payload.workspace.reports:reports.filter(x=>x.id!==id);
    if(currentReport?.id===id){
      currentReport=null;
      $("socialReport").hidden=true;
      $("socialEmpty").hidden=false;
    }
    renderHistory();
  }catch(error){setStatus(error.message,"error");}
}

async function runInvestigation(event){
  event.preventDefault();
  const button=$("socialRunButton");
  const payload=formPayload();
  if(!payload.target&&!payload.usernames.length&&!payload.keywords.length&&!payload.urls.length){
    setStatus("Enter a target, username, keyword or public URL.","warning");return;
  }
  if(payload.mode==="urls_only"&&!payload.urls.length){
    setStatus("Analyze known public URLs requires at least one URL.","warning");return;
  }

  button.disabled=true;
  button.textContent="SOCMINT AGENT RUNNING…";
  setStatus(payload.mode==="discover"
    ?"Searching public sources and building analytical report…"
    :"Retrieving supplied public URLs and building analytical report…");

  try{
    const response=await fetch(API+"/social-investigate",{
      method:"POST",headers:authHeaders(),body:JSON.stringify(payload)
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(result.error||"SOCMINT investigation failed.");
    reports=[result.report,...reports.filter(x=>x.id!==result.report.id)].slice(0,50);
    renderHistory();
    renderReport(result.report);
    setStatus("SOCMINT report generated and saved.","success");
  }catch(error){
    setStatus(error.message||"SOCMINT investigation failed.","error");
  }finally{
    button.disabled=false;
    button.textContent="RUN SOCMINT INVESTIGATION";
  }
}

function pdfBlocks(report){
  const blocks=[
    {text:"EXECUTIVE ASSESSMENT",type:"heading"},
    {text:report.executive_assessment||"",type:"body"},
    {text:"KEY FINDINGS",type:"heading"}
  ];
  for(const item of report.key_findings||[]){
    blocks.push({text:(item.confidence||"LOW")+" · "+(item.finding||"")+"\nBasis: "+(item.basis||"")+(item.source_urls?.length?"\nSources: "+item.source_urls.join(" · "):""),type:"body"});
  }
  const sections=[
    ["SOURCE COVERAGE","source_coverage"],
    ["IDENTITY & ALIAS FINDINGS","identity_alias_findings"],
    ["NETWORK & ASSOCIATIONS","network_associations"],
    ["CONTENT & NARRATIVE","content_narrative"],
    ["ACTIVITY & TIMELINE","activity_timeline"],
    ["LOCATIONS & TRAVEL SIGNALS","locations_travel_signals"],
    ["FINANCIAL / CRYPTO INDICATORS","financial_crypto_indicators"],
    ["CT RELEVANCE","ct_relevance"]
  ];
  for(const [title,key] of sections){
    blocks.push({text:title,type:"heading"},{text:report[key]||"No supported finding.",type:"body"});
  }
  blocks.push({text:"ENTITIES / IDENTIFIERS",type:"heading"});
  for(const entity of report.entities||[]){
    blocks.push({text:[entity.type,entity.value,entity.platform,entity.confidence].filter(Boolean).join(" · ")+"\n"+(entity.basis||"")+(entity.source_urls?.length?"\nSources: "+entity.source_urls.join(" · "):""),type:"body"});
  }
  blocks.push({text:"OUTLOOK / WATCHPOINTS",type:"heading"});
  for(const item of report.watchpoints||[]){
    blocks.push({text:(item.issue||"")+"\nIndicator: "+(item.indicator||""),type:"body"});
  }
  blocks.push({text:"ANALYTICAL GAPS / LIMITATIONS",type:"heading"},{text:report.analytical_gaps||"",type:"body"});
  blocks.push({text:"SOURCES",type:"heading"});
  for(const source of report.sources||[]){
    blocks.push({text:(source.title||source.url)+"\n"+source.url+(source.snippet?"\n"+source.snippet:""),type:"source"});
  }
  blocks.push({text:"ANALYTICAL LIMITATION",type:"heading"},{text:"Public-source analytical output. Similar usernames, content, imagery, contacts or activity patterns do not by themselves establish identity, control, criminality or terrorist affiliation. Significant findings require independent analyst validation.",type:"footer"});
  return blocks;
}

async function downloadPdf(){
  if(!currentReport||!window.CTAtlasPdf?.download){setStatus("PDF export is unavailable.","error");return;}
  await window.CTAtlasPdf.download({
    filename:"CT-Atlas-SOCMINT-"+(currentReport.query?.target||"Assessment"),
    eyebrow:"CT ATLAS · SOCIAL MEDIA ANALYSIS",
    title:currentReport.title||"SOCMINT Assessment",
    meta:"Generated "+(currentReport.generated_at||new Date().toISOString())+" · user "+user(),
    blocks:pdfBlocks(currentReport),
    footer:"CT Atlas SOCMINT · public-source analytical report"
  });
}

async function verifySession(){
  const t=token();
  if(!t){location.replace("index.html");return false;}
  try{
    const response=await fetch(API+"/session-check",{headers:{"X-Session-Token":t},cache:"no-store"});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.ok||!payload.username)throw new Error();
    sessionStorage.setItem(USER_KEY,String(payload.username).toLowerCase());
    $("socialUser").textContent=String(payload.username).toUpperCase();
    return true;
  }catch(_){location.replace("index.html");return false;}
}

document.addEventListener("DOMContentLoaded",async()=>{
  if(!await verifySession())return;
  $("socialForm").addEventListener("submit",runInvestigation);
  $("socialPdfButton").addEventListener("click",downloadPdf);
  await loadWorkspace();
});
})();