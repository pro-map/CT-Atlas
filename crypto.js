(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
let lastPayload=null;
let activeCounterparty="";

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

function renderKpis(payload){
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
  const rows=Array.isArray(payload.transactions)?payload.transactions:[];
  const counterparties=new Set(rows.flatMap(row=>Array.isArray(row.counterparties)?row.counterparties:[]).filter(Boolean));
  const incoming=rows.filter(row=>row.direction==="IN").length;
  const outgoing=rows.filter(row=>row.direction==="OUT").length;
  const balance=payload.balance?fmtNumber(payload.balance.amount)+" "+String(payload.balance.asset||""):"—";
  box.innerHTML=[
    kpi("Current balance",balance),
    kpi("Returned records",String(rows.length)),
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

function renderTable(payload){
  const tbody=document.getElementById("cryptoTableBody");
  const note=document.getElementById("cryptoTableNote");
  const clear=document.getElementById("cryptoClearFilter");
  if(!tbody)return;
  let rows=Array.isArray(payload.transactions)?payload.transactions:[];
  if(activeCounterparty){
    rows=rows.filter(row=>(row.counterparties||[]).some(cp=>String(cp).toLowerCase()===activeCounterparty.toLowerCase()));
  }
  if(note)note.textContent=activeCounterparty?("Filtered to "+activeCounterparty+" · "+rows.length+" record(s)"):(rows.length+" recent record(s) shown");
  if(clear)clear.style.display=activeCounterparty?"inline-block":"none";

  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="6">No transaction records in this view.</td></tr>';
    return;
  }

  tbody.innerHTML=rows.map(row=>{
    const cp=(row.counterparties||[]).filter(Boolean);
    const cpText=cp.length?cp.map(item=>short(item,9)).join(", "):"—";
    const dir=String(row.direction||"").toUpperCase();
    const cls=dir==="IN"?"dir-in":dir==="OUT"?"dir-out":"dir-self";
    return "<tr>"+
      "<td>"+esc(fmtTime(row.time))+"</td>"+
      '<td class="'+cls+'">'+esc(dir||"—")+"</td>"+
      "<td>"+esc(row.asset||"—")+"</td>"+
      "<td>"+esc(fmtNumber(row.amount))+"</td>"+
      '<td class="mono" title="'+esc(cp.join(", "))+'">'+esc(cpText)+"</td>"+
      '<td><a class="tx-link" href="'+esc(row.explorer_url||"#")+'" target="_blank" rel="noopener noreferrer">'+esc(short(row.id,8))+"</a></td>"+
      "</tr>";
  }).join("");
}

function graphNodes(payload){
  const seed=String(payload.query||"");
  const flows=Array.isArray(payload.flows)?payload.flows:[];
  const counts=new Map();
  for(const flow of flows){
    const cp=String(flow.from).toLowerCase()===seed.toLowerCase()?flow.to:flow.from;
    if(!cp||String(cp).toLowerCase()===seed.toLowerCase())continue;
    counts.set(cp,(counts.get(cp)||0)+Number(flow.tx_count||1));
  }
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,14).map(([id,count])=>({id,count}));
}

function renderGraph(payload){
  const svg=document.getElementById("flowGraph");
  if(!svg)return;
  const seed=String(payload.query||"");
  const flows=Array.isArray(payload.flows)?payload.flows:[];
  const nodes=graphNodes(payload);
  const W=820,H=390,cx=410,cy=195,r=Math.min(150,Math.max(95,40+nodes.length*8));
  const pos=new Map([[seed,{x:cx,y:cy}]]);
  nodes.forEach((node,index)=>{
    const angle=(-Math.PI/2)+(Math.PI*2*index/Math.max(1,nodes.length));
    pos.set(node.id,{x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r});
  });

  let html="";
  const visible=new Set(nodes.map(n=>n.id.toLowerCase()));
  for(const flow of flows){
    const cp=String(flow.from).toLowerCase()===seed.toLowerCase()?flow.to:flow.from;
    if(!cp||!visible.has(String(cp).toLowerCase()))continue;
    const a=pos.get(seed),b=pos.get(cp);
    if(!a||!b)continue;
    const outgoing=String(flow.from).toLowerCase()===seed.toLowerCase();
    const width=Math.min(7,1+Math.log2(1+Number(flow.tx_count||1)));
    html+='<line class="graph-edge '+(outgoing?"out":"in")+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke-width="'+width+'"></line>';
  }

  html+='<circle class="graph-node seed" cx="'+cx+'" cy="'+cy+'" r="31"></circle>';
  html+='<text class="graph-label" x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle">SEED</text>';
  html+='<text class="graph-sub" x="'+cx+'" y="'+(cy+12)+'" text-anchor="middle">'+esc(short(seed,6))+"</text>";

  nodes.forEach(node=>{
    const p=pos.get(node.id);
    const selected=activeCounterparty&&activeCounterparty.toLowerCase()===node.id.toLowerCase();
    html+='<g class="graph-counterparty" data-address="'+esc(node.id)+'" tabindex="0" role="button" aria-label="Filter transactions for '+esc(node.id)+'">';
    html+='<circle class="graph-node'+(selected?" selected":"")+'" cx="'+p.x+'" cy="'+p.y+'" r="'+Math.min(22,13+Math.log2(1+node.count)*2)+'"></circle>';
    html+='<text class="graph-label" x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle">'+esc(short(node.id,4))+"</text>";
    html+="</g>";
  });
  if(!nodes.length){
    html+='<text class="graph-label" x="410" y="265" text-anchor="middle">No counterparties available in this sample</text>';
  }
  svg.innerHTML=html;
  svg.querySelectorAll(".graph-counterparty").forEach(group=>{
    const select=()=>{
      activeCounterparty=String(group.dataset.address||"");
      renderGraph(payload);renderTable(payload);
    };
    group.addEventListener("click",select);
    group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();select();}});
  });
}

function render(payload){
  lastPayload=payload;
  activeCounterparty="";
  const result=document.getElementById("cryptoResult");
  if(result)result.hidden=false;
  document.getElementById("cryptoResultQuery").textContent=payload.query||"";
  document.getElementById("cryptoResultMeta").textContent=(payload.chain_name||payload.chain||"")+" · "+(payload.kind||"")+" · "+(payload.provider||"")+" · "+fmtTime(payload.generated_at);
  const explorer=document.getElementById("cryptoExplorer");
  if(explorer)explorer.href=payload.explorer_url||"#";
  renderKpis(payload);

  const addressView=document.getElementById("addressView");
  const transactionView=document.getElementById("transactionView");
  if(payload.kind==="transaction"){
    if(addressView)addressView.hidden=true;
    if(transactionView)transactionView.hidden=false;
    const pre=document.getElementById("cryptoTransactionJson");
    if(pre)pre.textContent=JSON.stringify(payload.transaction||{},null,2);
  }else{
    if(addressView)addressView.hidden=false;
    if(transactionView)transactionView.hidden=true;
    renderObservations(payload);
    renderGraph(payload);
    renderTable(payload);
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
      body:JSON.stringify({user_id:user(),query,chain,limit:60})
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

function bind(){
  document.getElementById("cryptoRun")?.addEventListener("click",run);
  document.getElementById("cryptoQuery")?.addEventListener("keydown",event=>{if(event.key==="Enter")run();});
  document.getElementById("cryptoClearFilter")?.addEventListener("click",()=>{
    activeCounterparty="";
    if(lastPayload){renderGraph(lastPayload);renderTable(lastPayload);}
  });
}

async function start(){
  bind();
  const ok=await verifySession();
  if(ok)providerHealth();
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);
else start();
})();