const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const read=file=>fs.readFileSync(file,"utf8");
const html=read("crypto.html");
const js=read("crypto.js");

test("the Crypto page has the report button in the result header, and loads the report code before crypto.js",()=>{
  assert.match(html,/<button id="cryptoReportButton" class="crypto-report-button" type="button"[^>]*>GENERATE FULL REPORT \(PDF\)<\/button>/);
  const topline=html.slice(html.indexOf('<div class="crypto-topline">'),html.indexOf('<div id="cryptoKpis"'));
  assert.ok(topline.includes("cryptoReportButton")&&topline.includes("cryptoExplorer"),"next to the explorer link, inside the result header");
  const order=["pdf-export.js","crypto-report.js","crypto.js"].map(name=>html.indexOf('<script src="'+name+'?v='));
  assert.ok(order.every(index=>index>0)&&order[0]<order[1]&&order[1]<order[2],"pdf-export, then crypto-report, then crypto");
  assert.match(html,/pdf-export\.js\?v=([4-9]|\d{2,})"/,"the exporter changed (tables, text layer): new version");
  assert.match(html,/crypto\.js\?v=([5-9]|\d{2,})"/);
  assert.match(read("crypto.css"),/\.crypto-report-button\{/);
  assert.match(read("crypto.css"),/\.crypto-topline-actions\{/);
});

test("the button is bound, disabled while it works, and failures are reported instead of thrown",()=>{
  assert.match(js,/getElementById\("cryptoReportButton"\)\?\.addEventListener\("click",exportFullReport\)/);
  const body=js.slice(js.indexOf("async function exportFullReport"),js.indexOf("function snapshotFromPayload"));
  assert.match(body,/button\.disabled=true/);
  assert.match(body,/finally\{[\s\S]*button\.disabled=false/);
  assert.match(body,/catch\(error\)\{\s*setStatus\(error\?\.message\|\|"Report generation failed\.","error"\)/);
  assert.match(body,/window\.CTAtlasCryptoReport\.build\(model\)/);
  assert.match(body,/const model=collectReportModel\(\);/);
  assert.match(body,/if\(model\.graph\)model\.graph\.image=await graphImageForReport\(\);/);
  assert.match(body,/if\(lastPayload\.kind==="address"\)renderGraph\(lastPayload\);/);
  assert.match(body,/window\.CTAtlasPdf\.download\(report\)/);
  assert.match(body,/Run an analysis first/);
});

test("PRIVACY: assembling the report never sends anything anywhere",()=>{
  const block=js.slice(js.indexOf("// Full analysis report: everything on screen"),js.indexOf("function snapshotFromPayload"));
  assert.ok(block.length>3000);
  for(const forbidden of ["fetch(","XMLHttpRequest","sendBeacon","WebSocket","window.open(","localStorage","sessionStorage.setItem"])assert.ok(!block.includes(forbidden),"the report code must not use "+forbidden);
  const builder=read("crypto-report.js");
  for(const forbidden of ["fetch(","XMLHttpRequest","sendBeacon","document.","window.open("])assert.ok(!builder.replace(/\/\/.*$/gm,"").includes(forbidden),"crypto-report.js is pure: no "+forbidden);
});

test("the report uses EVERY record: filters read as off only while it collects, and the screen is restored",()=>{
  assert.match(js,/let reportUnfiltered=false;/);
  const read_=js.slice(js.indexOf("function readFilters(){"),js.indexOf("function traceSettings(){"));
  assert.match(read_,/if\(reportUnfiltered\)return \{direction:"all",asset:"all",type:"all",status:"all",minAmount:null,maxAmount:null,from:"",to:"",text:"",graphMinLinks:1,graphNodes:REPORT_GRAPH_NODE_CAP\};/);
  assert.match(js,/const REPORT_GRAPH_NODE_CAP=\d{4,};/,"the report must not cap graph nodes to the cosmetic on-screen display limit (20-80), or a labelled/watched wallet beyond it is wrongly reported as absent");
  const wrapper=js.slice(js.indexOf("function withoutTransactionFilters(fn){"),js.indexOf("function flattenField("));
  assert.match(wrapper,/const previousFlag=reportUnfiltered,previousModel=currentNetworkModel;/);
  assert.match(wrapper,/reportUnfiltered=true;[\s\S]*currentNetworkModel=buildNetworkModel\(lastPayload\);[\s\S]*finally\{\s*reportUnfiltered=previousFlag;\s*currentNetworkModel=previousModel;/,"restored even if collecting throws");
  const collect=js.slice(js.indexOf("function collectReportModel("),js.indexOf("async function graphImageForReport"));
  assert.match(collect,/allTraceRows\(false\)/);
  assert.match(collect,/fullModel:currentNetworkModel/,"exposure/labels/patterns and the watchlist must share the same uncapped model");
  assert.match(collect,/derived\.fullModel\.nodes\.map\(node=>node\.id\)/,"watchlist must not be scoped to the on-screen (possibly capped) graph");
  assert.ok(!collect.includes("displayed.nodes.map(node=>node.id)"),"watchlist must not use the screen-capped node list");
  assert.match(collect,/withoutTransactionFilters\(\(\)=>\(\{[\s\S]*detectPatterns\(\)[\s\S]*exposureFindings\(\)[\s\S]*crossChainFindings\(\)[\s\S]*visibleRelevantLabels\(\)/);
  assert.match(collect,/activeFilterLabels\(\)/,"the filters that were on screen are stated in the report");
  assert.match(collect,/kind:isTransaction\?"transaction":"address"/);
  assert.match(collect,/lastPayload\.kind==="transaction"|isTransaction/);
});

test("a transaction lookup never reuses the previous address analysis (its trace state is stale)",()=>{
  const collect=js.slice(js.indexOf("function collectReportModel("),js.indexOf("async function graphImageForReport"));
  const txBranch=collect.slice(collect.indexOf("if(isTransaction){"),collect.indexOf("// The graph and its node table"));
  assert.match(txBranch,/transactionFields/);
  assert.ok(!/tracePayloads|allTraceRows|currentNetworkModel|buildNetworkModel/.test(txBranch),"transaction branch touches no trace state");
  const image=js.slice(js.indexOf("async function graphImageForReport"),js.indexOf("async function exportFullReport"));
  assert.match(image,/lastPayload\?\.kind!=="address"/);
});

test("the sanctions card and the report share one source of truth (sanctionsView), with the card's DOM unchanged",()=>{
  assert.match(js,/function sanctionsView\(\)\{/);
  const render=js.slice(js.indexOf("function renderSanctions(){"),js.indexOf("function renderIntelligencePanels(){"));
  assert.match(render,/const view=sanctionsView\(\);/);
  for(const id of ["cryptoSanctions","cryptoSanctionsBody","cryptoSanctionsBadge","cryptoSanctionsNote"])assert.ok(render.includes('"'+id+'"'),id);
  for(const cls of ["sanctions-warning","intel-item alert-item high","sanctions-address","intel-detail","intel-result","sanctions-scope","intel-badge high"])assert.ok(render.includes(cls)||js.includes(cls),cls);
  assert.ok(render.includes('(hit.terrorism?"high":"medium")'),"the hit badge keeps its two colours");
  const view=js.slice(js.indexOf("function sanctionsView(){"),js.indexOf("function renderSanctions(){"));
  assert.match(view,/NOT performed for this analysis/);
  assert.match(view,/must not be read as a clean result/);
  assert.match(view,/No match does not mean an address is safe/);
  assert.match(view,/older than 7 days/);
  assert.match(view,/could not be screened; results below are partial/);
  assert.match(js,/sanctions:sanctionsView\(\)/,"the report gets the same text");
});

test("the graph image comes from the page's own SVG, made standalone, and degrades to the node table",()=>{
  const image=js.slice(js.indexOf("async function graphImageForReport"),js.indexOf("async function exportFullReport"));
  assert.match(image,/getElementById\("flowGraph"\)/);
  assert.match(image,/CTAtlasCryptoReport\.standaloneGraphSvg\(svg\.outerHTML\)/);
  assert.match(image,/image\/svg\+xml;charset=utf-8/);
  assert.match(image,/URL\.revokeObjectURL\(url\)/);
  assert.match(image,/toDataURL\("image\/png"\)/);
  assert.match(image,/catch\(_\)\{\s*return "";/);
});

test("crypto-report.js ships everywhere the Crypto page does",()=>{
  assert.match(read("tools/deploy_mirror.sh"),/crypto\.js crypto-report\.js crypto\.css/);
  const ui=read(".github/workflows/deploy-current-ct-atlas-ui.yml");
  assert.ok(ui.includes('- "crypto-report.js"'),"its change triggers the UI deployment");
  assert.ok(ui.includes("test -s crypto-report.js")&&ui.includes("node --check crypto-report.js")&&ui.includes("node --check pdf-export.js"));
  assert.ok(ui.includes("grep -q 'cryptoReportButton' crypto.html")&&ui.includes("grep -q 'exportFullReport' crypto.js"));
  const smoke=read(".github/workflows/live-smoke.yml");
  assert.ok(smoke.includes('- "crypto-report.js"'));
  assert.ok(smoke.includes("https://ct-atlas.com/crypto-report.js")&&smoke.includes("grep -q 'CTAtlasCryptoReport' /tmp/crypto-report.js")&&smoke.includes("grep -q 'cryptoReportButton' /tmp/crypto.html"));
});

test("the exporter keeps its old callers working: same block types, only additions",()=>{
  const source=read("pdf-export.js");
  for(const type of ["title","heading","body","question","meta","highlight","badge","source","small","footer"])assert.ok(new RegExp("\\b"+type+":\\{size:").test(source),type+" style is still there");
  assert.match(source,/window\.CTAtlasPdf=\{download,blocksFromElement,safeFilename\};/);
  for(const page of ["index.html","deep-search.js","social.js"])assert.ok(read(page).includes("CTAtlasPdf"),page+" still uses it");
});
