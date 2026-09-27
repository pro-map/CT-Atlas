const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const R=require("../crypto-report.js");
const read=file=>fs.readFileSync(path.join(__dirname,"..",file),"utf8");

const SEED="bc1q5rkrg0kayvn6pfsh79d5mz23clxw4urtjeqg0k";
const CP1="bc1qehjqlrtjeqg0kayvn6pfsh79d5mz23clxw4urt";
const CP2="bc1q9pz6nclxw4urtjeqg0kayvn6pfsh79d5mz23cl";
const HASH=n=>String(n).padStart(4,"0").repeat(16);

function fixture(overrides={}){
  return {
    generatedAt:"2026-09-26T14:05:33.000Z",user:"alice",
    subject:{kind:"address",chain:"bitcoin",chainName:"Bitcoin",query:SEED,provider:"Blockstream Esplora",explorerUrl:"https://example.invalid/address/"+SEED,generatedAt:"2026-09-26T14:05:00.000Z"},
    balance:{amount:0.4231,asset:"BTC"},
    counts:{wallets:2,maxDepth:2,transactions:3,graphNodes:3,patterns:1,exposure:1},
    observations:["Sample: 3 records returned.","On-chain linkage shows transaction relationships only."],
    samplingNote:"Blockstream Esplora returns a bounded recent sample.",
    sanctions:{
      badge:{cls:"intel-badge high",text:"1 MATCH"},note:"OFAC SDN List (test fixture) · published 2026-09-20 · 1,234 listed addresses",warnings:[],
      hits:[{title:"EXAMPLE ENTITY (FICTIONAL) [SDGT]",role:"counterparty",roleLabel:"COUNTERPARTY",depth:1,currency:"XBT",terrorism:true,address:CP1,context:"Seen with bc1q5rkr…rtjeqg0k: received from 3× · sent to 1× in the returned sample."}],
      noMatchText:"",scope:R.SANCTIONS_NOTE
    },
    filters:{active:["IN","MIN 0.5"]},
    patterns:[{name:"FAN-IN / CONSOLIDATION",severity:"medium",metric:"8 incoming counterparties",detail:"Multiple counterparties converge on "+SEED}],
    exposure:[{hop:1,category:"DARKNET",name:"Test market (fictional)",confidence:"MEDIUM",address:CP2,direct_share:34.04894805}],
    path:{nodes:[SEED,CP2]},
    labels:[{address:CP2,name:"Test market (fictional)",category:"DARKNET",confidence:"MEDIUM",source_type:"OSINT",source_title:"Fictional report",source_url:"https://example.invalid/report",notes:"Fixture"}],
    watchlist:[{label:"Watched seed",address:SEED,enabled:true,thresholdsText:"single transfer ≥ 0.5"}],
    alerts:[{created_at:"2026-09-25T10:00:00.000Z",severity:"HIGH",title:"Large transfer",detail:"0.9 BTC",tx_id:HASH(9)}],
    crossChain:[{service:{category:"BRIDGE",name:"Example bridge",source:"Known service registry"},address:CP1,tx_id:HASH(3),time:"2026-09-20T00:00:00.000Z",source_wallet:SEED}],
    graph:{
      image:"data:image/png;base64,iVBORw0KGgo=",statusLine:"3 visible node(s) · 2 analysed wallet(s) · visible depth H2 · max depth H3 · branch 3",
      nodes:[
        {address:SEED,label:"Seed wallet",depth:0,relation:"both",total:3,incoming:0,outgoing:0,assets:[]},
        {address:CP1,label:"",depth:1,relation:"incoming",total:2,incoming:2,outgoing:0,assets:["BTC"]},
        {address:CP2,label:"Test market (fictional)",depth:1,relation:"outgoing",total:1,incoming:0,outgoing:1,assets:["BTC","USDT"]}
      ],
      edges:[{from:CP1,to:SEED,count:2,assets:["BTC"],hop:1},{from:SEED,to:CP2,count:1,assets:["BTC"],hop:1}]
    },
    counterparties:[{address:CP1,label:"",incoming:2,outgoing:0,total:2,assets:["BTC"]},{address:CP2,label:"Test market (fictional)",incoming:0,outgoing:1,total:1,assets:["BTC"]}],
    wallets:[{address:SEED,depth:0,records:3,screening:"MATCH (see the sanctions section)"},{address:CP1,depth:1,records:14,screening:"no match"}],
    transactions:[
      {id:HASH(1),time:"2026-09-26T12:00:00.000Z",direction:"IN",asset:"BTC",amount:0.00147,status:"confirmed",counterparties:[CP1,CP2],depth:0,sourceWallet:SEED},
      {id:HASH(2),time:"2026-09-25T05:00:00.000Z",direction:"OUT",asset:"USDT",amount:1250.5,status:"pending",counterparties:[CP2],tokenName:"Tether USD",tokenContract:"0xdac17f958d2ee523a2206206994597c13d831ec7",functionName:"transfer",depth:1,sourceWallet:CP1},
      {id:HASH(3),time:"",direction:"SELF",asset:"BTC",amount:"x",status:"failed",counterparties:[],depth:0,sourceWallet:SEED}
    ],
    caseContext:{name:"Test case",status:"OPEN",chain:"bitcoin",description:"Fictional scope",notes:["First note"],savedPaths:[{name:"Path 1",nodes:[SEED,CP2]}],offchain:[{type:"ORGANIZATION",label:"Example org",linked:SEED,notes:"n"}],crosschain:[{service:"Example bridge",confidence:"HIGH",from:"bitcoin: "+SEED,to:"ethereum: 0xabc",notes:""}]},
    ...overrides
  };
}

