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
let currentNetworkModel=null;
let cryptoWorkspace={version:"crypto-workspace-v1",labels:[],watchlist:[],cases:[],alerts:[]};
let activeCaseId="";
let lastFoundPath=null;
let workspaceSaveTimer=null;

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
    strip.innerHTML=[
      ["BITCOIN · BLOCKSTREAM",providers.bitcoin!==false],
      ["EVM · ETHERSCAN",Boolean(providers.evm)],
      ["TRON · TRONGRID",Boolean(providers.tron)]
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

function labelForAddress(address,chain=lastPayload?.chain){
  const normalized=normalizeAddressForChain(address,chain);
  return (cryptoWorkspace.labels||[]).find(label=>
    label.chain===chain&&normalizeAddressForChain(label.address,chain)===normalized
  )||null;
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
  return (cryptoWorkspace.labels||[]).filter(label=>
    label.chain===lastPayload.chain&&visible.has(normalizeAddressForChain(label.address,label.chain))
  );
}

function renderWorkspaceUi(){
  renderLabelList();
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
    graphNodes:Math.max(20,Math.min(80,Number(document.getElementById("filterGraphNodes")?.value||40)||40))
  };
}

function traceSettings(){
  return {
    maxDepth:Math.max(2,Math.min(3,Number(document.getElementById("traceMaxDepth")?.value||3)||3)),
    branch:Math.max(3,Math.min(8,Number(document.getElementById("traceBranch")?.value||3)||3))
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
    filterText:"",filterGraphMinLinks:"1",filterGraphNodes:"40"
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
    return '<div class="intel-item"><div class="intel-item-head"><div><div class="intel-title">'+esc(label.name||label.category)+'</div>'+
      '<div class="intel-meta">'+esc(label.category)+' · '+esc(short(label.address,9))+'</div></div>'+
      '<span class="intel-badge '+String(label.confidence||"low").toLowerCase()+'">'+esc(label.confidence||"LOW")+'</span></div>'+
      '<div class="label-source">SOURCE: '+source+'</div>'+
      (label.notes?'<div class="intel-detail">'+esc(label.notes)+'</div>':"")+
      '<div class="intel-actions"><button type="button" class="crypto-small-button label-delete" data-id="'+esc(label.id)+'">DELETE</button></div></div>';
  }).join("");
  box.querySelectorAll(".label-delete").forEach(button=>button.addEventListener("click",()=>{
    cryptoWorkspace.labels=(cryptoWorkspace.labels||[]).filter(item=>item.id!==button.dataset.id);
    scheduleWorkspaceSave();renderWorkspaceUi();renderFilteredViews();
  }));
}

function openLabelForm(address){
  const form=document.getElementById("labelForm");
  if(!form)return;
  form.hidden=false;
  document.getElementById("labelAddress").value=address||lastPayload?.query||"";
  document.getElementById("labelName").focus();
}

function saveLabel(){
  const address=String(document.getElementById("labelAddress")?.value||"").trim();
  if(!lastPayload||!isSearchableAddress(address,lastPayload.chain)){
    setStatus("Enter a valid address on the current blockchain before saving a label.","warning");
    return;
  }
  const name=String(document.getElementById("labelName")?.value||"").trim();
  const sourceTitle=String(document.getElementById("labelSourceTitle")?.value||"").trim();
  const sourceType=String(document.getElementById("labelSourceType")?.value||"").trim();
  if(!name||(!sourceTitle&&!sourceType)){
    setStatus("A label/entity name and a source description are required.","warning");
    return;
  }
  const item={
    id:makeId("label"),
    chain:lastPayload.chain,
    address,
    name,
    category:String(document.getElementById("labelCategory")?.value||"OTHER"),
    confidence:String(document.getElementById("labelConfidence")?.value||"LOW"),
    source_type:sourceType,
    source_title:sourceTitle,
    source_url:String(document.getElementById("labelSourceUrl")?.value||"").trim(),
    notes:String(document.getElementById("labelNotes")?.value||"").trim(),
    created_at:new Date().toISOString()
  };
  const key=normalizeAddressForChain(address,lastPayload.chain);
  cryptoWorkspace.labels=(cryptoWorkspace.labels||[]).filter(label=>
    !(label.chain===lastPayload.chain&&normalizeAddressForChain(label.address,label.chain)===key&&label.category===item.category)
  );
  cryptoWorkspace.labels.unshift(item);
  document.getElementById("labelForm").hidden=true;
  scheduleWorkspaceSave();
  renderWorkspaceUi();renderFilteredViews();
  setStatus("Sourced analyst label saved.","success");
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
    status:"OPEN",chain:lastPayload?.chain||"",seed_addresses:[],saved_paths:[],notes:[],
    created_at:new Date().toISOString()
  };
  cryptoWorkspace.cases.unshift(item);
  activeCaseId=item.id;
  document.getElementById("caseCreateForm").hidden=true;
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
  scheduleWorkspaceSave();renderCaseUi();renderFilteredViews();
  setStatus("Off-chain node saved to the active case.","success");
}

