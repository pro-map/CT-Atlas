(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
const FILTER_IDS=[
  "filterDirection","filterAsset","filterType","filterStatus","filterMinAmount",
  "filterMaxAmount","filterFromDate","filterToDate","filterText",
  "filterGraphMinLinks","filterGraphNodes"
];

let lastPayload=null;
let graphPositions=new Map();
let tracePayloads=new Map();
let traceExpanded=new Set();
let traceBusy=new Set();
// The last automatic trace (autoTrace): how far it went, why it stopped and the
// exchanges it reached, for the page and the report. Reset with the trace.
let autoTraceRun=null;
// AI-assessed operator of exchange-like wallets (/crypto-exchange-attribution),
// by trace key. An investigative lead, never a sourced label.
let exchangeAttributions=new Map();
// While an automatic trace runs, the graph keeps its whole frontier (no node cap).
let autoTraceActive=false;
let currentNetworkModel=null;
let graphDisplayModel=null;
let exchangeGraphMode="auto";
let selectedExchangePath="";
let activeExchangePath=null;
let cryptoWorkspace={version:"crypto-workspace-v1",labels:[],watchlist:[],cases:[],alerts:[]};
let sharedExchangeLabels=new Map();
let activeCaseId="";
let lastFoundPath=null;
let workspaceSaveTimer=null;
let reportUnfiltered=false;   // set only while the full report collects its data: every filter reads as "off"
// The report must not drop a labelled or watched wallet just because the on-screen "max nodes" display
// setting (20-80, a cosmetic cap for a readable picture) is lower: while collecting, the trace graph is
// built with effectively no node cap (the branch/depth limits from #traceBranch and #traceMaxDepth still
// apply, exactly as on screen -- only the display-density cap is lifted).
const REPORT_GRAPH_NODE_CAP=100000;

const SERVICE_REGISTRY={
  ethereum:{
    "0x7a250d5630b4cf539739df2c5dacab4c659f2488":{name:"Uniswap V2 Router",category:"DEX"},
    "0xe592427a0aece92de3edee1f18e0157c05861564":{name:"Uniswap V3 SwapRouter",category:"DEX"},
    "0x1111111254eeb25477b68fb85ed929f73a960582":{name:"1inch Router",category:"DEX"},
    "0x77b2043768d28e9c9ab44e1abfc95944bce57931":{name:"Stargate Native Pool",category:"BRIDGE"},
    "0xc026395860db2d07ee33e05fe50ed7bd583189c7":{name:"Stargate USDC Pool",category:"BRIDGE"},
    "0x933597a323eb81cae705c5bc29985172fd5a3973":{name:"Stargate USDT Pool",category:"BRIDGE"}
  },
  bsc:{
    "0x138eb30f73bc423c6455c53df6d89cb01d9ebc63":{name:"Stargate USDT Pool",category:"BRIDGE"},
    "0x962bd449e630b0d928f308ce63f1a21f02576057":{name:"Stargate USDC Pool",category:"BRIDGE"}
  },
  polygon:{
    "0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4":{name:"Stargate USDC Pool",category:"BRIDGE"},
    "0xd47b03ee6d86cf251ee7860fb2acf9f91b9fd4d7":{name:"Stargate USDT Pool",category:"BRIDGE"}
  },
  arbitrum:{
    "0xa45b5130f36cdca45667738e2a258ab09f4a5f7f":{name:"Stargate Native Pool",category:"BRIDGE"},
    "0xe8cdf27acd73a434d661c84887215f7598e7d0d3":{name:"Stargate USDC Pool",category:"BRIDGE"},
    "0xce8cca271ebc0533920c83d39f417ed6a0abb7d0":{name:"Stargate USDT Pool",category:"BRIDGE"}
  }
};

function token(){return String(sessionStorage.getItem(TOKEN_KEY)||"");}
function user(){return String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();}
function esc(value){return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");}
function short(value,n=10){const text=String(value||"");return text.length>n*2+3?text.slice(0,n)+"…"+text.slice(-n):text;}
function fmtNumber(value,max=8){
  const n=Number(value);
  if(!Number.isFinite(n))return "—";
  if(n===0)return "0";
  if(Math.abs(n)>=1000000)return n.toLocaleString(undefined,{maximumFractionDigits:2});
  return n.toLocaleString(undefined,{maximumFractionDigits:max});
}
function fmtTime(value){
  if(!value)return "Pending / unknown";
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return String(value);
  return d.toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
}
function setStatus(message,type=""){
  const el=document.getElementById("cryptoStatus");
  if(!el)return;
  el.textContent=message;
  el.className="crypto-status"+(type?" "+type:"");
}
function setTraceStatus(message,type=""){
  const el=document.getElementById("cryptoTraceStatus");
  if(!el)return;
  el.textContent=message;
  el.className="crypto-trace-status"+(type?" "+type:"");
}
function sessionHeaders(extra={}){
  return {"X-Session-Token":token(),...extra};
}
function redirectToLogin(){
  window.location.href="index.html";
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function traceKey(address,chain){
  const value=String(address||"");
  return ["ethereum","bsc","polygon","arbitrum","base"].includes(chain)?value.toLowerCase():value;
}

async function verifySession(){
  if(!user()||!token()){redirectToLogin();return false;}
  try{
    const response=await fetch(API_BASE+"/session-check",{headers:sessionHeaders(),cache:"no-store"});
    if(!response.ok){redirectToLogin();return false;}
    return true;
  }catch(_){
    setStatus("Unable to verify the CT Atlas session. Check the API connection.","error");
    return false;
  }
}

async function providerHealth(){
  const strip=document.getElementById("providerStrip");
  if(!strip)return;
  try{
    const response=await fetch(API_BASE+"/health",{cache:"no-store"});
    const payload=await response.json().catch(()=>({}));
    const providers=payload.crypto_providers||{};
    const labelProviders=payload.crypto_exchange_label_providers||{};
    strip.innerHTML=[
      ["BITCOIN · BLOCKSTREAM",providers.bitcoin!==false],
      ["EVM · ETHERSCAN",Boolean(providers.evm)],
      ["TRON · TRONGRID",Boolean(providers.tron)],
      ["TRON EXCHANGE TAGS · TRONSCAN KEY",Boolean(labelProviders.tronscan_enabled)]
    ].map(([label,on])=>'<span class="provider-chip '+(on?"on":"off")+'">'+esc(label)+" · "+(on?"READY":"KEY NOT CONFIGURED")+"</span>").join("");
  }catch(_){
    strip.innerHTML='<span class="provider-chip off">CRYPTO BACKEND STATUS UNAVAILABLE</span>';
  }
}

function makeId(prefix){
  const id=(globalThis.crypto&&typeof globalThis.crypto.randomUUID==="function")
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36)+Math.random().toString(36).slice(2);
  return prefix+"-"+id;
}

async function loadCryptoWorkspace(){
  try{
    const response=await fetch(API_BASE+"/crypto-workspace?user_id="+encodeURIComponent(user()),{
      headers:sessionHeaders(),cache:"no-store"
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||"Unable to load Crypto workspace.");
    cryptoWorkspace=payload.workspace||cryptoWorkspace;
    cryptoWorkspace.labels=Array.isArray(cryptoWorkspace.labels)?cryptoWorkspace.labels:[];
    cryptoWorkspace.watchlist=Array.isArray(cryptoWorkspace.watchlist)?cryptoWorkspace.watchlist:[];
    cryptoWorkspace.cases=Array.isArray(cryptoWorkspace.cases)?cryptoWorkspace.cases:[];
    cryptoWorkspace.alerts=Array.isArray(cryptoWorkspace.alerts)?cryptoWorkspace.alerts:[];
    renderWorkspaceUi();
    return true;
  }catch(error){
    console.warn("Crypto workspace load failed",error);
    setStatus("Crypto analysis is available, but the persistent investigation workspace could not be loaded.","warning");
    return false;
  }
}

async function saveCryptoWorkspace(){
  document.body.classList.add("workspace-saving");
  try{
    const response=await fetch(API_BASE+"/crypto-workspace",{
      method:"POST",
      headers:sessionHeaders({"Content-Type":"application/json"}),
      body:JSON.stringify({user_id:user(),workspace:cryptoWorkspace})
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||"Unable to save Crypto workspace.");
    cryptoWorkspace=payload.workspace||cryptoWorkspace;
    return true;
  }catch(error){
    console.warn("Crypto workspace save failed",error);
    setStatus(error?.message||"Unable to save Crypto workspace.","warning");
    return false;
  }finally{
    document.body.classList.remove("workspace-saving");
  }
}

function scheduleWorkspaceSave(){
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer=setTimeout(()=>saveCryptoWorkspace(),250);
}

function normalizeAddressForChain(address,chain){
  const value=String(address||"");
  return ["ethereum","bsc","polygon","arbitrum","base"].includes(chain)?value.toLowerCase():value;
}

function exchangeLabelKey(address,chain){
  return String(chain||"")+":"+normalizeAddressForChain(address,chain);
}

function absorbExchangeLabels(payload,replace=false){
  if(replace)sharedExchangeLabels=new Map();
  for(const raw of Array.isArray(payload?.exchange_labels)?payload.exchange_labels:[]){
    if(String(raw?.category||"").toUpperCase()!=="EXCHANGE")continue;
    const label={...raw,shared:true,id:"shared:"+exchangeLabelKey(raw.address,raw.chain)};
    sharedExchangeLabels.set(exchangeLabelKey(label.address,label.chain),label);
  }
}

function labelForAddress(address,chain=lastPayload?.chain){
  const normalized=normalizeAddressForChain(address,chain);
  const personal=(cryptoWorkspace.labels||[]).find(label=>
    label.chain===chain&&normalizeAddressForChain(label.address,chain)===normalized
  );
  if(personal)return personal;
  const shared=sharedExchangeLabels.get(exchangeLabelKey(address,chain));
  if(shared)return shared;
  const builtin=SERVICE_REGISTRY[chain]?.[normalized];
  return builtin?{...builtin,address,chain,confidence:"HIGH",source_type:"CT Atlas built-in service registry",source_title:"CT Atlas built-in service registry",builtin:true}:null;
}

function watchesForAddress(address,chain=lastPayload?.chain){
  const normalized=normalizeAddressForChain(address,chain);
  return (cryptoWorkspace.watchlist||[]).filter(item=>
    item.chain===chain&&normalizeAddressForChain(item.address,chain)===normalized
  );
}

function categoryTargets(category,chain=lastPayload?.chain){
  const target=String(category||"").toUpperCase();
  const values=new Set();
  for(const label of cryptoWorkspace.labels||[]){
    if(label.chain===chain&&String(label.category||"").toUpperCase()===target){
      values.add(normalizeAddressForChain(label.address,chain));
    }
  }
  for(const label of sharedExchangeLabels.values()){
    if(label.chain===chain&&String(label.category||"").toUpperCase()===target){
      values.add(normalizeAddressForChain(label.address,chain));
    }
  }
  for(const watch of cryptoWorkspace.watchlist||[]){
    if(watch.chain!==chain)continue;
    if((watch.categories||[]).map(x=>String(x).toUpperCase()).includes(target)){
      values.add(normalizeAddressForChain(watch.address,chain));
    }
  }
  for(const [address,service] of Object.entries(SERVICE_REGISTRY[chain]||{})){
    if(String(service.category||"").toUpperCase()===target)values.add(normalizeAddressForChain(address,chain));
  }
  return values;
}

function visibleRelevantLabels(){
  if(!lastPayload)return [];
  const visible=new Set([normalizeAddressForChain(lastPayload.query,lastPayload.chain)]);
  for(const node of currentNetworkModel?.nodes||[])visible.add(node.key);
  const byAddress=new Map();
  for(const label of cryptoWorkspace.labels||[]){
    if(label.chain===lastPayload.chain&&visible.has(normalizeAddressForChain(label.address,label.chain))){
      byAddress.set(exchangeLabelKey(label.address,label.chain),label);
    }
  }
  for(const [key,label] of sharedExchangeLabels){
    if(label.chain===lastPayload.chain&&visible.has(normalizeAddressForChain(label.address,label.chain))&&!byAddress.has(key))byAddress.set(key,label);
  }
  return [...byAddress.values()];
}

function renderWorkspaceUi(){
  renderLabelList();
  renderExchangeAdminAccess();
  renderCaseUi();
  renderAlerts();
  if(lastPayload?.kind==="address")renderIntelligencePanels();
}

function kpi(label,value){
  return '<div class="crypto-kpi"><div class="crypto-kpi-value">'+esc(value)+'</div><div class="crypto-kpi-label">'+esc(label)+'</div></div>';
}

function nativeAssetFor(payload){
  if(payload?.chain==="bitcoin")return "BTC";
  if(payload?.chain==="tron")return "TRX";
  if(["ethereum","arbitrum","base"].includes(payload?.chain))return "ETH";
  if(payload?.chain==="bsc")return "BNB";
  if(payload?.chain==="polygon")return "POL";
  return "";
}

function isTokenRow(row,payload){
  if(row?.token_contract||row?.token_name)return true;
  const native=nativeAssetFor(payload);
  return Boolean(native&&String(row?.asset||"")&&String(row.asset)!==native);
}

function rowStatus(row){
  if(row?.failed===true)return "failed";
  if(row?.confirmed===true)return "confirmed";
  return "pending";
}

function readFilters(){
  if(reportUnfiltered)return {direction:"all",asset:"all",type:"all",status:"all",minAmount:null,maxAmount:null,from:"",to:"",text:"",graphMinLinks:1,graphNodes:REPORT_GRAPH_NODE_CAP};
  const numberValue=id=>{
    const raw=String(document.getElementById(id)?.value||"").trim();
    if(!raw)return null;
    const number=Number(raw);
    return Number.isFinite(number)?number:null;
  };
  return {
    direction:String(document.getElementById("filterDirection")?.value||"all"),
    asset:String(document.getElementById("filterAsset")?.value||"all"),
    type:String(document.getElementById("filterType")?.value||"all"),
    status:String(document.getElementById("filterStatus")?.value||"all"),
    minAmount:numberValue("filterMinAmount"),
    maxAmount:numberValue("filterMaxAmount"),
    from:String(document.getElementById("filterFromDate")?.value||""),
    to:String(document.getElementById("filterToDate")?.value||""),
    text:String(document.getElementById("filterText")?.value||"").trim().toLowerCase(),
    graphMinLinks:Math.max(1,Math.min(99,Number(document.getElementById("filterGraphMinLinks")?.value||1)||1)),
    graphNodes:Math.max(20,Math.min(80,Number(document.getElementById("filterGraphNodes")?.value||80)||80))
  };
}

// The automatic trace follows branches until they reach an exchange, up to this
// hop and this many expanded wallets (one provider request each).
const AUTO_TRACE_MAX_DEPTH=6;
const AUTO_TRACE_MAX_WALLETS=30;

function traceSettings(){
  return {
    maxDepth:Math.max(2,Math.min(AUTO_TRACE_MAX_DEPTH,Number(document.getElementById("traceMaxDepth")?.value||6)||6)),
    branch:Math.max(3,Math.min(8,Number(document.getElementById("traceBranch")?.value||8)||8))
  };
}

function utcDateStart(value){
  if(!value)return null;
  const time=Date.parse(value+"T00:00:00Z");
  return Number.isFinite(time)?time:null;
}
function utcDateEndExclusive(value){
  const start=utcDateStart(value);
  return start===null?null:start+86400000;
}

function filterRows(payload){
  const all=Array.isArray(payload?.transactions)?payload.transactions:[];
  const f=readFilters();
  const from=utcDateStart(f.from);
  const to=utcDateEndExclusive(f.to);

  return all.filter(row=>{
    const direction=String(row.direction||"").toUpperCase();
    if(f.direction!=="all"&&direction!==f.direction)return false;
    if(f.asset!=="all"&&String(row.asset||"")!==f.asset)return false;

    const tokenRow=isTokenRow(row,payload);
    if(f.type==="token"&&!tokenRow)return false;
    if(f.type==="native"&&tokenRow)return false;

    if(f.status!=="all"&&rowStatus(row)!==f.status)return false;

    const amount=Math.abs(Number(row.amount));
    if(f.minAmount!==null&&(!Number.isFinite(amount)||amount<f.minAmount))return false;
    if(f.maxAmount!==null&&(!Number.isFinite(amount)||amount>f.maxAmount))return false;

    if(from!==null||to!==null){
      const time=Date.parse(row.time||"");
      if(!Number.isFinite(time))return false;
      if(from!==null&&time<from)return false;
      if(to!==null&&time>=to)return false;
    }

    if(f.text){
      const haystack=[
        row.id,row.asset,row.token_name,row.token_contract,row.contract_type,
        ...(Array.isArray(row.counterparties)?row.counterparties:[])
      ].filter(Boolean).join(" ").toLowerCase();
      if(!haystack.includes(f.text))return false;
    }
    return true;
  });
}

function activeFilterLabels(){
  const f=readFilters(),labels=[];
  if(f.direction!=="all")labels.push(f.direction);
  if(f.asset!=="all")labels.push(f.asset);
  if(f.type!=="all")labels.push(f.type.toUpperCase());
  if(f.status!=="all")labels.push(f.status.toUpperCase());
  if(f.minAmount!==null)labels.push("MIN "+f.minAmount);
  if(f.maxAmount!==null)labels.push("MAX "+f.maxAmount);
  if(f.from)labels.push("FROM "+f.from);
  if(f.to)labels.push("TO "+f.to);
  if(f.text)labels.push("MATCH "+f.text);
  return labels;
}

function traceEntries(){
  return [...tracePayloads.values()].sort((a,b)=>a.depth-b.depth||String(a.address).localeCompare(String(b.address)));
}

function allTraceRows(filtered=true){
  const rows=[];
  const seen=new Set();
  for(const entry of traceEntries()){
    const sourceRows=filtered?filterRows(entry.payload):(entry.payload.transactions||[]);
    for(const row of sourceRows){
      const key=[entry.key,row.id,row.asset,row.direction,(row.counterparties||[]).join(",")].join("|");
      if(seen.has(key))continue;
      seen.add(key);
      rows.push({...row,_trace_source:entry.address,_trace_depth:entry.depth});
    }
  }
  return rows.sort((a,b)=>String(b.time||"").localeCompare(String(a.time||"")));
}

function populateAssetFilter(){
  const select=document.getElementById("filterAsset");
  if(!select)return;
  const current=String(select.value||"all");
  const assets=[...new Set(traceEntries().flatMap(entry=>(entry.payload.transactions||[]).map(row=>String(row.asset||"").trim())).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b));
  select.innerHTML='<option value="all">All assets</option>'+
    assets.map(asset=>'<option value="'+esc(asset)+'">'+esc(asset)+'</option>').join("");
  select.value=assets.includes(current)?current:"all";
}

function resetFilterControls(renderNow=true){
  const defaults={
    filterDirection:"all",filterAsset:"all",filterType:"all",filterStatus:"all",
    filterMinAmount:"",filterMaxAmount:"",filterFromDate:"",filterToDate:"",
    filterText:"",filterGraphMinLinks:"1",filterGraphNodes:"80"
  };
  for(const [id,value] of Object.entries(defaults)){
    const el=document.getElementById(id);
    if(el)el.value=value;
  }
  populateAssetFilter();
  if(renderNow)renderFilteredViews();
}

function renderFilterSummary(rows){
  const el=document.getElementById("cryptoFilterSummary");
  if(!el||!lastPayload)return;
  const total=allTraceRows(false).length;
  const labels=activeFilterLabels();
  el.textContent=rows.length+" of "+total+" records across "+tracePayloads.size+" analyzed wallet(s)"+
    (labels.length?" · "+labels.join(" · "):" · no transaction filters active");
  el.classList.toggle("crypto-filter-active",labels.length>0);
}

function isSearchableAddress(address,chain){
  const value=String(address||"");
  if(["ethereum","bsc","polygon","arbitrum","base"].includes(chain))return /^0x[a-fA-F0-9]{40}$/.test(value);
  if(chain==="tron")return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
  if(chain==="bitcoin")return /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{24,33})$/i.test(value);
  return false;
}

function openCryptoSearch(address,chain){
  if(!isSearchableAddress(address,chain)){
    setStatus("This provider returned an encoded/non-searchable counterparty address for the current chain. You can still inspect linked transactions.","warning");
    return;
  }
  const url=new URL("crypto.html",window.location.href);
  url.search="";
  url.searchParams.set("q",address);
  url.searchParams.set("chain",chain);
  url.searchParams.set("autorun","1");
  const child=window.open(url.toString(),"_blank");
  if(child){
    try{child.opener=null;}catch(_){}
  }else{
    setStatus("The browser blocked the new CT Atlas Crypto tab. Allow pop-ups for CT Atlas and try again.","warning");
  }
}

function maxCountInWindow(rows,windowMs){
  const times=rows.map(row=>Date.parse(row.time||"")).filter(Number.isFinite).sort((a,b)=>a-b);
  let best=0,left=0;
  for(let right=0;right<times.length;right++){
    while(times[right]-times[left]>windowMs)left++;
    best=Math.max(best,right-left+1);
  }
  return best;
}

function amountCluster(rows){
  const values=rows.map(row=>Math.abs(Number(row.amount))).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
  let best=[];
  for(let i=0;i<values.length;i++){
    const anchor=values[i];
    const cluster=values.filter(value=>Math.abs(value-anchor)/Math.max(anchor,1e-12)<=0.03);
    if(cluster.length>best.length)best=cluster;
  }
  return best;
}

function detectPatterns(){
  const rows=allTraceRows(true);
  const patterns=[];
  if(!rows.length)return patterns;

  const bySource=new Map();
  for(const row of rows){
    const key=String(row._trace_source||"");
    if(!bySource.has(key))bySource.set(key,[]);
    bySource.get(key).push(row);
  }

  for(const [source,sourceRows] of bySource){
    const incoming=sourceRows.filter(row=>row.direction==="IN");
    const outgoing=sourceRows.filter(row=>row.direction==="OUT");
    const inCp=new Set(incoming.flatMap(row=>row.counterparties||[]));
    const outCp=new Set(outgoing.flatMap(row=>row.counterparties||[]));

    if(inCp.size>=4){
      patterns.push({
        name:"FAN-IN / CONSOLIDATION",
        severity:inCp.size>=10?"medium":"low",
        metric:inCp.size+" incoming counterparties",
        detail:"Multiple observed counterparties converge on "+short(source,8)+". This is a structural consolidation pattern only."
      });
    }
    if(outCp.size>=4){
      patterns.push({
        name:"FAN-OUT / DISPERSION",
        severity:outCp.size>=10?"medium":"low",
        metric:outCp.size+" outgoing counterparties",
        detail:short(source,8)+" distributes value to multiple observed counterparties."
      });
    }

    const velocity=maxCountInWindow(sourceRows,24*3600000);
    if(velocity>=10){
      patterns.push({
        name:"HIGH VELOCITY",
        severity:velocity>=30?"high":"medium",
        metric:velocity+" records / 24h",
        detail:"High transaction frequency is observed in a rolling 24-hour window."
      });
    }
    const burst=maxCountInWindow(sourceRows,3600000);
    if(burst>=6){
      patterns.push({
        name:"BURST ACTIVITY",
        severity:burst>=15?"high":"medium",
        metric:burst+" records / 1h",
        detail:"A concentrated burst of on-chain activity is present in the returned sample."
      });
    }

    const times=sourceRows.map(row=>Date.parse(row.time||"")).filter(Number.isFinite).sort((a,b)=>a-b);
    let maxGap=0;
    for(let i=1;i<times.length;i++)maxGap=Math.max(maxGap,times[i]-times[i-1]);
    if(maxGap>=30*86400000){
      patterns.push({
        name:"DORMANT → ACTIVE",
        severity:"low",
        metric:Math.floor(maxGap/86400000)+" day observed gap",
        detail:"The returned history contains a long inactivity gap followed by later activity. Full lifetime history may be required to confirm dormancy."
      });
    }

    const cluster=amountCluster(outgoing);
    if(cluster.length>=4){
      const center=cluster.reduce((sum,x)=>sum+x,0)/cluster.length;
      patterns.push({
        name:"REPEATED SIMILAR AMOUNTS",
        severity:"low",
        metric:cluster.length+" transfers near "+fmtNumber(center),
        detail:"Several outgoing transfers have closely similar values (±3%). This can reflect batching, splitting, payroll-like activity or other benign/illicit processes."
      });
    }

    const incomingSorted=incoming.filter(row=>Number.isFinite(Date.parse(row.time||""))).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
    const outgoingSorted=outgoing.filter(row=>Number.isFinite(Date.parse(row.time||""))).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
    let passThrough=0;
    for(const inc of incomingSorted){
      const it=Date.parse(inc.time);
      const ia=Math.abs(Number(inc.amount)||0);
      const match=outgoingSorted.find(out=>{
        const dt=Date.parse(out.time)-it;
        const oa=Math.abs(Number(out.amount)||0);
        return dt>=0&&dt<=6*3600000&&ia>0&&oa>=ia*0.5&&oa<=ia*1.5;
      });
      if(match)passThrough++;
    }
    if(passThrough>=2){
      patterns.push({
        name:"RAPID PASS-THROUGH",
        severity:passThrough>=5?"high":"medium",
        metric:passThrough+" matched receive/send pairs ≤6h",
        detail:"Incoming value is followed by similarly sized outgoing value within six hours. This does not by itself establish layering or common ownership."
      });
    }
  }

  const model=currentNetworkModel;
  if(model&&model.maxVisibleDepth>=2){
    const degree=new Map();
    for(const edge of model.edges){
      degree.set(edge.fromKey,(degree.get(edge.fromKey)||0)+1);
      degree.set(edge.toKey,(degree.get(edge.toKey)||0)+1);
    }
    const chainLike=model.nodes.filter(node=>node.depth>0&&node.depth<model.maxVisibleDepth&&(degree.get(node.key)||0)<=3);
    if(chainLike.length>=2){
      patterns.push({
        name:"POSSIBLE PEELING-LIKE CHAIN",
        severity:"low",
        metric:chainLike.length+" low-branch intermediate nodes",
        detail:"The traced graph contains a narrow multi-hop continuation resembling a peeling-chain topology. Confirmation requires full transaction/value analysis and should not be inferred from topology alone."
      });
    }
  }

  const unique=new Map();
  for(const item of patterns){
    const key=item.name+"|"+item.metric+"|"+item.detail;
    if(!unique.has(key))unique.set(key,item);
  }
  return [...unique.values()].slice(0,20);
}

function directedAdjacency(){
  const adjacency=new Map();
  for(const edge of currentNetworkModel?.edges||[]){
    if(!adjacency.has(edge.fromKey))adjacency.set(edge.fromKey,[]);
    adjacency.get(edge.fromKey).push(edge.toKey);
  }
  return adjacency;
}

function shortestPath(targetSet,maxHops=4){
  if(!currentNetworkModel)return null;
  const root=currentNetworkModel.rootKey;
  const targets=new Set([...targetSet].map(value=>normalizeAddressForChain(value,lastPayload.chain)));
  if(targets.has(root))return [root];
  const adjacency=directedAdjacency();
  const queue=[[root,[root]]];
  const visited=new Set([root]);
  while(queue.length){
    const [node,path]=queue.shift();
    const hops=path.length-1;
    if(hops>=maxHops)continue;
    for(const next of adjacency.get(node)||[]){
      if(visited.has(next))continue;
      const nextPath=[...path,next];
      if(targets.has(next))return nextPath;
      visited.add(next);
      queue.push([next,nextPath]);
    }
  }
  return null;
}

function displayAddressForKey(key){
  const node=(currentNetworkModel?.nodes||[]).find(item=>item.key===key);
  if(node)return node.id;
  const label=(cryptoWorkspace.labels||[]).find(item=>normalizeAddressForChain(item.address,item.chain)===key&&item.chain===lastPayload?.chain);
  return label?.address||key;
}

function exposureFindings(){
  if(!lastPayload||!currentNetworkModel)return [];
  const sensitive=new Set(["CT WATCHLIST","SANCTIONS","DARKNET","MIXER","EXCHANGE","BRIDGE","DEX","GAMBLING","SCAM/FRAUD"]);
  const findings=[];
  const seen=new Set();

  const candidates=[];
  for(const label of cryptoWorkspace.labels||[]){
    if(label.chain!==lastPayload.chain||!sensitive.has(String(label.category||"").toUpperCase()))continue;
    candidates.push({address:label.address,category:label.category,name:label.name,confidence:label.confidence,source:"label"});
  }
  for(const watch of cryptoWorkspace.watchlist||[]){
    if(watch.chain!==lastPayload.chain)continue;
    for(const category of watch.categories||[]){
      if(sensitive.has(String(category).toUpperCase())){
        candidates.push({address:watch.address,category,name:watch.label||short(watch.address,8),confidence:"ANALYST",source:"watchlist"});
      }
    }
  }

  for(const item of candidates){
    const key=normalizeAddressForChain(item.address,lastPayload.chain);
    if(seen.has(item.category+"|"+key))continue;
    seen.add(item.category+"|"+key);
    const path=shortestPath(new Set([key]),3);
    if(!path||path.length<2)continue;
    findings.push({
      ...item,
      hop:path.length-1,
      path
    });
  }

  const rootEntry=tracePayloads.get(currentNetworkModel.rootKey);
  const rootRows=rootEntry?filterRows(rootEntry.payload):[];
  const totalOutgoing=rootRows.filter(row=>row.direction==="OUT").reduce((sum,row)=>sum+Math.abs(Number(row.amount)||0),0);
  const directValueByCategory=new Map();
  for(const row of rootRows.filter(row=>row.direction==="OUT")){
    const cps=(row.counterparties||[]).filter(Boolean);
    if(!cps.length)continue;
    const share=Math.abs(Number(row.amount)||0)/cps.length;
    for(const cp of cps){
      const label=labelForAddress(cp,lastPayload.chain);
      if(label&&sensitive.has(String(label.category||"").toUpperCase())){
        directValueByCategory.set(label.category,(directValueByCategory.get(label.category)||0)+share);
      }
    }
  }

  return findings.sort((a,b)=>a.hop-b.hop||String(a.category).localeCompare(String(b.category))).map(item=>({
    ...item,
    direct_share:item.hop===1&&totalOutgoing>0
      ? Math.min(100,100*(directValueByCategory.get(item.category)||0)/totalOutgoing)
      : null
  }));
}

function renderPatterns(){
  const box=document.getElementById("cryptoPatternList");
  if(!box)return;
  const patterns=detectPatterns();
  if(!patterns.length){
    box.innerHTML='<div class="intel-result">No configured behavioral pattern crossed its heuristic threshold in the currently traced/filtered sample.</div>';
    return;
  }
  box.innerHTML=patterns.map(item=>
    '<div class="intel-item"><div class="intel-item-head"><div class="intel-title">'+esc(item.name)+'</div>'+
    '<span class="intel-badge '+esc(item.severity)+'">'+esc(item.severity.toUpperCase())+'</span></div>'+
    '<div class="intel-meta">'+esc(item.metric)+'</div><div class="intel-detail">'+esc(item.detail)+'</div></div>'
  ).join("");
}

function exchangeIdentificationFindings(){
  if(!lastPayload||lastPayload.kind!=="address")return [];
  const findings=new Map();
  const chain=lastPayload.chain;
  const addSourced=(address,label,depth=0,interactions=0)=>{
    if(!label||String(label.category||"").toUpperCase()!=="EXCHANGE"||!(label.source_url||label.source_title))return;
    const key=exchangeLabelKey(address,chain);
    const previous=findings.get(key);
    findings.set(key,{
      type:"sourced",
      address,
      chain,
      name:label.name||"Exchange",
      wallet_role:label.wallet_role||"UNKNOWN",
      confidence:label.confidence||"MEDIUM",
      source_type:label.source_type||"",
      source_title:label.source_title||"",
      source_url:label.source_url||"",
      notes:label.notes||"",
      depth:previous?.depth??depth,
      interactions:(previous?.interactions||0)+interactions
    });
  };

  for(const entry of traceEntries()){
    addSourced(entry.address,labelForAddress(entry.address,chain),entry.depth,0);
    for(const row of Array.isArray(entry.payload?.transactions)?entry.payload.transactions:[]){
      for(const address of Array.isArray(row?.counterparties)?row.counterparties:[]){
        addSourced(address,labelForAddress(address,chain),entry.depth,1);
      }
    }
    const behavior=entry.payload?.exchange_behavior;
    if(behavior?.status!=="behavioral_candidate"||Number(behavior.score)<80)continue;
    const key=exchangeLabelKey(entry.address,chain);
    if(findings.has(key))continue;
    findings.set(key,{
      type:"behavioral",
      address:entry.address,
      chain,
      name:behavior.related_exchange?.name
        ? "Exchange-like · repeated link to "+behavior.related_exchange.name
        : "Exchange-like high-throughput hub",
      score:Number(behavior.score),
      threshold:Number(behavior.threshold)||80,
      depth:entry.depth,
      evidence:Array.isArray(behavior.evidence)?behavior.evidence:[],
      metrics:behavior.metrics||{},
      related_exchange:behavior.related_exchange||null,
      ai_attribution:exchangeAttributions.get(traceKey(entry.address,chain))||null,
      limitations:behavior.limitations||"Rules-based screening score, not a calibrated probability; review the underlying transactions before attribution."
    });
  }
  return [...findings.values()].sort((a,b)=>
    (a.type===b.type?0:a.type==="sourced"?-1:1)||
    Number(b.score||0)-Number(a.score||0)||
    String(a.name).localeCompare(String(b.name))
  );
}

function exchangeBehaviorForAddress(address,chain=lastPayload?.chain){
  const entry=tracePayloads.get(traceKey(address,chain));
  const behavior=entry?.payload?.exchange_behavior;
  return behavior?.status==="behavioral_candidate"&&Number(behavior.score)>=80?behavior:null;
}

function renderExchangeIdentification(){
  const box=document.getElementById("cryptoExchangeFindings");
  if(!box)return;
  const findings=exchangeIdentificationFindings();
  if(!findings.length){
    box.innerHTML='<div class="intel-result">No sourced exchange match or behavioural candidate at or above 80/100 was found in the currently analysed sample. Counterparties appear here only after their addresses are sourced or their wallets are expanded.</div>';
    return;
  }
  box.innerHTML=findings.map(item=>{
    const sourced=item.type==="sourced";
    const source=item.source_url
      ?'<a href="'+esc(item.source_url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.source_title||item.source_url)+'</a>'
      :esc(item.source_title||item.source_type||"Sourced exchange label");
    const evidence=(item.evidence||[]).map(text=>esc(text)).join(" · ");
    const meta=esc(item.chain.toUpperCase())+" · H"+Number(item.depth||0)+" · "+esc(short(item.address,9))+
      (item.wallet_role?" · "+esc(String(item.wallet_role).replaceAll("_"," ")):"")+
      (item.interactions?" · "+Number(item.interactions)+" observed link(s)":"");
    const badge=sourced
      ?'<span class="intel-badge clear">SOURCED LABEL · '+esc(item.confidence)+'</span>'
      :'<span class="intel-badge exchange-score">SCORE '+Number(item.score)+"/100</span>";
    const ai=item.ai_attribution;
    const aiDetail=ai?'<div class="intel-detail"><strong>AI-assessed operator: '+esc(ai.likely_exchange)+' · '+esc(ai.confidence)+' confidence</strong>'+
      (ai.service_type?' · '+esc(String(ai.service_type).replaceAll("_"," ")):"")+
      (ai.basis?.length?' — '+ai.basis.map(text=>esc(text)).join(" · "):"")+
      (ai.alternatives?.length?' · Alternatives: '+ai.alternatives.map(text=>esc(text)).join(", "):"")+
      ' <em>(investigative lead, not a sourced label)</em></div>':"";
    const detail=sourced
      ?(item.notes?'<div class="intel-detail">'+esc(item.notes)+'</div>':"")
      :aiDetail+'<div class="intel-detail">'+evidence+'</div><div class="intel-detail">'+esc(item.limitations)+'</div>';
    return '<div class="intel-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(item.name)+'</div><div class="intel-meta">'+meta+'</div></div>'+badge+'</div>'+
      (sourced?'<div class="label-source">SOURCE: '+source+'</div>':"")+detail+'</div>';
  }).join("");
}

function renderExposure(){
  const box=document.getElementById("cryptoExposureSummary");
  if(!box)return;
  const findings=exposureFindings();
  if(!findings.length){
    box.innerHTML='<div class="intel-result">No path from the seed to a currently labelled sensitive category was observed within H1–H3.</div>';
    return;
  }
  box.innerHTML=findings.map(item=>{
    const label=item.name||short(item.address,8);
    const share=item.direct_share!==null
      ? '<div class="exposure-row"><span>Direct value</span><span class="exposure-bar"><i style="width:'+Math.max(2,item.direct_share)+'%"></i></span><strong>'+item.direct_share.toFixed(1)+'%</strong></div>'
      :"";
    return '<div class="intel-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(item.category)+' · H'+item.hop+'</div>'+
      '<div class="intel-meta">'+esc(label)+' · '+esc(short(item.address,9))+'</div></div><span class="intel-badge exposure">EXPOSURE</span></div>'+
      share+'<div class="intel-detail">Observed path: '+item.path.map(key=>esc(short(displayAddressForKey(key),6))).join(" → ")+'</div></div>';
  }).join("");
}

function renderPath(path){
  const box=document.getElementById("pathResult");
  if(!box)return;
  if(!path){
    box.textContent="No observed directed path matched the current target within the configured hop limit.";
    return;
  }
  lastFoundPath=path;
  box.innerHTML='<div class="intel-meta">SHORTEST OBSERVED PATH · '+(path.length-1)+' HOP(S)</div><div class="intel-path">'+
    path.map((key,index)=>'<span class="intel-path-node" title="'+esc(displayAddressForKey(key))+'">'+esc(short(displayAddressForKey(key),7))+'</span>'+
      (index<path.length-1?'<span class="intel-path-arrow">→</span>':"")).join("")+
    "</div>";
}

function runPathFinder(){
  if(!currentNetworkModel)return;
  const target=String(document.getElementById("pathTarget")?.value||"").trim();
  const category=String(document.getElementById("pathCategory")?.value||"").trim();
  const maxHops=Math.max(1,Math.min(4,Number(document.getElementById("pathMaxHops")?.value||3)||3));
  let targets=new Set();
  if(target)targets.add(normalizeAddressForChain(target,lastPayload.chain));
  else if(category)targets=categoryTargets(category,lastPayload.chain);
  else{
    document.getElementById("pathResult").textContent="Enter a target address or choose a target category.";
    return;
  }
  renderPath(shortestPath(targets,maxHops));
}

function renderLabelList(){
  const box=document.getElementById("cryptoLabelList");
  if(!box)return;
  const labels=lastPayload?visibleRelevantLabels():(cryptoWorkspace.labels||[]).slice(0,50);
  if(!labels.length){
    box.innerHTML='<div class="intel-result">No sourced labels are attached to the currently visible network.</div>';
    return;
  }
  box.innerHTML=labels.map(label=>{
    const source=label.source_url
      ? '<a href="'+esc(label.source_url)+'" target="_blank" rel="noopener noreferrer">'+esc(label.source_title||label.source_url)+'</a>'
      : esc(label.source_title||label.source_type||"Analyst source");
    const role=label.category==="EXCHANGE"&&label.wallet_role?" · "+label.wallet_role.replaceAll("_"," "):"";
    const state=label.shared?'<span class="intel-badge clear exchange-source-badge">SHARED · APPROVED</span>':label.builtin?'<span class="intel-badge pattern exchange-source-badge">BUILT-IN</span>':"";
    const remove=label.shared||label.builtin?"":'<div class="intel-actions"><button type="button" class="crypto-small-button label-delete" data-id="'+esc(label.id)+'">DELETE</button></div>';
    return '<div class="intel-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(label.name||label.category)+'</div>'+
      '<div class="intel-meta">'+esc(label.category+role)+' · '+esc(short(label.address,9))+'</div></div>'+
      '<div>'+state+'<span class="intel-badge '+String(label.confidence||"low").toLowerCase()+'">'+esc(label.confidence||"LOW")+'</span></div></div>'+
      '<div class="label-source">SOURCE: '+source+'</div>'+
      (label.notes?'<div class="intel-detail">'+esc(label.notes)+'</div>':"")+
      remove+'</div>';
  }).join("");
  box.querySelectorAll(".label-delete").forEach(button=>button.addEventListener("click",()=>{
    cryptoWorkspace.labels=(cryptoWorkspace.labels||[]).filter(item=>item.id!==button.dataset.id);
    scheduleWorkspaceSave();renderWorkspaceUi();renderFilteredViews();
  }));
}

async function exchangeApi(action,extra={}){
  const response=await fetch(API_BASE+"/crypto-address-labels",{
    method:"POST",
    headers:sessionHeaders({"Content-Type":"application/json"}),
    body:JSON.stringify({user_id:user(),action,...extra})
  });
  const payload=await response.json().catch(()=>({}));
  if(response.status===401){redirectToLogin();throw new Error("Session expired.");}
  if(!response.ok)throw new Error(payload.error||"Exchange label request failed.");
  return payload;
}

function setExchangeAdminStatus(message){
  const el=document.getElementById("exchangeAdminStatus");
  if(el)el.textContent=message||"";
}

function renderExchangeAdminAccess(){
  const panel=document.getElementById("exchangeAdminPanel");
  if(!panel)return;
  const allowed=user()==="admin";
  panel.hidden=!allowed;
  if(allowed&&panel.dataset.initialized!=="true"){
    panel.open=true;
    panel.dataset.initialized="true";
    refreshExchangeProposals().catch(error=>setExchangeAdminStatus(error.message));
  }
}

async function refreshExchangeProposals(){
  const box=document.getElementById("exchangeProposalList");
  if(box)box.innerHTML='<div class="intel-result">Loading pending exchange proposals…</div>';
  const payload=await exchangeApi("pending");
  const proposals=Array.isArray(payload.proposals)?payload.proposals:[];
  if(!box)return;
  if(!proposals.length){
    box.innerHTML='<div class="intel-result">No exchange labels are waiting for review.</div>';
    return;
  }
  box.innerHTML=proposals.map(item=>{
    const source=item.source_url
      ?'<a href="'+esc(item.source_url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.source_title||item.source_url)+'</a>'
      :esc(item.source_title||item.source_type||"No source title");
    return '<div class="intel-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(item.name)+'</div><div class="intel-meta">'+esc(item.chain)+' · '+esc(item.wallet_role||"UNKNOWN")+' · '+esc(short(item.address,10))+'</div></div><span class="intel-badge '+String(item.confidence||"medium").toLowerCase()+'">'+esc(item.confidence||"MEDIUM")+'</span></div><div class="label-source">SOURCE: '+source+'</div>'+(item.notes?'<div class="intel-detail">'+esc(item.notes)+'</div>':"")+'<div class="intel-meta">Submitted by '+esc(item.created_by||"unknown")+' · '+esc(fmtTime(item.created_at))+'</div><div class="exchange-proposal-actions"><button class="crypto-small-button trace-button" data-exchange-review="approve" data-proposal-id="'+esc(item.id)+'" type="button">APPROVE</button><button class="crypto-small-button" data-exchange-review="reject" data-proposal-id="'+esc(item.id)+'" type="button">REJECT</button></div></div>';
  }).join("");
}

function parseCsvRecords(text){
  text=String(text||"").replace(/^\uFEFF/,"");
  const rows=[];let row=[],field="",quoted=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(quoted){
      if(char==='"'&&text[i+1]==='"'){field+='"';i++;}
      else if(char==='"')quoted=false;
      else field+=char;
    }else if(char==='"')quoted=true;
    else if(char===","){row.push(field);field="";}
    else if(char==="\n") {row.push(field);rows.push(row);row=[];field="";}
    else if(char!=="\r")field+=char;
  }
  if(field.length||row.length){row.push(field);rows.push(row);}
  if(rows.length<2)return [];
  const headers=rows.shift().map(value=>value.trim().toLowerCase());
  return rows.filter(values=>values.some(value=>String(value||"").trim())).map(values=>{
    const item={};headers.forEach((key,index)=>item[key]=String(values[index]||"").trim());return item;
  });
}

function parseExchangeImport(text){
  const trimmed=String(text||"").replace(/^\uFEFF/,"").trim();
  if(!trimmed)return [];
  if(trimmed.startsWith("[")||trimmed.startsWith("{")){
    const parsed=JSON.parse(trimmed);
    return Array.isArray(parsed)?parsed:Array.isArray(parsed.labels)?parsed.labels:[];
  }
  return parseCsvRecords(trimmed);
}

async function reviewExchangeProposal(button){
  button.disabled=true;
  try{
    const decision=String(button.dataset.exchangeReview||"");
    const result=await exchangeApi("review",{proposal_id:button.dataset.proposalId,decision});
    if(decision==="approve"&&result.proposal){
      const label={...result.proposal,shared:true,status:"APPROVED",id:"shared:"+exchangeLabelKey(result.proposal.address,result.proposal.chain)};
      sharedExchangeLabels.set(exchangeLabelKey(label.address,label.chain),label);
      renderWorkspaceUi();renderFilteredViews();
    }
    await refreshExchangeProposals();
    setExchangeAdminStatus(decision==="approve"?"Exchange label approved and now available to every analyst.":"Exchange label rejected.");
  }catch(error){setExchangeAdminStatus(error.message);}
  finally{button.disabled=false;}
}

async function importExchangeLabels(){
  const text=String(document.getElementById("exchangeImportText")?.value||"");
  let records;
  try{records=parseExchangeImport(text);}catch(error){setExchangeAdminStatus("Import parse error: "+error.message);return;}
  if(!records.length){setExchangeAdminStatus("No import rows found.");return;}
  let imported=0;
  try{
    for(let start=0;start<records.length;start+=100){
      const payload=await exchangeApi("import",{labels:records.slice(start,start+100)});
      imported+=Number(payload.imported||0);
    }
    setExchangeAdminStatus(imported+" exchange label(s) imported and approved from "+records.length+" row(s).");
    document.getElementById("exchangeImportText").value="";
  }catch(error){setExchangeAdminStatus("Import stopped after "+imported+" label(s): "+error.message);}
}

function downloadExchangeTemplate(){
  const content="chain,address,name,wallet_role,confidence,source_type,source_title,source_url,notes\n";
  const url=URL.createObjectURL(new Blob([content],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download="crypto-exchange-addresses-template.csv";link.click();URL.revokeObjectURL(url);
}

function openLabelForm(address){
  const form=document.getElementById("labelForm");
  if(!form)return;
  form.hidden=false;
  const chainSelect=document.getElementById("labelChain");
  if(chainSelect&&lastPayload?.chain)chainSelect.value=lastPayload.chain;
  document.getElementById("labelAddress").value=address||lastPayload?.query||"";
  syncLabelCategoryFields();
  document.getElementById("labelName").focus();
}

function syncLabelCategoryFields(){
  const isExchange=String(document.getElementById("labelCategory")?.value||"").toUpperCase()==="EXCHANGE";
  const role=document.getElementById("labelWalletRoleField");
  const proposal=document.getElementById("exchangeProposalField");
  if(role)role.hidden=!isExchange;
  if(proposal)proposal.hidden=!isExchange;
  if(!isExchange&&document.getElementById("labelProposeExchange"))document.getElementById("labelProposeExchange").checked=false;
}

async function saveLabel(){
  const address=String(document.getElementById("labelAddress")?.value||"").trim();
  const chain=String(document.getElementById("labelChain")?.value||lastPayload?.chain||"");
  if(!chain||!isSearchableAddress(address,chain)){
    setStatus("Select a chain and enter a valid address on it before saving a label.","warning");
    return;
  }
  const name=String(document.getElementById("labelName")?.value||"").trim();
  const sourceTitle=String(document.getElementById("labelSourceTitle")?.value||"").trim();
  const sourceType=String(document.getElementById("labelSourceType")?.value||"").trim();
  const sourceUrl=String(document.getElementById("labelSourceUrl")?.value||"").trim();
  if(!name||(!sourceTitle&&!sourceType&&!/^https:\/\//i.test(sourceUrl))){
    setStatus("A label/entity name and a source description are required.","warning");
    return;
  }
  const category=String(document.getElementById("labelCategory")?.value||"OTHER");
  const walletRole=String(document.getElementById("labelWalletRole")?.value||"UNKNOWN");
  const proposeExchange=category==="EXCHANGE"&&document.getElementById("labelProposeExchange")?.checked===true;
  const item={
    id:makeId("label"),
    chain,
    address,
    name,
    category,
    wallet_role:walletRole,
    confidence:String(document.getElementById("labelConfidence")?.value||"LOW"),
    source_type:sourceType,
    source_title:sourceTitle,
    source_url:sourceUrl,
    notes:String(document.getElementById("labelNotes")?.value||"").trim(),
    created_at:new Date().toISOString()
  };
  const key=normalizeAddressForChain(address,chain);
  cryptoWorkspace.labels=(cryptoWorkspace.labels||[]).filter(label=>
    !(label.chain===chain&&normalizeAddressForChain(label.address,label.chain)===key&&label.category===item.category)
  );
  cryptoWorkspace.labels.unshift(item);
  document.getElementById("labelForm").hidden=true;
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();
  renderWorkspaceUi();renderFilteredViews();
  if(proposeExchange){
    try{
      await exchangeApi("propose",{label:item});
      setStatus("Private analyst label saved; EXCHANGE proposal is waiting for admin validation.","success");
    }catch(error){setStatus("Private label saved, but the shared EXCHANGE proposal failed: "+error.message,"warning");}
  }else setStatus("Sourced analyst label saved.","success");
}

function renderCaseUi(){
  const select=document.getElementById("caseSelect");
  const detail=document.getElementById("caseDetail");
  if(!select||!detail)return;
  const cases=cryptoWorkspace.cases||[];
  select.innerHTML='<option value="">No case selected</option>'+cases.map(item=>
    '<option value="'+esc(item.id)+'">'+esc(item.name)+' · '+esc(item.status||"OPEN")+'</option>'
  ).join("");
  if(activeCaseId&&cases.some(item=>item.id===activeCaseId))select.value=activeCaseId;
  else activeCaseId="";

  const active=cases.find(item=>item.id===activeCaseId);
  if(!active){detail.textContent="Select or create a case to persist seeds, paths and analyst notes.";return;}
  detail.innerHTML='<div class="intel-title">'+esc(active.name)+'</div>'+
    '<div class="intel-detail">'+esc(active.description||"No description")+'</div>'+
    '<div class="intel-meta">SEEDS</div><div>'+((active.seed_addresses||[]).map(address=>'<span class="case-pill">'+esc(short(address,8))+'</span>').join("")||"—")+'</div>'+
    '<div class="intel-meta" style="margin-top:7px">SAVED PATHS · '+(active.saved_paths||[]).length+'</div>'+
    '<div class="intel-meta" style="margin-top:7px">OFF-CHAIN NODES · '+(active.offchain_nodes||[]).length+' · CROSS-CHAIN LINKS · '+(active.crosschain_links||[]).length+'</div>'+
    '<div class="intel-meta" style="margin-top:7px">NOTES · '+(active.notes||[]).length+'</div>';
}

function createCase(){
  const name=String(document.getElementById("caseName")?.value||"").trim();
  if(!name){setStatus("Enter a case name.","warning");return;}
  const item={
    id:makeId("case"),name,
    description:String(document.getElementById("caseDescription")?.value||"").trim(),
    status:"OPEN",chain:lastPayload?.chain||"",seed_addresses:[],saved_paths:[],notes:[],offchain_nodes:[],crosschain_links:[],
    created_at:new Date().toISOString()
  };
  cryptoWorkspace.cases.unshift(item);
  activeCaseId=item.id;
  document.getElementById("caseCreateForm").hidden=true;
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();
}

function activeCase(){
  return (cryptoWorkspace.cases||[]).find(item=>item.id===activeCaseId)||null;
}

function addSeedToCase(){
  const item=activeCase();
  if(!item||!lastPayload?.query){setStatus("Select a case first.","warning");return;}
  item.seed_addresses=Array.isArray(item.seed_addresses)?item.seed_addresses:[];
  if(!item.seed_addresses.includes(lastPayload.query))item.seed_addresses.push(lastPayload.query);
  item.chain=item.chain||lastPayload.chain;
  item.updated_at=new Date().toISOString();
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();setStatus("Current seed added to case.","success");
}

function savePathToCase(){
  const item=activeCase();
  if(!item){setStatus("Select a case first.","warning");return;}
  if(!lastFoundPath||lastFoundPath.length<2){setStatus("Run Path Finder first, then save the resulting path.","warning");return;}
  item.saved_paths=Array.isArray(item.saved_paths)?item.saved_paths:[];
  item.saved_paths.unshift({
    id:makeId("path"),
    name:"Path "+new Date().toLocaleString(),
    nodes:lastFoundPath.map(displayAddressForKey),
    created_at:new Date().toISOString()
  });
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();setStatus("Current path saved to case.","success");
}

function addCaseNote(){
  const item=activeCase();
  const input=document.getElementById("caseNote");
  const text=String(input?.value||"").trim();
  if(!item){setStatus("Select a case first.","warning");return;}
  if(!text){setStatus("Enter an analyst note.","warning");return;}
  item.notes=Array.isArray(item.notes)?item.notes:[];
  item.notes.unshift({id:makeId("note"),text,created_at:new Date().toISOString()});
  input.value="";
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();
}

function saveOffchainNode(){
  const item=activeCase();
  if(!item){setStatus("Select a case first.","warning");return;}
  const label=String(document.getElementById("offchainLabel")?.value||"").trim();
  if(!label){setStatus("Enter an off-chain node label.","warning");return;}
  const linked=String(document.getElementById("offchainLinkedAddress")?.value||lastPayload?.query||"").trim();
  item.offchain_nodes=Array.isArray(item.offchain_nodes)?item.offchain_nodes:[];
  item.offchain_nodes.unshift({
    id:makeId("offchain"),
    type:String(document.getElementById("offchainType")?.value||"OTHER"),
    label,
    linked_address:linked,
    source_url:String(document.getElementById("offchainSourceUrl")?.value||"").trim(),
    notes:String(document.getElementById("offchainNotes")?.value||"").trim(),
    created_at:new Date().toISOString()
  });
  document.getElementById("offchainForm").hidden=true;
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();renderFilteredViews();
  setStatus("Off-chain node saved to the active case.","success");
}

function saveCrosschainLink(){
  const item=activeCase();
  if(!item){setStatus("Select a case first.","warning");return;}
  const fromChain=String(document.getElementById("crosschainFromChain")?.value||lastPayload?.chain||"").trim();
  const from=String(document.getElementById("crosschainFromAddress")?.value||lastPayload?.query||"").trim();
  const to=String(document.getElementById("crosschainToAddress")?.value||"").trim();
  const toChain=String(document.getElementById("crosschainToChain")?.value||"").trim();
  if(!fromChain||!from||!to||!toChain){setStatus("From chain, from wallet, destination chain and destination wallet are required.","warning");return;}
  item.crosschain_links=Array.isArray(item.crosschain_links)?item.crosschain_links:[];
  item.crosschain_links.unshift({
    id:makeId("crosschain"),
    from_chain:fromChain,
    from_address:from,
    to_chain:toChain,
    to_address:to,
    service:String(document.getElementById("crosschainService")?.value||"").trim(),
    confidence:String(document.getElementById("crosschainConfidence")?.value||"MEDIUM"),
    source_url:String(document.getElementById("crosschainSourceUrl")?.value||"").trim(),
    notes:String(document.getElementById("crosschainNotes")?.value||"").trim(),
    created_at:new Date().toISOString()
  });
  document.getElementById("crosschainForm").hidden=true;
  window.CTAtlasSound?.play();
  scheduleWorkspaceSave();renderCaseUi();renderFilteredViews();
  setStatus("Sourced cross-chain link saved to the active case.","success");
}

async function exportCasePdf(){
  const item=activeCase();
  if(!item){setStatus("Select a case first.","warning");return;}
  if(!window.CTAtlasPdf?.download){setStatus("PDF export library is unavailable.","error");return;}

  const patterns=detectPatterns();
  const exchangeFindings=exchangeIdentificationFindings();
  const exposure=exposureFindings();
  const cross=crossChainFindings();
  const labels=visibleRelevantLabels();

  const blocks=[
    {text:"CASE SUMMARY",type:"heading"},
    {text:item.description||"No description provided.",type:"body"},
    {text:"STATUS: "+(item.status||"OPEN")+" · CHAIN: "+(item.chain||lastPayload?.chain||"—"),type:"meta"},
    {text:"SEED ADDRESSES",type:"heading"},
    {text:(item.seed_addresses||[]).join("\n")||"No seeds saved.",type:"body"},
    {text:"BEHAVIORAL PATTERNS",type:"heading"},
    ...((patterns.length?patterns:[{name:"No configured pattern threshold crossed",metric:"",detail:""}]).map(p=>({
      text:p.name+(p.metric?" · "+p.metric:"")+(p.detail?"\n"+p.detail:""),type:"body"
    }))),
    {text:"EXCHANGE IDENTIFICATION",type:"heading"},
    ...((exchangeFindings.length?exchangeFindings:[{name:"No sourced exchange match or behavioural candidate at or above 80/100."}]).map(item=>({
      text:(item.name||"Exchange finding")+(item.score!==undefined?" · heuristic score "+item.score+"/100":" · "+(item.confidence||"SOURCED"))+
        (item.address?"\n"+item.address:"")+(item.source_title?"\nSource: "+item.source_title:"")+
        (item.evidence?.length?"\n"+item.evidence.join("; "):"")+
        (item.limitations?"\n"+item.limitations:""),type:"body"
    }))),
    {text:"EXPOSURE",type:"heading"},
    ...((exposure.length?exposure:[{category:"No labelled H1-H3 exposure observed",hop:"",name:"",address:""}]).map(e=>({
      text:e.category+(e.hop?" · H"+e.hop:"")+(e.name?" · "+e.name:"")+(e.address?"\n"+e.address:""),type:"body"
    }))),
    {text:"SOURCED LABELS",type:"heading"},
    ...((labels.length?labels:[{name:"No visible sourced labels",category:"",confidence:"",address:""}]).map(label=>({
      text:(label.name||"")+(label.category?" · "+label.category:"")+(label.confidence?" · "+label.confidence:"")+(label.address?"\n"+label.address:"")+(label.source_title?"\nSource: "+label.source_title:""),type:"source"
    }))),
    {text:"SAVED PATHS",type:"heading"},
    ...((item.saved_paths||[]).map(path=>({text:(path.name||"Path")+"\n"+(path.nodes||[]).join(" → "),type:"body"}))),
    {text:"OFF-CHAIN ENTITIES",type:"heading"},
    ...((item.offchain_nodes||[]).map(node=>({text:(node.type||"OTHER")+" · "+node.label+"\nLinked wallet: "+(node.linked_address||"—")+(node.notes?"\n"+node.notes:""),type:"body"}))),
    {text:"CROSS-CHAIN LINKS",type:"heading"},
    ...((item.crosschain_links||[]).map(link=>({text:(link.service||"Cross-chain")+" · "+link.confidence+"\n"+link.from_chain+": "+link.from_address+"\n→ "+link.to_chain+": "+link.to_address+(link.notes?"\n"+link.notes:""),type:"body"}))),
    {text:"DETECTED SERVICE / BRIDGE / DEX TOUCHPOINTS",type:"heading"},
    ...((cross.length?cross:[{service:{category:"None observed",name:""},source_wallet:"",tx_id:""}]).map(entry=>({
      text:(entry.service?.category||"")+" · "+(entry.service?.name||"")+(entry.source_wallet?"\nSource wallet: "+entry.source_wallet:"")+(entry.tx_id?"\nTX: "+entry.tx_id:""),type:"body"
    }))),
    {text:"ANALYST NOTES",type:"heading"},
    ...((item.notes||[]).map(note=>({text:note.text,type:"body"}))),
    {text:"ANALYTICAL LIMITATIONS",type:"heading"},
    {text:"CT Atlas Crypto uses bounded public blockchain samples and analyst-sourced labels. On-chain transaction linkage does not establish identity, common ownership, criminality, terrorist financing, intent, or custody. Heuristic pattern detection and H1-H3 exposure calculations require independent validation before operational or evidentiary use.",type:"footer"}
  ];

  await window.CTAtlasPdf.download({
    filename:"CT-Atlas-Crypto-"+item.name,
    eyebrow:"CT ATLAS · CRYPTO INTELLIGENCE CASE",
    title:item.name,
    meta:"Generated "+new Date().toISOString()+" · user "+user(),
    blocks,
    footer:"CT Atlas Crypto · analyst workspace export"
  });
}

// ---------------------------------------------------------------------------
// Full analysis report: everything on screen (and what the filters hide) in one PDF.
// crypto-report.js turns the model below into the document; nothing here leaves the browser.
// ---------------------------------------------------------------------------

// Runs `fn` as if no transaction filter were set, so the report's sections use EVERY record, then puts the screen back.
function withoutTransactionFilters(fn){
  const previousFlag=reportUnfiltered,previousModel=currentNetworkModel;
  reportUnfiltered=true;
  try{
    currentNetworkModel=buildNetworkModel(lastPayload);
    return fn();
  }finally{
    reportUnfiltered=previousFlag;
    currentNetworkModel=previousModel;
  }
}

function flattenField(value){
  if(value===null||value===undefined)return "";
  if(Array.isArray(value))return value.map(flattenField).join(", ");
  if(typeof value==="object")return JSON.stringify(value);
  return String(value);
}

function thresholdsText(watch){
  const limits=watch.thresholds||{},parts=[];
  if(limits.min_amount!==null&&limits.min_amount!==undefined)parts.push("single transfer ≥ "+limits.min_amount);
  if(limits.aggregate_24h!==null&&limits.aggregate_24h!==undefined)parts.push("24h aggregate ≥ "+limits.aggregate_24h);
  if(limits.velocity_24h!==null&&limits.velocity_24h!==undefined)parts.push("24h tx count ≥ "+limits.velocity_24h);
  if(limits.dormant_days!==null&&limits.dormant_days!==undefined)parts.push("dormant ≥ "+limits.dormant_days+" days");
  return parts.join(" · ");
}

function caseContextForReport(){
  const item=activeCase();
  if(!item)return null;
  return {
    name:item.name,status:item.status,chain:item.chain,description:item.description,
    notes:(item.notes||[]).map(note=>note.text),
    savedPaths:(item.saved_paths||[]).map(path=>({name:path.name,nodes:path.nodes||[]})),
    offchain:(item.offchain_nodes||[]).map(node=>({type:node.type,label:node.label,linked:node.linked_address,notes:node.notes})),
    crosschain:(item.crosschain_links||[]).map(link=>({service:link.service,confidence:link.confidence,from:link.from_chain+": "+link.from_address,to:link.to_chain+": "+link.to_address,notes:link.notes}))
  };
}

function collectReportModel(){
  const payload=lastPayload;
  const isTransaction=payload.kind==="transaction";
  const base={
    generatedAt:new Date().toISOString(),
    user:user(),
    subject:{
      kind:isTransaction?"transaction":"address",chain:payload.chain,chainName:payload.chain_name,query:payload.query,
      provider:payload.provider,explorerUrl:payload.explorer_url||"",generatedAt:payload.generated_at||""
    },
    observations:Array.isArray(payload.observations)?payload.observations:[],
    samplingNote:payload.sampling_note||"",
    sanctions:sanctionsView(),
    filters:{active:isTransaction?[]:activeFilterLabels()},
    caseContext:caseContextForReport()
  };
  if(isTransaction){
    return {...base,counts:{},transactionFields:Object.entries(payload.transaction||{}).map(([key,value])=>[key,flattenField(value)])};
  }

  // The graph and its node table are the screen as the analyst arranged it; everything else uses all records.
  const displayed=graphDisplayModel||currentNetworkModel||buildNetworkModel(payload);
  const nodeLabel=address=>labelForAddress(address,payload.chain)?.name||"";
  let path=null;
  if(Array.isArray(lastFoundPath)&&lastFoundPath.length>1){
    const keys=new Set(displayed.nodes.map(node=>node.key));
    if(lastFoundPath.every(key=>keys.has(key)))path={nodes:lastFoundPath.map(key=>displayAddressForKey(key))};
  }
  const derived=withoutTransactionFilters(()=>({
    rows:allTraceRows(false),
    patterns:detectPatterns(),
    exchangeFindings:exchangeIdentificationFindings(),
    exposure:exposureFindings().map(item=>({...item,name:item.name||nodeLabel(item.address)})),
    crossChain:crossChainFindings(),
    labels:visibleRelevantLabels(),
    // Captured here, not from `displayed`: this is the same graph exposure/labels/patterns were just computed
    // from (no on-screen node-count cap), so a watched wallet reachable only past that cap is still found.
    fullModel:currentNetworkModel
  }));

  const seen=new Set(),watchlist=[];
  for(const address of [payload.query,...derived.fullModel.nodes.map(node=>node.id)]){
    for(const item of watchesForAddress(address,payload.chain)){
      if(seen.has(item.id))continue;
      seen.add(item.id);
      watchlist.push({label:item.label,address:item.address,enabled:item.enabled,thresholdsText:thresholdsText(item)});
    }
  }
  const seedKey=normalizeAddressForChain(payload.query,payload.chain);
  const alerts=(cryptoWorkspace.alerts||[]).filter(alert=>alert.chain===payload.chain&&normalizeAddressForChain(alert.address,alert.chain)===seedKey);

  return {
    ...base,
    balance:payload.balance||null,
    counts:{
      wallets:tracePayloads.size,maxDepth:displayed.maxVisibleDepth,
      transactions:derived.rows.length,transactionsListed:Math.min(derived.rows.length,window.CTAtlasCryptoReport.LIMITS.transactions),
      graphNodes:displayed.nodes.length,patterns:derived.patterns.length,exchangeFindings:derived.exchangeFindings.length,exposure:derived.exposure.length
    },
    patterns:derived.patterns,
    autoTrace:autoTraceRun?{
      startedAt:autoTraceRun.startedAt,finishedAt:autoTraceRun.finishedAt,maxDepth:autoTraceRun.maxDepth,maxDepthReached:autoTraceRun.maxDepthReached,
      branch:autoTraceRun.branch,walletBudget:autoTraceRun.walletBudget,expanded:autoTraceRun.expanded,failed:autoTraceRun.failed,
      stop:autoTraceRun.stop,attribution:autoTraceRun.attribution,
      exchanges:autoTraceRun.exchanges.map(item=>({
        address:item.address,depth:item.depth,basis:item.basis,name:item.name,score:item.score,source:item.source,
        evidence:item.behavior?.evidence||[],path:item.path,ai:exchangeAttributions.get(item.key)||null
      }))
    }:null,
    exchangeFindings:derived.exchangeFindings,
    exposure:derived.exposure,
    path,
    labels:derived.labels,
    crossChain:derived.crossChain,
    watchlist,alerts,
    graph:{
      image:"",
      statusLine:displayed.nodes.length+" visible node(s) · "+tracePayloads.size+" analysed wallet(s) · visible depth H"+displayed.maxVisibleDepth+" · max depth H"+displayed.settings.maxDepth+" · branch "+displayed.settings.branch,
      nodes:displayed.nodes.map(node=>({address:node.id,label:nodeLabel(node.id),depth:node.depth,relation:node.relation,total:node.total,incoming:node.incoming,outgoing:node.outgoing,assets:node.assets})),
      edges:displayed.edges.slice().sort((a,b)=>b.count-a.count).map(edge=>({from:edge.from,to:edge.to,count:edge.count,assets:edge.assets,hop:edge.hop}))
    },
    counterparties:neighborStats(payload,Array.isArray(payload.transactions)?payload.transactions:[]).map(node=>({
      address:node.id,label:nodeLabel(node.id),incoming:node.incoming,outgoing:node.outgoing,total:node.total,assets:[...node.assets].sort()
    })),
    wallets:traceEntries().map(entry=>{
      const screening=entry.payload?.sanctions_screening;
      return {
        address:entry.address,depth:entry.depth,records:(entry.payload?.transactions||[]).length,
        screening:!screening||screening.status==="unavailable"?"not screened":screening.hit?"MATCH (see the sanctions section)":screening.status==="stale"?"no match (list older than 7 days)":"no match"
      };
    }),
    transactions:derived.rows.map(row=>({
      id:row.id,time:row.time,direction:String(row.direction||"").toUpperCase(),asset:row.asset,amount:row.amount,status:rowStatus(row),
      counterparties:row.counterparties||[],tokenName:row.token_name||"",tokenContract:row.token_contract||"",
      functionName:row.function_name||row.contract_type||"",depth:row._trace_depth,sourceWallet:row._trace_source
    }))
  };
}

// The graph as an image: the page's own SVG (its layout, hop rings, colours), made standalone so it renders outside crypto.css.
// Call renderGraph(lastPayload) (a synchronous repaint from the current, on-screen filters/case/trace state -- it
// does not touch reportUnfiltered or any data the rest of the report reads) right before this, so the image matches
// what collectReportModel() just read: otherwise a case switched or a wallet expanded since the last paint, with
// no filter/trace change since, would leave the SVG showing a different graph (or another case's off-chain nodes)
// than the node/edge tables built from the freshly rebuilt currentNetworkModel.
async function graphImageForReport(){
  const svg=document.getElementById("flowGraph");
  if(!svg||lastPayload?.kind!=="address"||!window.CTAtlasCryptoReport?.standaloneGraphSvg)return "";
  const markup=window.CTAtlasCryptoReport.standaloneGraphSvg(svg.outerHTML);
  if(!markup)return "";
  const url=URL.createObjectURL(new Blob([markup],{type:"image/svg+xml;charset=utf-8"}));
  try{
    const image=await new Promise((resolve,reject)=>{
      const element=new Image();
      element.onload=()=>resolve(element);
      element.onerror=()=>reject(new Error("The graph image could not be rendered."));
      element.src=url;
    });
    const canvas=document.createElement("canvas");
    canvas.width=2000;canvas.height=1300;
    canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL("image/png");
  }catch(_){
    return "";       // the report says so and carries the node table instead
  }finally{
    URL.revokeObjectURL(url);
  }
}

async function exportFullReport(){
  if(!lastPayload){setStatus("Run an analysis first.","warning");return;}
  if(!window.CTAtlasPdf?.download||!window.CTAtlasCryptoReport?.build){setStatus("The report library is unavailable.","error");return;}
  const button=document.getElementById("cryptoReportButton");
  if(button)button.disabled=true;
  setStatus("Building the full report…","");
  const finishWait = window.CTAtlasUI?.begin(document.getElementById("cryptoStatus"));
  try{
    // Fresh graph paint, then the data model, then the image -- all synchronous up to this point (no
    // intervening await), so the node/edge tables and the graph image describe the same instant. Only
    // then does the async image-loading and PDF assembly begin.
    if(lastPayload.kind==="address")renderGraph(lastPayload);
    const model=collectReportModel();
    if(model.graph)model.graph.image=await graphImageForReport();
    const report=window.CTAtlasCryptoReport.build(model);
    const result=await window.CTAtlasPdf.download(report);
    setStatus("Report downloaded: "+result.filename+" · "+result.pages+" page(s).","success");
  }catch(error){
    setStatus(error?.message||"Report generation failed.","error");
  }finally{
    finishWait?.();
    if(button)button.disabled=false;
  }
}

function snapshotFromPayload(payload){
  const rows=(payload.transactions||[]).slice().sort((a,b)=>String(b.time||"").localeCompare(String(a.time||"")));
  const now=Date.now(),dayAgo=now-86400000;
  const recent=rows.filter(row=>{
    const t=Date.parse(row.time||"");
    return Number.isFinite(t)&&t>=dayAgo;
  });
  return {
    checked_at:new Date().toISOString(),
    newest_tx_id:String(rows[0]?.id||""),
    newest_tx_time:String(rows[0]?.time||""),
    tx_count:recent.length,
    aggregate_value:recent.reduce((sum,row)=>sum+Math.abs(Number(row.amount)||0),0)
  };
}

function addAlert(alert){
  const signature=[alert.watch_id,alert.type,alert.tx_id||"",alert.title].join("|");
  const exists=(cryptoWorkspace.alerts||[]).some(item=>
    [item.watch_id,item.type,item.tx_id||"",item.title].join("|")===signature
  );
  if(exists)return false;
  cryptoWorkspace.alerts.unshift({
    id:makeId("alert"),
    created_at:new Date().toISOString(),
    acknowledged:false,
    ...alert
  });
  cryptoWorkspace.alerts=cryptoWorkspace.alerts.slice(0,1000);
  return true;
}

function monitorSeed(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const thresholds={
    min_amount:Number(document.getElementById("monitorMinAmount")?.value)||null,
    aggregate_24h:Number(document.getElementById("monitorAggregate")?.value)||null,
    velocity_24h:Number(document.getElementById("monitorVelocity")?.value)||null,
    dormant_days:Number(document.getElementById("monitorDormantDays")?.value)||null
  };
  const key=normalizeAddressForChain(lastPayload.query,lastPayload.chain);
  let watch=(cryptoWorkspace.watchlist||[]).find(item=>
    item.chain===lastPayload.chain&&normalizeAddressForChain(item.address,item.chain)===key
  );
  if(!watch){
    watch={
      id:makeId("watch"),chain:lastPayload.chain,address:lastPayload.query,
      label:labelForAddress(lastPayload.query,lastPayload.chain)?.name||short(lastPayload.query,9),
      categories:labelForAddress(lastPayload.query,lastPayload.chain)?.category?[labelForAddress(lastPayload.query,lastPayload.chain).category]:[],
      enabled:true,created_at:new Date().toISOString()
    };
    cryptoWorkspace.watchlist.unshift(watch);
  }
  watch.thresholds=thresholds;
  watch.last_snapshot=snapshotFromPayload(lastPayload);
  watch.updated_at=new Date().toISOString();
  scheduleWorkspaceSave();
  renderAlerts();
  document.getElementById("monitorStatus").textContent="Seed is monitored. Baseline saved; automatic checks rotate every 6 hours. CHECK NOW remains available.";
}

async function checkMonitored(){
  const button=document.getElementById("monitorCheckButton");
  const status=document.getElementById("monitorStatus");
  const watches=(cryptoWorkspace.watchlist||[]).filter(item=>item.enabled!==false);
  if(!watches.length){status.textContent="No monitored wallets.";return;}
  if(button){button.disabled=true;button.textContent="CHECKING…";}
  let created=0,checked=0;
  try{
    for(const watch of watches.slice(0,50)){
      status.textContent="Checking "+(checked+1)+"/"+Math.min(watches.length,50)+" · "+short(watch.address,8);
      try{
        const fresh=await fetchAddressAnalysis(watch.address,watch.chain,100,"monitor");
        const previous=watch.last_snapshot||null;
        const snap=snapshotFromPayload(fresh);
        const rows=fresh.transactions||[];
        const previousTime=Date.parse(previous?.newest_tx_time||"");
        const newRows=Number.isFinite(previousTime)
          ? rows.filter(row=>Date.parse(row.time||"")>previousTime)
          : [];

        if(previous&&snap.newest_tx_id&&snap.newest_tx_id!==previous.newest_tx_id){
          if(addAlert({
            watch_id:watch.id,chain:watch.chain,address:watch.address,type:"NEW_TRANSACTION",severity:"LOW",
            title:"New transaction observed",detail:"A transaction newer than the saved monitoring baseline was observed.",
            tx_id:snap.newest_tx_id
          }))created++;
        }

        const min=Number(watch.thresholds?.min_amount);
        if(Number.isFinite(min)&&min>0){
          for(const row of newRows.filter(row=>Math.abs(Number(row.amount)||0)>=min).slice(0,10)){
            if(addAlert({
              watch_id:watch.id,chain:watch.chain,address:watch.address,type:"LARGE_TRANSFER",severity:"MEDIUM",
              title:"Transfer threshold crossed",detail:fmtNumber(row.amount)+" "+String(row.asset||"")+" crossed the configured single-transfer threshold.",
              tx_id:row.id
            }))created++;
          }
        }

        const aggregate=Number(watch.thresholds?.aggregate_24h);
        if(Number.isFinite(aggregate)&&aggregate>0&&snap.aggregate_value>=aggregate){
          if(addAlert({
            watch_id:watch.id,chain:watch.chain,address:watch.address,type:"AGGREGATE_24H",severity:"MEDIUM",
            title:"24h aggregate threshold crossed",detail:fmtNumber(snap.aggregate_value)+" observed aggregate value across the returned last-24h sample."
          }))created++;
        }

        const velocity=Number(watch.thresholds?.velocity_24h);
        if(Number.isFinite(velocity)&&velocity>0&&snap.tx_count>=velocity){
          if(addAlert({
            watch_id:watch.id,chain:watch.chain,address:watch.address,type:"VELOCITY_24H",severity:"MEDIUM",
            title:"24h velocity threshold crossed",detail:snap.tx_count+" transaction records observed in the last 24 hours."
          }))created++;
        }

        const dormant=Number(watch.thresholds?.dormant_days);
        if(previous&&Number.isFinite(dormant)&&dormant>0&&Number.isFinite(previousTime)&&snap.newest_tx_time){
          const gap=Date.parse(snap.newest_tx_time)-previousTime;
          if(gap>=dormant*86400000&&snap.newest_tx_id!==previous.newest_tx_id){
            if(addAlert({
              watch_id:watch.id,chain:watch.chain,address:watch.address,type:"REACTIVATION",severity:"MEDIUM",
              title:"Activity after configured dormant interval",detail:"New activity followed an observed gap of at least "+dormant+" days.",
              tx_id:snap.newest_tx_id
            }))created++;
          }
        }

        for(const row of newRows.slice(0,30)){
          for(const cp of row.counterparties||[]){
            const label=labelForAddress(cp,watch.chain);
            if(label&&["CT WATCHLIST","SANCTIONS","DARKNET","MIXER"].includes(label.category)){
              if(addAlert({
                watch_id:watch.id,chain:watch.chain,address:watch.address,type:"WATCHLIST_EXPOSURE",severity:"HIGH",
                title:"New direct exposure to "+label.category,
                detail:"New transaction relationship observed with sourced label "+(label.name||short(cp,8))+".",
                tx_id:row.id
              }))created++;
            }
          }
        }

        watch.last_snapshot=snap;
        watch.updated_at=new Date().toISOString();
        checked++;
      }catch(error){
        console.warn("Monitor check failed",watch.address,error);
      }
      await sleep(250);
    }
    scheduleWorkspaceSave();renderAlerts();
    status.textContent="Monitoring check complete · "+checked+" wallet(s) checked · "+created+" new alert(s).";
  }finally{
    if(button){button.disabled=false;button.textContent="CHECK MONITORED NOW";}
  }
}

function renderAlerts(){
  const box=document.getElementById("cryptoAlerts");
  if(!box)return;
  const alerts=(cryptoWorkspace.alerts||[]).slice(0,30);
  if(!alerts.length){box.innerHTML='<div class="intel-result">No saved monitoring alerts.</div>';return;}
  box.innerHTML=alerts.map(item=>
    '<div class="intel-item alert-item '+String(item.severity||"low").toLowerCase()+'"><div class="intel-item-head"><div><div class="intel-title">'+esc(item.title)+'</div>'+
    '<div class="intel-meta">'+esc(item.type)+' · '+esc(short(item.address,8))+' · '+esc(fmtTime(item.created_at))+'</div></div>'+
    '<span class="intel-badge '+String(item.severity||"low").toLowerCase()+'">'+esc(item.severity||"LOW")+'</span></div>'+
    '<div class="intel-detail">'+esc(item.detail||"")+'</div></div>'
  ).join("");
}

function knownServiceFor(address,chain){
  const key=normalizeAddressForChain(address,chain);
  const manual=labelForAddress(address,chain);
  if(manual&&["BRIDGE","DEX","MIXER","EXCHANGE"].includes(manual.category)){
    return {name:manual.name||manual.category,category:manual.category,source:"ANALYST LABEL"};
  }
  return SERVICE_REGISTRY[chain]?.[key]||null;
}

function crossChainFindings(){
  if(!lastPayload)return [];
  const findings=[];
  const seen=new Set();
  for(const row of allTraceRows(true)){
    const addresses=[...(row.counterparties||[]),row.to_address,row.contract_address,row.token_contract].filter(Boolean);
    for(const address of addresses){
      const service=knownServiceFor(address,lastPayload.chain);
      if(!service)continue;
      const key=service.category+"|"+normalizeAddressForChain(address,lastPayload.chain)+"|"+row.id;
      if(seen.has(key))continue;
      seen.add(key);
      findings.push({
        service,address,tx_id:row.id,time:row.time,source_wallet:row._trace_source,
        asset:row.asset,amount:row.amount
      });
    }
    const fn=String(row.function_name||row.contract_type||"").toLowerCase();
    if(/bridge|swap|router|exchange/.test(fn)){
      const key="metadata|"+row.id;
      if(!seen.has(key)){
        seen.add(key);
        findings.push({
          service:{name:row.function_name||row.contract_type,category:/bridge/.test(fn)?"BRIDGE":"DEX",source:"TRANSACTION METADATA"},
          address:row.to_address||"",tx_id:row.id,time:row.time,source_wallet:row._trace_source,asset:row.asset,amount:row.amount
        });
      }
    }
  }
  const active=activeCase();
  for(const link of active?.crosschain_links||[]){
    if(link.from_chain!==lastPayload.chain)continue;
    const key="case-link|"+link.id;
    if(seen.has(key))continue;
    seen.add(key);
    findings.push({
      service:{name:link.service||"Analyst cross-chain link",category:"BRIDGE",source:"CASE LINK · "+(link.confidence||"LOW")},
      address:link.to_address,tx_id:"",time:link.created_at,source_wallet:link.from_address,asset:"",amount:null,
      destination_chain:link.to_chain
    });
  }
  return findings.slice(0,50);
}

function renderCrossChain(){
  const box=document.getElementById("crossChainFindings");
  if(!box)return;
  const findings=crossChainFindings();
  if(!findings.length){
    box.innerHTML='<div class="intel-result">No known labelled bridge/DEX/mixer/service touchpoint was detected in the currently traced sample. Absence here is not proof of absence.</div>';
    return;
  }
  box.innerHTML=findings.map(item=>
    '<div class="intel-item crosschain-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(item.service.category)+' · '+esc(item.service.name)+'</div>'+
    '<div class="intel-meta">'+esc(item.service.source)+' · '+esc(fmtTime(item.time))+'</div></div><span class="intel-badge category">'+esc(item.service.category)+'</span></div>'+
    '<div class="intel-detail">Source '+esc(short(item.source_wallet,8))+
    (item.amount==null?"":' · '+esc(fmtNumber(item.amount))+' '+esc(item.asset||""))+
    (item.destination_chain?' · → '+esc(String(item.destination_chain).toUpperCase()):"")+
    (item.tx_id?' · TX '+esc(short(item.tx_id,8)):"")+'</div></div>'
  ).join("");
}

function sanctionsEntries(){
  if(!lastPayload)return [];
  if(lastPayload.kind==="transaction")return [{key:"tx",address:lastPayload.query,depth:0,payload:lastPayload}];
  return traceEntries();
}

// Groups every listed address found across all traced wallets, nearest hop first.
function sanctionsHits(){
  const isTransaction=lastPayload?.kind==="transaction";
  const groups=new Map();
  const add=(address,depth,role,via,match)=>{
    const key=traceKey(address,lastPayload.chain);
    const group=groups.get(key)||{address,depth,role,via:new Set(),in_count:0,out_count:0,last_seen:"",match};
    group.depth=Math.min(group.depth,depth);
    if(role==="wallet")group.role="wallet";
    if(via)group.via.add(via);
    group.in_count+=Number(match.received_from_count||0);
    group.out_count+=Number(match.sent_to_count||0);
    if(match.last_seen&&String(match.last_seen)>group.last_seen)group.last_seen=String(match.last_seen);
    groups.set(key,group);
  };
  for(const entry of sanctionsEntries()){
    const screening=entry.payload?.sanctions_screening;
    if(!screening?.hit)continue;
    if(screening.seed_match)add(entry.address,entry.depth,"wallet","",screening.seed_match);
    for(const match of screening.counterparty_matches||[]){
      add(match.address,entry.depth+1,isTransaction?"party":"counterparty",entry.address,match);
    }
  }
  const terrorismRank=group=>group.match.entities?.some(entity=>entity.terrorism)?0:1;
  return [...groups.values()].sort((a,b)=>
    terrorismRank(a)-terrorismRank(b)||a.depth-b.depth||String(a.address).localeCompare(String(b.address))
  );
}

// Everything the sanctions card shows, as data: the card renders it, and the full report reuses it word for word.
function sanctionsView(){
  const entries=sanctionsEntries();
  const usable=entries.map(entry=>entry.payload?.sanctions_screening)
    .filter(item=>item&&(item.status==="ok"||item.status==="stale"));
  const rootScreening=lastPayload.sanctions_screening||null;
  const hits=sanctionsHits();
  const list=rootScreening?.list||usable[0]?.list||null;
  const source=list?.sources?.[0];
  const unscreened=!rootScreening||rootScreening.status==="unavailable";

  const note=source
    ? (source.name||source.id)+(source.published?" · published "+source.published:"")+" · "+fmtNumber(list.address_count)+" listed addresses"
    : "Checks the wallet and its counterparties against sanctioned digital-currency addresses.";

  const warnings=[];
  if(unscreened){
    warnings.push("Sanctions screening was NOT performed for this analysis"+
      (rootScreening?.reason?" ("+rootScreening.reason+")":" (this response carries no screening data)")+
      ". The absence of a match below must not be read as a clean result.");
  }else if(entries.length>usable.length){
    warnings.push((entries.length-usable.length)+" of "+entries.length+" analysed wallet(s) could not be screened; results below are partial.");
  }
  if(usable.some(item=>item.status==="stale")){
    warnings.push("The sanctions list is older than 7 days or could not be refreshed; recent designations may be missing.");
  }

  let badge;
  if(hits.length)badge={cls:"intel-badge high",text:hits.length+(hits.length>1?" MATCHES":" MATCH")};
  else if(unscreened)badge={cls:"intel-badge unscreened",text:"NOT SCREENED"};
  else badge={cls:"intel-badge clear",text:"NO MATCH"};

  const hitViews=hits.map(hit=>{
    const terrorism=Boolean(hit.match.entities?.some(entity=>entity.terrorism));
    const roleLabel=hit.role==="wallet"?"ANALYSED WALLET":hit.role==="party"?"TRANSACTION PARTY":"COUNTERPARTY";
    const via=[...hit.via];
    let context="";
    if(hit.role==="party"){
      context="Input or output of this transaction.";
    }else if(hit.role!=="wallet"){
      context="Seen with "+via.slice(0,3).map(address=>short(address,8)).join(", ")+(via.length>3?" +"+(via.length-3)+" more":"")+
        ": received from "+hit.in_count+"× · sent to "+hit.out_count+"× in the returned sample"+
        (hit.last_seen?" · last "+fmtTime(hit.last_seen):"")+".";
    }
    return {
      title:hit.match.summary||"Listed address",
      role:hit.role,roleLabel,depth:hit.depth,currency:hit.match.currency||"",
      terrorism,address:hit.address,context
    };
  });

  let noMatchText="";
  if(!hits.length&&!unscreened){
    const checked=usable.reduce((sum,item)=>sum+Number(item.counterparties_checked||0),0);
    noMatchText="No match among the analysed wallet(s) and "+checked+" screened counterpart"+(checked===1?"y":"ies")+
      ". No match does not mean an address is safe.";
  }
  const scope=rootScreening?.scope_note||usable[0]?.scope_note||"";
  return {unscreened,badge,note,warnings,hits:hitViews,noMatchText,scope};
}

function renderSanctions(){
  const card=document.getElementById("cryptoSanctions");
  const body=document.getElementById("cryptoSanctionsBody");
  const badge=document.getElementById("cryptoSanctionsBadge");
  const note=document.getElementById("cryptoSanctionsNote");
  if(!card||!body||!badge||!note||!lastPayload)return;

  const view=sanctionsView();
  note.textContent=view.note;
  card.classList.toggle("hit",view.hits.length>0);
  card.classList.toggle("unscreened",view.unscreened&&view.hits.length===0);
  badge.className=view.badge.cls;
  badge.textContent=view.badge.text;

  const parts=view.warnings.map(text=>'<div class="sanctions-warning">'+esc(text)+'</div>');
  for(const hit of view.hits){
    parts.push(
      '<div class="intel-item alert-item high"><div class="intel-item-head"><div>'+
      '<div class="intel-title">'+esc(hit.title)+'</div>'+
      '<div class="intel-meta">'+hit.roleLabel+' · H'+hit.depth+' · '+esc(hit.currency)+'</div></div>'+
      '<span class="intel-badge '+(hit.terrorism?"high":"medium")+'">'+(hit.terrorism?"TERRORISM PROGRAM":"SANCTIONS LIST")+'</span></div>'+
      '<code class="sanctions-address">'+esc(hit.address)+'</code>'+
      (hit.context?'<div class="intel-detail">'+esc(hit.context)+'</div>':"")+
      '</div>'
    );
  }
  if(view.noMatchText)parts.push('<div class="intel-result">'+esc(view.noMatchText)+'</div>');
  if(view.scope)parts.push('<div class="sanctions-scope">'+esc(view.scope)+'</div>');
  body.innerHTML=parts.join("");
}

function renderIntelligencePanels(){
  renderSanctions();
  renderPatterns();
  renderExchangeIdentification();
  renderExposure();
  renderLabelList();
  renderCaseUi();
  renderAlerts();
  renderCrossChain();
}

function renderKpis(payload,filteredRows){
  const box=document.getElementById("cryptoKpis");
  if(!box)return;
  if(payload.kind==="transaction"){
    const tx=payload.transaction||{};
    const value=tx.value??tx.amount_trx??"—";
    const asset=tx.asset||((payload.chain==="tron")?"TRX":"");
    box.innerHTML=[
      kpi("Chain",payload.chain_name||payload.chain),
      kpi("Value",value==="—"?"—":fmtNumber(value)+" "+asset),
      kpi("Block",tx.block_number??"—"),
      kpi("Provider",payload.provider||"—")
    ].join("");
    return;
  }

  const rows=filteredRows||[];
  const counterparties=new Set(rows.flatMap(row=>Array.isArray(row.counterparties)?row.counterparties:[]).filter(Boolean));
  const maxDepth=currentNetworkModel?.maxVisibleDepth??0;
  const balance=payload.balance?fmtNumber(payload.balance.amount)+" "+String(payload.balance.asset||""):"—";
  box.innerHTML=[
    kpi("Seed balance",balance),
    kpi("Filtered records",String(rows.length)),
    kpi("Analyzed wallets",String(tracePayloads.size)),
    kpi("Visible nodes",String(currentNetworkModel?.nodes?.length||counterparties.size)),
    kpi("Trace depth","H"+String(maxDepth))
  ].join("");
}

function renderObservations(payload){
  const list=document.getElementById("cryptoObservations");
  if(list){
    const notes=Array.isArray(payload.observations)?payload.observations:[];
    list.innerHTML=notes.map(note=>"<li>"+esc(note)+"</li>").join("");
  }
  const sampling=document.getElementById("cryptoSampling");
  if(sampling)sampling.textContent=payload.sampling_note||"";
}

function renderTable(payload,rows){
  const tbody=document.getElementById("cryptoTableBody");
  const note=document.getElementById("cryptoTableNote");
  if(!tbody)return;
  if(note)note.textContent=rows.length+" filtered record(s) across "+tracePayloads.size+" analyzed wallet(s) · counterparty click opens a new CT Atlas Crypto analysis";

  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="7" class="crypto-filter-empty">No transaction records match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML=rows.map(row=>{
    const cp=(row.counterparties||[]).filter(Boolean);
    const cpHtml=cp.length
      ? cp.slice(0,5).map(item=>{
          const searchable=isSearchableAddress(item,payload.chain);
          const attribution=labelForAddress(item,payload.chain);
          const display=attribution?esc(attribution.name)+" · "+esc(short(item,6)):esc(short(item,8));
          const title=attribution?attribution.name+" · "+item:item;
          return searchable
            ? '<button type="button" class="counterparty-link" data-address="'+esc(item)+'" title="'+esc(title)+'">'+display+"</button>"
            : '<span title="'+esc(title)+'">'+display+"</span>";
        }).join(", ")
      :"—";
    const dir=String(row.direction||"").toUpperCase();
    const cls=dir==="IN"?"dir-in":dir==="OUT"?"dir-out":"dir-self";
    const status=rowStatus(row);
    const tokenBadge=isTokenRow(row,payload)?'<span class="crypto-type-badge">TOKEN</span>':'<span class="crypto-type-badge">NATIVE</span>';
    const statusHtml='<span class="crypto-status-dot '+status+'"></span>'+status.toUpperCase();
    const depth=Math.max(0,Math.min(3,Number(row._trace_depth)||0));
    return "<tr>"+
      '<td class="crypto-hop-cell"><span class="crypto-hop-badge h'+depth+'">H'+depth+'</span><span class="crypto-source-address" title="'+esc(row._trace_source||"")+'">'+esc(short(row._trace_source||"",7))+"</span></td>"+
      "<td>"+esc(fmtTime(row.time))+'<br><span class="crypto-card-note">'+statusHtml+"</span></td>"+
      '<td class="'+cls+'">'+esc(dir||"—")+"</td>"+
      "<td>"+esc(row.asset||"—")+tokenBadge+"</td>"+
      "<td>"+esc(fmtNumber(row.amount))+"</td>"+
      '<td class="mono">'+cpHtml+"</td>"+
      '<td><a class="tx-link" href="'+esc(row.explorer_url||"#")+'" target="_blank" rel="noopener noreferrer">'+esc(short(row.id,8))+"</a></td>"+
      "</tr>";
  }).join("");

  tbody.querySelectorAll(".counterparty-link").forEach(button=>{
    button.addEventListener("click",()=>openCryptoSearch(String(button.dataset.address||""),payload.chain));
  });
}

function neighborStats(payload,rows){
  const source=String(payload.query||"");
  const map=new Map();

  function nodeFor(address){
    const key=traceKey(address,payload.chain);
    let node=map.get(key);
    if(!node){
      node={id:address,key,incoming:0,outgoing:0,total:0,assets:new Set()};
      map.set(key,node);
    }
    return node;
  }

  for(const row of rows){
    const direction=String(row.direction||"").toUpperCase();
    const unique=[...new Set((row.counterparties||[]).filter(Boolean))];
    for(const cp of unique){
      if(traceKey(cp,payload.chain)===traceKey(source,payload.chain))continue;
      const node=nodeFor(cp);
      node.total+=1;
      if(row.asset)node.assets.add(String(row.asset));
      if(direction==="IN")node.incoming+=1;
      else if(direction==="OUT")node.outgoing+=1;
    }
  }

  return [...map.values()].sort((a,b)=>b.total-a.total||b.incoming+b.outgoing-(a.incoming+a.outgoing));
}

function buildNetworkModel(payload,allAnalyzed=false){
  const root=String(payload.query||"");
  const rootKey=traceKey(root,payload.chain);
  const f=readFilters();
  const settings=traceSettings();
  const nodes=new Map();
  const edges=new Map();

  function ensureNode(address,depth){
    const key=traceKey(address,payload.chain);
    let node=nodes.get(key);
    if(!node){
      node={id:address,key,depth,total:0,incoming:0,outgoing:0,assets:new Set()};
      nodes.set(key,node);
    }else{
      node.depth=Math.min(node.depth,depth);
    }
    return node;
  }

  function addEdge(from,to,count,assets,hop){
    if(!count)return;
    const fromKey=traceKey(from,payload.chain);
    const toKey=traceKey(to,payload.chain);
    const key=fromKey+"|"+toKey;
    let edge=edges.get(key);
    if(!edge){
      edge={from,to,fromKey,toKey,count:0,assets:new Set(),hop};
      edges.set(key,edge);
    }
    edge.count+=count;
    edge.hop=Math.min(edge.hop,hop);
    (assets||[]).forEach(asset=>edge.assets.add(asset));
  }

  ensureNode(root,0);

  const entries=traceEntries().filter(entry=>allAnalyzed||entry.depth<settings.maxDepth);
  for(const entry of entries){
    const source=entry.address;
    const sourceNode=ensureNode(source,entry.depth);
    const rows=filterRows(entry.payload);
    const neighbors=neighborStats(entry.payload,rows)
      .filter(node=>allAnalyzed||node.total>=f.graphMinLinks)
      .slice(0,allAnalyzed?undefined:entry.depth===0?Math.min(14,f.graphNodes-1):settings.branch);

    for(const neighbor of neighbors){
      const childDepth=allAnalyzed?entry.depth+1:Math.min(settings.maxDepth,entry.depth+1);
      const child=ensureNode(neighbor.id,childDepth);
      child.total+=neighbor.total;
      child.incoming+=neighbor.incoming;
      child.outgoing+=neighbor.outgoing;
      neighbor.assets.forEach(asset=>child.assets.add(asset));
      sourceNode.total+=neighbor.total;

      const assets=[...neighbor.assets];
      if(neighbor.incoming>0)addEdge(neighbor.id,source,neighbor.incoming,assets,childDepth);
      if(neighbor.outgoing>0)addEdge(source,neighbor.id,neighbor.outgoing,assets,childDepth);
    }
  }

  let nodeList=[...nodes.values()];
  // Expanded wallets and the exchanges the automatic trace reached stay visible.
  const keepKeys=new Set([rootKey,...traceEntries().map(entry=>entry.key),...(autoTraceRun?.exchanges||[]).map(item=>item.key)]);
  const nodeCap=autoTraceActive?Math.max(f.graphNodes,REPORT_GRAPH_NODE_CAP):f.graphNodes;
  if(!allAnalyzed&&nodeList.length>nodeCap){
    const retained=nodeList
      .sort((a,b)=>{
        const ak=keepKeys.has(a.key)?1:0,bk=keepKeys.has(b.key)?1:0;
        return bk-ak||a.depth-b.depth||b.total-a.total;
      })
      .slice(0,nodeCap);
    const retainedKeys=new Set(retained.map(node=>node.key));
    nodeList=retained;
    for(const [key,edge] of edges){
      if(!retainedKeys.has(edge.fromKey)||!retainedKeys.has(edge.toKey))edges.delete(key);
    }
  }

  nodeList.forEach(node=>{
    node.assets=[...node.assets].sort();
    node.relation=node.incoming>0&&node.outgoing>0?"both":node.incoming>0?"incoming":"outgoing";
    node.expanded=traceExpanded.has(node.key);
    node.busy=traceBusy.has(node.key);
    node.searchable=isSearchableAddress(node.id,payload.chain);
  });

  const depthByKey=new Map(nodeList.map(node=>[node.key,node.depth]));
  const edgeList=[...edges.values()].map(edge=>({
    ...edge,
    assets:[...edge.assets].sort(),
    fromDepth:depthByKey.get(edge.fromKey)??0,
    toDepth:depthByKey.get(edge.toKey)??0
  }));
  const maxVisibleDepth=nodeList.reduce((max,node)=>Math.max(max,node.depth),0);

  return {root,rootKey,nodes:nodeList,edges:edgeList,maxVisibleDepth,settings};
}

function defaultGraphPosition(node,index,totalAtDepth){
  if(node.depth===0)return {x:500,y:325};
  // H1-H3 on their own rings; deeper hops (automatic trace) on wider ellipses
  // that stay inside the 1000 x 650 canvas.
  const radii=[0,150,245,305,350,395,440];
  const radius=radii[Math.min(node.depth,radii.length-1)];
  const angleOffset=-Math.PI/2+0.26*(node.depth-1);
  const angle=angleOffset+(Math.PI*2*index/Math.max(totalAtDepth,1));
  const xScale=node.depth>=4?1.05:1;
  return {x:500+Math.cos(angle)*radius*xScale,y:325+Math.sin(angle)*Math.min(radius,305)};
}

function ensureGraphPositions(model){
  for(let depth=0;depth<=AUTO_TRACE_MAX_DEPTH;depth++){
    const group=model.nodes.filter(node=>node.depth===depth);
    group.forEach((node,index)=>{
      if(!graphPositions.has(node.key))graphPositions.set(node.key,defaultGraphPosition(node,index,group.length));
    });
  }
}

function updateGraphEdges(svg){
  svg.querySelectorAll(".graph-edge-group").forEach(group=>{
    const from=String(group.dataset.from||"");
    const to=String(group.dataset.to||"");
    const a=graphPositions.get(from),b=graphPositions.get(to);
    if(!a||!b)return;
    const line=group.querySelector("line");
    if(line){
      const distance=Math.hypot(b.x-a.x,b.y-a.y)||1;
      const inset=graphDisplayModel?.exchangePath?Math.min(42,distance/3):0;
      const dx=(b.x-a.x)/distance*inset,dy=(b.y-a.y)/distance*inset;
      line.setAttribute("x1",a.x+dx);line.setAttribute("y1",a.y+dy);
      line.setAttribute("x2",b.x-dx);line.setAttribute("y2",b.y-dy);
    }
    const label=group.querySelector("text");
    if(label){
      label.setAttribute("x",(a.x+b.x)/2);
      label.setAttribute("y",(a.y+b.y)/2-6);
    }
  });
}

function clientPointToSvg(svg,event){
  const point=svg.createSVGPoint();
  point.x=event.clientX;point.y=event.clientY;
  const matrix=svg.getScreenCTM();
  return matrix?point.matrixTransform(matrix.inverse()):{x:event.clientX,y:event.clientY};
}

function attachGraphInteraction(svg,group,node,payload,isSeed=false){
  let state=null;
  group.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    if(event.target.closest?.(".graph-expand-control"))return;
    const p=clientPointToSvg(svg,event);
    const current=graphPositions.get(node.key)||{x:p.x,y:p.y};
    state={pointerId:event.pointerId,startX:p.x,startY:p.y,offsetX:p.x-current.x,offsetY:p.y-current.y,moved:false};
    group.classList.add("dragging");
    try{group.setPointerCapture(event.pointerId);}catch(_){}
    event.preventDefault();
  });
  group.addEventListener("pointermove",event=>{
    if(!state||event.pointerId!==state.pointerId)return;
    const p=clientPointToSvg(svg,event);
    if(Math.hypot(p.x-state.startX,p.y-state.startY)>5)state.moved=true;
    const next={
      x:Math.max(40,Math.min(960,p.x-state.offsetX)),
      y:Math.max(40,Math.min(610,p.y-state.offsetY))
    };
    graphPositions.set(node.key,next);
    group.setAttribute("transform","translate("+next.x+" "+next.y+")");
    updateGraphEdges(svg);
    event.preventDefault();
  });
  const finish=event=>{
    if(!state||event.pointerId!==state.pointerId)return;
    const moved=state.moved;
    state=null;
    group.classList.remove("dragging");
    try{group.releasePointerCapture(event.pointerId);}catch(_){}
    if(!moved&&!isSeed&&node.searchable)openCryptoSearch(node.id,payload.chain);
  };
  group.addEventListener("pointerup",finish);
  group.addEventListener("pointercancel",event=>{
    if(state&&event.pointerId===state.pointerId){state=null;group.classList.remove("dragging");}
  });
  if(!isSeed){
    group.addEventListener("keydown",event=>{
      if((event.key==="Enter"||event.key===" ")&&node.searchable){
        event.preventDefault();openCryptoSearch(node.id,payload.chain);
      }
    });
  }
}

function attachAuxGraphInteraction(svg,group,key,onClick){
  let state=null;
  group.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    const p=clientPointToSvg(svg,event);
    const current=graphPositions.get(key)||{x:p.x,y:p.y};
    state={pointerId:event.pointerId,startX:p.x,startY:p.y,offsetX:p.x-current.x,offsetY:p.y-current.y,moved:false};
    group.classList.add("dragging");
    try{group.setPointerCapture(event.pointerId);}catch(_){}
    event.preventDefault();
  });
  group.addEventListener("pointermove",event=>{
    if(!state||event.pointerId!==state.pointerId)return;
    const p=clientPointToSvg(svg,event);
    if(Math.hypot(p.x-state.startX,p.y-state.startY)>5)state.moved=true;
    const next={
      x:Math.max(40,Math.min(960,p.x-state.offsetX)),
      y:Math.max(40,Math.min(610,p.y-state.offsetY))
    };
    graphPositions.set(key,next);
    group.setAttribute("transform","translate("+next.x+" "+next.y+")");
    updateGraphEdges(svg);
    event.preventDefault();
  });
  const finish=event=>{
    if(!state||event.pointerId!==state.pointerId)return;
    const moved=state.moved;
    state=null;
    group.classList.remove("dragging");
    try{group.releasePointerCapture(event.pointerId);}catch(_){}
    if(!moved&&typeof onClick==="function")onClick();
  };
  group.addEventListener("pointerup",finish);
  group.addEventListener("pointercancel",event=>{
    if(state&&event.pointerId===state.pointerId){state=null;group.classList.remove("dragging");}
  });
}

// origin tells the admin search history a trace expansion or monitor check from a search.
async function fetchAddressAnalysis(address,chain,limit=40,origin="trace"){
  const response=await fetch(API_BASE+"/crypto-analyze",{
    method:"POST",
    headers:sessionHeaders({"Content-Type":"application/json"}),
    body:JSON.stringify({user_id:user(),query:address,chain,limit,origin})
  });
  const payload=await response.json().catch(()=>({}));
  if(response.status===401){redirectToLogin();throw new Error("Session expired.");}
  if(!response.ok)throw new Error(payload.error||"Unable to expand this wallet.");
  if(payload.kind!=="address")throw new Error("Only wallet addresses can be expanded in the trace graph.");
  return payload;
}

async function expandTraceNode(address,options={}){
  if(!lastPayload||lastPayload.kind!=="address")return false;
  const model=currentNetworkModel||buildNetworkModel(lastPayload);
  const key=traceKey(address,lastPayload.chain);
  const node=model.nodes.find(item=>item.key===key);
  if(!node)throw new Error("This node is no longer visible under the current filters.");
  if(node.depth>=model.settings.maxDepth){
    setTraceStatus("This node is already at the configured maximum depth H"+model.settings.maxDepth+".","error");
    return false;
  }
  if(!node.searchable){
    setTraceStatus("This node is not available in a searchable address format from the current provider.","error");
    return false;
  }
  if(traceExpanded.has(key)){
    if(!options.quiet)setTraceStatus("This wallet has already been expanded in the current trace.","success");
    return true;
  }
  if(traceBusy.has(key))return false;

  traceBusy.add(key);
  renderFilteredViews();
  if(!options.quiet)setTraceStatus("Expanding "+short(address,9)+" from H"+node.depth+" to H"+(node.depth+1)+"…","working");

  try{
    // The automatic trace reads a larger sample: the exchange score needs it.
    const payload=await fetchAddressAnalysis(address,lastPayload.chain,options.limit||40);
    absorbExchangeLabels(payload,false);
    tracePayloads.set(key,{key,address,payload,depth:node.depth});
    traceExpanded.add(key);
    populateAssetFilter();
    renderFilteredViews();
    if(!options.quiet){
      setTraceStatus("Expanded "+short(address,9)+". The graph now includes up to H"+Math.min(model.settings.maxDepth,node.depth+1)+".","success");
    }
    return true;
  }catch(error){
    if(!options.quiet)setTraceStatus(error?.message||"Trace expansion failed.","error");
    throw error;
  }finally{
    traceBusy.delete(key);
    renderFilteredViews();
  }
}

// The exchange status of a wallet in the trace: a sourced exchange label, or a
// behaviour score at or above 80/100 once the wallet has been expanded.
function exchangeStatusOf(address,chain=lastPayload?.chain){
  const label=labelForAddress(address,chain);
  if(label&&String(label.category||"").toUpperCase()==="EXCHANGE"&&(label.source_url||label.source_title)){
    return {basis:"sourced",name:label.name||"Exchange",source:label.source_url||label.source_title};
  }
  const behavior=exchangeBehaviorForAddress(address,chain);
  if(behavior)return {basis:"behavioral",name:behavior.related_exchange?.name||"",score:Number(behavior.score),behavior};
  return null;
}

// The shortest path (any flow direction) from the seed to a node of the graph,
// as node keys, with the direction of each hop.
function tracePathTo(model,targetKey){
  const adjacency=new Map();
  const link=(a,b,direction)=>{
    if(!adjacency.has(a))adjacency.set(a,[]);
    adjacency.get(a).push({key:b,direction});
  };
  for(const edge of model.edges){
    link(edge.fromKey,edge.toKey,"out");
    link(edge.toKey,edge.fromKey,"in");
  }
  const queue=[[model.rootKey,[{key:model.rootKey,direction:""}]]];
  const visited=new Set([model.rootKey]);
  while(queue.length){
    const [key,path]=queue.shift();
    if(key===targetKey)return path;
    for(const next of adjacency.get(key)||[]){
      if(visited.has(next.key))continue;
      visited.add(next.key);
      queue.push([next.key,[...path,next]]);
    }
  }
  return null;
}

// Nodes reached only through exchanges are past the end of their branch:
// funds that reach an exchange leave the traceable chain there.
function reachedOnlyThroughExchanges(model,node,exchangeKeys){
  const parents=new Set();
  for(const edge of model.edges){
    if(edge.hop!==node.depth)continue;
    if(edge.toKey===node.key)parents.add(edge.fromKey);
    if(edge.fromKey===node.key)parents.add(edge.toKey);
  }
  parents.delete(node.key);
  const upstream=[...parents].filter(key=>(model.nodes.find(item=>item.key===key)?.depth??99)<node.depth);
  return upstream.length>0&&upstream.every(key=>exchangeKeys.has(key));
}

async function requestExchangeAttributions(model,exchanges){
  const chain=lastPayload.chain;
  const wallets=exchanges.filter(item=>item.basis==="behavioral").slice(0,8).map(item=>{
    const entry=tracePayloads.get(item.key);
    const neighbours=[];
    for(const row of Array.isArray(entry?.payload?.transactions)?entry.payload.transactions:[]){
      for(const address of Array.isArray(row?.counterparties)?row.counterparties:[]){
        const label=labelForAddress(address,chain);
        if(label&&!neighbours.some(n=>n.address===address))neighbours.push({address,name:label.name,category:label.category,source:label.source_url||label.source_title||""});
      }
    }
    const node=model.nodes.find(n=>n.key===item.key);
    return {address:item.address,hop:item.depth,score:item.score,evidence:item.behavior?.evidence||[],metrics:item.behavior?.metrics||{},
      assets:node?.assets||[],related_exchange:item.behavior?.related_exchange?.name||"",labelled_neighbours:neighbours.slice(0,12)};
  });
  if(!wallets.length)return 0;
  const response=await fetch(API_BASE+"/crypto-exchange-attribution",{
    method:"POST",
    headers:sessionHeaders({"Content-Type":"application/json"}),
    body:JSON.stringify({user_id:user(),chain,wallets})
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||"AI attribution unavailable.");
  let count=0;
  for(const item of Array.isArray(payload.attributions)?payload.attributions:[]){
    exchangeAttributions.set(traceKey(item.address,chain),{...item,model:payload.model||"",note:payload.note||""});
    count++;
  }
  return count;
}

// The AI-assessed operator of a wallet, when one was named.
function attributionFor(address,chain=lastPayload?.chain){
  const item=exchangeAttributions.get(traceKey(address,chain));
  return item&&item.likely_exchange&&item.likely_exchange.toLowerCase()!=="unknown"?item:null;
}

// Follows the trace until its branches reach an exchange: breadth-first from
// the seed, the strongest branches first (BRANCH per hop), expanding each
// wallet (its own transactions and behaviour score). A branch ends at a
// wallet with a documented exchange label; behaviour alone never ends a branch;
// the trace stops when every branch has ended, at H6, or after 30 wallets.
// The exchange-like wallets are then sent for an AI-assessed attribution.
async function autoTrace(){
  if(autoTraceActive||!lastPayload||lastPayload.kind!=="address")return;
  const button=document.getElementById("cryptoAutoTrace");
  const depthSelect=document.getElementById("traceMaxDepth");
  if(depthSelect)depthSelect.value=String(AUTO_TRACE_MAX_DEPTH);
  const settings=traceSettings();
  if(button){button.disabled=true;button.textContent="TRACING…";}
  autoTraceActive=true;
  setTraceStatus("Automatic trace started: following the strongest branches until they reach a documented exchange (up to H"+AUTO_TRACE_MAX_DEPTH+", "+AUTO_TRACE_MAX_WALLETS+" wallets).","working");

  const run={startedAt:new Date().toISOString(),maxDepth:AUTO_TRACE_MAX_DEPTH,branch:settings.branch,walletBudget:AUTO_TRACE_MAX_WALLETS,
    expanded:0,failed:0,stop:"",exchanges:[],attribution:""};
  const exchangeKeys=new Set(); // Only documented labels terminate a branch.
  const findingKeys=new Set(); // Behavioural candidates remain investigable.
  const noteExchanges=model=>{
    for(const node of model.nodes){
      if(node.depth===0||exchangeKeys.has(node.key))continue;
      const status=exchangeStatusOf(node.id);
      if(status)findingKeys.add(node.key);
      if(status?.basis==="sourced")exchangeKeys.add(node.key);
    }
  };

  try{
    let depth=1;
    for(;depth<AUTO_TRACE_MAX_DEPTH;depth++){
      currentNetworkModel=buildNetworkModel(lastPayload);
      noteExchanges(currentNetworkModel);
      const model=currentNetworkModel;
      const candidates=model.nodes
        .filter(node=>node.depth===depth&&node.searchable&&!traceExpanded.has(node.key)&&!exchangeKeys.has(node.key)&&!reachedOnlyThroughExchanges(model,node,exchangeKeys))
        .sort((a,b)=>b.total-a.total)
        .slice(0,settings.branch);
      if(!candidates.length){
        // A previous/manual expansion may already have populated deeper hops.
        if(model.nodes.some(node=>node.depth>depth&&node.depth<AUTO_TRACE_MAX_DEPTH&&node.searchable&&!traceExpanded.has(node.key)&&!exchangeKeys.has(node.key)&&!reachedOnlyThroughExchanges(model,node,exchangeKeys)))continue;
        run.stop=exchangeKeys.size?"every branch reached an exchange or ended":"no further searchable branch";
        break;
      }
      for(let i=0;i<candidates.length;i++){
        if(run.expanded+run.failed>=AUTO_TRACE_MAX_WALLETS){run.stop="wallet budget reached ("+AUTO_TRACE_MAX_WALLETS+")";break;}
        const node=candidates[i];
        setTraceStatus("Auto trace H"+depth+" → H"+(depth+1)+" · "+(i+1)+"/"+candidates.length+" · "+short(node.id,8)+
          (exchangeKeys.size?" · "+exchangeKeys.size+" exchange(s) reached":""),"working");
        try{
          const ok=await expandTraceNode(node.id,{quiet:true,limit:100});
          if(ok){
            run.expanded++;
            const status=exchangeStatusOf(node.id);
            if(status)findingKeys.add(node.key);
            if(status?.basis==="sourced")exchangeKeys.add(node.key);
          }
        }catch(error){
          run.failed++;
          console.warn("Auto-trace node skipped",node.id,error);
        }
        await sleep(400);
      }
      if(run.stop)break;
    }
    if(!run.stop)run.stop="maximum depth H"+AUTO_TRACE_MAX_DEPTH+" reached";

    currentNetworkModel=buildNetworkModel(lastPayload);
    noteExchanges(currentNetworkModel);
    const model=currentNetworkModel;
    for(const key of findingKeys){
      const node=model.nodes.find(item=>item.key===key);
      if(!node)continue;
      const status=exchangeStatusOf(node.id);
      const path=tracePathTo(model,key);
      run.exchanges.push({key,address:node.id,depth:node.depth,basis:status?.basis||"behavioral",name:status?.name||"",
        score:status?.score??null,source:status?.source||"",behavior:status?.behavior||null,
        path:path?path.map(step=>({address:displayAddressForKey(step.key),direction:step.direction})):[]});
    }
    run.exchanges.sort((a,b)=>a.depth-b.depth||(a.basis===b.basis?0:a.basis==="sourced"?-1:1));
    // The deepest wallet actually followed (an exchange's own counterparties are drawn, not followed).
    run.maxDepthReached=Math.max(0,...traceEntries().map(entry=>entry.depth));

    if(run.exchanges.some(item=>item.basis==="behavioral")){
      setTraceStatus("Assessing exchange-like candidates from their documented neighbours…","working");
      try{
        const count=await requestExchangeAttributions(model,run.exchanges);
        run.attribution=count?"assessed":"none";
      }catch(error){
        run.attribution="unavailable: "+(error?.message||"AI attribution failed");
      }
    }
    run.finishedAt=new Date().toISOString();
    autoTraceRun=run;
    // The graph returns to its node cap (keeping the exchanges reached) before
    // the closing message, which a repaint would otherwise replace.
    autoTraceActive=false;
    renderFilteredViews();

    const names=run.exchanges.slice(0,4).map(item=>{
      const ai=attributionFor(item.address);
      const name=item.basis==="sourced"?item.name:ai?"likely "+ai.likely_exchange+" ("+ai.confidence+")":(item.name?"linked to "+item.name:"exchange-like wallet");
      return name+" at H"+item.depth;
    });
    setTraceStatus(
      run.exchanges.length
        ? "Automatic trace complete: "+run.exchanges.filter(item=>item.basis==="sourced").length+" documented exchange(s), "+run.exchanges.filter(item=>item.basis==="behavioral").length+" behavioural candidate(s) — "+names.join(" · ")+(run.exchanges.length>4?" …":"")+". "+run.expanded+" wallet(s) expanded, depth H"+run.maxDepthReached+"; stopped: "+run.stop+"."
        :  "Automatic trace complete: no documented exchange or behavioural candidate found. "+run.expanded+" wallet(s) expanded, depth H"+run.maxDepthReached+"; stopped: "+run.stop+".",
      "success"
    );
  }catch(error){
    setTraceStatus(error?.message||"Automatic trace failed.","error");
  }finally{
    if(autoTraceActive){
      autoTraceActive=false;
      renderFilteredViews();
    }
    if(button){button.disabled=false;button.textContent="AUTO TRACE";}
  }
}

function clearTrace(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const root=String(lastPayload.query||"");
  const key=traceKey(root,lastPayload.chain);
  tracePayloads=new Map([[key,{key,address:root,payload:lastPayload,depth:0}]]);
  traceExpanded=new Set([key]);
  traceBusy=new Set();
  graphPositions=new Map();
  autoTraceRun=null;
  exchangeAttributions=new Map();
  populateAssetFilter();
  renderFilteredViews();
  setTraceStatus("Trace cleared. H1 is rebuilt from the seed wallet only.","success");
}

// A directed shortest observed path, never an undirected connection presented as funds flow.
function directedExchangePath(model,start,end,allowReverse=false){
  const adjacency=new Map();
  for(const edge of model.edges){
    if(!adjacency.has(edge.fromKey))adjacency.set(edge.fromKey,[]);
    adjacency.get(edge.fromKey).push(edge.toKey);
    if(allowReverse){
      if(!adjacency.has(edge.toKey))adjacency.set(edge.toKey,[]);
      adjacency.get(edge.toKey).push(edge.fromKey);
    }
  }
  const parent=new Map([[start,null]]),queue=[start];
  for(let i=0;i<queue.length;i++){
    const key=queue[i];
    if(key===end){
      const path=[];
      for(let cursor=end;cursor!==null;cursor=parent.get(cursor))path.push(cursor);
      return path.reverse();
    }
    for(const next of adjacency.get(key)||[]){
      if(parent.has(next))continue;
      parent.set(next,key);queue.push(next);
    }
  }
  return null;
}

function documentedExchangePaths(model,chain,includeCandidates=false){
  const paths=[];
  for(const node of model.nodes){
    if(node.key===model.rootKey)continue;
    const status=exchangeStatusOf(node.id,chain);
    if(!status||(status.basis!=="sourced"&&!includeCandidates))continue;
    const basis=status.basis;
    const name=basis==="sourced"?status.name:(attributionFor(node.id,chain)?.likely_exchange||status.name||"Exchange-like wallet");
    const before=paths.length;
    for(const incoming of [true,false]){
      const keys=directedExchangePath(model,incoming?node.key:model.rootKey,incoming?model.rootKey:node.key);
      if(!keys)continue;
      const pairs=new Set(keys.slice(1).map((key,i)=>keys[i]+"|"+key));
      paths.push({id:node.key+"|"+(incoming?"in":"out"),name,source:status.source,basis,
        incoming,keys,edges:model.edges.filter(edge=>pairs.has(edge.fromKey+"|"+edge.toKey))});
    }
    // A documented exchange may be connected through transfers whose directions alternate.
    // Preserve those arrows and identify this as a connection, never as continuous funds flow.
    if(paths.length===before){
      const keys=directedExchangePath(model,node.key,model.rootKey,true);
      if(!keys)continue;
      const pairs=new Set(keys.slice(1).flatMap((key,i)=>[keys[i]+"|"+key,key+"|"+keys[i]]));
      paths.push({id:node.key+"|connection",name,source:status.source,basis,incoming:null,mixed:true,
        keys,edges:model.edges.filter(edge=>pairs.has(edge.fromKey+"|"+edge.toKey))});
    }
  }
  return paths.sort((a,b)=>(a.basis===b.basis?0:a.basis==="sourced"?-1:1)||Number(Boolean(a.mixed))-Number(Boolean(b.mixed))||Number(b.incoming)-Number(a.incoming)||a.keys.length-b.keys.length||a.id.localeCompare(b.id));
}

function rowsForExchangePath(rows,path,chain){
  if(!path)return rows;
  const pairs=new Set(path.edges.map(edge=>edge.fromKey+"|"+edge.toKey));
  return rows.filter(row=>{
    const direction=String(row.direction||"").toUpperCase();
    if(direction!=="IN"&&direction!=="OUT")return false;
    const source=traceKey(row._trace_source,chain);
    return (row.counterparties||[]).some(address=>{
      const cp=traceKey(address,chain);
      return pairs.has(direction==="IN"?cp+"|"+source:source+"|"+cp);
    });
  });
}

function exchangeGraphView(model,payload){
  const paths=documentedExchangePaths(model,payload.chain,true);
  const controls=document.getElementById("exchangePathControls");
  const select=document.getElementById("exchangePathSelect");
  const toggle=document.getElementById("exchangePathToggle");
  const details=document.getElementById("exchangePathDetails");
  if(controls)controls.hidden=false;
  if(!paths.some(path=>path.id===selectedExchangePath))selectedExchangePath=paths[0]?.id||"";
  const selected=paths.find(path=>path.id===selectedExchangePath);
  activeExchangePath=exchangeGraphMode!=="all"&&(selected?.basis==="sourced"||exchangeGraphMode==="focus")?selected||null:null;
  if(select){
    select.innerHTML=paths.length?paths.map(path=>'<option value="'+esc(path.id)+'">'+esc(path.name+" · "+(path.basis==="sourced"?"DOCUMENTED":"UNVERIFIED LEAD")+" · "+(path.mixed?"Connection · mixed directions":path.incoming?"Wallet → target":"Target → wallet")+" · "+(path.keys.length-1)+" hops")+'</option>').join(""):'<option value="">No exchange connection available</option>';
    select.value=selectedExchangePath;select.disabled=!paths.length;
  }
  if(toggle){toggle.textContent=activeExchangePath?"SHOW ALL ANALYZED TRANSACTIONS":selected?.basis==="behavioral"?"SHOW CANDIDATE CONNECTION":"SHOW EXCHANGE PATH";toggle.disabled=!paths.length;toggle.setAttribute("aria-pressed",String(Boolean(activeExchangePath)));}
  if(details){
    const path=activeExchangePath;
    details.hidden=false;
    if(path){
      const nodeByKey=new Map(model.nodes.map(node=>[node.key,node]));
      const addresses=path.keys.map(key=>nodeByKey.get(key)?.id||key);
      details.textContent=(path.basis==="sourced"?"DOCUMENTED EXCHANGE. ":"UNVERIFIED LEAD — the exchange identity is not established. ")+(path.mixed?"Shortest observed connection (mixed transfer directions)":"Shortest observed path")+" · "+String(payload.chain_name||payload.chain)+" · "+addresses.join(path.mixed?" — ":" → ")+(path.source?". Source: "+path.source:"")+". Arrows show recorded transfer directions; this does not establish that the same funds passed through every hop. Other analyzed transactions are hidden, not deleted. Date, asset and transaction filters still apply.";
    }else if(paths.length){
      details.textContent=selected?.basis==="behavioral"
        ?"UNVERIFIED LEAD: "+selected.name+" is a behavioral or AI-assessed candidate, not a documented exchange identity. Select SHOW CANDIDATE CONNECTION to examine its observed links without confirming the attribution."
        :paths.length+" connection(s) available. Choose an exchange or select SHOW EXCHANGE PATH to focus.";
    }else{
      const rootIsExchange=exchangeStatusOf(model.root,payload.chain)?.basis==="sourced";
      details.textContent=rootIsExchange
        ?"The target itself is a documented exchange. No path to a different documented exchange is present in the current transactions."
        :"No connection to a documented exchange is available in the current transactions. An exchange-like score or AI-assessed name is a lead, not a documented label. Clear transaction filters or expand the trace; a path requires both a source-backed exchange address and observed links to the target.";
    }
  }
  if(!activeExchangePath)return model;
  const path=activeExchangePath,keys=new Set(path.keys);
  path.keys.forEach((key,index)=>graphPositions.set(key,{x:80+840*index/Math.max(1,path.keys.length-1),y:325}));
  return {...model,nodes:model.nodes.filter(node=>keys.has(node.key)),edges:path.edges,exchangePath:true,
    maxVisibleDepth:Math.max(...model.nodes.filter(node=>keys.has(node.key)).map(node=>node.depth))};
}

function renderGraph(payload){
  stopPlaybackSilently();
  const svg=document.getElementById("flowGraph");
  if(!svg)return;

  let model=buildNetworkModel(payload,true);
  graphDisplayModel=exchangeGraphView(model,payload);
  if(!activeExchangePath&&exchangeGraphMode!=="all"){
    model=buildNetworkModel(payload);
    graphDisplayModel=model;
  }
  currentNetworkModel=model;
  ensureGraphPositions(graphDisplayModel);
  paintGraphFrame(payload,graphDisplayModel);

  setTraceStatus(
    (activeExchangePath?"Exchange path: ":"Network: ")+graphDisplayModel.nodes.length+" visible node(s) · "+tracePayloads.size+" analyzed wallet(s) · visible depth H"+graphDisplayModel.maxVisibleDepth+
    " · max depth H"+model.settings.maxDepth+" · branch "+model.settings.branch,
    ""
  );
  updatePlaybackControls();
}

// Pure draw: given an already-built network model (the full one from renderGraph, or a
// chronologically-filtered copy for playback -- see startPlayback below), paints the SVG and wires
// up node/edge interactions. Never touches currentNetworkModel, so a playback frame can repaint the
// graph without disturbing what every other panel (KPIs, patterns, exposure, the report...) reads.
function paintGraphFrame(payload,model){
  const svg=document.getElementById("flowGraph");
  if(!svg)return;
  ensureGraphPositions(model);

  const nodeByKey=new Map(model.nodes.map(node=>[node.key,node]));
  let html='<defs>'+
    '<marker id="arrowIn" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#46d890"></path></marker>'+
    '<marker id="arrowOut" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#ff8268"></path></marker>'+
    '</defs>';

  for(const edge of model.edges){
    const a=graphPositions.get(edge.fromKey),b=graphPositions.get(edge.toKey);
    if(!a||!b)continue;
    const fromNode=nodeByKey.get(edge.fromKey),toNode=nodeByKey.get(edge.toKey);
    const sourceDepth=Math.min(fromNode?.depth??0,toNode?.depth??0);
    const targetDepth=Math.max(fromNode?.depth??0,toNode?.depth??0);
    const className=targetDepth>=3?"hop3":targetDepth>=2?"hop2":"";
    const outgoing=fromNode&&toNode&&fromNode.depth<=toNode.depth;
    const edgeClass=outgoing?"out":"in";
    const width=Math.min(8,1.2+Math.log2(1+edge.count)*1.2);
    const marker=outgoing?"arrowOut":"arrowIn";
    html+='<g class="graph-edge-group" data-from="'+esc(edge.fromKey)+'" data-to="'+esc(edge.toKey)+'">'+
      '<line class="graph-edge trace-link '+edgeClass+' '+className+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke-width="'+width+'" marker-end="url(#'+marker+')"></line>'+
      (edge.count>1?'<text class="graph-edge-label" x="'+((a.x+b.x)/2)+'" y="'+((a.y+b.y)/2-6)+'">'+edge.count+" tx</text>":"")+
      "</g>";
  }

  for(const node of model.nodes){
    const p=graphPositions.get(node.key);
    if(!p)continue;
    const isSeed=node.depth===0;
    if(isSeed){
      const seedLabel=labelForAddress(node.id,payload.chain);
      const seedBehavior=exchangeBehaviorForAddress(node.id,payload.chain);
      const seedSub=seedLabel?.category||(seedBehavior?"SCORE "+seedBehavior.score+"/100":short(node.id,6));
      html+='<g class="graph-seed" data-key="'+esc(node.key)+'" transform="translate('+p.x+" "+p.y+')">'+
        '<circle class="graph-node seed" cx="0" cy="0" r="35"></circle>'+
        '<text class="graph-label" x="0" y="-3" text-anchor="middle">'+esc(seedLabel?.name?short(seedLabel.name,10):seedBehavior?"EXCHANGE-LIKE":"SEED")+'</text>'+
        '<text class="graph-sub" x="0" y="13" text-anchor="middle">'+esc(seedSub)+"</text>"+
        "</g>";
      continue;
    }

    const radius=Math.min(29,14+Math.log2(1+Math.max(1,node.total))*3);
    const assets=node.assets.slice(0,2).join(" · ");
    const nodeLabel=labelForAddress(node.id,payload.chain);
    const nodeBehavior=exchangeBehaviorForAddress(node.id,payload.chain);
    const nodeAttribution=nodeLabel?null:attributionFor(node.id,payload.chain);
    const title="H"+node.depth+" · "+node.total+" linked record(s)"+
      (assets?" · "+assets:"")+
      (nodeBehavior?" · exchange-like heuristic score "+nodeBehavior.score+"/100 (not a calibrated probability)":"")+
      (nodeAttribution?" · AI-assessed: likely "+nodeAttribution.likely_exchange+" ("+nodeAttribution.confidence+" confidence), not a sourced label":"")+
      (node.searchable?" · click node: open new tab · +: expand in graph":" · provider address format cannot be expanded");
    const hopClass="h"+Math.min(3,node.depth);
    const expandClass=node.busy?"loading":node.expanded?"expanded":node.depth>=model.settings.maxDepth||!node.searchable?"disabled":"";
    const expandText=node.busy?"…":node.expanded?"✓":"+";
    const ringRadius=radius+5;

    html+='<g class="graph-counterparty" data-key="'+esc(node.key)+'" transform="translate('+p.x+" "+p.y+')" tabindex="0" role="button" aria-label="'+esc(title)+'">'+
      "<title>"+esc(title)+"</title>"+
      '<circle class="graph-hop-ring '+hopClass+'" cx="0" cy="0" r="'+ringRadius+'"></circle>'+
      '<circle class="graph-node '+node.relation+(node.expanded?" trace-expanded":"")+(node.searchable?"":" unsearchable")+'" cx="0" cy="0" r="'+radius+'"></circle>'+
      '<text class="graph-label" x="0" y="-2" text-anchor="middle">'+esc(nodeLabel?.name?short(nodeLabel.name,9):nodeAttribution?"≈ "+short(nodeAttribution.likely_exchange,8):nodeBehavior?"EXCHANGE-LIKE":short(node.id,5))+"</text>"+
      '<text class="graph-sub" x="0" y="12" text-anchor="middle">'+esc(nodeLabel?.category||(nodeAttribution?"AI · "+nodeAttribution.confidence.toUpperCase():nodeBehavior?"SCORE "+nodeBehavior.score+"/100":(node.total+" tx"+(assets?" · "+short(assets,6):""))))+"</text>"+
      '<g class="graph-hop-badge '+hopClass+'" transform="translate('+(-radius-5)+" "+(-radius-5)+')"><circle class="graph-hop-badge '+hopClass+'" cx="0" cy="0" r="10"></circle><text class="graph-hop-text" x="0" y="2.5" text-anchor="middle">H'+node.depth+"</text></g>"+
      '<g class="graph-expand-control '+expandClass+'" data-key="'+esc(node.key)+'" transform="translate('+(radius+5)+" "+(-radius-5)+')" role="button" aria-label="Expand '+esc(node.id)+' in graph"><circle cx="0" cy="0" r="11"></circle><text x="0" y="5" text-anchor="middle">'+expandText+"</text></g>"+
      "</g>";
  }

  const active=model.exchangePath?null:activeCase();
  const visibleKeys=new Set(model.nodes.map(node=>node.key));
  const offchainNodes=(active?.offchain_nodes||[]).filter(item=>{
    const linkedKey=normalizeAddressForChain(item.linked_address,payload.chain);
    return visibleKeys.has(linkedKey);
  });
  offchainNodes.forEach((item,index)=>{
    const linkedKey=normalizeAddressForChain(item.linked_address,payload.chain);
    const base=graphPositions.get(linkedKey);
    if(!base)return;
    const key="offchain:"+item.id;
    if(!graphPositions.has(key)){
      const angle=(index%8)*(Math.PI/4);
      graphPositions.set(key,{x:Math.max(45,Math.min(955,base.x+95*Math.cos(angle))),y:Math.max(45,Math.min(605,base.y+95*Math.sin(angle)))});
    }
    const p=graphPositions.get(key);
    html+='<g class="graph-edge-group graph-aux-edge" data-from="'+esc(linkedKey)+'" data-to="'+esc(key)+'"><line class="graph-edge offchain-link" x1="'+base.x+'" y1="'+base.y+'" x2="'+p.x+'" y2="'+p.y+'"></line></g>';
    html+='<g class="graph-aux-node offchain-node" data-aux-key="'+esc(key)+'" transform="translate('+p.x+" "+p.y+')">'+
      '<title>'+esc(item.type+" · "+item.label+(item.notes?" · "+item.notes:""))+'</title>'+
      '<rect x="-44" y="-20" width="88" height="40" rx="7" ry="7"></rect>'+
      '<text class="graph-label" x="0" y="-2" text-anchor="middle">'+esc(short(item.label,11))+'</text>'+
      '<text class="graph-sub" x="0" y="12" text-anchor="middle">'+esc(short(item.type,12))+'</text></g>';
  });

  const crossLinks=(active?.crosschain_links||[]).filter(link=>
    link.from_chain===payload.chain&&visibleKeys.has(normalizeAddressForChain(link.from_address,payload.chain))
  );
  crossLinks.forEach((link,index)=>{
    const fromKey=normalizeAddressForChain(link.from_address,payload.chain);
    const base=graphPositions.get(fromKey);
    if(!base)return;
    const key="crosschain:"+link.id;
    if(!graphPositions.has(key)){
      const angle=Math.PI/6+(index%8)*(Math.PI/4);
      graphPositions.set(key,{x:Math.max(50,Math.min(950,base.x+125*Math.cos(angle))),y:Math.max(50,Math.min(600,base.y+125*Math.sin(angle)))});
    }
    const p=graphPositions.get(key);
    html+='<g class="graph-edge-group graph-aux-edge" data-from="'+esc(fromKey)+'" data-to="'+esc(key)+'"><line class="graph-edge crosschain-link" x1="'+base.x+'" y1="'+base.y+'" x2="'+p.x+'" y2="'+p.y+'"></line></g>';
    html+='<g class="graph-aux-node crosschain-node" data-aux-key="'+esc(key)+'" data-to-chain="'+esc(link.to_chain)+'" data-to-address="'+esc(link.to_address)+'" transform="translate('+p.x+" "+p.y+')" tabindex="0" role="button">'+
      '<title>'+esc((link.service||"Cross-chain link")+" · "+link.confidence+" · "+link.to_chain+" · "+link.to_address)+'</title>'+
      '<polygon points="0,-29 38,0 0,29 -38,0"></polygon>'+
      '<text class="graph-label" x="0" y="-2" text-anchor="middle">'+esc(short(link.service||link.to_chain,10))+'</text>'+
      '<text class="graph-sub" x="0" y="12" text-anchor="middle">'+esc(link.to_chain.toUpperCase()+" · "+short(link.to_address,5))+'</text></g>';
  });

  if(model.nodes.length<=1){
    html+='<text class="graph-label" x="500" y="405" text-anchor="middle">No counterparties match the current filters</text>';
  }

  svg.innerHTML=html;
  updateGraphEdges(svg);

  const seedNode=model.nodes.find(node=>node.depth===0);
  const seedGroup=svg.querySelector(".graph-seed");
  if(seedNode&&seedGroup)attachGraphInteraction(svg,seedGroup,seedNode,payload,true);

  svg.querySelectorAll(".graph-counterparty").forEach(group=>{
    const key=String(group.dataset.key||"");
    const node=nodeByKey.get(key);
    if(!node)return;
    attachGraphInteraction(svg,group,node,payload,false);
  });

  svg.querySelectorAll(".graph-aux-node.offchain-node").forEach(group=>{
    const key=String(group.dataset.auxKey||"");
    attachAuxGraphInteraction(svg,group,key,null);
  });
  svg.querySelectorAll(".graph-aux-node.crosschain-node").forEach(group=>{
    const key=String(group.dataset.auxKey||"");
    attachAuxGraphInteraction(svg,group,key,()=>{
      const address=String(group.dataset.toAddress||"");
      const chain=String(group.dataset.toChain||"");
      if(address&&chain)openCryptoSearch(address,chain);
    });
  });

  svg.querySelectorAll(".graph-expand-control").forEach(control=>{
    const key=String(control.dataset.key||"");
    const node=nodeByKey.get(key);
    if(!node)return;
    control.addEventListener("pointerdown",event=>{event.stopPropagation();});
    control.addEventListener("pointerup",event=>{event.stopPropagation();});
    control.addEventListener("click",event=>{
      event.stopPropagation();
      if(control.classList.contains("disabled")||control.classList.contains("loading")||control.classList.contains("expanded"))return;
      expandTraceNode(node.id).catch(error=>console.warn(error));
    });
  });
}

// ---------------------------------------------------------------------------
// Graph playback: replays the currently visible network's transactions in chronological order,
// starting from just the seed node and adding each edge/node as its earliest underlying
// transaction "happens". Purely a view over data already fetched (allTraceRows/currentNetworkModel);
// nothing is refetched, and currentNetworkModel/graphPositions are never touched by a frame, so every
// other panel (KPIs, patterns, exposure, the report...) keeps reading the real, full graph throughout.
let playback=null;   // {timeline,index,playing,speedMs,timer,model,payload}

// One entry per (transaction row, counterparty) that maps to an edge actually drawn in `model`,
// i.e. exactly the edges/nodes paintGraphFrame would show for the FULL model -- an edge whose only
// transactions are pending/undated, or that a lower node-cap/branch setting pruned away, is simply
// never revealed mid-playback and appears (with everything else) once the playback reaches its end.
function buildPlaybackTimeline(model,payload){
  const edgeKeys=new Set(model.edges.map(edge=>edge.fromKey+"|"+edge.toKey));
  const events=[];
  for(const row of allTraceRows(true)){
    const direction=String(row.direction||"").toUpperCase();
    if(direction!=="IN"&&direction!=="OUT")continue;
    const time=Date.parse(row.time||"");
    if(!Number.isFinite(time))continue;
    const sourceKey=traceKey(row._trace_source,payload.chain);
    const counterparties=[...new Set((row.counterparties||[]).filter(Boolean))];
    for(const counterparty of counterparties){
      const cpKey=traceKey(counterparty,payload.chain);
      if(cpKey===sourceKey)continue;
      const fromKey=direction==="IN"?cpKey:sourceKey;
      const toKey=direction==="IN"?sourceKey:cpKey;
      const key=fromKey+"|"+toKey;
      if(!edgeKeys.has(key))continue;
      events.push({time,key,fromKey,toKey,txId:String(row.id||""),asset:String(row.asset||""),amount:row.amount,counterparty});
    }
  }
  events.sort((a,b)=>a.time-b.time);
  return events;
}

// A filtered copy of `model`: only the seed, plus nodes/edges reached by the first `count` events.
function playbackFrameModel(model,timeline,count){
  const revealedEdgeKeys=new Set();
  const revealedNodeKeys=new Set([model.rootKey]);
  for(let i=0;i<count&&i<timeline.length;i++){
    const event=timeline[i];
    revealedEdgeKeys.add(event.key);
    revealedNodeKeys.add(event.fromKey);
    revealedNodeKeys.add(event.toKey);
  }
  const atEnd=count>=timeline.length;
  return {
    ...model,
    nodes:atEnd?model.nodes:model.nodes.filter(node=>revealedNodeKeys.has(node.key)),
    edges:atEnd?model.edges:model.edges.filter(edge=>revealedEdgeKeys.has(edge.fromKey+"|"+edge.toKey))
  };
}

function updatePlaybackControls(){
  const toggle=document.getElementById("playbackToggle");
  const stop=document.getElementById("playbackStop");
  const speed=document.getElementById("playbackSpeed");
  const scrubber=document.getElementById("playbackScrubber");
  const status=document.getElementById("playbackStatus");
  if(!toggle||!stop||!scrubber||!status)return;
  const canPlay=Boolean(lastPayload&&lastPayload.kind==="address"&&currentNetworkModel&&currentNetworkModel.edges.length);
  if(!playback){
    toggle.textContent="▶ PLAYBACK";
    toggle.disabled=!canPlay;
    stop.disabled=true;
    scrubber.disabled=true;
    scrubber.max="0";
    scrubber.value="0";
    if(speed)speed.disabled=true;
    status.textContent=canPlay?"":"Run an analysis with at least one dated transaction to replay the graph.";
    return;
  }
  toggle.textContent=playback.playing?"⏸ PAUSE":"▶ RESUME";
  toggle.disabled=false;
  stop.disabled=false;
  scrubber.disabled=false;
  scrubber.max=String(playback.timeline.length);
  scrubber.value=String(playback.index);
  if(speed)speed.disabled=false;
  const total=playback.timeline.length;
  if(playback.index>=total){
    status.textContent="Playback complete · "+total+" transaction(s) replayed.";
  }else{
    const event=playback.timeline[playback.index];
    status.textContent="Transaction "+(playback.index+1)+"/"+total+" · "+fmtTime(new Date(event.time).toISOString())+
      " · "+short(event.txId,8)+" · "+(event.asset||"")+" "+fmtNumber(event.amount);
  }
}

function renderPlaybackFrame(){
  if(!playback)return;
  paintGraphFrame(playback.payload,playbackFrameModel(playback.model,playback.timeline,playback.index));
  updatePlaybackControls();
}

function schedulePlaybackTick(){
  if(!playback||!playback.playing)return;
  clearTimeout(playback.timer);
  playback.timer=setTimeout(()=>{
    if(!playback)return;
    if(playback.index>=playback.timeline.length){pausePlayback();return;}
    playback.index+=1;
    renderPlaybackFrame();
    schedulePlaybackTick();
  },playback.speedMs);
}

function startPlayback(){
  if(!lastPayload||lastPayload.kind!=="address"||!currentNetworkModel){
    setStatus("Run an address analysis first.","warning");
    return;
  }
  if(playback){togglePlayback();return;}   // already running: the toggle button means pause/resume
  const playbackModel=graphDisplayModel||currentNetworkModel;
  const timeline=buildPlaybackTimeline(playbackModel,lastPayload);
  if(!timeline.length){
    setTraceStatus("No dated transaction in the current view can be replayed (all pending, or filtered out).","error");
    return;
  }
  const speedMs=Number(document.getElementById("playbackSpeed")?.value)||600;
  playback={timeline,index:0,playing:true,speedMs,timer:null,model:playbackModel,payload:lastPayload};
  renderPlaybackFrame();
  schedulePlaybackTick();
}

function pausePlayback(){
  if(!playback)return;
  clearTimeout(playback.timer);
  playback.playing=false;
  updatePlaybackControls();
}

function resumePlayback(){
  if(!playback||playback.playing)return;
  playback.playing=true;
  schedulePlaybackTick();
  updatePlaybackControls();
}

function togglePlayback(){
  if(!playback){startPlayback();return;}
  if(playback.playing)pausePlayback();else resumePlayback();
}

// Ends playback and repaints the full, current graph exactly as a normal render would -- used both
// by the STOP button and, silently, whenever anything else re-renders the graph (a filter, AUTO
// TRACE, an expansion, RESET LAYOUT, a new search) so playback can never go on looking at a graph
// that has since changed underneath it.
function stopPlaybackSilently(){
  if(!playback)return;
  clearTimeout(playback.timer);
  playback=null;
}

function stopPlayback(){
  if(!playback){updatePlaybackControls();return;}
  stopPlaybackSilently();
  if(lastPayload&&currentNetworkModel)paintGraphFrame(lastPayload,graphDisplayModel||currentNetworkModel);
  updatePlaybackControls();
}

function scrubPlayback(index){
  if(!playback)return;
  pausePlayback();
  playback.index=Math.max(0,Math.min(playback.timeline.length,Number(index)||0));
  renderPlaybackFrame();
}

function renderFilteredViews(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const rows=allTraceRows(true);
  renderFilterSummary(rows);
  renderGraph(lastPayload);
  renderKpis(lastPayload,rows);
  renderTable(lastPayload,rowsForExchangePath(rows,activeExchangePath,lastPayload.chain));
  renderIntelligencePanels();
}

function resetTraceState(payload){
  exchangeGraphMode="auto";
  selectedExchangePath="";
  activeExchangePath=null;
  graphDisplayModel=null;
  tracePayloads=new Map();
  traceExpanded=new Set();
  traceBusy=new Set();
  autoTraceRun=null;
  exchangeAttributions=new Map();
  graphPositions=new Map();
  currentNetworkModel=null;
  const address=String(payload.query||"");
  const key=traceKey(address,payload.chain);
  tracePayloads.set(key,{key,address,payload,depth:0});
  traceExpanded.add(key);
}

function render(payload){
  lastPayload=payload;
  absorbExchangeLabels(payload,true);
  renderLabelList();
  const result=document.getElementById("cryptoResult");
  if(result)result.hidden=false;
  document.getElementById("cryptoResultQuery").textContent=payload.query||"";
  document.getElementById("cryptoResultMeta").textContent=(payload.chain_name||payload.chain||"")+" · "+(payload.kind||"")+" · "+(payload.provider||"")+" · "+fmtTime(payload.generated_at);
  const explorer=document.getElementById("cryptoExplorer");
  if(explorer)explorer.href=payload.explorer_url||"#";

  const addressView=document.getElementById("addressView");
  const transactionView=document.getElementById("transactionView");
  if(payload.kind==="transaction"){
    if(addressView)addressView.hidden=true;
    if(transactionView)transactionView.hidden=false;
    renderKpis(payload,[]);
    const pre=document.getElementById("cryptoTransactionJson");
    if(pre)pre.textContent=JSON.stringify(payload.transaction||{},null,2);
    renderSanctions();
  }else{
    if(addressView)addressView.hidden=false;
    if(transactionView)transactionView.hidden=true;
    resetTraceState(payload);
    resetFilterControls(false);
    populateAssetFilter();
    renderObservations(payload);
    renderFilteredViews();
  }
}

async function run({silent=false}={}){
  if(document.getElementById("cryptoRun")?.disabled)return;
  const query=String(document.getElementById("cryptoQuery")?.value||"").trim();
  const chain=String(document.getElementById("cryptoChain")?.value||"auto");
  const button=document.getElementById("cryptoRun");
  if(query.length<8){setStatus("Enter a wallet address or transaction hash.","error");return;}
  if(!user()||!token()){redirectToLogin();return;}

  const finishSound=silent?null:window.CTAtlasSound?.begin();
  if(button){button.disabled=true;button.textContent="ANALYSING…";}
  setStatus("Querying on-chain provider and building transaction relationships…","working");
  const result=document.getElementById("cryptoResult");
  if(result)result.hidden=true;

  try{
    const response=await fetch(API_BASE+"/crypto-analyze",{
      method:"POST",
      headers:sessionHeaders({"Content-Type":"application/json"}),
      body:JSON.stringify({user_id:user(),query,chain,limit:100,origin:silent?"url":"search"})
    });
    const payload=await response.json().catch(()=>({}));
    if(response.status===401){redirectToLogin();return;}
    if(!response.ok)throw new Error(payload.error||"Crypto analysis failed.");
    render(payload);finishSound?.("success");
    setStatus("Analysis completed from public on-chain data.","success");
  }catch(error){
    finishSound?.("error");
    setStatus(error?.message||"Crypto analysis failed.","error");
  }finally{
    if(button){button.disabled=false;button.textContent="ANALYSE";}
  }
}

// Demo address: listed on the OFAC SDN list (sanctions-crypto.json; a test fails if a
// refresh ever delists it), and chosen because one analysis shows most of the tool:
// a sanctions match on the wallet itself, a dozen other listed wallets among its
// counterparties, large-transfer / burst / dormant-reactivation patterns and a wide
// graph to trace. Only the list's own attribution is stated; nothing else is claimed.
const TEST_ADDRESS="3FoD1f6Tfnq3s8MYHgJqFPWv9cUrtUdBSv";

function loadTestExample(){
  const input=document.getElementById("cryptoQuery");
  const chain=document.getElementById("cryptoChain");
  if(input)input.value=TEST_ADDRESS;
  if(chain)chain.value="bitcoin";
  setStatus("Demo address loaded (listed on the OFAC SDN list). The analysis will show the sanctions match, listed counterparties, behavioural patterns and the transaction graph. Transaction links are not proof of common ownership. Select ANALYSE to run the test.","");
  input?.focus();
}

function applyUrlQuery(){
  const params=new URLSearchParams(window.location.search);
  const q=String(params.get("q")||"").trim();
  const chain=String(params.get("chain")||"").trim();
  if(q){
    const input=document.getElementById("cryptoQuery");
    if(input)input.value=q;
  }
  if(chain){
    const select=document.getElementById("cryptoChain");
    if(select&&[...select.options].some(option=>option.value===chain))select.value=chain;
  }
  return Boolean(q&&params.get("autorun")==="1");
}

function bind(){
  document.getElementById("exchangePathToggle")?.addEventListener("click",()=>{
    exchangeGraphMode=activeExchangePath?"all":"focus";
    graphPositions=new Map();
    renderFilteredViews();
  });
  document.getElementById("exchangePathSelect")?.addEventListener("change",event=>{
    selectedExchangePath=event.target.value;
    exchangeGraphMode="focus";
    graphPositions=new Map();
    renderFilteredViews();
  });
  document.getElementById("cryptoRun")?.addEventListener("click",run);
  document.getElementById("cryptoTestExample")?.addEventListener("click",loadTestExample);
  document.getElementById("cryptoQuery")?.addEventListener("keydown",event=>{if(event.key==="Enter")run();});
  document.getElementById("cryptoResetFilters")?.addEventListener("click",()=>resetFilterControls(true));
  document.getElementById("cryptoClearFilter")?.addEventListener("click",()=>resetFilterControls(true));
  document.getElementById("cryptoResetGraph")?.addEventListener("click",()=>{
    graphPositions=new Map();
    renderFilteredViews();
  });
  document.getElementById("playbackToggle")?.addEventListener("click",togglePlayback);
  document.getElementById("playbackStop")?.addEventListener("click",stopPlayback);
  document.getElementById("playbackSpeed")?.addEventListener("change",event=>{
    if(playback)playback.speedMs=Number(event.target.value)||600;
  });
  document.getElementById("playbackScrubber")?.addEventListener("input",event=>scrubPlayback(event.target.value));
  document.getElementById("cryptoClearTrace")?.addEventListener("click",clearTrace);
  document.getElementById("cryptoAutoTrace")?.addEventListener("click",autoTrace);
  document.getElementById("traceMaxDepth")?.addEventListener("change",()=>renderFilteredViews());
  document.getElementById("traceBranch")?.addEventListener("change",()=>renderFilteredViews());
  document.getElementById("pathFindButton")?.addEventListener("click",runPathFinder);
  document.getElementById("labelSeedButton")?.addEventListener("click",()=>openLabelForm(lastPayload?.query||""));
  document.getElementById("labelSaveButton")?.addEventListener("click",saveLabel);
  document.getElementById("labelCancelButton")?.addEventListener("click",()=>{document.getElementById("labelForm").hidden=true;});
  document.getElementById("labelCategory")?.addEventListener("change",syncLabelCategoryFields);
  document.getElementById("exchangeRefreshQueue")?.addEventListener("click",()=>refreshExchangeProposals().catch(error=>setExchangeAdminStatus(error.message)));
  document.getElementById("exchangeMigrateLabels")?.addEventListener("click",async event=>{
    const button=event.currentTarget;button.disabled=true;
    setExchangeAdminStatus("Collecting existing private EXCHANGE labels into the pending review queue…");
    try{
      const result=await exchangeApi("migrate");
      await refreshExchangeProposals();
      setExchangeAdminStatus((result.proposals_added||0)+" proposal(s) added for review; "+(result.skipped||0)+" skipped because they were invalid or already present.");
    }catch(error){setExchangeAdminStatus(error.message);}
    finally{button.disabled=false;}
  });
  document.getElementById("exchangeTemplateDownload")?.addEventListener("click",downloadExchangeTemplate);
  document.getElementById("exchangeSeedOfficial")?.addEventListener("click",async event=>{
    const button=event.currentTarget;button.disabled=true;
    setExchangeAdminStatus("Importing historically disclosed Binance, OKX and Crypto.com wallet addresses…");
    try{
      const result=await exchangeApi("seed");
      setExchangeAdminStatus((result.imported||0)+" address(es) imported from "+(result.source_records||0)+" sourced rows ("+(result.skipped||0)+" already present). Lists are historical and partial; verify current control.");
      await refreshExchangeProposals();
    }catch(error){setExchangeAdminStatus(error.message);}
    finally{button.disabled=false;}
  });
  document.getElementById("exchangeImportButton")?.addEventListener("click",importExchangeLabels);
  document.getElementById("exchangeImportFile")?.addEventListener("change",async event=>{
    const file=event.currentTarget.files?.[0];
    if(!file)return;
    try{document.getElementById("exchangeImportText").value=await file.text();setExchangeAdminStatus("Loaded "+file.name+"; review the rows before importing.");}
    catch(_){setExchangeAdminStatus("Unable to read the selected file.");}
  });
  document.getElementById("exchangeProposalList")?.addEventListener("click",event=>{
    const button=event.target.closest("[data-exchange-review]");
    if(button)reviewExchangeProposal(button);
  });
  document.getElementById("caseNewButton")?.addEventListener("click",()=>{
    document.getElementById("caseCreateForm").hidden=false;
    document.getElementById("caseName")?.focus();
  });
  document.getElementById("caseCreateButton")?.addEventListener("click",createCase);
  document.getElementById("caseSelect")?.addEventListener("change",event=>{
    activeCaseId=String(event.target.value||"");
    renderCaseUi();
  });
  document.getElementById("caseAddSeedButton")?.addEventListener("click",addSeedToCase);
  document.getElementById("caseSavePathButton")?.addEventListener("click",savePathToCase);
  document.getElementById("cryptoReportButton")?.addEventListener("click",exportFullReport);
  document.getElementById("caseExportPdfButton")?.addEventListener("click",()=>exportCasePdf().catch(error=>setStatus(error?.message||"Case PDF export failed.","error")));
  document.getElementById("caseAddNoteButton")?.addEventListener("click",addCaseNote);
  document.getElementById("caseOffchainToggle")?.addEventListener("click",()=>{
    const form=document.getElementById("offchainForm");
    form.hidden=!form.hidden;
    if(!form.hidden&&lastPayload)document.getElementById("offchainLinkedAddress").value=lastPayload.query||"";
  });
  document.getElementById("caseCrosschainToggle")?.addEventListener("click",()=>{
    const form=document.getElementById("crosschainForm");
    form.hidden=!form.hidden;
    if(!form.hidden&&lastPayload){
      document.getElementById("crosschainFromAddress").value=lastPayload.query||"";
      const fromChain=document.getElementById("crosschainFromChain");
      if(fromChain&&lastPayload.chain)fromChain.value=lastPayload.chain;
    }
  });
  document.getElementById("offchainSaveButton")?.addEventListener("click",saveOffchainNode);
  document.getElementById("crosschainSaveButton")?.addEventListener("click",saveCrosschainLink);
  document.getElementById("monitorSeedButton")?.addEventListener("click",monitorSeed);
  document.getElementById("monitorCheckButton")?.addEventListener("click",checkMonitored);

  FILTER_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    const eventName=el.tagName==="SELECT"?"change":"input";
    el.addEventListener(eventName,()=>renderFilteredViews());
  });
}

async function start(){
  bind();
  const autoRun=applyUrlQuery();
  const ok=await verifySession();
  if(!ok)return;
  renderExchangeAdminAccess();
  await providerHealth();
  await loadCryptoWorkspace();
  if(autoRun)run({silent:true});
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);
else start();
})();




