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
function sessionHeaders(extra={}){
  return {"X-Session-Token":token(),...extra};
}
function redirectToLogin(){
  window.location.href="index.html";
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
    graphNodes:Math.max(5,Math.min(40,Number(document.getElementById("filterGraphNodes")?.value||20)||20))
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

  const all=Array.isArray(payload.transactions)?payload.transactions:[];
  const rows=filteredRows||all;
  const counterparties=new Set(rows.flatMap(row=>Array.isArray(row.counterparties)?row.counterparties:[]).filter(Boolean));
  const incoming=rows.filter(row=>row.direction==="IN").length;
  const outgoing=rows.filter(row=>row.direction==="OUT").length;
  const balance=payload.balance?fmtNumber(payload.balance.amount)+" "+String(payload.balance.asset||""):"—";
  box.innerHTML=[
    kpi("Current balance",balance),
    kpi("Sample records",String(all.length)),
    kpi("Filtered records",String(rows.length)),
    kpi("Counterparties",String(counterparties.size)),
    kpi("Direction mix",incoming+" IN · "+outgoing+" OUT")
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

function populateAssetFilter(payload){
  const select=document.getElementById("filterAsset");
  if(!select)return;
  const current=String(select.value||"all");
  const assets=[...new Set((payload.transactions||[]).map(row=>String(row.asset||"").trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b));
  select.innerHTML='<option value="all">All assets</option>'+
    assets.map(asset=>'<option value="'+esc(asset)+'">'+esc(asset)+'</option>').join("");
  select.value=assets.includes(current)?current:"all";
}

function resetFilterControls(renderNow=true){
  const defaults={
    filterDirection:"all",filterAsset:"all",filterType:"all",filterStatus:"all",
    filterMinAmount:"",filterMaxAmount:"",filterFromDate:"",filterToDate:"",
    filterText:"",filterGraphMinLinks:"1",filterGraphNodes:"20"
  };
  for(const [id,value] of Object.entries(defaults)){
    const el=document.getElementById(id);
    if(el)el.value=value;
  }
  if(lastPayload)populateAssetFilter(lastPayload);
  if(renderNow)renderFilteredViews();
}

function renderFilterSummary(rows){
  const el=document.getElementById("cryptoFilterSummary");
  if(!el||!lastPayload)return;
  const total=(lastPayload.transactions||[]).length;
  const labels=activeFilterLabels();
  el.textContent=rows.length+" of "+total+" records"+(labels.length?" · "+labels.join(" · "):" · no transaction filters active");
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
    setStatus("This provider returned an encoded/non-searchable counterparty address for the current chain. You can still drag the node and inspect linked transactions.","warning");
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

function renderTable(payload,rows){
  const tbody=document.getElementById("cryptoTableBody");
  const note=document.getElementById("cryptoTableNote");
  if(!tbody)return;
  if(note)note.textContent=rows.length+" filtered record(s) · click a counterparty to open a new CT Atlas Crypto analysis";

  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="6" class="crypto-filter-empty">No transaction records match the current filters.</td></tr>';
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
    return "<tr>"+
      "<td>"+esc(fmtTime(row.time))+"<br><span class=\"crypto-card-note\">"+statusHtml+"</span></td>"+
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

function buildGraphModel(payload,rows){
  const seed=String(payload.query||"");
  const map=new Map();

  function nodeFor(address){
    let node=map.get(address);
    if(!node){
      node={id:address,incoming:0,outgoing:0,total:0,assets:new Set()};
      map.set(address,node);
    }
    return node;
  }

  for(const row of rows){
    const direction=String(row.direction||"").toUpperCase();
    const unique=[...new Set((row.counterparties||[]).filter(Boolean))];
    for(const cp of unique){
      if(String(cp).toLowerCase()===seed.toLowerCase())continue;
      const node=nodeFor(cp);
      node.total+=1;
      if(row.asset)node.assets.add(String(row.asset));
      if(direction==="IN")node.incoming+=1;
      else if(direction==="OUT")node.outgoing+=1;
    }
  }

  const f=readFilters();
  const nodes=[...map.values()]
    .filter(node=>node.total>=f.graphMinLinks)
    .sort((a,b)=>b.total-a.total||b.incoming+b.outgoing-(a.incoming+a.outgoing))
    .slice(0,f.graphNodes)
    .map(node=>({
      ...node,
      assets:[...node.assets].sort(),
      relation:node.incoming>0&&node.outgoing>0?"both":node.incoming>0?"incoming":"outgoing"
    }));

  return {seed,nodes};
}

function defaultGraphPosition(id,index,total,isSeed){
  if(isSeed)return {x:410,y:230};
  const radius=total>22?180:total>12?165:145;
  const angle=-Math.PI/2+(Math.PI*2*index/Math.max(total,1));
  return {x:410+Math.cos(angle)*radius,y:230+Math.sin(angle)*radius};
}

function graphPosition(id,index,total,isSeed){
  if(graphPositions.has(id))return graphPositions.get(id);
  const pos=defaultGraphPosition(id,index,total,isSeed);
  graphPositions.set(id,pos);
  return pos;
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
      label.setAttribute("y",(a.y+b.y)/2-5);
    }
  });
}

function clientPointToSvg(svg,event){
  const point=svg.createSVGPoint();
  point.x=event.clientX;point.y=event.clientY;
  const matrix=svg.getScreenCTM();
  return matrix?point.matrixTransform(matrix.inverse()):{x:event.clientX,y:event.clientY};
}

function attachGraphInteraction(svg,group,id,payload,searchable,isSeed=false){
  let state=null;
  group.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    const p=clientPointToSvg(svg,event);
    const current=graphPositions.get(id)||{x:p.x,y:p.y};
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
      x:Math.max(35,Math.min(785,p.x-state.offsetX)),
      y:Math.max(35,Math.min(425,p.y-state.offsetY))
    };
    graphPositions.set(id,next);
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
    if(!moved&&!isSeed&&searchable)openCryptoSearch(id,payload.chain);
  };
  group.addEventListener("pointerup",finish);
  group.addEventListener("pointercancel",event=>{
    if(state&&event.pointerId===state.pointerId){state=null;group.classList.remove("dragging");}
  });
  if(!isSeed){
    group.addEventListener("keydown",event=>{
      if((event.key==="Enter"||event.key===" ")&&searchable){
        event.preventDefault();openCryptoSearch(id,payload.chain);
      }
    });
  }
}