const textOf=blocks=>blocks.flatMap(block=>{
  if(block.type==="table")return [block.caption||"",...(block.columns||[]).map(c=>c.label),...(block.rows||[]).flatMap(row=>Object.values(row).map(cell=>typeof cell==="object"&&cell?cell.text:cell))];
  return [block.text||block.caption||""];
}).join("\n");
const headings=blocks=>blocks.filter(b=>b.type==="heading").map(b=>b.text);

// ---------------------------------------------------------------- structure

test("an address report has every section, in a readable order, with the right title and file name",()=>{
  const report=R.build(fixture());
  assert.equal(report.title,"Wallet analysis report");
  assert.match(report.eyebrow,/CRYPTO INTELLIGENCE · FULL ANALYSIS REPORT/);
  assert.match(report.filename,/^CT-Atlas-Crypto-Report-bitcoin-bc1q5rkr-jeqg0k-20260926-1405$/);
  assert.match(report.meta,/Bitcoin · Blockstream Esplora · generated 2026-09-26 14:05:33 UTC · analyst alice/);
  assert.deepEqual(headings(report.blocks),[
    "SUMMARY","SANCTIONS-LIST SCREENING","KEY OBSERVATIONS","BEHAVIOURAL PATTERNS","LABELLED EXPOSURE (H1–H3)","SOURCED LABELS",
    "SERVICE / BRIDGE / DEX TOUCHPOINTS","WATCHLIST & MONITORING","TRANSACTION FLOW GRAPH","SEED COUNTERPARTIES","ANALYSED WALLETS",
    "TRANSACTION RECORDS","ACTIVE CASE","METHOD & LIMITATIONS"
  ]);
  assert.equal(report.blocks[0].type,"mono");
  assert.equal(report.blocks[0].text,SEED,"the full subject is printed under the title");
});

test("a transaction lookup gets its own, shorter report",()=>{
  const report=R.build({
    generatedAt:"2026-09-26T14:05:33.000Z",
    subject:{kind:"transaction",chain:"tron",chainName:"TRON",query:HASH(7),provider:"TronGrid",explorerUrl:"https://example.invalid/tx"},
    observations:["On-chain linkage shows transaction relationships only."],
    sanctions:{badge:{text:"NO MATCH"},note:"list",warnings:[],hits:[],noMatchText:"No match among the analysed wallet(s) and 2 screened counterparties. No match does not mean an address is safe.",scope:""},
    transactionFields:[["id",HASH(7)],["contract_type","TransferContract"],["amount_trx","12.5"],["input_addresses","a, b"]],
    counts:{},filters:{active:[]}
  });
  assert.equal(report.title,"Transaction report");
  assert.deepEqual(headings(report.blocks),["SUMMARY","SANCTIONS-LIST SCREENING","KEY OBSERVATIONS","TRANSACTION DETAILS","METHOD & LIMITATIONS"]);
  const all=textOf(report.blocks);
  assert.ok(all.includes("TransferContract")&&all.includes("Explorer: https://example.invalid/tx"));
  assert.ok(!/TRANSACTION RECORDS|FLOW GRAPH/.test(all));
});

