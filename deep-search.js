(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
let lastPayload=null;
let backendReady=false;

function esc(value){
  return String(value??"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function token(){return String(sessionStorage.getItem(TOKEN_KEY)||"");}
function user(){return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();}

function ensureCss(){
  if(document.getElementById("deepSearchCss"))return;
  const link=document.createElement("link");
  link.id="deepSearchCss";
  link.rel="stylesheet";
  link.href="deep-search.css?v=5";
  document.head.appendChild(link);
}

function inject(){
  ensureCss();
  if(document.getElementById("deepSearchPanel"))return;

  const reportButton=document.getElementById("reportGeneratorButton");
  if(reportButton&&!document.getElementById("deepSearchButton")){
    const button=document.createElement("button");
    button.id="deepSearchButton";
    button.type="button";
    button.textContent="CUSTOM INTELLIGENCE";
    reportButton.insertAdjacentElement("afterend",button);
  }

  document.body.insertAdjacentHTML("beforeend",`
    <div id="deepSearchPanel" aria-hidden="true">
      <div id="deepSearchWindow" role="dialog" aria-modal="true" aria-labelledby="deepSearchTitle">
        <div id="deepSearchHeader">
          <div>
            <div id="deepSearchTitle">CUSTOM INTELLIGENCE</div>
            <div id="deepSearchSubtitle">An intelligence assessment answering your question: CT Atlas database, multilingual OSINT and analytical knowledge</div>
          </div>
          <button id="deepSearchClose" type="button" aria-label="Close Custom Intelligence">×</button>
        </div>
        <div id="deepSearchBody">
          <div id="deepSearchControls">
            <div id="deepSearchGuidance">
              Custom Intelligence writes a full sourced intelligence assessment from your question, so be specific: name the <strong>period</strong> ("last 3 months", "in 2022" -- or leave it out entirely for a full historical search), the <strong>group / actor</strong>, and the <strong>country or region</strong>. There is no separate period field any more -- it reads the time window directly out of your question.
            </div>
            <label class="deep-field deep-question-field">
              <span>ANALYST QUESTION</span>
              <textarea id="deepSearchQuestion" rows="5" maxlength="1200" placeholder="Example: ISIS-K facilitation networks in Afghanistan and Pakistan over the last 6 months. Or: Al-Shabaab attacks in Somalia since 2022."></textarea>
            </label>
            <div id="deepSearchMethod">
              Custom Intelligence first takes the matching events from the CT Atlas database (within the DATABASE panel's place, category and group) as its primary evidence, then runs two native-language Google News searches in each of the 12 supported languages, plus ACLED and GDELT (chunked across longer periods for real historical depth). Languages relevant to the country in the analyst question receive priority rescue searches through Bing News as well when Google coverage comes up sparse, before deduplication, CT Atlas comparison and source-cited analysis.
            </div>
            <div id="deepSearchScope" class="deep-scope" hidden></div>
            <button id="deepSearchRun" type="button">GENERATE ASSESSMENT</button>
            <div id="deepSearchStatus"></div>
          </div>

          <div id="deepSearchResult" hidden>
            <div id="deepSearchResultTopline">
              <div>
                <div id="deepSearchResultTitle">INTELLIGENCE ASSESSMENT</div>
                <div id="deepSearchResultMeta"></div>
                <div id="deepSearchDetectedPeriod"></div>
              </div>
              <div id="deepSearchActions">
                <button id="deepSearchCopy" type="button">COPY</button>
                <button id="deepSearchPrint" type="button">DOWNLOAD PDF</button>
              </div>
            </div>

            <div id="deepSearchMetrics"></div>

            <div class="deep-section-head deep-search-coverage-head">SEARCH COVERAGE</div>
            <div id="deepSearchLanguageCoverage"></div>

            <div class="deep-section-head">ANALYTICAL REPORT</div>
            <div id="deepSearchIllustration"></div>
            <div id="deepSearchReport"></div>

            <div class="deep-section-head">SOURCES CITED / EVIDENCE PACK</div>
            <div id="deepSearchEvidence"></div>

            <div id="deepSearchDisclaimer">
              Custom Intelligence uses live open-source search results and AI-assisted analysis; passages marked [GK] come from the model's general knowledge, not from a retrieved source. Automatic CT Atlas gap matching is approximate. Citation coverage is not a statistical hallucination probability. Source material and significant claims should be independently validated before operational or decision-making use.
            </div>
          </div>
        </div>
      </div>
    </div>`);

  document.getElementById("deepSearchButton")?.addEventListener("click",open);
  document.getElementById("deepSearchClose")?.addEventListener("click",close);
  document.getElementById("deepSearchPanel")?.addEventListener("click",event=>{if(event.target.id==="deepSearchPanel")close();});
  document.getElementById("deepSearchRun")?.addEventListener("click",run);
  document.getElementById("deepSearchCopy")?.addEventListener("click",copyReport);
  document.getElementById("deepSearchPrint")?.addEventListener("click",downloadPdf);
  document.getElementById("deepSearchQuestion")?.addEventListener("keydown",event=>{
    if((event.ctrlKey||event.metaKey)&&event.key==="Enter")run();
  });
  checkBackend();
}

async function checkBackend(){
  const button=document.getElementById("deepSearchButton");
  if(!button)return;
  try{
    const response=await fetch(API_BASE+"/health",{cache:"no-store"});
    const payload=await response.json().catch(()=>({}));
    backendReady=Boolean(response.ok&&payload.deep_search===true);
  }catch(_){backendReady=false;}
  if(backendReady){
    button.disabled=false; button.textContent="CUSTOM INTELLIGENCE"; button.title="An intelligence assessment answering your question: CT Atlas database, multilingual OSINT search and analysis";
  }else{
    button.disabled=true; button.textContent="CUSTOM INTELLIGENCE · UNAVAILABLE";
    button.title="The Custom Intelligence backend is not currently available.";
  }
}

// The Database panel's place / category / group (when the page has one). The
// period still comes from the question, so external search can reach further
// back than the database's retention.
function databaseScope(){
  const api=window.CTAtlasDatabase;
  if(!api||typeof api.filters!=="function")return {filters:{},label:""};
  try{
    const filters=api.filters()||{};
    return {
      filters:{region:filters.region,topic:filters.topic,actor_group:filters.actor_group},
      label:typeof api.label==="function"?api.label({withPeriod:false}):""
    };
  }catch(_){return {filters:{},label:""};}
}

function renderScope(){
  const node=document.getElementById("deepSearchScope");
  if(!node)return;
  const {label}=databaseScope();
  node.textContent=label?"Database scope: "+label+" (DATABASE panel) · period: read from your question":"";
  node.hidden=!label;
}

function open(){
  const panel=document.getElementById("deepSearchPanel");
  renderScope();
  panel?.classList.add("open"); panel?.setAttribute("aria-hidden","false");
  setTimeout(()=>document.getElementById("deepSearchQuestion")?.focus(),30);
}
function close(){
  const panel=document.getElementById("deepSearchPanel");
  panel?.classList.remove("open"); panel?.setAttribute("aria-hidden","true");
}
function setStatus(message,type=""){
  const status=document.getElementById("deepSearchStatus");
  if(!status)return;
  status.textContent=message; status.className=type?"deep-status "+type:"deep-status";
}

function stripFence(value){
  return String(value||"").trim()
    .replace(/^```(?:json|text|markdown)?\s*/i,"")
    .replace(/\s*```$/i,"").trim();
}

function normalizePayload(payload){
  const normalized={...(payload||{})};
  let title=String(normalized.title||"").trim();
  let analysis=String(normalized.analysis||"").trim();

  for(let pass=0;pass<2;pass++){
    const candidate=stripFence(analysis);
    if(!(candidate.startsWith("{")&&candidate.endsWith("}")))break;
    try{
      const nested=JSON.parse(candidate);
      if(!nested||typeof nested!=="object"||!nested.analysis)break;
      title=String(nested.title||title).trim();
      analysis=String(nested.analysis||"").trim();
    }catch(_){break;}
  }

  if(!analysis.includes("\n")&&analysis.includes("\\n")){
    analysis=analysis.replace(/\\n/g,"\n").replace(/\\"/g,'"');
  }
  analysis=stripFence(analysis)
    .replace(/^\*\*```(?:json)?\*\*/i,"")
    .replace(/\*\*```\*\*$/i,"").trim();

  normalized.title=title||"CT Atlas · Intelligence Assessment";
  normalized.analysis=analysis;
  return normalized;
}

function inlineMarkup(value){
  let safe=esc(value);
  safe=safe.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  safe=safe.replace(/\[(S\d{2}(?:,\s*S\d{2})*)\]/g,(_,ids)=>{
    const label=ids.split(",").map(x=>x.trim()).join(", ");
    return `<span class="deep-citation">[${label}]</span>`;
  });
  // The model's own knowledge, not a retrieved source.
  safe=safe.replace(/\[GK\]/g,'<span class="deep-citation deep-gk" title="General knowledge: the model\'s own analytical knowledge, not a retrieved source">GK</span>');
  return safe;
}

function formatAnalysis(text){
  const clean=stripFence(String(text||"")).replace(/\r\n?/g,"\n");
  const lines=clean.split("\n");
  const out=[];
  let inList=false;

  function closeList(){
    if(inList){out.push("</ul>");inList=false;}
  }

  for(const raw of lines){
    let value=raw.trim();
    if(!value){closeList();continue;}
    value=value.replace(/^#{1,6}\s*/,"").trim();

    if(/^[A-Z][A-Z0-9 /&()’'–—-]{3,}$/.test(value)){
      closeList();
      out.push(`<h4>${inlineMarkup(value)}</h4>`);
      continue;
    }

    if(/^[-•]\s+/.test(value)){
      if(!inList){out.push('<ul class="deep-report-list">');inList=true;}
      out.push(`<li>${inlineMarkup(value.replace(/^[-•]\s+/,""))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inlineMarkup(value)}</p>`);
  }
  closeList();
  return out.join("");
}

function fmtDate(value){
  if(!value)return "Date unavailable";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return String(value);
  return date.toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
}

const SEARCH_ENGINE_LABELS={gdelt:"GDELT",acled:"ACLED",bing:"BING",ct_atlas_corpus:"CT ATLAS ARCHIVE",ct_atlas_database:"CT ATLAS DATABASE"};
function engineLabel(engine){
  return SEARCH_ENGINE_LABELS[engine]||"GOOGLE NEWS";
}

// A zero article count is ambiguous on its own: it could mean the search
// genuinely found nothing, or that the fetch itself failed (rate limit,
// timeout, provider error) and never got a real answer. successful_queries <
// query_count for a language means at least one of its requests failed, so a
// low/zero count there is NOT proof of an absence of coverage. Rather than
// repeating a warning on every affected language row, a single ⚠ is shown
// once at the top of the report when this is true for ANY language -- see
// hasFetchIssue() below.
function hasFetchIssue(payload){
  const languages=Array.isArray(payload.languages_searched)?payload.languages_searched:[];
  return languages.some(item=>{
    const queryCount=Number(item.query_count||0);
    const successCount=Number(item.successful_queries||0);
    return queryCount>0&&successCount<queryCount;
  });
}

const FETCH_ISSUE_TITLE="At least one search request failed somewhere in this report (rate limit, timeout or provider error) -- some counts below may be lower than real coverage.";

function languageCoverageHtml(payload){
  const languages=Array.isArray(payload.languages_searched)?payload.languages_searched:[];
  if(!languages.length)return '<div class="deep-language-empty">Language diagnostics unavailable for this cached result.</div>';
  return languages.map(item=>{
    const count=Number(item.article_count||0);
    const queryCount=Number(item.query_count||0);
    const successCount=Number(item.successful_queries||0);
    const googleCount=Number(item.google_news_articles||0);
    const gdeltCount=Number(item.gdelt_articles||0);
    const acledCount=Number(item.acled_articles||0);
    const bingCount=Number(item.bing_articles||0);
    const priority=Boolean(item.priority);
    const cls=count>0?" has-results":" no-results";
    return `<div class="deep-language${cls}">
      <span class="deep-language-name">${esc(item.name||item.code||"Language")}</span>
      <strong>${count}</strong>
      <small>${count===1?"article":"articles"}${priority?" · PRIORITY":""} · Google ${googleCount} · GDELT ${gdeltCount}${acledCount?` · ACLED ${acledCount}`:""}${bingCount?` · Bing ${bingCount}`:""} · ${successCount}/${queryCount||1} ${queryCount===1?"query":"queries"} succeeded</small>
    </div>`;
  }).join("");
}

function evidenceHtml(payload){
  const evidence=Array.isArray(payload.evidence)?payload.evidence:[];
  const cited=new Set(payload.grounding?.cited_source_ids||[]);
  const ordered=[...evidence].sort((a,b)=>(cited.has(b.id)?1:0)-(cited.has(a.id)?1:0));
  return ordered.map(item=>{
    const citedClass=cited.has(item.id)?" cited":"";
    const gap=item.atlas_status==="potential_gap";
    const fromDatabase=item.search_engine==="ct_atlas_database";
    const gapLabel=fromDatabase?"CT ATLAS DATABASE":(gap?"POTENTIAL ATLAS GAP":"MATCHED IN CT ATLAS");
    const gapClass=gap&&!fromDatabase?" gap":" matched";
    const extras=Array.isArray(item.additional_sources)?item.additional_sources:[];
    return `
      <article class="deep-evidence${citedClass}">
        <div class="deep-evidence-head">
          <strong>${esc(item.id)}</strong>
          <span class="deep-evidence-source">${esc(item.source||"Source")}</span>
          <span class="deep-gap-badge${gapClass}">${gapLabel}</span>
        </div>
        <div class="deep-evidence-title">${esc(item.title||"")}</div>
        <div class="deep-evidence-meta">${esc(fmtDate(item.published))} · ${esc(String(item.language||"").toUpperCase())}${item.search_engine?` · ${engineLabel(item.search_engine)}`:""}${Number(item.source_count||1)>1?` · ${Number(item.source_count)} merged sources`:""}</div>
        ${item.summary?`<div class="deep-evidence-summary">${esc(item.summary)}</div>`:""}
        <div class="deep-evidence-links">
          ${item.url?`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">OPEN ARTICLE</a>`:""}
          ${item.atlas_match_id&&!fromDatabase?`<span>Atlas match: ${esc(item.atlas_match_title||item.atlas_match_id)} (${Number(item.atlas_match_score||0)}%)</span>`:""}
        </div>
        ${extras.length?`<details><summary>${extras.length} additional merged source${extras.length===1?"":"s"}</summary>${extras.map(source=>`<div class="deep-extra-source">${esc(source.source||"Source")} · ${esc(fmtDate(source.published))}${source.url?` · <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">open</a>`:""}</div>`).join("")}</details>`:""}
      </article>`;
  }).join("");
}

function render(rawPayload){
  const payload=normalizePayload(rawPayload);
  lastPayload=payload;
  const result=document.getElementById("deepSearchResult");
  if(result)result.hidden=false;
  document.getElementById("deepSearchResultTitle").innerHTML=esc(payload.title||"INTELLIGENCE ASSESSMENT")+(hasFetchIssue(payload)?` <span class="deep-fetch-issue-flag" title="${esc(FETCH_ISSUE_TITLE)}">⚠</span>`:"");

  const languages=(payload.languages_searched||[]).map(item=>item.name||item.code).join(", ");
  const retrieved=payload.retrieval||{};
  document.getElementById("deepSearchResultMeta").textContent=
    `Generated ${new Date(payload.generated_at||Date.now()).toLocaleString("en-GB")} · ${payload.model||"Gemini"} · ${languages||"multilingual"}${payload.cached?" · CACHED":""}`;
  document.getElementById("deepSearchDetectedPeriod").textContent=
    (payload.detected_period?.label?`Period detected from your question: ${payload.detected_period.label}`:"")+
    (payload.database_scope?` · Database scope: ${payload.database_scope}`:"");

  document.getElementById("deepSearchMetrics").innerHTML=`
    <div class="deep-metric"><span>DATABASE EVENTS</span><strong>${Number(retrieved.ct_atlas_database_events||0)}</strong></div>
    <div class="deep-metric"><span>ARTICLES</span><strong>${Number(retrieved.articles_retrieved||0)}</strong></div>
    <div class="deep-metric"><span>UNIQUE EVENTS</span><strong>${Number(retrieved.unique_event_clusters||0)}</strong></div>
    <div class="deep-metric"><span>EVIDENCE USED</span><strong>${Number(retrieved.evidence_events_used_for_analysis||0)}</strong></div>
    <div class="deep-metric"><span>ATLAS MATCHES</span><strong>${Number(retrieved.matched_to_atlas||0)}</strong></div>
    <div class="deep-metric"><span>POTENTIAL GAPS</span><strong>${Number(retrieved.potential_atlas_gaps||0)}</strong></div>
    <div class="deep-metric"><span>CITATION COVERAGE</span><strong>${Number(payload.grounding?.citation_coverage_percent||0)}%</strong></div>
    <div class="deep-metric"><span>GENERAL KNOWLEDGE [GK]</span><strong>${Number(payload.grounding?.general_knowledge_percent||0)}%</strong></div>`;

  document.getElementById("deepSearchLanguageCoverage").innerHTML=languageCoverageHtml(payload);
  document.getElementById("deepSearchReport").innerHTML=formatAnalysis(payload.analysis||"");
  // The best photo among the cited articles, fetched once the report is on screen.
  window.CTAtlasIllustration?.load(document.getElementById("deepSearchIllustration"),payload.illustration_candidates,API_BASE);
  document.getElementById("deepSearchEvidence").innerHTML=evidenceHtml(payload);
}

async function run(){
  if(!backendReady){setStatus("The Custom Intelligence backend is not available.","warning");return;}
  const question=String(document.getElementById("deepSearchQuestion")?.value||"").trim();
  const username=user(), sessionToken=token(), button=document.getElementById("deepSearchRun");
  if(question.length<8){setStatus("Enter a more specific analyst question.","warning");return;}
  if(!username||!sessionToken){setStatus("Custom Intelligence requires an authenticated CT Atlas session. Sign in again.","error");return;}

  if(button){button.disabled=true;button.textContent="SEARCHING MULTILINGUAL SOURCES…";}
  const result=document.getElementById("deepSearchResult");
  if(result)result.hidden=true;
  renderScope();
  setStatus("Reading the period from your question, taking the matching CT Atlas database events first, then retrieving fresh multilingual reporting…","working");

  const finishWait = window.CTAtlasUI?.begin(document.getElementById("deepSearchStatus"));
  try{
    const response=await fetch(API_BASE+"/deep-search",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Session-Token":sessionToken},
      body:JSON.stringify({...databaseScope().filters,user_id:username,question})
    });
    const payload=await response.json().catch(()=>({}));
    const periodNote=payload.detected_period?.label?` Period searched: ${payload.detected_period.label}.`:"";
    if(!response.ok){
      const retry=Number(payload.retry_after_seconds||0);
      throw new Error((payload.error||"The assessment failed.")+periodNote+(retry?` Retry in approximately ${Math.ceil(retry/60)} minute(s).`:""));
    }
    render(payload);
    if(payload.no_current_reporting){
      setStatus(payload.likely_transient_fetch_issue
        ?"Assessment written from general knowledge only [GK]: the search providers were unavailable for every query. Retry in a few minutes for current reporting."
        :"Assessment written from general knowledge only [GK]: no current reporting was found in the database or the multilingual search.","warning");
    }else setStatus(`Assessment complete · ${Number(payload.retrieval?.articles_retrieved||0)} articles · ${Number(payload.retrieval?.unique_event_clusters||0)} unique event clusters · ${Number(payload.retrieval?.potential_atlas_gaps||0)} potential CT Atlas gaps.${periodNote}`,"success");
  }catch(error){setStatus(error?.message||"The assessment failed.","error");}
  finally{
    finishWait?.();
    if(button){button.disabled=false;button.textContent="GENERATE ASSESSMENT";}}
}

async function copyReport(){
  if(!lastPayload)return;
  const cited=new Set(lastPayload.grounding?.cited_source_ids||[]);
  const sourceText=(lastPayload.evidence||[]).filter(item=>cited.has(item.id))
    .map(item=>`${item.id} — ${item.source} — ${item.title} — ${item.url}`).join("\n");
  const scopeText=lastPayload.database_scope?`Database scope: ${lastPayload.database_scope}\n`:"";
  const databaseCount=Number(lastPayload.retrieval?.ct_atlas_database_events||0);
  const text=`${lastPayload.title||"CT Atlas · Intelligence Assessment"}\n\nQuestion: ${lastPayload.question||""}\n${scopeText}CT Atlas database events used: ${databaseCount}\n\n${lastPayload.analysis||""}\n\nSOURCES CITED\n${sourceText}`;
  try{await navigator.clipboard.writeText(text);setStatus("Assessment and cited sources copied to clipboard.","success");}
  catch(_){setStatus("Clipboard access was unavailable.","warning");}
}

function pdfSafeName(value){
  return String(value||"Assessment").replace(/[^a-z0-9_-]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,70)||"Assessment";
}

function pdfDisplayUrl(url,maxLength=100){
  const value=String(url||"");
  return value.length<=maxLength?value:value.slice(0,maxLength)+"…";
}

async function downloadPdf(){
  if(!lastPayload)return;
  const button=document.getElementById("deepSearchPrint");
  const original=button?.textContent||"DOWNLOAD PDF";
  const pdf=window.CTAtlasPdf;
  if(!pdf){setStatus("PDF export is not available. Reload CT Atlas and retry.","error");return;}
  if(button){button.disabled=true;button.textContent="BUILDING PDF…";}
  try{
    const cited=new Set(lastPayload.grounding?.cited_source_ids||[]);
    const evidence=[...(lastPayload.evidence||[])].sort((a,b)=>(cited.has(b.id)?1:0)-(cited.has(a.id)?1:0));
    const languages=Array.isArray(lastPayload.languages_searched)?lastPayload.languages_searched:[];
    const retrieved=lastPayload.retrieval||{};
    const stamp=new Date(lastPayload.generated_at||Date.now());
    const fileStamp=stamp.toISOString().replace(/[:T]/g,"-").slice(0,16);
    const blocks=[
      {text:"QUESTION",type:"heading"},
      {text:lastPayload.question||"",type:"question"},
      {text:"Generated: "+stamp.toLocaleString("en-GB")+" · Period: "+(lastPayload.detected_period?.label||"unknown")+" · Model: "+(lastPayload.model||"Gemini"),type:"meta"},
      ...(lastPayload.database_scope?[{text:"Database scope: "+lastPayload.database_scope,type:"meta"}]:[]),
      {text:"SEARCH SUMMARY",type:"heading"},
      {text:"CT Atlas database events: "+Number(retrieved.ct_atlas_database_events||0)+" · Articles: "+Number(retrieved.articles_retrieved||0)+" · Unique events: "+Number(retrieved.unique_event_clusters||0)+" · Evidence used: "+Number(retrieved.evidence_events_used_for_analysis||0)+" · Atlas matches: "+Number(retrieved.matched_to_atlas||0)+" · Potential gaps: "+Number(retrieved.potential_atlas_gaps||0)+" · Citation coverage: "+Number(lastPayload.grounding?.citation_coverage_percent||0)+"%"+" · General knowledge [GK]: "+Number(lastPayload.grounding?.general_knowledge_percent||0)+"%",type:"highlight"}
    ];
    if(hasFetchIssue(lastPayload))blocks.push({text:"Retrieval warning: "+FETCH_ISSUE_TITLE,type:"meta"});
    if(languages.length){
      blocks.push({text:"SEARCH COVERAGE",type:"heading"});
      languages.forEach(item=>{
        const queryCount=Number(item.query_count||0);
        const successCount=Number(item.successful_queries||0);
        blocks.push({
          text:String(item.name||item.code||"Language")+" · "+Number(item.article_count||0)+" articles · Google "+Number(item.google_news_articles||0)+" · GDELT "+Number(item.gdelt_articles||0)+" · "+successCount+"/"+(queryCount||1)+" queries succeeded",
          type:"small"
        });
      });
    }
    blocks.push({text:"ANALYTICAL REPORT",type:"heading"});
    const illustration=document.getElementById("deepSearchIllustration");
    await window.CTAtlasIllustration?.ready(illustration);
    blocks.push(...pdf.blocksFromElement(illustration));
    blocks.push(...pdf.blocksFromElement(document.getElementById("deepSearchReport")));
    if(evidence.length){
      blocks.push({text:"EVIDENCE PACK",type:"heading"});
      evidence.forEach(item=>{
        const lines=[
          String(item.id||"Source")+" · "+String(item.source||"Source")+(cited.has(item.id)?" · CITED":""),
          String(item.title||""),
          fmtDate(item.published)+" · "+String(item.language||"").toUpperCase()+" · "+engineLabel(item.search_engine)
        ];
        if(item.url)lines.push(pdfDisplayUrl(item.url));
        blocks.push({text:lines.filter(Boolean).join("\n"),type:"source"});
      });
    }
    await pdf.download({
      filename:"CT-Atlas-Intelligence-Assessment-"+fileStamp+"-"+pdfSafeName(lastPayload.title),
      eyebrow:"CT ATLAS · INTELLIGENCE ASSESSMENT",
      title:lastPayload.title||"CT Atlas · Intelligence Assessment",
      meta:"Evidence-based OSINT research report",
      blocks,
      footer:"This analytical tool is an independent OSINT prototype created for research and analytical purposes. The information displayed is derived from open sources and automated AI-assisted processing. It should not be considered verified intelligence and must be independently validated before any operational or decision-making use."
    });
    setStatus("PDF downloaded successfully.","success");
  }catch(error){
    setStatus(error?.message||"PDF download failed.","error");
  }finally{
    if(button){button.disabled=false;button.textContent=original;}
  }
}

document.addEventListener("keydown",event=>{if(event.key==="Escape")close();});
document.addEventListener("DOMContentLoaded",inject);
if(document.readyState!=="loading")inject();
})();