function renderGraph(payload,rows){
  const svg=document.getElementById("flowGraph");
  if(!svg)return;

  const model=buildGraphModel(payload,rows);
  const seed=model.seed,nodes=model.nodes;
  const seedPos=graphPosition(seed,0,nodes.length,true);
  let html='<defs>'+
    '<marker id="arrowIn" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#46d890"></path></marker>'+
    '<marker id="arrowOut" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#ff8268"></path></marker>'+
    '</defs>';

  nodes.forEach((node,index)=>graphPosition(node.id,index,nodes.length,false));

  for(const node of nodes){
    const cpPos=graphPositions.get(node.id);
    if(node.incoming>0){
      const width=Math.min(8,1.3+Math.log2(1+node.incoming)*1.25);
      html+='<g class="graph-edge-group" data-from="'+esc(node.id)+'" data-to="'+esc(seed)+'">'+
        '<line class="graph-edge in" x1="'+cpPos.x+'" y1="'+cpPos.y+'" x2="'+seedPos.x+'" y2="'+seedPos.y+'" stroke-width="'+width+'" marker-end="url(#arrowIn)"></line>'+
        (node.incoming>1?'<text class="graph-edge-label" x="'+((cpPos.x+seedPos.x)/2)+'" y="'+((cpPos.y+seedPos.y)/2-5)+'">'+node.incoming+" IN</text>":"")+
        "</g>";
    }
    if(node.outgoing>0){
      const width=Math.min(8,1.3+Math.log2(1+node.outgoing)*1.25);
      html+='<g class="graph-edge-group" data-from="'+esc(seed)+'" data-to="'+esc(node.id)+'">'+
        '<line class="graph-edge out" x1="'+seedPos.x+'" y1="'+seedPos.y+'" x2="'+cpPos.x+'" y2="'+cpPos.y+'" stroke-width="'+width+'" marker-end="url(#arrowOut)"></line>'+
        (node.outgoing>1?'<text class="graph-edge-label" x="'+((cpPos.x+seedPos.x)/2)+'" y="'+((cpPos.y+seedPos.y)/2-5)+'">'+node.outgoing+" OUT</text>":"")+
        "</g>";
    }
  }

  html+='<g class="graph-seed" data-id="'+esc(seed)+'" transform="translate('+seedPos.x+" "+seedPos.y+')">'+
    '<circle class="graph-node seed" cx="0" cy="0" r="34"></circle>'+
    '<text class="graph-label" x="0" y="-2" text-anchor="middle">SEED</text>'+
    '<text class="graph-sub" x="0" y="13" text-anchor="middle">'+esc(short(seed,6))+"</text>"+
    "</g>";

  nodes.forEach(node=>{
    const p=graphPositions.get(node.id);
    const searchable=isSearchableAddress(node.id,payload.chain);
    const radius=Math.min(28,14+Math.log2(1+node.total)*3);
    const assets=node.assets.slice(0,3).join(" · ");
    const title=(searchable?"Click: open new CT Atlas Crypto analysis. ":"")+
      "Drag: reposition. "+node.total+" linked record(s). "+node.incoming+" incoming / "+node.outgoing+" outgoing."+
      (assets?" Assets: "+assets:"");
    html+='<g class="graph-counterparty" data-id="'+esc(node.id)+'" transform="translate('+p.x+" "+p.y+')" tabindex="0" role="button" aria-label="'+esc(title)+'">'+
      "<title>"+esc(title)+"</title>"+
      '<circle class="graph-node '+node.relation+(searchable?"":" unsearchable")+'" cx="0" cy="0" r="'+radius+'"></circle>'+
      '<text class="graph-label" x="0" y="-1" text-anchor="middle">'+esc(short(node.id,5))+"</text>"+
      '<text class="graph-sub" x="0" y="13" text-anchor="middle">'+node.total+" tx"+(assets?" · "+esc(short(assets,8)):"")+"</text>"+
      "</g>";
  });

  if(!nodes.length){
    html+='<text class="graph-label" x="410" y="230" text-anchor="middle">No counterparties match the current graph filters</text>';
  }

  svg.innerHTML=html;
  updateGraphEdges(svg);

  const seedGroup=svg.querySelector(".graph-seed");
  if(seedGroup)attachGraphInteraction(svg,seedGroup,seed,payload,false,true);
  svg.querySelectorAll(".graph-counterparty").forEach(group=>{
    const id=String(group.dataset.id||"");
    attachGraphInteraction(svg,group,id,payload,isSearchableAddress(id,payload.chain),false);
  });
}

function renderFilteredViews(){
  if(!lastPayload||lastPayload.kind!=="address")return;
  const rows=filterRows(lastPayload);
  renderFilterSummary(rows);
  renderKpis(lastPayload,rows);
  renderTable(lastPayload,rows);
  renderGraph(lastPayload,rows);
}

function render(payload){
  lastPayload=payload;
  graphPositions=new Map();

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
    resetFilterControls(false);
    populateAssetFilter(payload);
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