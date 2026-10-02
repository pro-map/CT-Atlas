(function(root){
"use strict";

// Full analysis report of the Crypto Intelligence tab.
//
// crypto.js collects everything the analyst sees (and the parts that filters hide) into a plain MODEL, this file
// turns it into the blocks of a PDF (pdf-export.js: headings, text, tables, one image). It is pure - no DOM, no state -
// so every section and every wording rule is unit-tested in Node.
//
// Wording rules, kept from the page: a transaction link is not identity attribution, common ownership or proof of
// control; a sanctions-list match is an address-string match, not a compliance determination; NOT SCREENED is never
// presented as clean; absence statements are scoped to the sample, never absolute.

const LIMITS=Object.freeze({transactions:1500,nodes:80,counterparties:40,labels:60,patterns:20,exchangeFindings:60,exposure:60,crosschain:50,alerts:20,notes:30,txDetailFields:60});

const DISCLAIMER="Transaction linkage is not identity attribution, common ownership, criminality, terrorist financing, or proof of control. Multi-input Bitcoin transactions, smart-contract execution and token routing can require specialist interpretation. Validate significant findings against the source explorer and other evidence before operational use.";
const EXCHANGE_LIMITATIONS="The 0–100 behaviour score is a rules-based screening score, not a calibrated probability. An exchange-like pattern can also come from bridges, payment services, protocols, or other high-throughput wallets; it does not confirm that the wallet is an exchange or identify its operator.";
const LABEL_LIMITATIONS="Labels preserve their source and confidence. An approved exchange label is a sourced attribution, not a verified fact; it does not prove common ownership or control of connected wallets.";
const LIMITATIONS="CT Atlas Crypto uses bounded public blockchain samples (the most recent records the provider returned for each analysed wallet, not a full archival crawl) and analyst-sourced labels. On-chain transaction linkage does not establish identity, common ownership, criminality, terrorist financing, intent, or custody. Exchange-behaviour scores are rules-based screening scores, not calibrated probabilities; a high-throughput wallet may be another exchange, bridge, payment service, protocol, or other service. Heuristic pattern detection and H1-H3 exposure calculations describe observed transaction behaviour, not criminal intent, and require independent validation before operational or evidentiary use. Absence of a finding is limited to the sample analysed and is not proof of absence.";
const SANCTIONS_NOTE="A sanctions-list match means this exact address string appears on a published list; it is not a compliance determination and does not by itself show who controls the address. No match does NOT mean an address is safe: coverage is limited to the listed source(s), and only the counterparties visible in the recent transaction sample were screened (direct relationships only, no indirect exposure).";
const NOT_SCREENED="Sanctions screening was NOT performed for this analysis, so the absence of a match must not be read as a clean result.";
const AI_ATTRIBUTION_NOTE="An AI-assessed operator is an investigative lead drawn from the wallet's behaviour, its labelled neighbours and publicly documented patterns. It is not a sourced attribution and does not establish control or ownership; confirm it with the exchange or a sourced label before operational use.";
const HOPS="H0 is the seed wallet, H1 its direct counterparties; H2 and beyond (up to H6) are wallets the analyst or AUTO TRACE expanded. A ring colour encodes a node's minimum hop. Node size and edge width reflect the number of linked records, not ownership probability.";

function badgeText(badge){return text(badge&&typeof badge==="object"?badge.text:badge,80);}
function text(value,max=6000){
  return String(value??"").replace(/ /g," ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").trim().slice(0,max);
}
function list(value){return Array.isArray(value)?value:[];}
function num(value){
  if(value===null||value===undefined||value===""||typeof value==="boolean")return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

// Deterministic (browser-locale independent) formatting, so a report reads the same wherever it is generated.
function fmtAmount(value){
  const n=num(value);
  if(n===null)return "—";
  if(n===0)return "0";
  const digits=Math.abs(n)>=1000000?2:8;
  return n.toLocaleString("en-US",{maximumFractionDigits:digits});
}
function fmtUtc(value){
  const raw=text(value,80);
  if(!raw)return "Pending / unknown";
  const time=Date.parse(raw);
  if(!Number.isFinite(time))return raw;
  return new Date(time).toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC");
}
function plural(n,one,many){return n+" "+(n===1?one:many);}

function heading(label){return {type:"heading",text:label};}
function body(value){return {type:"body",text:value};}
function small(value){return {type:"small",text:value};}
function alert(value){return {type:"alert",text:value};}
function sub(value){return {type:"subheading",text:value};}
function mono(value){return {type:"mono",text:value};}
function bullet(value){return {type:"body",text:"• "+value};}
function noneRecorded(value){return small(value);}

function keyValueTable(rows,caption){
  return {type:"table",caption,fontSize:15,columns:[{key:"k",label:"Item",width:3},{key:"v",label:"Value",width:9}],
    rows:rows.map(([k,v])=>({k:{text:k,bold:true},v:{text:text(v)||"—"}}))};
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function summarySection(model){
  const s=model.subject||{};
  const c=model.counts||{};
  const rows=[
    ["Subject",(s.kind==="transaction"?"Transaction lookup":"Wallet analysis")+" · "+text(s.chainName||s.chain)],
    [s.kind==="transaction"?"Transaction hash":"Wallet address",s.query],
    ["Data provider",s.provider],
    ["Generated",fmtUtc(model.generatedAt)+(model.user?" · analyst "+model.user:"")],
    ["Provider response time",fmtUtc(s.generatedAt)]
  ];
  if(s.kind!=="transaction"){
    rows.push(
      ["Seed balance (native asset)",model.balance?fmtAmount(model.balance.amount)+" "+text(model.balance.asset):"—"],
      ["Analysed wallets",String(c.wallets??"—")+(c.maxDepth!==undefined?" · trace depth H"+c.maxDepth:"")],
      ["Transaction records in the sample",String(c.transactions??"—")+(c.transactionsListed!==undefined&&c.transactionsListed<c.transactions?" (first "+c.transactionsListed+" listed)":"")],
      ["Graph nodes shown",String(c.graphNodes??"—")],
      ["Behavioural patterns",String(c.patterns??"—")],
      ["Exchange identification findings",String(c.exchangeFindings??"—")],
      ["Labelled exposure findings",String(c.exposure??"—")]
    );
  }
  if(s.kind!=="transaction"){
    const t=model.autoTrace;
    rows.push(["Automatic trace",t
      ?"reached H"+(num(t.maxDepthReached)??"—")+" of H"+(num(t.maxDepth)??6)+" · "+plural(num(t.expanded)??0,"wallet","wallets")+" expanded · "+
        plural(list(t.exchanges).length,"exchange","exchanges")+" reached · stopped: "+text(t.stop||"—")
      :"not run — the report covers the trace as expanded by hand"]);
  }
  rows.push(["Sanctions-list screening",badgeText(model.sanctions?.badge)||"—"]);
  if(model.filters?.active?.length){
    rows.push(["Transaction filters active on screen",model.filters.active.join(" · ")+" — every section of this report (including the graph's node and flow tables) uses ALL records regardless of these filters"]);
  }else{
    rows.push(["Transaction filters active on screen","none — this report already uses all records"]);
  }
  if(s.kind!=="transaction"&&model.graph?.statusLine){
    rows.push(["Graph display settings (affect only the graph image and its node/flow tables below)",text(model.graph.statusLine)]);
  }
  return [heading("SUMMARY"),keyValueTable(rows)];
}

function exchangeTitle(item){
  const ai=item.ai&&text(item.ai.likely_exchange)&&text(item.ai.likely_exchange).toLowerCase()!=="unknown"?item.ai:null;
  if(item.basis==="sourced")return (text(item.name)||"Exchange")+" (sourced label)";
  if(ai)return "Exchange-like wallet, likely "+text(ai.likely_exchange)+" ("+text(ai.confidence)+" confidence, AI-assessed)";
  if(text(item.name))return "Exchange-like wallet linked to "+text(item.name);
  return "Exchange-like wallet (operator not assessed)";
}

// What the automatic trace established, as the report's conclusion: how deep
// the funds were followed, which exchanges they reached, why the trace
// stopped. Written from the trace actually reached in the chart.
function traceConclusionSection(model){
  if((model.subject||{}).kind==="transaction")return [];
  const t=model.autoTrace;
  const c=model.counts||{};
  const blocks=[heading("TRACE CONCLUSION")];
  if(!t){
    blocks.push(body("No automatic trace was run. This report covers the trace as expanded by hand: "+plural(num(c.wallets)??1,"analysed wallet","analysed wallets")+
      ", visible depth H"+(num(c.maxDepth)??0)+". Run AUTO TRACE to follow the funds until they reach an exchange."));
    return blocks;
  }
  const exchanges=list(t.exchanges);
  const reached=exchanges.map(item=>exchangeTitle(item)+" at H"+(num(item.depth)??"—"));
  blocks.push(body(
    "The automatic trace followed the strongest branches from the seed for "+plural(num(t.expanded)??0,"wallet","wallets")+
    ", up to H"+(num(t.maxDepthReached)??"—")+" (limit H"+(num(t.maxDepth)??6)+", top "+(num(t.branch)??3)+" branches per hop, "+(num(t.walletBudget)??30)+"-wallet budget). "+
    (exchanges.length
      ?"It reached "+plural(exchanges.length,"exchange wallet","exchange wallets")+": "+reached.join("; ")+"."
      :"It did not reach any wallet identified as an exchange.")+
    " It stopped because "+(text(t.stop)||"the trace ended")+"."+
    (num(t.failed)?" "+plural(num(t.failed),"wallet","wallets")+" could not be expanded (provider error) and were skipped.":"")
  ));
  if(exchanges.length){
    const sourced=exchanges.filter(item=>item.basis==="sourced").length;
    const assessed=exchanges.filter(item=>item.ai&&text(item.ai.likely_exchange).toLowerCase()!=="unknown").length;
    blocks.push(body("Of these, "+sourced+" "+(sourced===1?"is":"are")+" identified by a sourced exchange label and "+(exchanges.length-sourced)+
      " by behaviour (exchange score of 80/100 or more)"+(assessed?", "+assessed+" of which "+(assessed===1?"has":"have")+" an AI-assessed operator":"")+
      ". An exchange is where traceable on-chain flows usually end: the next step is a request to the exchange for the account behind the deposit or withdrawal."));
  }
  if(text(t.attribution).startsWith("unavailable"))blocks.push(alert("AI attribution of the exchange-like wallets was "+text(t.attribution)+"."));
  return blocks;
}

function autoTraceSection(model){
  const t=model.autoTrace;
  const exchanges=list(t?.exchanges);
  if(!t||!exchanges.length)return [];
  const blocks=[heading("EXCHANGES REACHED BY THE AUTOMATIC TRACE"),small(EXCHANGE_LIMITATIONS),small(AI_ATTRIBUTION_NOTE)];
  for(const item of exchanges.slice(0,LIMITS.exchangeFindings)){
    blocks.push(sub(exchangeTitle(item)+" · H"+(num(item.depth)??"—")+(item.basis==="sourced"?" · SOURCED LABEL":" · SCORE "+String(num(item.score)??"—")+"/100")));
    blocks.push(mono(text(item.address)));
    const path=list(item.path);
    if(path.length>1){
      blocks.push(small("Path from the seed ("+(path.length-1)+" hop"+(path.length===2?"":"s")+"): "+path.map((step,index)=>
        (index===0?"seed ":(step.direction==="in"?"← ":"→ "))+text(step.address).slice(0,14)+(text(step.address).length>14?"…":"")).join(" ")+
        " (→ funds sent onward, ← funds received from)."));
    }
    if(item.basis==="sourced"&&text(item.source))blocks.push(small("Source: "+text(item.source)));
    const ai=item.ai;
    if(ai){
      blocks.push(body("AI-assessed operator: "+text(ai.likely_exchange)+" · "+text(ai.confidence)+" confidence"+
        (text(ai.service_type)?" · "+text(ai.service_type).replaceAll("_"," "):"")+"."));
      for(const reason of list(ai.basis))blocks.push(bullet(text(reason)));
      if(list(ai.alternatives).length)blocks.push(small("Alternatives: "+list(ai.alternatives).map(value=>text(value)).join(", ")+"."));
    }
    for(const detail of list(item.evidence).slice(0,6))blocks.push(bullet("Behaviour: "+text(detail)));
  }
  return blocks;
}

function sanctionsSection(model){
  const sx=model.sanctions;
  const blocks=[heading("SANCTIONS-LIST SCREENING")];
  if(!sx){
    blocks.push(alert(NOT_SCREENED));
    return blocks;
  }
  const hits=list(sx.hits);
  const warnings=list(sx.warnings);
  const qualifier=!hits.length&&warnings.length?" — see the coverage warning(s) below before treating this as clean.":".";
  blocks.push(hits.length?alert(badgeText(sx.badge)+" — listed address(es) found among the analysed wallet(s) and their counterparties in the returned sample."):body("Result: "+(badgeText(sx.badge)||"—")+qualifier));
  if(sx.note)blocks.push(small(text(sx.note)));
  for(const warning of warnings)blocks.push(alert(text(warning)));
  for(const hit of hits){
    blocks.push(sub((hit.terrorism?"TERRORISM PROGRAM":"SANCTIONS LIST")+" · "+text(hit.roleLabel||hit.role)+" · H"+(num(hit.depth)??0)+(hit.currency?" · "+text(hit.currency):"")));
    blocks.push(mono(text(hit.address)));
    if(hit.title)blocks.push(body(text(hit.title)));
    if(hit.context)blocks.push(small(text(hit.context)));
  }
  if(!hits.length&&sx.noMatchText)blocks.push(body(text(sx.noMatchText)));
  blocks.push(small(text(sx.scope)||SANCTIONS_NOTE));
  if(hits.some(hit=>hit.context))blocks.push(small("\"Last …\" dates in a hit's context above are shown in the analyst's own browser time zone; every other time in this report is UTC."));
  return blocks;
}

function observationsSection(model){
  const notes=list(model.observations).map(item=>text(item)).filter(Boolean);
  if(!notes.length&&!model.samplingNote)return [];
  const blocks=[heading("KEY OBSERVATIONS"),small("Deterministic summary of the returned sample · no identity inference.")];
  for(const note of notes)blocks.push(bullet(note));
  if(model.samplingNote)blocks.push(small("Sampling: "+text(model.samplingNote)));
  return blocks;
}

function patternsSection(model){
  const all=list(model.patterns);
  const patterns=all.slice(0,LIMITS.patterns);
  const blocks=[heading("BEHAVIOURAL PATTERNS"),small("Heuristics describe observed transaction behaviour — not criminal intent. Computed on every record of every analysed wallet.")];
  if(!patterns.length){
    blocks.push(noneRecorded("No configured behavioural pattern crossed its heuristic threshold in the analysed sample."));
    return blocks;
  }
  blocks.push({type:"table",fontSize:14,columns:[{key:"sev",label:"Level",width:1.4},{key:"name",label:"Pattern",width:3.4},{key:"metric",label:"Metric",width:3},{key:"note",label:"Detail",width:5}],
    rows:patterns.map(p=>({
      sev:{text:text(p.severity).toUpperCase(),bold:true,color:p.severity==="high"?"#8a1f2c":p.severity==="medium"?"#8a5a10":"#18252d"},
      name:text(p.name),metric:text(p.metric),note:text(p.detail)
    }))});
  if(all.length>patterns.length)blocks.push(alert("This table lists the first "+patterns.length+" of "+all.length+" pattern(s) found; the report is capped to stay readable."));
  return blocks;
}

function exchangeSection(model){
  const all=list(model.exchangeFindings);
  const items=all.slice(0,LIMITS.exchangeFindings);
  const blocks=[heading("EXCHANGE IDENTIFICATION"),small("Sourced address matches are listed separately from behavioural candidates."),small(EXCHANGE_LIMITATIONS)];
  if(!items.length){
    blocks.push(noneRecorded("No sourced exchange match or behavioural candidate at or above 80/100 was found in the analysed sample."));
    return blocks;
  }
  for(const item of items){
    const sourced=item.type==="sourced";
    blocks.push(sub((text(item.name)||"Exchange finding")+(sourced?" · SOURCED LABEL · "+text(item.confidence||"MEDIUM"):" · HEURISTIC SCORE "+String(num(item.score)??"—")+"/100")));
    if(item.address)blocks.push(mono(text(item.address)));
    if(item.wallet_role)blocks.push(small("Wallet role: "+text(item.wallet_role).replaceAll("_"," ")+(item.depth!==undefined?" · trace H"+(num(item.depth)??0):"")));
    if(item.interactions)blocks.push(small("Observed direct transaction links in this sample: "+String(num(item.interactions)??0)+". This does not establish control by the exchange."));
    if(item.source_title)blocks.push(small("Source: "+text(item.source_title)+(item.source_url?" — "+text(item.source_url):"")));
    const ai=item.ai_attribution;
    if(ai&&text(ai.likely_exchange)){
      blocks.push(small("AI-assessed operator (investigative lead, not a sourced label): "+text(ai.likely_exchange)+" · "+text(ai.confidence)+" confidence"+
        (list(ai.basis).length?" — "+list(ai.basis).map(value=>text(value)).join("; "):"")));
    }
    if(list(item.evidence).length)for(const detail of item.evidence)blocks.push(bullet(text(detail)));
  }
  if(all.length>items.length)blocks.push(alert("This section lists the first "+items.length+" of "+all.length+" exchange finding(s)."));
  return blocks;
}

function exposureSection(model){
  const items=list(model.exposure).slice(0,LIMITS.exposure);
  const blocks=[heading("LABELLED EXPOSURE (H1–H3)"),small("Addresses carrying an analyst label or watchlist category that were observed within three hops of the seed along the direction of value flow. Every label is an analyst attribution with its own source and confidence.")];
  if(!items.length)blocks.push(noneRecorded("No path from the seed to a currently labelled sensitive category was observed within H1–H3 in the analysed sample."));
  else{
    blocks.push({type:"table",fontSize:14,columns:[{key:"hop",label:"Hop",width:1},{key:"category",label:"Category",width:3},{key:"name",label:"Label",width:4},{key:"conf",label:"Confidence",width:2},{key:"share",label:"Direct share",width:2,align:"right"}],
      rows:items.map(item=>({hop:"H"+(num(item.hop)??"?"),category:text(item.category),name:text(item.name)||"—",conf:text(item.confidence)||"—",
        share:item.direct_share===null||item.direct_share===undefined?"—":(Math.round(Number(item.direct_share)*10)/10)+"%",detail:text(item.address)}))});
    blocks.push(small("\"Direct share\" is a heuristic: each outgoing record's amount is split evenly across its counterparties and all assets are summed without unit conversion; it is not a value share."));
  }
  if(model.path&&list(model.path.nodes).length){
    blocks.push(sub("SHORTEST OBSERVED PATH · "+(list(model.path.nodes).length-1)+" hop(s)"));
    blocks.push(mono(list(model.path.nodes).map(item=>text(item)).join("\n→ ")));
  }
  return blocks;
}

function labelsSection(model){
  const labels=list(model.labels).slice(0,LIMITS.labels);
  const blocks=[heading("SOURCED LABELS"),small(LABEL_LIMITATIONS)];
  if(!labels.length){blocks.push(noneRecorded("No analyst label applies to the seed or to the counterparties reached within the traced graph."));return blocks;}
  blocks.push({type:"table",fontSize:14,columns:[{key:"name",label:"Label / entity",width:4},{key:"category",label:"Category",width:2},{key:"role",label:"Wallet role",width:3},{key:"conf",label:"Confidence",width:2}],
    rows:labels.map(label=>({name:text(label.name)||"—",category:text(label.category),role:text(label.wallet_role).replaceAll("_"," ")||"—",conf:text(label.confidence)||"—",
      detail:text(label.address)+"\n"+(label.shared?"Shared CT Atlas registry · ":label.provider?text(label.provider)+" · ":"")+"Source: "+(text(label.source_title)||text(label.source_type)||"Analyst source")+(label.source_url?" — "+text(label.source_url):"")+(label.notes?"\nNotes: "+text(label.notes):"")}))});
  return blocks;
}

function watchSection(model){
  const watch=list(model.watchlist);
  const alerts=list(model.alerts).slice(0,LIMITS.alerts);
  if(!watch.length&&!alerts.length)return [];
  const blocks=[heading("WATCHLIST & MONITORING")];
  if(watch.length){
    blocks.push({type:"table",fontSize:14,columns:[{key:"label",label:"Watched wallet",width:4},{key:"state",label:"Monitoring",width:2},{key:"limits",label:"Alert thresholds",width:6}],
      rows:watch.map(item=>({label:text(item.label)||"—",state:item.enabled===false?"paused":"enabled",limits:text(item.thresholdsText)||"none set",detail:text(item.address)}))});
  }
  if(alerts.length){
    blocks.push(sub("RECENT ALERTS FOR THE SEED"));
    blocks.push({type:"table",fontSize:14,columns:[{key:"time",label:"Raised",width:3},{key:"sev",label:"Severity",width:2},{key:"title",label:"Alert",width:7}],
      rows:alerts.map(item=>({time:fmtUtc(item.created_at),sev:text(item.severity),title:text(item.title)+(item.detail?" — "+text(item.detail):""),...(item.tx_id?{detail:"TX "+text(item.tx_id)}:{})}))});
  }
  return blocks;
}

function crossChainSection(model){
  const all=list(model.crossChain);
  const items=all.slice(0,LIMITS.crosschain);
  const blocks=[heading("SERVICE / BRIDGE / DEX TOUCHPOINTS"),small("Known labelled services observed in the analysed sample. A touchpoint shows that a record involved the service; it does not show where value ended up.")];
  if(!items.length){blocks.push(noneRecorded("No known labelled bridge, DEX, mixer or service touchpoint was detected in the analysed sample. Absence here is not proof of absence."));return blocks;}
  blocks.push({type:"table",fontSize:14,columns:[{key:"category",label:"Category",width:2},{key:"name",label:"Service",width:4},{key:"source",label:"Basis",width:3},{key:"time",label:"Time (UTC)",width:3}],
    rows:items.map(item=>({category:text(item.service?.category),name:text(item.service?.name)||"—",source:text(item.service?.source)||"Known service registry",time:item.time?fmtUtc(item.time):"—",
      detail:[item.address?"Address: "+text(item.address):"",item.source_wallet?"Source wallet: "+text(item.source_wallet):"",item.tx_id?"TX "+text(item.tx_id):"",item.destination_chain?"Destination chain: "+text(item.destination_chain):""].filter(Boolean).join("\n")}))});
  if(all.length>items.length)blocks.push(alert("This table lists the first "+items.length+" of "+all.length+" touchpoint(s) found; the report is capped to stay readable."));
  return blocks;
}

function graphSection(model){
  const g=model.graph;
  if(!g)return [];
  const blocks=[heading("TRANSACTION FLOW GRAPH")];
  if(g.image)blocks.push({type:"image",src:g.image,maxHeight:640,maxScale:1.1,caption:"Flow graph as displayed on screen at the time of the report"+(g.statusLine?" · "+text(g.statusLine):"")});
  else blocks.push(noneRecorded("The graph image could not be produced in this browser; the node table below carries the same information."));
  blocks.push(small("Legend — Seed: blue · incoming only: green · outgoing only: red · bidirectional: purple · incoming flow: green line · outgoing flow: orange line. "+HOPS));
  const nodes=list(g.nodes).slice(0,LIMITS.nodes);
  if(nodes.length){
    blocks.push({type:"table",caption:"Nodes of the graph ("+nodes.length+(list(g.nodes).length>nodes.length?" of "+list(g.nodes).length:"")+")",fontSize:14,
      columns:[{key:"hop",label:"Hop",width:1},{key:"role",label:"Direction",width:2.4},{key:"records",label:"Records",width:1.6,align:"right"},{key:"in",label:"In",width:1,align:"right"},{key:"out",label:"Out",width:1,align:"right"},{key:"assets",label:"Assets",width:3}],
      rows:nodes.map(node=>node.depth===0
        ?{hop:"H0",role:"seed",records:"—",in:"—",out:"—",assets:list(node.assets).join(", ")||"—",detail:text(node.address)+(node.label?"\nLabel: "+text(node.label):"")+"\nThe seed's own record count is in the summary and in Transaction Records below."}
        :{hop:"H"+(num(node.depth)??0),role:text(node.relation),records:String(num(node.total)??"—"),in:String(num(node.incoming)??"—"),out:String(num(node.outgoing)??"—"),
          assets:list(node.assets).join(", ")||"—",detail:text(node.address)+(node.label?"\nLabel: "+text(node.label):"")}
      )});
    blocks.push(small("Records / In / Out count each node's own linked transactions with other visible nodes; they describe that node's position in the graph, not the seed's total activity."));
  }
  const edges=list(g.edges);
  if(edges.length){
    const shown=edges.slice(0,LIMITS.transactions);
    blocks.push({type:"table",caption:"Flows between nodes ("+shown.length+" of "+edges.length+", strongest first)",fontSize:14,
      columns:[{key:"hop",label:"Hop",width:1},{key:"count",label:"Records",width:1.6,align:"right"},{key:"assets",label:"Assets",width:3}],
      rows:shown.map(edge=>({hop:"H"+(num(edge.hop)??0),count:String(num(edge.count)??"—"),assets:list(edge.assets).join(", ")||"—",detail:text(edge.from)+"\n→ "+text(edge.to)}))});
  }
  return blocks;
}

function counterpartiesSection(model){
  const all=list(model.counterparties);
  const rows=all.slice(0,LIMITS.counterparties);
  if(!rows.length)return [];
  const blocks=[heading("SEED COUNTERPARTIES"),
    {type:"table",caption:"Direct counterparties of the seed in the returned sample, most linked records first",fontSize:14,
      columns:[{key:"label",label:"Label",width:3},{key:"in",label:"In",width:1,align:"right"},{key:"out",label:"Out",width:1,align:"right"},{key:"total",label:"Records",width:1.6,align:"right"},{key:"assets",label:"Assets",width:3}],
      rows:rows.map(row=>({label:text(row.label)||"—",in:String(num(row.incoming)??0),out:String(num(row.outgoing)??0),total:String(num(row.total)??0),assets:list(row.assets).join(", ")||"—",detail:text(row.address)}))}];
  if(all.length>rows.length)blocks.push(alert("This table lists the first "+rows.length+" of "+all.length+" counterpart(y/ies), by linked record count; the report is capped to stay readable."));
  return blocks;
}

function walletsSection(model){
  const wallets=list(model.wallets);
  if(wallets.length<=1)return [];
  return [heading("ANALYSED WALLETS"),small("Wallets analysed by tracing: the seed (H0) and the wallets the analyst expanded. Each contributes its own sample of recent records."),
    {type:"table",fontSize:14,columns:[{key:"hop",label:"Hop",width:1},{key:"records",label:"Records returned",width:2.4,align:"right"},{key:"sx",label:"Sanctions screening",width:3}],
      rows:wallets.map(w=>({hop:"H"+(num(w.depth)??0),records:String(num(w.records)??0),sx:text(w.screening)||"—",detail:text(w.address)}))}];
}

function transactionRows(model){
  const rows=list(model.transactions);
  const shown=rows.slice(0,LIMITS.transactions);
  return {rows,shown};
}

function transactionsSection(model){
  const {rows,shown}=transactionRows(model);
  const blocks=[heading("TRANSACTION RECORDS")];
  blocks.push(small("All records returned for the analysed wallet(s), newest first, without on-screen filters. Times are UTC. Amounts are in asset units. \"Source wallet\" is the analysed wallet the record belongs to; the same transaction seen from two analysed wallets appears once for each, so amounts must not be summed across rows. \"Counterparty address(es)\" lists every other address the provider attached to the record; for a Bitcoin transaction this can be several input or output addresses at once, not a single sender or recipient."));
  if(!shown.length){blocks.push(noneRecorded("No transaction records were returned for the analysed wallet(s)."));return blocks;}
  blocks.push({type:"table",fontSize:14,columns:[
      {key:"hop",label:"Wallet hop",width:1.7},{key:"time",label:"Time (UTC)",width:3.2},{key:"dir",label:"Dir",width:1.1},{key:"asset",label:"Asset",width:1.8},{key:"amount",label:"Amount",width:2.6,align:"right"},{key:"status",label:"Status",width:1.9}],
    rows:shown.map(row=>{
      const cp=list(row.counterparties).map(item=>text(item)).filter(Boolean);
      const lines=["TX "+text(row.id)];
      if(row.tokenName||row.tokenContract)lines.push("Token: "+(text(row.tokenName)||"—")+(row.tokenContract?" · contract "+text(row.tokenContract):""));
      if(row.functionName)lines.push("Method: "+text(row.functionName));
      lines.push("Counterparty address(es): "+(cp.length?cp.join(", "):"—"));
      if(num(row.depth)>0&&row.sourceWallet)lines.push("Source wallet (H"+(num(row.depth)??0)+"): "+text(row.sourceWallet));
      return {
        hop:"H"+(num(row.depth)??0),time:fmtUtc(row.time),
        dir:{text:text(row.direction)||"—",bold:true,color:row.direction==="IN"?"#0d6b45":row.direction==="OUT"?"#9a4938":"#18252d"},
        asset:text(row.asset)||"—",amount:fmtAmount(row.amount),
        status:{text:text(row.status).toUpperCase()||"—",color:row.status==="failed"?"#8a1f2c":"#18252d"},
        detail:lines.join("\n")
      };
    })});
  if(rows.length>shown.length)blocks.push(alert("This table lists the first "+shown.length+" of "+rows.length+" records (newest first); the report is capped to stay readable."));
  return blocks;
}

function transactionDetailSection(model){
  const fields=list(model.transactionFields).slice(0,LIMITS.txDetailFields);
  const blocks=[heading("TRANSACTION DETAILS")];
  if(!fields.length){blocks.push(noneRecorded("The provider returned no field values for this transaction."));return blocks;}
  blocks.push({type:"table",fontSize:15,columns:[{key:"k",label:"Field",width:3},{key:"v",label:"Value",width:9,mono:true}],
    rows:fields.map(([k,v])=>({k:{text:text(k),bold:true},v:text(v)||"—"}))});
  if(model.subject?.explorerUrl)blocks.push(small("Explorer: "+text(model.subject.explorerUrl)));
  return blocks;
}

function caseSection(model){
  const item=model.caseContext;
  if(!item)return [];
  const blocks=[heading("ACTIVE CASE"),body(text(item.name)+" · "+text(item.status||"OPEN")+(item.chain?" · "+text(item.chain):""))];
  if(item.description)blocks.push(small(text(item.description)));
  const notes=list(item.notes).slice(0,LIMITS.notes);
  if(notes.length){blocks.push(sub("ANALYST NOTES"));for(const note of notes)blocks.push(bullet(text(note)));}
  const paths=list(item.savedPaths);
  if(paths.length){blocks.push(sub("SAVED PATHS"));for(const p of paths)blocks.push(mono(text(p.name)+"\n"+list(p.nodes).map(item=>text(item)).join("\n→ ")));}
  const off=list(item.offchain);
  if(off.length){blocks.push(sub("OFF-CHAIN ENTITIES"));for(const node of off)blocks.push(body(text(node.type)+" · "+text(node.label)+(node.linked?"\nLinked wallet: "+text(node.linked):"")+(node.notes?"\n"+text(node.notes):"")));}
  const links=list(item.crosschain);
  if(links.length){blocks.push(sub("SOURCED CROSS-CHAIN LINKS"));for(const link of links)blocks.push(body(text(link.service||"Cross-chain")+" · "+text(link.confidence)+"\n"+text(link.from)+"\n→ "+text(link.to)+(link.notes?"\n"+text(link.notes):"")));}
  return blocks;
}

function methodSection(model){
  const blocks=[heading("METHOD & LIMITATIONS"),body(LIMITATIONS),small(DISCLAIMER)];
  const sanctionsData=!model.sanctions||model.sanctions.unscreened?"not screened for this analysis":(text(model.sanctions.note)||"list source not reported");
  blocks.push(small("Data provider: "+(text(model.subject?.provider)||"—")+". Sanctions data: "+sanctionsData+". This report was assembled locally in the analyst's browser from the analysis shown on screen."));
  return blocks;
}

// ---------------------------------------------------------------------------
function safeName(value){
  return String(value||"").normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,60);
}

function reportFilename(model){
  const s=model.subject||{};
  const id=String(s.query||"").length>16?String(s.query).slice(0,8)+"-"+String(s.query).slice(-6):String(s.query||"");
  const stamp=new Date(Date.parse(model.generatedAt)||0).toISOString().slice(0,16).replace(/[-:]/g,"").replace("T","-");
  return "CT-Atlas-Crypto-Report-"+[safeName(s.chain),safeName(id),stamp].filter(Boolean).join("-");
}

function build(model){
  const m=model||{};
  const s=m.subject||{};
  const isTransaction=s.kind==="transaction";
  const blocks=[
    ...summarySection(m),
    ...traceConclusionSection(m),
    ...sanctionsSection(m),
    ...observationsSection(m)
  ];
  if(isTransaction){
    blocks.push(...transactionDetailSection(m));
  }else{
    blocks.push(
      ...autoTraceSection(m),
      ...patternsSection(m),
      ...exchangeSection(m),
      ...exposureSection(m),
      ...labelsSection(m),
      ...crossChainSection(m),
      ...watchSection(m),
      ...graphSection(m),
      ...counterpartiesSection(m),
      ...walletsSection(m),
      ...transactionsSection(m)
    );
  }
  blocks.push(...caseSection(m),...methodSection(m));
  return {
    filename:reportFilename(m),
    eyebrow:"CT ATLAS · CRYPTO INTELLIGENCE · FULL ANALYSIS REPORT",
    title:isTransaction?"Transaction report":"Wallet analysis report",
    subject:text(s.query),
    meta:[text(s.chainName||s.chain),text(s.provider),"generated "+fmtUtc(m.generatedAt),m.user?"analyst "+m.user:""].filter(Boolean).join(" · "),
    blocks:[{type:"mono",text:text(s.query)},...blocks],
    footer:"CT Atlas Crypto · full analysis report · "+DISCLAIMER
  };
}

// ---------------------------------------------------------------------------
// The flow graph as a standalone SVG (the page styles it with crypto.css, which an SVG used as an image cannot see).
// ---------------------------------------------------------------------------
const GRAPH_CSS=[
  ".graph-label{fill:#f2f8fb;font:800 10px Arial,sans-serif;stroke:#09141b;stroke-width:3;paint-order:stroke;stroke-linejoin:round}",
  ".graph-sub{fill:#b4c7d1;font:700 8px Arial,sans-serif;stroke:#09141b;stroke-width:2.4;paint-order:stroke;stroke-linejoin:round}",
  ".graph-edge-label{fill:#c4d5dd;font:800 7px Arial,sans-serif;stroke:#0a151c;stroke-width:2.5;paint-order:stroke}",
  ".graph-node{fill:#26404d;stroke:#789baa;stroke-width:1.6}",
  ".graph-node.seed{fill:#167ea4;stroke:#9ee7ff;stroke-width:2.6}",
  ".graph-node.incoming{fill:#17704d;stroke:#6ce2a7}",
  ".graph-node.outgoing{fill:#9a4938;stroke:#ff9a82}",
  ".graph-node.both{fill:#67459c;stroke:#c9a4ff}",
  ".graph-node.unsearchable{stroke-dasharray:3 3;opacity:.78}",
  ".graph-hop-ring{fill:none;stroke-width:2;opacity:.92}",
  ".graph-hop-ring.h1{stroke:#58c6e8}",
  ".graph-hop-ring.h2{stroke:#e0b457;stroke-dasharray:5 3}",
  ".graph-hop-ring.h3{stroke:#e078c5;stroke-dasharray:2 3}",
  ".graph-hop-badge{fill:#0d1820;stroke-width:1.2}",
  ".graph-hop-badge.h1{stroke:#58c6e8}",".graph-hop-badge.h2{stroke:#e0b457}",".graph-hop-badge.h3{stroke:#e078c5}",
  ".graph-hop-text{fill:#f4f8fa;font:900 7px Arial,sans-serif}",
  ".graph-edge{fill:none;stroke:#5d7f8c;stroke-opacity:.8;stroke-linecap:round}",
  ".graph-edge.in{stroke:#46d890}",".graph-edge.out{stroke:#ff8268}",
  ".graph-edge.hop2{stroke-opacity:.72}",".graph-edge.hop3{stroke-opacity:.62}",
  ".graph-edge.offchain-link{stroke:#9aaab3;stroke-width:1.5;stroke-dasharray:6 5;stroke-opacity:.58}",
  ".graph-edge.crosschain-link{stroke:#c084df;stroke-width:2;stroke-dasharray:3 4;stroke-opacity:.82}",
  ".graph-aux-node.offchain-node rect{fill:#20313d;stroke:#9aaab3;stroke-width:1.6;stroke-dasharray:5 3}",
  ".graph-aux-node.crosschain-node polygon{fill:#3b2b57;stroke:#c39beb;stroke-width:1.8}"
].join("");

function standaloneGraphSvg(markup){
  // A label or note can contain arbitrary analyst text; XML 1.0 forbids most C0 control characters, and a single
  // one anywhere in the markup would make the whole standalone document ill-formed, so the image silently fails
  // to load. Stripped here (not just in text(), which only cleans the report's own text blocks) because this
  // string is the page's live SVG markup, not a value that passed through this file's own formatting first.
  let svg=String(markup||"").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"").trim();
  const open=svg.match(/^<svg\b([^>]*)>/i);
  if(!open||!/<\/svg>\s*$/i.test(svg))return "";
  let inner=svg.slice(open[0].length,svg.lastIndexOf("</svg>"));
  // Interactive controls (the "+" expanders) are UI, not data.
  inner=inner.replace(/<g class="graph-expand-control[^"]*"[^>]*>[\s\S]*?<\/g>/g,"");
  const viewBox=(open[1].match(/viewBox="([^"]+)"/i)||[])[1]||"0 0 1000 650";
  const parts=viewBox.split(/\s+/).map(Number);
  const width=parts[2]>0?parts[2]:1000,height=parts[3]>0?parts[3]:650;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="'+viewBox+'">'+
    "<style>"+GRAPH_CSS+"</style>"+
    '<rect x="0" y="0" width="'+width+'" height="'+height+'" fill="#0c1821"/>'+
    inner+"</svg>";
}

const api={build,standaloneGraphSvg,reportFilename,fmtAmount,fmtUtc,LIMITS,DISCLAIMER,EXCHANGE_LIMITATIONS,LABEL_LIMITATIONS,LIMITATIONS,SANCTIONS_NOTE,NOT_SCREENED,GRAPH_CSS};
if(typeof module!=="undefined"&&module.exports)module.exports=api;
root.CTAtlasCryptoReport=api;
})(typeof window!=="undefined"?window:globalThis);