test("the summary states what was filtered on screen and that the report ignores those filters, and separately discloses the graph's own display settings",()=>{
  const all=textOf(R.build(fixture()).blocks);
  assert.match(all,/Transaction filters active on screen\nIN · MIN 0\.5 — every section of this report \(including the graph's node and flow tables\) uses ALL records regardless of these filters/);
  assert.match(all,/Graph display settings[^\n]*\n3 visible node\(s\) · 2 analysed wallet\(s\)/);
  const none=textOf(R.build(fixture({filters:{active:[]}})).blocks);
  assert.match(none,/Transaction filters active on screen\nnone — this report already uses all records/);
  const txReport=textOf(R.build({generatedAt:"2026-09-26T14:05:33.000Z",subject:{kind:"transaction",chain:"tron",chainName:"TRON",query:HASH(7),provider:"TronGrid"},counts:{},filters:{active:[]}}).blocks);
  assert.ok(!txReport.includes("Graph display settings"),"a transaction lookup has no graph, so no graph-settings row");
});

// ---------------------------------------------------------------- the data itself

test("every transaction record is listed with its full hash and ALL its counterparties in full",()=>{
  const report=R.build(fixture());
  const table=report.blocks.find(b=>b.type==="table"&&b.rows.length===3&&b.columns.some(c=>c.key==="amount"));
  assert.ok(table,"transactions table");
  const first=table.rows[0];
  assert.ok(first.detail.includes("TX "+HASH(1)));
  assert.ok(first.detail.includes(CP1)&&first.detail.includes(CP2),"both counterparties, never truncated or cut to a first character");
  assert.match(first.detail,/Counterparty address\(es\): /,"neutral wording: a Bitcoin row can carry several input or output addresses at once, not a single sender/recipient");
  assert.ok(!first.detail.includes("Source wallet"),"H0 records do not repeat the seed on every line");
  const second=table.rows[1];
  assert.match(second.detail,/Token: Tether USD · contract 0xdac17f958d2ee523a2206206994597c13d831ec7/);
  assert.match(second.detail,/Method: transfer/);
  assert.match(second.detail,/Counterparty address\(es\): /);
  assert.ok(second.detail.includes("Source wallet (H1): "+CP1));
  const third=table.rows[2];
  assert.equal(third.time,"Pending / unknown");
  assert.equal(third.amount,"—","a non-numeric amount is a dash, never NaN");
  assert.ok(!/NaN|undefined|null|\[object/.test(textOf(report.blocks)),"no leaked JavaScript values");
});

test("amounts and times are formatted the same way everywhere (UTC, en-US, no locale surprises)",()=>{
  assert.equal(R.fmtUtc("2026-09-26T14:05:33.000Z"),"2026-09-26 14:05:33 UTC");
  assert.equal(R.fmtUtc(""),"Pending / unknown");
  assert.equal(R.fmtUtc("not a date"),"not a date");
  assert.equal(R.fmtAmount(0.00012345678),"0.00012346");
  assert.equal(R.fmtAmount(1234567.891),"1,234,567.89");
  assert.equal(R.fmtAmount(0),"0");
  assert.equal(R.fmtAmount("abc"),"—");
  assert.equal(R.fmtAmount(null),"—");
});

test("a very long record list is capped, and the report says so",()=>{
  const rows=Array.from({length:R.LIMITS.transactions+25},(_,i)=>({id:HASH(i),time:"2026-09-26T12:00:00.000Z",direction:"IN",asset:"BTC",amount:1,status:"confirmed",counterparties:[CP1],depth:0,sourceWallet:SEED}));
  const report=R.build(fixture({transactions:rows}));
  const table=report.blocks.find(b=>b.type==="table"&&b.columns.some(c=>c.key==="amount"));
  assert.equal(table.rows.length,R.LIMITS.transactions);
  assert.match(textOf(report.blocks),new RegExp("first "+R.LIMITS.transactions+" of "+(R.LIMITS.transactions+25)+" records"));
});

test("silently-truncated lists (patterns, touchpoints, counterparties) get a 'first N of M' notice, same as transactions",()=>{
  const patterns=Array.from({length:R.LIMITS.patterns+3},(_,i)=>({name:"PATTERN "+i,severity:"low",metric:"m",detail:"d"}));
  const crossChain=Array.from({length:R.LIMITS.crosschain+4},(_,i)=>({service:{category:"DEX",name:"S"+i},address:CP1,tx_id:HASH(i),time:"2026-09-20T00:00:00.000Z",source_wallet:SEED}));
  const counterparties=Array.from({length:R.LIMITS.counterparties+5},(_,i)=>({address:CP1+i,label:"",incoming:1,outgoing:0,total:1,assets:["BTC"]}));
  const report=R.build(fixture({patterns,crossChain,counterparties}));
  const all=textOf(report.blocks);
  assert.match(all,new RegExp("first "+R.LIMITS.patterns+" of "+(R.LIMITS.patterns+3)+" pattern\\(s\\)"));
  assert.match(all,new RegExp("first "+R.LIMITS.crosschain+" of "+(R.LIMITS.crosschain+4)+" touchpoint\\(s\\)"));
  assert.match(all,new RegExp("first "+R.LIMITS.counterparties+" of "+(R.LIMITS.counterparties+5)+" counterpart"));
  // and no false notice when nothing was cut
  const short=textOf(R.build(fixture()).blocks);
  assert.ok(!/pattern\(s\) found; the report is capped/.test(short));
  assert.ok(!/touchpoint\(s\) found; the report is capped/.test(short));
});

test("the seed's own row in the graph node table does not show a confusing 0/0/0, and the table explains what Records/In/Out mean",()=>{
  const report=R.build(fixture());
  const table=report.blocks.find(b=>b.type==="table"&&b.columns.some(c=>c.key==="in")&&b.columns.some(c=>c.key==="records")&&b.columns.length===6);
  const seedRow=table.rows.find(row=>row.hop==="H0");
  assert.deepEqual([seedRow.records,seedRow.in,seedRow.out],["—","—","—"]);
  assert.match(seedRow.detail,/own record count is in the summary/);
  const other=table.rows.find(row=>row.hop!=="H0");
  assert.notEqual(other.records,"—");
  assert.match(textOf(report.blocks),/Records \/ In \/ Out count each node's own linked transactions with other visible nodes/);
});

test("no table has a column called 'detail' (that name is the row's full-width line)",()=>{
  const report=R.build(fixture());
  for(const table of report.blocks.filter(b=>b.type==="table"))assert.ok(!table.columns.some(c=>c.key==="detail"),table.caption||"table");
});

test("direct share is shown with one decimal, not as a raw float",()=>{
  const table=R.build(fixture()).blocks.find(b=>b.type==="table"&&b.columns.some(c=>c.key==="share"));
  assert.equal(table.rows[0].share,"34%");
});

test("empty analyses never crash and say plainly that nothing was found (scoped to the sample)",()=>{
  const report=R.build({generatedAt:"2026-09-26T14:05:33.000Z",subject:{kind:"address",chain:"ethereum",chainName:"Ethereum",query:"0x"+"ab".repeat(20),provider:"Etherscan API V2"},counts:{}});
  const all=textOf(report.blocks);
  assert.match(all,/No configured behavioural pattern crossed its heuristic threshold in the analysed sample\./);
  assert.match(all,/No path from the seed to a currently labelled sensitive category was observed within H1–H3 in the analysed sample\./);
  assert.match(all,/No analyst label applies/);
  assert.match(all,/No transaction records were returned/);
  assert.ok(!/NaN|undefined|\[object/.test(all));
});

// ---------------------------------------------------------------- wording

test("NOT SCREENED is never presented as clean",()=>{
  const report=R.build(fixture({sanctions:{unscreened:true,badge:{text:"NOT SCREENED"},note:"",hits:[],noMatchText:"",scope:"",
    warnings:["Sanctions screening was NOT performed for this analysis (list unavailable). The absence of a match below must not be read as a clean result."]}}));
  const all=textOf(report.blocks);
  assert.match(all,/NOT SCREENED/);
  assert.match(all,/must not be read as a clean result/);
  const section=all.split("SANCTIONS-LIST SCREENING")[1].split("KEY OBSERVATIONS")[0];
  assert.ok(!/\bNO MATCH\b|No match among/.test(section),"no 'no match' result in the sanctions section");
  assert.match(section,/see the coverage warning\(s\) below before treating this as clean/,"the bare badge line itself also refuses to look clean");
  assert.match(all,/Sanctions data: not screened for this analysis\./,"METHOD & LIMITATIONS must not repeat the (unscreened) card note as if it were the list actually used");
  const noSx=R.build(fixture({sanctions:null}));
  assert.match(textOf(noSx.blocks),/NOT performed/);
  assert.match(textOf(noSx.blocks),/Sanctions data: not screened for this analysis\./);
});

test("a plain 'no match' with a partial or stale coverage warning is qualified, not stated as a clean bill",()=>{
  const report=R.build(fixture({sanctions:{unscreened:false,badge:{text:"NO MATCH"},note:"list",hits:[],noMatchText:"",scope:"",
    warnings:["1 of 3 analysed wallet(s) could not be screened; results below are partial."]}}));
  const section=textOf(report.blocks).split("SANCTIONS-LIST SCREENING")[1].split("KEY OBSERVATIONS")[0];
  assert.match(section,/Result: NO MATCH — see the coverage warning\(s\) below before treating this as clean\./);
  assert.match(section,/could not be screened; results below are partial/);
  const clean=R.build(fixture({sanctions:{unscreened:false,badge:{text:"NO MATCH"},note:"list",hits:[],noMatchText:"No match among the analysed wallet(s) and 9 screened counterparties.",scope:"",warnings:[]}}));
  const cleanSection=textOf(clean.blocks).split("SANCTIONS-LIST SCREENING")[1].split("KEY OBSERVATIONS")[0];
  assert.match(cleanSection,/Result: NO MATCH\./);
  assert.ok(!/coverage warning/.test(cleanSection));
});

test("a sanctions match is described as an address-string match, never as ownership or a determination",()=>{
  const report=R.build(fixture());
  const section=textOf(report.blocks).split("SANCTIONS-LIST SCREENING")[1].split("KEY OBSERVATIONS")[0];
  assert.match(section,/1 MATCH — listed address\(es\) found among the analysed wallet\(s\) and their counterparties/);
  assert.match(section,/TERRORISM PROGRAM · COUNTERPARTY · H1 · XBT/);
  assert.match(section,/not a compliance determination/);
  assert.match(section,/No match does NOT mean an address is safe/);
  assert.ok(!/(owned|controlled|operated) by|belongs to|is a terrorist|criminal/i.test(section));
});

test("over-claiming words appear only inside the disclaimers that deny them",()=>{
  const report=R.build(fixture());
  const risky=/ownership|terrorist financing|criminality|identity attribution|proof of control|custody/i;
  const allowed=new Set([R.DISCLAIMER,R.LIMITATIONS,R.SANCTIONS_NOTE]);
  for(const block of report.blocks){
    const value=block.type==="table"?"":String(block.text||"");
    if(risky.test(value)){
      assert.ok([...allowed].some(text=>value.includes(text)||text.includes(value))||value.includes("HOPS")||/not ownership probability/.test(value),"unexpected claim: "+value.slice(0,120));
    }
  }
  assert.ok(risky.test(report.footer)&&report.footer.includes(R.DISCLAIMER),"the footer repeats the disclaimer");
  assert.match(textOf(report.blocks),/Heuristics describe observed transaction behaviour — not criminal intent/);
  assert.match(textOf(report.blocks),/not a verified fact/);
});

test("the graph section explains the hops and that size means record count, and survives a missing image",()=>{
  const withImage=R.build(fixture());
  const image=withImage.blocks.find(b=>b.type==="image");
  assert.ok(image&&image.src.startsWith("data:image/png"));
  assert.equal(image.maxHeight,640);
  assert.match(image.caption,/as displayed on screen/);
  assert.match(textOf(withImage.blocks),/H0 is the seed wallet, H1 its direct counterparties/);
  assert.match(textOf(withImage.blocks),/not ownership probability/);
  const noImage=R.build(fixture({graph:{...fixture().graph,image:""}}));
  assert.ok(!noImage.blocks.some(b=>b.type==="image"));
  assert.match(textOf(noImage.blocks),/graph image could not be produced/);
});

test("hostile or oversized input is contained",()=>{
  const evil="A\u0000B\u0007C"+"x".repeat(50000);
  const report=R.build(fixture({observations:[evil],labels:[{address:evil,name:evil,category:"OTHER",confidence:"LOW"}]}));
  const all=textOf(report.blocks);
  assert.ok(!/[\u0000-\u0008]/.test(all),"control characters are stripped");
  assert.ok(all.length<400000);
  const filename=R.reportFilename(fixture({subject:{...fixture().subject,query:"../../etc/passwd é\n",chain:"bit coin"}}));
  assert.match(filename,/^[A-Za-z0-9-]+$/);
});

// ---------------------------------------------------------------- second-review fixes

test("SANCTIONS-LIST SCREENING styling still uses stroke-opacity for hop2/hop3/off-chain/cross-chain edges, matching crypto.css exactly (a plain 'opacity' also fades the arrowhead, unlike on screen)",()=>{
  const css=read("crypto.css");
  for(const rule of [
    /\.graph-edge\.hop2\{stroke-opacity:\.72\}/,
    /\.graph-edge\.hop3\{stroke-opacity:\.62\}/,
    /stroke-opacity:\.58;/,   // .offchain-link
    /stroke-opacity:\.82;/    // .crosschain-link
  ])assert.match(css,rule,"crypto.css no longer has this exact rule: update GRAPH_CSS to match");
  for(const rule of [".graph-edge.hop2{stroke-opacity:.72}",".graph-edge.hop3{stroke-opacity:.62}","stroke-opacity:.58","stroke-opacity:.82"]){
    assert.ok(R.GRAPH_CSS.includes(rule),rule+" must be stroke-opacity, not opacity, to match the screen exactly");
  }
  assert.ok(!/\.graph-edge\.(hop2|hop3|offchain-link|crosschain-link)\{[^}]*[^-]opacity:/.test(R.GRAPH_CSS),"no plain 'opacity' on these edge classes");
});

test("a control character anywhere in the live graph markup (a hostile or corrupted label) is stripped before the SVG is serialised, so the image is never silently dropped for that reason",()=>{
  const poisoned=SVG.replace("bc1q…","bc1q\u0007\u000b\u0000hostile");
  const out=R.standaloneGraphSvg(poisoned);
  assert.ok(out,"still produces an SVG");
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(out),"no C0 control character reaches the output");
  assert.ok(out.includes("bc1qhostile"));
  const {spawnSync}=require("node:child_process");
  const check=spawnSync("python3",["-c","import sys,xml.dom.minidom as m;m.parseString(sys.stdin.read().encode('utf-8'));print('ok')"],{input:out,encoding:"utf8"});
  if(!(check.error||(check.status!==0&&/No module|not found/i.test(check.stderr||""))))assert.equal(check.status,0,check.stderr);
});

// ---------------------------------------------------------------- the graph image

const SVG='<svg id="flowGraph" viewBox="0 0 1000 650" role="img" aria-label="Transaction flow graph"><defs><marker id="arrowIn"><path d="M0,0 L7,3.5 L0,7 Z"/></marker></defs>'+
  '<g class="graph-edge-group"><line class="graph-edge trace-link out" x1="1" y1="2" x2="3" y2="4" marker-end="url(#arrowOut)"></line></g>'+
  '<g class="graph-counterparty" transform="translate(10 20)"><circle class="graph-node incoming" r="14"></circle><text class="graph-label">bc1q…</text>'+
  '<g class="graph-expand-control loading" transform="translate(5 -5)"><circle r="11"></circle><text y="5">+</text></g></g>'+
  '<g class="graph-expand-control expanded"><circle r="11"></circle><text y="5">✓</text></g></svg>';

test("the graph SVG becomes standalone: namespace, size, its own styles and background; interactive controls removed",()=>{
  const out=R.standaloneGraphSvg(SVG);
  assert.match(out,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1000" height="650" viewBox="0 0 1000 650">/);
  assert.ok(out.includes("<style>")&&out.includes(".graph-node.seed{fill:#167ea4")&&out.includes(".graph-edge.in{stroke:#46d890}"));
  assert.match(out,/<rect x="0" y="0" width="1000" height="650" fill="#0c1821"\/>/);
  assert.ok(!out.includes("graph-expand-control"),"the + / ✓ expanders are UI, not data");
  assert.ok(out.includes('<marker id="arrowIn">')&&out.includes("graph-edge-group")&&out.includes("graph-label"));
  assert.ok(out.includes("bc1q…"),"Unicode survives");
  assert.ok(out.endsWith("</svg>"));
});

test("things that are not the graph SVG produce nothing",()=>{
  for(const bad of ["","<div></div>","<svg>unterminated","null",undefined,null,42])assert.equal(R.standaloneGraphSvg(bad),"");
});

test("the standalone SVG is well-formed XML (PyMuPDF/expat parse it) and every class the page draws has a rule",()=>{
  const out=R.standaloneGraphSvg(SVG);
  const {spawnSync}=require("node:child_process");
  const check=spawnSync("python3",["-c","import sys,xml.dom.minidom as m;m.parseString(sys.stdin.read().encode('utf-8'));print('ok')"],{input:out,encoding:"utf8"});
  if(check.error||check.status!==0&&/No module|not found/i.test(check.stderr||""))return;
  assert.equal(check.status,0,check.stderr);
  const source=read("crypto.js");
  const drawn=new Set([...source.matchAll(/class="(graph-[a-z-]+)/g)].map(m=>m[1]));
  for(const name of ["graph-node","graph-label","graph-sub","graph-edge","graph-hop-ring","graph-hop-badge","graph-hop-text","graph-edge-label"]){
    assert.ok(drawn.has(name),name+" is drawn by crypto.js");
    assert.ok(R.GRAPH_CSS.includes("."+name),name+" is styled in the standalone SVG");
  }
});

// ---------------------------------------------------------------- with the real PDF engine

function pdfHarness(){
  const pages=[];
  let captured=null;
  const document={body:{appendChild(){}},fonts:{ready:Promise.resolve()},
    createElement(tag){
      if(tag==="canvas"){
        const page={texts:[]};pages.push(page);
        const ctx={font:"",textAlign:"left",direction:"ltr",fillStyle:"",strokeStyle:"",lineWidth:1,beginPath(){},moveTo(){},lineTo(){},stroke(){},fillRect(){},drawImage(){},
          fillText(text,x,y){page.texts.push({text,font:this.font});},measureText(v){return {width:String(v).length*(/Courier/.test(this.font)?8:7)};}};
        return {width:0,height:0,getContext(){return ctx;},toDataURL(){return "data:image/jpeg;base64,/9j/2Q==";}};
      }
      return {style:{},remove(){},click(){}};
    }};
  const sandbox={window:{},document,URL:{createObjectURL(blob){captured=blob;return "blob:x";},revokeObjectURL(){}},Blob,TextEncoder,Uint8Array,atob,
    requestAnimationFrame(cb){cb();},setTimeout(cb){cb();},Element:class Element{},
    Image:class{set src(_){setTimeout(()=>{},0);this.naturalWidth=2000;this.naturalHeight=1300;queueMicrotask(()=>this.onload&&this.onload());}}};
  vm.runInNewContext(read("pdf-export.js"),sandbox,{filename:"pdf-export.js"});
  return {pages,async run(report){const result=await sandbox.window.CTAtlasPdf.download(report);return {result,bytes:Buffer.from(await captured.arrayBuffer())};}};
}

test("the report renders through the PDF engine: every address and hash is drawn whole and lands in the selectable text layer",async()=>{
  const h=pdfHarness();
  const {result,bytes}=await h.run(R.build(fixture()));
  assert.ok(result.pages>=3);
  const drawn=h.pages.flatMap(p=>p.texts.map(t=>t.text)).join("\n");
  for(const needle of [SEED,CP1,CP2,HASH(1),HASH(2),"SANCTIONS-LIST SCREENING","TRANSACTION RECORDS","EXAMPLE ENTITY (FICTIONAL) [SDGT]"])assert.ok(drawn.includes(needle),needle+" is drawn");
  const pdf=bytes.toString("latin1");
  const layer=[...pdf.matchAll(/<([0-9a-f]+)> Tj/g)].map(m=>Buffer.from(m[1],"hex").toString("latin1")).join("\n");
  for(const needle of [SEED,CP1,CP2,HASH(1),HASH(2)])assert.ok(layer.includes(needle),needle+" can be selected and searched in the PDF");
});

test("a transaction-lookup report also renders",async()=>{
  const h=pdfHarness();
  const {result}=await h.run(R.build({generatedAt:"2026-09-26T14:05:33.000Z",subject:{kind:"transaction",chain:"bitcoin",chainName:"Bitcoin",query:HASH(4),provider:"Blockstream Esplora"},
    sanctions:{badge:{text:"NO MATCH"},warnings:[],hits:[],noMatchText:"None.",scope:""},transactionFields:[["id",HASH(4)],["fee","0.00001"]],counts:{}}));
  assert.ok(result.pages>=1);
});