function saveCrosschainLink(){
  const item=activeCase();
  if(!item||!lastPayload){setStatus("Select a case first.","warning");return;}
  const from=String(document.getElementById("crosschainFromAddress")?.value||lastPayload.query||"").trim();
  const to=String(document.getElementById("crosschainToAddress")?.value||"").trim();
  const toChain=String(document.getElementById("crosschainToChain")?.value||"").trim();
  if(!from||!to||!toChain){setStatus("From wallet, destination chain and destination wallet are required.","warning");return;}
  item.crosschain_links=Array.isArray(item.crosschain_links)?item.crosschain_links:[];
  item.crosschain_links.unshift({
    id:makeId("crosschain"),
    from_chain:lastPayload.chain,
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
  scheduleWorkspaceSave();renderCaseUi();renderFilteredViews();
  setStatus("Sourced cross-chain link saved to the active case.","success");
}

async function exportCasePdf(){
  const item=activeCase();
  if(!item){setStatus("Select a case first.","warning");return;}
  if(!window.CTAtlasPdf?.download){setStatus("PDF export library is unavailable.","error");return;}

  const patterns=detectPatterns();
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
  document.getElementById("monitorStatus").textContent="Seed is monitored. Baseline snapshot saved.";
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
        const fresh=await fetchAddressAnalysis(watch.address,watch.chain,100);
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
    '<div class="intel-detail">Source '+esc(short(item.source_wallet,8))+' · '+esc(fmtNumber(item.amount))+' '+esc(item.asset||"")+
    (item.tx_id?' · TX '+esc(short(item.tx_id,8)):"")+'</div></div>'
  ).join("");
}

function renderIntelligencePanels(){
  renderPatterns();
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
          return searchable
            ? '<button type="button" class="counterparty-link" data-address="'+esc(item)+'" title="'+esc(item)+'">'+esc(short(item,8))+"</button>"
            : '<span title="'+esc(item)+'">'+esc(short(item,8))+"</span>";
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

function buildNetworkModel(payload){
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

  const entries=traceEntries().filter(entry=>entry.depth<settings.maxDepth);
  for(const entry of entries){
    const source=entry.address;
    const sourceNode=ensureNode(source,entry.depth);
    const rows=filterRows(entry.payload);
    const neighbors=neighborStats(entry.payload,rows)
      .filter(node=>node.total>=f.graphMinLinks)
      .slice(0,entry.depth===0?Math.min(14,f.graphNodes-1):settings.branch);

    for(const neighbor of neighbors){
      const childDepth=Math.min(settings.maxDepth,entry.depth+1);
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
  const keepKeys=new Set([rootKey,...traceEntries().map(entry=>entry.key)]);
  if(nodeList.length>f.graphNodes){
    const retained=nodeList
      .sort((a,b)=>{
        const ak=keepKeys.has(a.key)?1:0,bk=keepKeys.has(b.key)?1:0;
        return bk-ak||a.depth-b.depth||b.total-a.total;
      })
      .slice(0,f.graphNodes);
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
  const radius=node.depth===1?150:node.depth===2?245:305;
  const angleOffset=node.depth===1?-Math.PI/2:node.depth===2?-Math.PI/2+0.28:-Math.PI/2+0.52;
  const angle=angleOffset+(Math.PI*2*index/Math.max(totalAtDepth,1));
  return {x:500+Math.cos(angle)*radius,y:325+Math.sin(angle)*radius};
}

function ensureGraphPositions(model){
  for(const depth of [0,1,2,3]){
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
      line.setAttribute("x1",a.x);line.setAttribute("y1",a.y);
      line.setAttribute("x2",b.x);line.setAttribute("y2",b.y);
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

async function fetchAddressAnalysis(address,chain,limit=40){
  const response=await fetch(API_BASE+"/crypto-analyze",{
    method:"POST",
    headers:sessionHeaders({"Content-Type":"application/json"}),
    body:JSON.stringify({user_id:user(),query:address,chain,limit})
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
    const payload=await fetchAddressAnalysis(address,lastPayload.chain,40);
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

async function autoTrace(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const button=document.getElementById("cryptoAutoTrace");
  const settings=traceSettings();
  if(button){button.disabled=true;button.textContent="TRACING…";}
  setTraceStatus("Automatic trace started. CT Atlas expands only the strongest searchable branches to limit provider load.","working");

  let expandedCount=0;
  try{
    for(let depth=1;depth<settings.maxDepth;depth++){
      currentNetworkModel=buildNetworkModel(lastPayload);
      const candidates=currentNetworkModel.nodes
        .filter(node=>node.depth===depth&&node.searchable&&!traceExpanded.has(node.key))
        .sort((a,b)=>b.total-a.total)
        .slice(0,settings.branch);

      if(!candidates.length)continue;

      for(let i=0;i<candidates.length;i++){
        const node=candidates[i];
        setTraceStatus(
          "Auto trace H"+depth+" → H"+(depth+1)+" · "+(i+1)+"/"+candidates.length+
          " · "+short(node.id,8),
          "working"
        );
        try{
          const ok=await expandTraceNode(node.id,{quiet:true});
          if(ok)expandedCount++;
        }catch(error){
          console.warn("Auto-trace node skipped",node.id,error);
        }
        await sleep(400);
      }
    }
    renderFilteredViews();
    setTraceStatus(
      expandedCount
        ? "Automatic trace complete: "+expandedCount+" wallet(s) expanded, visible network depth H"+(currentNetworkModel?.maxVisibleDepth||0)+"."
        : "Automatic trace found no additional searchable branches to expand under the current filters.",
      "success"
    );
  }catch(error){
    setTraceStatus(error?.message||"Automatic trace failed.","error");
  }finally{
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
  populateAssetFilter();
  renderFilteredViews();
  setTraceStatus("Trace cleared. H1 is rebuilt from the seed wallet only.","success");
}

function renderGraph(payload){
  const svg=document.getElementById("flowGraph");
  if(!svg)return;

  const model=buildNetworkModel(payload);
  currentNetworkModel=model;
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
      html+='<g class="graph-seed" data-key="'+esc(node.key)+'" transform="translate('+p.x+" "+p.y+')">'+
        '<circle class="graph-node seed" cx="0" cy="0" r="35"></circle>'+
        '<text class="graph-label" x="0" y="-3" text-anchor="middle">'+esc(seedLabel?.name?short(seedLabel.name,10):"SEED")+'</text>'+
        '<text class="graph-sub" x="0" y="13" text-anchor="middle">'+esc(seedLabel?.category||short(node.id,6))+"</text>"+
        "</g>";
      continue;
    }

    const radius=Math.min(29,14+Math.log2(1+Math.max(1,node.total))*3);
    const assets=node.assets.slice(0,2).join(" · ");
    const title="H"+node.depth+" · "+node.total+" linked record(s)"+
      (assets?" · "+assets:"")+
      (node.searchable?" · click node: open new tab · +: expand in graph":" · provider address format cannot be expanded");
    const hopClass="h"+Math.min(3,node.depth);
    const expandClass=node.busy?"loading":node.expanded?"expanded":node.depth>=model.settings.maxDepth||!node.searchable?"disabled":"";
    const expandText=node.busy?"…":node.expanded?"✓":"+";
    const ringRadius=radius+5;

    html+='<g class="graph-counterparty" data-key="'+esc(node.key)+'" transform="translate('+p.x+" "+p.y+')" tabindex="0" role="button" aria-label="'+esc(title)+'">'+
      "<title>"+esc(title)+"</title>"+
      '<circle class="graph-hop-ring '+hopClass+'" cx="0" cy="0" r="'+ringRadius+'"></circle>'+
      '<circle class="graph-node '+node.relation+(node.expanded?" trace-expanded":"")+(node.searchable?"":" unsearchable")+'" cx="0" cy="0" r="'+radius+'"></circle>'+
      '<text class="graph-label" x="0" y="-2" text-anchor="middle">'+esc(labelForAddress(node.id,payload.chain)?.name?short(labelForAddress(node.id,payload.chain).name,9):short(node.id,5))+"</text>"+
      '<text class="graph-sub" x="0" y="12" text-anchor="middle">'+esc(labelForAddress(node.id,payload.chain)?.category||(node.total+" tx"+(assets?" · "+short(assets,6):"")))+"</text>"+
      '<g class="graph-hop-badge '+hopClass+'" transform="translate('+(-radius-5)+" "+(-radius-5)+')"><circle class="graph-hop-badge '+hopClass+'" cx="0" cy="0" r="10"></circle><text class="graph-hop-text" x="0" y="2.5" text-anchor="middle">H'+node.depth+"</text></g>"+
      '<g class="graph-expand-control '+expandClass+'" data-key="'+esc(node.key)+'" transform="translate('+(radius+5)+" "+(-radius-5)+')" role="button" aria-label="Expand '+esc(node.id)+' in graph"><circle cx="0" cy="0" r="11"></circle><text x="0" y="5" text-anchor="middle">'+expandText+"</text></g>"+
      "</g>";
  }

  const active=activeCase();
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

  setTraceStatus(
    "Network: "+model.nodes.length+" visible node(s) · "+tracePayloads.size+" analyzed wallet(s) · visible depth H"+model.maxVisibleDepth+
    " · max depth H"+model.settings.maxDepth+" · branch "+model.settings.branch,
    ""
  );
}

function renderFilteredViews(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const rows=allTraceRows(true);
  renderFilterSummary(rows);
  renderGraph(lastPayload);
  renderKpis(lastPayload,rows);
  renderTable(lastPayload,rows);
  renderIntelligencePanels();
}

function resetTraceState(payload){
  tracePayloads=new Map();
  traceExpanded=new Set();
  traceBusy=new Set();
  graphPositions=new Map();
  currentNetworkModel=null;
  const address=String(payload.query||"");
  const key=traceKey(address,payload.chain);
  tracePayloads.set(key,{key,address,payload,depth:0});
  traceExpanded.add(key);
}

function render(payload){
  lastPayload=payload;
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

async function run(){
  const query=String(document.getElementById("cryptoQuery")?.value||"").trim();
  const chain=String(document.getElementById("cryptoChain")?.value||"auto");
  const button=document.getElementById("cryptoRun");
  if(query.length<8){setStatus("Enter a wallet address or transaction hash.","error");return;}
  if(!user()||!token()){redirectToLogin();return;}

  if(button){button.disabled=true;button.textContent="ANALYSING…";}
  setStatus("Querying on-chain provider and building transaction relationships…","working");
  const result=document.getElementById("cryptoResult");
  if(result)result.hidden=true;

  try{
    const response=await fetch(API_BASE+"/crypto-analyze",{
      method:"POST",
      headers:sessionHeaders({"Content-Type":"application/json"}),
      body:JSON.stringify({user_id:user(),query,chain,limit:100})
    });
    const payload=await response.json().catch(()=>({}));
    if(response.status===401){redirectToLogin();return;}
    if(!response.ok)throw new Error(payload.error||"Crypto analysis failed.");
    render(payload);
    setStatus("Analysis completed from public on-chain data.","success");
  }catch(error){
    setStatus(error?.message||"Crypto analysis failed.","error");
  }finally{
    if(button){button.disabled=false;button.textContent="ANALYSE";}
  }
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
  document.getElementById("cryptoRun")?.addEventListener("click",run);
  document.getElementById("cryptoQuery")?.addEventListener("keydown",event=>{if(event.key==="Enter")run();});
  document.getElementById("cryptoResetFilters")?.addEventListener("click",()=>resetFilterControls(true));
  document.getElementById("cryptoClearFilter")?.addEventListener("click",()=>resetFilterControls(true));
  document.getElementById("cryptoResetGraph")?.addEventListener("click",()=>{
    graphPositions=new Map();
    renderFilteredViews();
  });
  document.getElementById("cryptoClearTrace")?.addEventListener("click",clearTrace);
  document.getElementById("cryptoAutoTrace")?.addEventListener("click",autoTrace);
  document.getElementById("traceMaxDepth")?.addEventListener("change",()=>renderFilteredViews());
  document.getElementById("traceBranch")?.addEventListener("change",()=>renderFilteredViews());
  document.getElementById("pathFindButton")?.addEventListener("click",runPathFinder);
  document.getElementById("labelSeedButton")?.addEventListener("click",()=>openLabelForm(lastPayload?.query||""));
  document.getElementById("labelSaveButton")?.addEventListener("click",saveLabel);
  document.getElementById("labelCancelButton")?.addEventListener("click",()=>{document.getElementById("labelForm").hidden=true;});
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
    if(!form.hidden&&lastPayload)document.getElementById("crosschainFromAddress").value=lastPayload.query||"";
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
  await providerHealth();
  await loadCryptoWorkspace();
  if(autoRun)run();
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);
else start();
})();