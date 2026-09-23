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
    "0x1111111254eeb25477b68fb85ed929f73a960582":{name:"1inch Router",category:"DEX"}
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
      html+='<g class="graph-seed" data-key="'+esc(node.key)+'" transform="translate('+p.x+" "+p.y+')">'+
        '<circle class="graph-node seed" cx="0" cy="0" r="35"></circle>'+
        '<text class="graph-label" x="0" y="-3" text-anchor="middle">SEED</text>'+
        '<text class="graph-sub" x="0" y="13" text-anchor="middle">'+esc(short(node.id,6))+"</text>"+
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
      '<text class="graph-label" x="0" y="-2" text-anchor="middle">'+esc(short(node.id,5))+"</text>"+
      '<text class="graph-sub" x="0" y="12" text-anchor="middle">'+node.total+" tx"+(assets?" · "+esc(short(assets,6)):"")+"</text>"+
      '<g class="graph-hop-badge '+hopClass+'" transform="translate('+(-radius-5)+" "+(-radius-5)+')"><circle class="graph-hop-badge '+hopClass+'" cx="0" cy="0" r="10"></circle><text class="graph-hop-text" x="0" y="2.5" text-anchor="middle">H'+node.depth+"</text></g>"+
      '<g class="graph-expand-control '+expandClass+'" data-key="'+esc(node.key)+'" transform="translate('+(radius+5)+" "+(-radius-5)+')" role="button" aria-label="Expand '+esc(node.id)+' in graph"><circle cx="0" cy="0" r="11"></circle><text x="0" y="5" text-anchor="middle">'+expandText+"</text></g>"+
      "</g>";
  }

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
  document.getElementById("cryptoResetGraph")?.addEventListener("click",()=>{
    graphPositions=new Map();
    renderFilteredViews();
  });
  document.getElementById("cryptoClearTrace")?.addEventListener("click",clearTrace);
  document.getElementById("cryptoAutoTrace")?.addEventListener("click",autoTrace);
  document.getElementById("traceMaxDepth")?.addEventListener("change",()=>renderFilteredViews());
  document.getElementById("traceBranch")?.addEventListener("change",()=>renderFilteredViews());

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
  if(autoRun)run();
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);
else start();
})();