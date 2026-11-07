const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const Report=require("../crypto-report.js");

// The real crypto.js in a vm, with a fake DOM and a scripted fetch.
function harness({respond}={}){
  const nodes=new Map();
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:"",innerHTML:"",textContent:"",className:"",hidden:false,disabled:false,dataset:{},options:[],
      classList:{toggle(){},add(){},remove(){},contains(){return false;}},querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},addEventListener(){},focus(){}});
    return nodes.get(id);
  };
  el("filterDirection").value="all";el("filterAsset").value="all";el("filterType").value="all";el("filterStatus").value="all";
  el("filterGraphMinLinks").value="1";el("filterGraphNodes").value="80";el("traceMaxDepth").value="6";el("traceBranch").value="8";
  const calls=[];
  const context=vm.createContext({
    console:{warn(){},log(){}},
    document:{readyState:"loading",addEventListener(){},getElementById:el,body:{classList:{add(){},remove(){}}}},
    sessionStorage:{getItem:()=>"analyst"},
    window:{location:{href:"https://example.invalid/crypto.html",search:""},CTAtlasCryptoReport:Report},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,1)),clearTimeout,URL,URLSearchParams,
    fetch:async(url,options={})=>{
      const call={url:String(url),method:options.method||"GET",body:options.body?JSON.parse(options.body):null};
      calls.push(call);
      const result=await (respond||(()=>({status:200,json:{}})))(call,calls);
      const status=result.status??200;
      return {status,ok:status>=200&&status<300,json:async()=>result.json??{}};
    }
  });
  const source=fs.readFileSync("crypto.js","utf8").replace(/\}\)\(\);\s*$/,`
    globalThis.api={
      loadCryptoWorkspace,saveCryptoWorkspace,scheduleWorkspaceSave,syncWorkspaceControls,mergeWorkspace,
      live(){return cryptoWorkspace;},
      state(){return {loaded:workspaceLoaded,revision:workspaceRevision};},
      seed(payload){lastPayload=payload;resetTraceState(payload);currentNetworkModel=buildNetworkModel(payload);},
      setLabels(labels){cryptoWorkspace.labels=labels;},
      addTrace(address,payload,depth){const key=traceKey(address,lastPayload.chain);tracePayloads.set(key,{key,address,payload,depth});traceExpanded.add(key);currentNetworkModel=buildNetworkModel(lastPayload);},
      expandTraceNode,autoTrace,clearTrace,exposureFindings,renderExposure,buildNetworkModel,allTraceRows,renderTable,neighborStats,
      inReportMode(fn){return withoutTransactionFilters(fn);},
      reportModel:()=>collectReportModel(),
      setPayloadOnly(payload){lastPayload=payload;},
      detectPatterns,renderPatterns,riskView,renderRisk,combineRisk,checkOneHop,oneHopCandidates,peelChainFinding,oneHopFinding,sanctionsView,
      riskOverlays,snapshotFromPayload,paintGraphFrame,render,exportCasePdf,
      renderWatchlist,toggleWatch,deleteWatch,acknowledgeAlert,renderAlerts,monitorSeed,checkMonitored,
      selectCase(id){activeCaseId=id;},
      traceKeys(){return [...tracePayloads.keys()];},
      traceRun(){return autoTraceRun;},
      isAutoTraceActive(){return autoTraceActive;}
    };
  })();`);
  vm.runInContext(source,context);
  context.api.workspace=()=>plain(context.api.live());
  return {api:context.api,calls,el,context};
}

// Values built inside the vm have that realm's prototypes; assertions compare plain copies.
const plain=value=>JSON.parse(JSON.stringify(value));

const emptyWorkspace=(extra={})=>({version:"crypto-workspace-v1",labels:[],watchlist:[],cases:[],alerts:[],...extra});
const posts=calls=>calls.filter(call=>call.method==="POST"&&call.url.endsWith("/crypto-workspace"));

// ---------------------------------------------------------------- failed-load save guard

test("a failed workspace load refuses every save and switches the controls off",async()=>{
  const h=harness({respond:()=>({status:503,json:{error:"down"}})});
  assert.equal(await h.api.loadCryptoWorkspace(),false);
  h.api.live().cases.push({id:"c1",name:"Would wipe the server copy"});
  assert.equal(await h.api.saveCryptoWorkspace(),false);
  assert.equal(posts(h.calls).length,0,"nothing may reach the server, which stores a save whole");
  assert.equal(h.el("caseNewButton").disabled,true);
  assert.equal(h.el("monitorSeedButton").disabled,true);
  assert.equal(h.el("workspaceLoadNotice").hidden,false);
});

test("a 200 that carries no workspace is a failed load, not an empty workspace",async()=>{
  const h=harness({respond:()=>({status:200,json:{ok:true}})});
  assert.equal(await h.api.loadCryptoWorkspace(),false);
  assert.equal(h.api.state().loaded,false);
});

test("controls stay off until a load succeeds, and a retry recovers",async()=>{
  let up=false;
  const h=harness({respond:call=>call.method==="GET"
    ?(up?{json:{ok:true,workspace:emptyWorkspace({labels:[{id:"l1"}]}),revision:4}}:{status:503})
    :{json:{ok:true,workspace:emptyWorkspace({labels:[{id:"l1"}]}),revision:5}}});
  h.api.syncWorkspaceControls();
  assert.equal(h.el("labelSaveButton").disabled,true,"off before the first load finishes");
  assert.equal(h.el("workspaceLoadNotice").hidden,true,"no failure to report yet");
  await h.api.loadCryptoWorkspace();
  up=true;
  assert.equal(await h.api.loadCryptoWorkspace(),true);
  assert.equal(h.el("labelSaveButton").disabled,false);
  assert.equal(h.el("workspaceLoadNotice").hidden,true);
  assert.equal(h.api.workspace().labels.length,1);
  assert.equal(await h.api.saveCryptoWorkspace(),true);
});

// ---------------------------------------------------------------- revision and 409

test("a save sends the revision it loaded and keeps the one the server returns",async()=>{
  const h=harness({respond:call=>call.method==="GET"
    ?{json:{ok:true,workspace:emptyWorkspace(),revision:7}}
    :{json:{ok:true,workspace:call.body.workspace,revision:8}}});
  await h.api.loadCryptoWorkspace();
  await h.api.saveCryptoWorkspace();
  assert.equal(posts(h.calls)[0].body.revision,7);
  assert.equal(h.api.state().revision,8);
});

test("a revision may also arrive inside the workspace object",async()=>{
  const h=harness({respond:()=>({json:{ok:true,workspace:emptyWorkspace({revision:3})}})});
  await h.api.loadCryptoWorkspace();
  assert.equal(h.api.state().revision,3);
});

test("a Worker without revisions keeps working: no revision, no 409, the save still lands",async()=>{
  const h=harness({respond:call=>({json:{ok:true,workspace:call.method==="GET"?emptyWorkspace():call.body.workspace}})});
  await h.api.loadCryptoWorkspace();
  h.api.live().labels.unshift({id:"l1",name:"New"});
  assert.equal(await h.api.saveCryptoWorkspace(),true);
  assert.equal(posts(h.calls)[0].body.revision,null);
  assert.equal(h.api.workspace().labels.length,1);
});

test("409: this page's edits are replayed on the newer server copy, which keeps its alerts and snapshots",async()=>{
  const baseCase={id:"c1",name:"Case",status:"OPEN",seed_addresses:["a"],notes:[{id:"n1",text:"old"}],saved_paths:[],offchain_nodes:[],crosschain_links:[]};
  const watch={id:"w1",chain:"bitcoin",address:"x",enabled:true,last_snapshot:{checked_at:"2026-11-01T00:00:00Z",newest_tx_id:"old"}};
  const start=emptyWorkspace({labels:[{id:"keep",name:"Keep"},{id:"gone",name:"Deleted here"}],watchlist:[watch],cases:[baseCase]});
  // What the scheduled monitor and another tab did meanwhile.
  const newer=emptyWorkspace({
    labels:[{id:"keep",name:"Keep"},{id:"gone",name:"Deleted here"},{id:"tab2",name:"Added in another tab"}],
    watchlist:[{...watch,last_snapshot:{checked_at:"2026-11-02T00:00:00Z",newest_tx_id:"monitor"}}],
    cases:[{...baseCase,notes:[{id:"n2",text:"from another tab"},{id:"n1",text:"old"}]}],
    alerts:[{id:"a1",type:"SANCTIONS",title:"Raised by the monitor",acknowledged:false}]
  });
  const h=harness({respond:(call,calls)=>{
    if(call.method==="GET")return {json:{ok:true,workspace:start,revision:1}};
    if(posts(calls).length===1)return {status:409,json:{error:"stale",workspace:newer,revision:2}};
    return {json:{ok:true,workspace:call.body.workspace,revision:3}};
  }});
  await h.api.loadCryptoWorkspace();
  const local=h.api.live();
  local.labels=local.labels.filter(item=>item.id!=="gone");
  local.labels.unshift({id:"mine",name:"Added here"});
  local.cases[0].notes.unshift({id:"n3",text:"from this tab"});
  local.watchlist[0].enabled=false;

  assert.equal(await h.api.saveCryptoWorkspace(),true);
  const sent=posts(h.calls);
  assert.equal(sent.length,2);
  assert.equal(sent[0].body.revision,1);
  assert.equal(sent[1].body.revision,2,"the second attempt uses the revision the 409 returned");
  const final=sent[1].body.workspace;
  assert.deepEqual(final.labels.map(item=>item.id),["mine","keep","tab2"],"added here, kept, and the other tab's; the one deleted here stays deleted");
  assert.deepEqual(final.cases[0].notes.map(item=>item.id),["n3","n2","n1"],"both tabs' notes on the same case survive");
  assert.equal(final.alerts.length,1,"the page's older copy must not drop a monitor alert");
  assert.equal(final.watchlist[0].enabled,false,"the pause made here is kept");
  assert.equal(final.watchlist[0].last_snapshot.newest_tx_id,"monitor","the monitor's newer baseline is not rolled back");
  assert.equal(h.api.state().revision,3);
});

test("409 without a workspace in the body falls back to a fresh read",async()=>{
  const newer=emptyWorkspace({labels:[{id:"tab2"}]});
  let reads=0;
  const h=harness({respond:(call,calls)=>{
    if(call.method==="GET")return {json:{ok:true,workspace:++reads===1?emptyWorkspace():newer,revision:reads}};
    if(posts(calls).length===1)return {status:409,json:{error:"stale"}};
    return {json:{ok:true,workspace:call.body.workspace}};
  }});
  await h.api.loadCryptoWorkspace();
  h.api.live().labels.unshift({id:"mine"});
  assert.equal(await h.api.saveCryptoWorkspace(),true);
  assert.deepEqual(posts(h.calls)[1].body.workspace.labels.map(item=>item.id),["mine","tab2"]);
  assert.equal(posts(h.calls)[1].body.revision,2);
});

test("a save that stays stale gives up with a warning and keeps the edits on the page",async()=>{
  const h=harness({respond:call=>call.method==="GET"
    ?{json:{ok:true,workspace:emptyWorkspace(),revision:1}}
    :{status:409,json:{workspace:emptyWorkspace(),revision:2}}});
  await h.api.loadCryptoWorkspace();
  h.api.live().labels.unshift({id:"mine"});
  assert.equal(await h.api.saveCryptoWorkspace(),false);
  assert.equal(posts(h.calls).length,3,"bounded retries");
  assert.equal(h.api.workspace().labels[0].id,"mine");
  assert.match(h.el("cryptoStatus").textContent,/still on this page/);
});

test("an edit made while a save is in flight is neither lost nor overwritten by the response",async()=>{
  let release;
  const h=harness({respond:(call,calls)=>{
    if(call.method==="GET")return {json:{ok:true,workspace:emptyWorkspace(),revision:1}};
    if(posts(calls).length===1)return new Promise(resolve=>{release=()=>resolve({json:{ok:true,workspace:call.body.workspace,revision:2}});});
    return {json:{ok:true,workspace:call.body.workspace,revision:3}};
  }});
  await h.api.loadCryptoWorkspace();
  h.api.live().labels.unshift({id:"first"});
  const saving=h.api.saveCryptoWorkspace();
  await new Promise(resolve=>setImmediate(resolve));
  h.api.live().labels.unshift({id:"second"});
  assert.equal(await h.api.saveCryptoWorkspace(),false,"a second save waits for the first instead of racing it");
  release();
  assert.equal(await saving,true);
  assert.deepEqual(h.api.workspace().labels.map(item=>item.id),["second","first"]);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(posts(h.calls).length,2,"the queued save ran");
  assert.deepEqual(posts(h.calls)[1].body.workspace.labels.map(item=>item.id),["second","first"]);
  assert.equal(posts(h.calls)[1].body.revision,2);
});

test("the merge keeps an acknowledgement from either side and takes the alert's content from the server",()=>{
  const h=harness();
  const alert={id:"a",title:"t",acknowledged:false};
  const merged=h.api.mergeWorkspace(
    emptyWorkspace({alerts:[alert]}),
    emptyWorkspace({alerts:[{...alert,acknowledged:true}]}),
    emptyWorkspace({alerts:[{...alert,title:"server"}]})
  );
  assert.deepEqual(JSON.parse(JSON.stringify(merged.alerts)),[{id:"a",title:"server",acknowledged:true}]);
});

// ---------------------------------------------------------------- trace generation guard

const t0=Date.parse("2026-11-01T00:00:00Z");
const iso=minutes=>new Date(t0+minutes*60000).toISOString();
const addr=i=>"0x"+String(i).padStart(40,"0");
const tx=(id,minutes,direction,asset,amount,cp,extra={})=>({id,time:iso(minutes),confirmed:true,direction,asset,amount,counterparties:[cp],...extra});
const wallet=(query,transactions,extra={})=>({kind:"address",chain:"ethereum",query,transactions,...extra});
const analysis=(calls,matcher)=>calls.filter(call=>call.url.endsWith("/crypto-analyze")&&(!matcher||matcher(call)));

test("a trace response that arrives after a new search stays out of the new graph",async()=>{
  let release;
  const h=harness({respond:call=>new Promise(resolve=>{release=()=>resolve({json:wallet(call.body.query,[tx("old",0,"OUT","ETH",1,addr(3))])});})});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))]));
  const pending=h.api.expandTraceNode(addr(2),{quiet:true});
  await new Promise(resolve=>setImmediate(resolve));
  h.api.seed(wallet(addr(7),[tx("b",0,"OUT","ETH",1,addr(8))]));
  release();
  assert.equal(await pending,false);
  assert.deepEqual(plain(h.api.traceKeys()),[addr(7)]);
});

test("a failed trace response from an older search is dropped without an error",async()=>{
  let fail;
  const h=harness({respond:()=>new Promise(resolve=>{fail=()=>resolve({status:503,json:{error:"down"}});})});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))]));
  const pending=h.api.expandTraceNode(addr(2));
  await new Promise(resolve=>setImmediate(resolve));
  h.api.seed(wallet(addr(7),[tx("b",0,"OUT","ETH",1,addr(8))]));
  fail();
  assert.equal(await pending,false);
  assert.doesNotMatch(h.el("cryptoTraceStatus").textContent,/down/);
});

test("an automatic trace stops when the search changes, and leaves no state behind",async()=>{
  const queue=[];
  const h=harness({respond:call=>new Promise(resolve=>queue.push(()=>resolve({json:wallet(call.body.query,[tx("n"+call.body.query,1,"OUT","ETH",1,addr(90))])})))});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2)),tx("b",0,"OUT","ETH",1,addr(3))]));
  const running=h.api.autoTrace();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.api.isAutoTraceActive(),true);
  h.api.seed(wallet(addr(7),[tx("c",0,"OUT","ETH",1,addr(8))]));
  assert.equal(h.api.isAutoTraceActive(),false,"the new graph is not treated as being auto-traced");
  assert.equal(h.el("cryptoAutoTrace").disabled,false,"AUTO TRACE is available again for the new seed");
  queue.shift()();
  await running;
  assert.equal(analysis(h.calls).length,1,"no further wallet is requested for the old seed");
  assert.deepEqual(plain(h.api.traceKeys()),[addr(7)]);
  assert.equal(h.api.traceRun(),null);
});

test("CLEAR TRACE also drops what was in flight",async()=>{
  let release;
  const h=harness({respond:call=>new Promise(resolve=>{release=()=>resolve({json:wallet(call.body.query,[])});})});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))]));
  const pending=h.api.expandTraceNode(addr(2),{quiet:true});
  await new Promise(resolve=>setImmediate(resolve));
  h.api.clearTrace();
  release();
  await pending;
  assert.deepEqual(plain(h.api.traceKeys()),[addr(1)]);
});

// ---------------------------------------------------------------- exposure

const label=(address,category,name="Label",extra={})=>({id:"l-"+address,chain:"ethereum",address,name,category,confidence:"HIGH",...extra});
const exposure=h=>plain(h.api.exposureFindings().map(item=>({category:item.category,hop:item.hop,direction:item.direction,flow:item.flow})));

test("funds received from a labelled mixer are exposure, and the finding says which way they moved",()=>{
  const h=harness();
  h.api.setLabels([label(addr(2),"MIXER")]);
  h.api.seed(wallet(addr(1),[tx("t1",0,"IN","ETH",10,addr(2)),tx("t2",10,"OUT","ETH",9,addr(3))]));
  assert.deepEqual(exposure(h),[{category:"MIXER",hop:1,direction:"from",flow:"funds from"}]);
  const sent=harness();
  sent.api.setLabels([label(addr(2),"MIXER")]);
  sent.api.seed(wallet(addr(1),[tx("t1",0,"OUT","ETH",10,addr(2))]));
  assert.deepEqual(exposure(sent),[{category:"MIXER",hop:1,direction:"to",flow:"funds to"}]);
  const both=harness();
  both.api.setLabels([label(addr(2),"MIXER")]);
  both.api.seed(wallet(addr(1),[tx("t1",0,"OUT","ETH",10,addr(2)),tx("t2",5,"IN","ETH",9,addr(2))]));
  assert.equal(exposure(both)[0].direction,"both");
});

test("a two-hop inbound path keeps its flow order, and alternating directions claim no flow",()=>{
  const h=harness();
  h.api.setLabels([label(addr(5),"DARKNET")]);
  h.api.seed(wallet(addr(1),[tx("t1",5,"IN","ETH",1,addr(2))]));
  h.api.addTrace(addr(2),wallet(addr(2),[tx("t0",0,"IN","ETH",1,addr(5)),tx("t1",5,"OUT","ETH",1,addr(1))]),1);
  const [finding]=plain(h.api.exposureFindings());
  assert.equal(finding.direction,"from");
  assert.deepEqual(finding.path,[addr(5),addr(2),addr(1)],"funds run from the labelled wallet to the seed");
  const mixed=harness();
  mixed.api.setLabels([label(addr(5),"DARKNET")]);
  mixed.api.seed(wallet(addr(1),[tx("t1",5,"OUT","ETH",1,addr(2))]));
  mixed.api.addTrace(addr(2),wallet(addr(2),[tx("t2",9,"IN","ETH",1,addr(5)),tx("t1",5,"IN","ETH",1,addr(1))]),1);
  assert.deepEqual(exposure(mixed),[{category:"DARKNET",hop:2,direction:"mixed",flow:"connected, mixed directions"}]);
  mixed.api.renderExposure();
  assert.match(mixed.el("cryptoExposureSummary").innerHTML,/ — /,"no arrows on a mere connection");
});

test("exposure is not limited to the 14 counterparties the graph draws, on screen or in the report",()=>{
  const h=harness();
  const rows=[];
  for(let i=0;i<20;i++)for(let k=0;k<3;k++)rows.push(tx("r"+i+"-"+k,i*10+k,"OUT","ETH",1,addr(100+i)));
  rows.push(tx("hidden",999,"OUT","ETH",50,addr(500)));
  h.api.setLabels([label(addr(500),"DARKNET")]);
  h.api.seed(wallet(addr(1),rows));
  const screen=h.api.buildNetworkModel(wallet(addr(1),rows));
  assert.ok(!plain(screen.nodes.map(node=>node.key)).includes(addr(500)),"the display model really leaves it out");
  assert.equal(exposure(h).length,1,"on screen");
  assert.equal(h.api.inReportMode(()=>h.api.exposureFindings()).length,1,"in the report");
});

test("the report's labels and watchlist also reach past the 14 the screen draws",()=>{
  const h=harness();
  const rows=[];
  for(let i=0;i<20;i++)for(let k=0;k<3;k++)rows.push(tx("r"+i+"-"+k,i*10+k,"OUT","ETH",1,addr(100+i)));
  rows.push(tx("hidden",999,"OUT","ETH",50,addr(500)));
  h.api.seed(wallet(addr(1),rows));
  const keys=h.api.inReportMode(()=>plain(h.api.buildNetworkModel(wallet(addr(1),rows)).nodes.map(node=>node.key)));
  assert.ok(keys.includes(addr(500)));
});

test("a failed transaction moved no funds, so it creates no exposure",()=>{
  const h=harness();
  h.api.setLabels([label(addr(2),"MIXER")]);
  h.api.seed(wallet(addr(1),[tx("f1",0,"OUT","ETH",5,addr(2),{failed:true}),tx("ok",1,"OUT","ETH",5,addr(3))]));
  assert.deepEqual(exposure(h),[]);
});

test("direct share is per address and per asset: units are never added together",()=>{
  const h=harness();
  h.api.setLabels([label(addr(2),"EXCHANGE","Ex A"),label(addr(3),"EXCHANGE","Ex B")]);
  h.api.seed(wallet(addr(1),[
    tx("a",0,"OUT","SHIB",9000000,addr(2)),tx("a2",1,"OUT","SHIB",1000000,addr(9)),
    tx("b",2,"OUT","ETH",1,addr(3)),tx("b2",3,"OUT","ETH",3,addr(9)),
    tx("c",4,"IN","ETH",2,addr(3))
  ]));
  const shares=Object.fromEntries(plain(h.api.exposureFindings()).map(item=>[item.name,item.direct_shares]));
  assert.deepEqual(shares["Ex A"],[{asset:"SHIB",direction:"to",share:90}]);
  assert.deepEqual(shares["Ex B"],[{asset:"ETH",direction:"from",share:100},{asset:"ETH",direction:"to",share:25}]);
});

test("a token and a coin with the same symbol stay separate assets",()=>{
  const h=harness();
  h.api.setLabels([label(addr(2),"EXCHANGE")]);
  h.api.seed(wallet(addr(1),[
    tx("a",0,"OUT","USDT",10,addr(2),{token_contract:"0xREAL"}),
    tx("b",1,"OUT","USDT",990,addr(3),{token_contract:"0xFAKE"})
  ]));
  assert.equal(plain(h.api.exposureFindings())[0].direct_share,100);
});

// ---------------------------------------------------------------- display and counting

test("the hop column prints the real hop; only the colour class stops at H3",()=>{
  const h=harness();
  const payload=wallet(addr(1),[]);
  h.api.seed(payload);
  h.api.renderTable(payload,[tx("a",0,"OUT","ETH",1,addr(2),{_trace_depth:5,_trace_source:addr(1)})]);
  assert.match(h.el("cryptoTableBody").innerHTML,/crypto-hop-badge h3">H5</);
});

test("one transaction between two analysed wallets counts once, on the edge and on the nodes",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[tx("same",0,"OUT","ETH",1,addr(2)),tx("other",1,"OUT","ETH",1,addr(3))]));
  h.api.addTrace(addr(2),wallet(addr(2),[tx("same",0,"IN","ETH",1,addr(1))]),1);
  const model=plain(h.api.buildNetworkModel(wallet(addr(1),[])));
  const edge=model.edges.find(item=>item.fromKey===addr(1)&&item.toKey===addr(2));
  assert.equal(edge.count,1);
  assert.equal(model.nodes.find(node=>node.key===addr(2)).total,1);
});

test("two transfers in one transaction with different amounts both stay in the table",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[tx("same",0,"OUT","USDT",100,addr(9)),tx("same",0,"OUT","USDT",250,addr(9))]));
  assert.deepEqual(plain(h.api.allTraceRows(false).map(row=>row.amount)).sort((a,b)=>a-b),[100,250]);
});

test("an expanded wallet ranked past the cap keeps its link to the seed",()=>{
  const h=harness();
  const rows=[];
  for(let i=0;i<20;i++)for(let k=0;k<3;k++)rows.push(tx("r"+i+"-"+k,i*10+k,"OUT","ETH",1,addr(100+i)));
  rows.push(tx("low",999,"OUT","ETH",50,addr(500)));
  const seed=wallet(addr(1),rows);
  h.api.seed(seed);
  h.api.addTrace(addr(500),wallet(addr(500),[tx("n",1000,"OUT","ETH",1,addr(600))]),1);
  const model=plain(h.api.buildNetworkModel(seed));
  assert.ok(model.edges.some(edge=>edge.fromKey===addr(1)&&edge.toKey===addr(500)));
});

test("date filters say they are UTC, and the balance says it is the native asset only",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  assert.ok(html.includes("<span>From date (UTC)</span>")&&html.includes("<span>To date (UTC)</span>"));
  assert.ok(fs.readFileSync("crypto.js","utf8").includes('kpi("Seed balance (native asset only)"'));
});

// ---------------------------------------------------------------- patterns come from the Worker

const finding=(code,family,strength,points,extra={})=>({code,family,strength,points,title:code+" title",metrics:{asset:"USDT"},tx_ids:[],benign:["ordinary reason"],...extra});
const assessment=(extra={})=>({version:"crypto-risk-v1",label:"LOW",score:0,thresholds:{elevated:25,high:60},service_discount:false,reasons:[],findings:[],not_evaluated:[],
  coverage:{rows:6,oldest:iso(0),newest:iso(60),complete:false,lifetime_tx_count:null,partial:false},disclaimer:"x",...extra});

test("the old false positives are gone: the page runs no behaviour rule of its own",()=>{
  const receipts=harness();
  const rows=[];
  for(let i=0;i<5;i++)rows.push(tx("in"+i,i,"IN","USDT",100,addr(10+i)));
  rows.push(tx("out",30,"OUT","ETH",100,addr(30)));
  receipts.api.seed(wallet(addr(1),rows,{risk_assessment:assessment()}));
  assert.deepEqual(plain(receipts.api.detectPatterns()),[],"five USDT receipts and one ETH send are not a pass-through");

  const failed=harness();
  const sends=[];
  for(let i=0;i<6;i++)sends.push(tx("f"+i,i,"OUT","ETH",3,addr(40+i),{failed:true}));
  failed.api.seed(wallet(addr(1),sends,{risk_assessment:assessment()}));
  assert.deepEqual(plain(failed.api.detectPatterns()),[],"six failed sends are not a fan-out, a burst or a similar-amount cluster");

  const narrow=harness();
  narrow.api.seed(wallet(addr(1),[tx("a",0,"IN","ETH",1,addr(2)),tx("b",1,"IN","ETH",1,addr(3)),tx("c",2,"OUT","ETH",1,addr(4))],{risk_assessment:assessment()}));
  narrow.api.addTrace(addr(4),wallet(addr(4),[tx("d",5,"OUT","USDT",1,addr(5))],{risk_assessment:assessment()}),1);
  assert.deepEqual(plain(narrow.api.detectPatterns()),[],"expanding one wallet is not a peeling chain");
});

test("Worker findings of every analysed wallet are listed, exposure stays in its own card, and filters change nothing",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))],{risk_assessment:assessment({findings:[
    finding("RAPID_PASS_THROUGH","FLOW","strong",30),finding("LISTED_WALLET","EXPOSURE","strong",100)]})}));
  h.api.addTrace(addr(2),wallet(addr(2),[],{risk_assessment:assessment({findings:[finding("FAN_IN","AGGREGATION","moderate",8)]})}),1);
  const patterns=plain(h.api.detectPatterns());
  assert.deepEqual(patterns.map(item=>[item.name,item.severity,item.level]),[["RAPID_PASS_THROUGH title","high","strong"],["FAN_IN title","medium","moderate"]]);
  assert.match(patterns[1].metric,/^H1 · /);
  assert.match(patterns[0].detail,/Ordinary explanations: ordinary reason/);
  h.el("filterDirection").value="IN";
  assert.deepEqual(plain(h.api.detectPatterns()),patterns);
});

test("a Worker without risk_assessment gives an honest empty state, never 'nothing found'",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))]));
  h.api.renderPatterns();
  assert.match(h.el("cryptoPatternList").innerHTML,/not available for this analysis yet/);
  const view=plain(h.api.riskView());
  assert.equal(view.available,false);
  assert.equal(view.label,"NOT_ASSESSED");
  assert.equal(view.summary,Report.RISK_WORDING.missing);
  assert.equal(view.score,null);
  h.api.renderRisk();
  assert.equal(h.el("cryptoRisk").hidden,false);
  assert.match(h.el("cryptoRiskBody").innerHTML,/Do not read this as clean/);
});

// ---------------------------------------------------------------- PEEL_CHAIN

const USDT={token_contract:"0xusdt"};

// seed -> a -> b -> c, each forwarding part of what it received.
function peelFixture(h,{first=90,second=80,third=70,gap=30,thirdExtra={},seedRisk}={}){
  const [s,a,b,c]=[addr(1),addr(2),addr(3),addr(4)];
  h.api.seed(wallet(s,[tx("r0",0,"IN","USDT",100,addr(9),USDT),tx("h1",10,"OUT","USDT",first,a,USDT)],seedRisk?{risk_assessment:seedRisk}:{}));
  h.api.addTrace(a,wallet(a,[tx("h1",10,"IN","USDT",first,s,USDT),tx("h2",10+gap,"OUT","USDT",second,b,USDT)]),1);
  h.api.addTrace(b,wallet(b,[tx("h2",10+gap,"IN","USDT",second,a,USDT),tx("h3",10+2*gap,"OUT","USDT",third,c,{...USDT,...thirdExtra})]),2);
}

test("PEEL_CHAIN needs three consecutive wallets that each forward most of what they received",()=>{
  const h=harness();
  peelFixture(h);
  const item=plain(h.api.peelChainFinding());
  assert.equal(item.code,"PEEL_CHAIN");
  assert.equal(item.points,30);
  assert.equal(item.family,"FRAGMENTATION");
  assert.equal(item.strength,"strong");
  assert.deepEqual(item.tx_ids,["h1","h2","h3"]);
  assert.deepEqual(item.hops.map(hop=>[hop.received,hop.forwarded,hop.minutes]),[[100,90,10],[90,80,30],[80,70,30]]);
  assert.deepEqual(item.hops.map(hop=>hop.to),[addr(2),addr(3),addr(4)]);
  assert.ok(plain(h.api.detectPatterns()).some(pattern=>pattern.name===item.title),"it also appears among the behaviour patterns");
});

test("PEEL_CHAIN stays quiet on chains that do not fit",()=>{
  const cases={
    "a hop that forwards under 80%":{second:50,third:45},
    "value that does not shrink":{second:90,third:90},
    "a hop later than 24 hours":{gap:25*60},
    "a failed last hop":{thirdExtra:{failed:true}}
  };
  for(const [name,options] of Object.entries(cases)){
    const h=harness();
    peelFixture(h,options);
    assert.equal(h.api.peelChainFinding(),null,name);
  }
  const twoHops=harness();
  twoHops.api.seed(wallet(addr(1),[tx("r0",0,"IN","USDT",100,addr(9),USDT),tx("h1",10,"OUT","USDT",90,addr(2),USDT)]));
  twoHops.api.addTrace(addr(2),wallet(addr(2),[tx("h1",10,"IN","USDT",90,addr(1),USDT),tx("h2",20,"OUT","USDT",80,addr(3),USDT)]),1);
  assert.equal(twoHops.api.peelChainFinding(),null,"two forwarding wallets are not yet a chain");
  const swapped=harness();
  peelFixture(swapped,{thirdExtra:{token_contract:"0xother"}});
  assert.equal(swapped.api.peelChainFinding(),null,"a hop in another token is not the same value");
});

test("PEEL_CHAIN reads the next wallet's receipt, because a Bitcoin row's amount covers every output",()=>{
  const h=harness();
  const [s,a,b,c]=[addr(1),addr(2),addr(3),addr(4)];
  const row=(id,minutes,direction,amount,parties)=>({id,time:iso(minutes),confirmed:true,direction,asset:"BTC",amount,counterparties:parties});
  h.api.seed(wallet(s,[row("r",0,"IN",1,[addr(9)]),row("h1",10,"OUT",1,[a,addr(20)])]));
  h.api.addTrace(a,wallet(a,[row("h1",10,"IN",0.9,[s]),row("h2",20,"OUT",0.9,[b,addr(21)])]),1);
  h.api.addTrace(b,wallet(b,[row("h2",20,"IN",0.8,[a]),row("h3",30,"OUT",0.8,[c,addr(22)])]),2);
  h.api.addTrace(c,wallet(c,[row("h3",30,"IN",0.7,[b])]),3);
  assert.deepEqual(plain(h.api.peelChainFinding().hops.map(hop=>hop.forwarded)),[0.9,0.8,0.7]);
});

test("PEEL_CHAIN ends in bounded time on a dense trace",()=>{
  const h=harness();
  const ring=Array.from({length:12},(_,i)=>addr(i+1));
  const rowsFor=i=>{
    const rows=[];
    for(let hop=0;hop<40;hop++)ring.forEach((other,j)=>{if(j!==i)rows.push(tx("x"+i+"-"+j+"-"+hop,hop,"OUT","USDT",1000-hop,other,USDT));});
    rows.push(tx("in"+i,0,"IN","USDT",1001,addr(99),USDT));
    return rows;
  };
  h.api.seed(wallet(ring[0],rowsFor(0)));
  for(let i=1;i<ring.length;i++)h.api.addTrace(ring[i],wallet(ring[i],rowsFor(i)),1);
  // CPU time: other test files run in parallel and stretch wall-clock time.
  const started=process.cpuUsage();
  h.api.peelChainFinding();
  const {user,system}=process.cpuUsage(started);
  assert.ok((user+system)/1000<1000,"it runs on every repaint, so the search has a step budget");
});

// ---------------------------------------------------------------- ONE_HOP_EXPOSURE

const LISTED=addr(77);
const listedMatch={address:LISTED,summary:"EXAMPLE ENTITY (FICTIONAL) [SDGT]",entities:[{terrorism:true}],received_from_count:0,sent_to_count:1,tx_ids:["w2"]};
const screened=(extra={})=>({sanctions_screening:{status:"ok",hit:true,counterparty_matches:[listedMatch],...extra}});

function oneHopFixture(h,{seedRows,walletRows,walletExtra={}}={}){
  h.api.seed(wallet(addr(1),seedRows||[tx("w1",0,"OUT","USDT",100,addr(2),USDT)]));
  h.api.addTrace(addr(2),wallet(addr(2),walletRows||[tx("w2",10,"OUT","USDT",90,LISTED,USDT)],{...screened(),...walletExtra}),1);
}

test("ONE_HOP_EXPOSURE scores 45 when the value order fits and the link matters, with its caveat",()=>{
  const h=harness();
  oneHopFixture(h);
  const item=plain(h.api.oneHopFinding());
  assert.equal(item.points,45);
  assert.equal(item.family,"EXPOSURE");
  assert.equal(item.metrics.value_order_fits,"yes");
  assert.equal(item.metrics.direction,"funds to");
  assert.equal(item.metrics.link_share,"100%");
  assert.equal(item.metrics.list_entry,listedMatch.summary);
  assert.deepEqual(item.tx_ids,["w1","w2"]);
  assert.ok(item.benign.some(text=>/does not mean the same funds/.test(text)));
});

test("ONE_HOP_EXPOSURE stays structural (30) when funds could not have followed that link",()=>{
  const cases={
    "the listed transfer came first":{walletRows:[tx("w2",-10,"OUT","USDT",90,LISTED,USDT)]},
    "another asset":{walletRows:[tx("w2",10,"OUT","ETH",90,LISTED)]},
    "a very different size":{walletRows:[tx("w2",10,"OUT","USDT",5,LISTED,USDT)]},
    "the other direction":{walletRows:[tx("w2",10,"IN","USDT",90,LISTED,USDT)]},
    "a link under 10% of the seed's flow":{seedRows:[tx("w1",0,"OUT","USDT",5,addr(2),USDT),tx("big",1,"OUT","USDT",95,addr(3),USDT)]}
  };
  for(const [name,options] of Object.entries(cases)){
    const h=harness();
    oneHopFixture(h,options);
    assert.equal(plain(h.api.oneHopFinding()).points,30,name);
  }
});

test("funds coming in are read the other way round: listed wallet first, then the seed",()=>{
  const h=harness();
  oneHopFixture(h,{seedRows:[tx("w1",20,"IN","USDT",100,addr(2),USDT)],walletRows:[tx("w2",10,"IN","USDT",90,LISTED,USDT)]});
  const item=plain(h.api.oneHopFinding());
  assert.equal(item.points,45);
  assert.equal(item.metrics.direction,"funds from");
});

test("ONE_HOP_EXPOSURE skips exchanges, exchange-like hubs, direct links and deeper hops",()=>{
  const sourced=harness();
  sourced.api.setLabels([{...label(addr(2),"EXCHANGE","Example Exchange"),source_title:"Published list"}]);
  oneHopFixture(sourced);
  assert.equal(sourced.api.oneHopFinding(),null,"a sourced exchange touches many listed wallets");

  const hub=harness();
  oneHopFixture(hub,{walletExtra:{exchange_behavior:{status:"behavioral_candidate",score:85}}});
  assert.equal(hub.api.oneHopFinding(),null,"a behaviour score of 80 or more");

  const direct=harness();
  oneHopFixture(direct,{seedRows:[tx("w1",0,"OUT","USDT",100,addr(2),USDT),tx("w0",1,"OUT","USDT",1,LISTED,USDT)]});
  assert.equal(direct.api.oneHopFinding(),null,"a listed counterparty of the seed is direct exposure, scored by the Worker");

  const deep=harness();
  deep.api.seed(wallet(addr(1),[tx("w1",0,"OUT","USDT",100,addr(2),USDT)]));
  deep.api.addTrace(addr(3),wallet(addr(3),[tx("w2",10,"OUT","USDT",90,LISTED,USDT)],screened()),2);
  assert.equal(deep.api.oneHopFinding(),null);
});

test("several listed links give one finding, so they cannot stack",()=>{
  const h=harness();
  const second={...listedMatch,address:addr(78)};
  h.api.seed(wallet(addr(1),[tx("w1",0,"OUT","USDT",100,addr(2),USDT)]));
  h.api.addTrace(addr(2),wallet(addr(2),[tx("w2",10,"OUT","USDT",90,LISTED,USDT)],screened({counterparty_matches:[listedMatch,second]})),1);
  const overlays=plain(h.api.riskOverlays());
  assert.equal(overlays.length,1);
  assert.equal(overlays[0].metrics.listed_links,2);
});

test("CHECK ONE HOP analyses the top 5 by value on request and joins them to the trace at H1",async()=>{
  const rows=[];
  for(let i=0;i<7;i++)rows.push(tx("o"+i,i,"OUT","USDT",i+1,addr(10+i),USDT));
  const h=harness({respond:call=>call.url.endsWith("/crypto-analyze")?{json:wallet(call.body.query,[])}:{json:{}}});
  h.api.setLabels([{...label(addr(16),"EXCHANGE","Example Exchange"),source_title:"Published list"}]);
  h.api.seed(wallet(addr(1),rows));
  assert.equal(analysis(h.calls).length,0,"nothing runs by itself");
  await h.api.checkOneHop();
  assert.deepEqual(analysis(h.calls).map(call=>call.body.query),[addr(15),addr(14),addr(13),addr(12),addr(11)],"largest first; the sourced exchange is skipped");
  assert.equal(new Set(plain(h.api.traceKeys())).size,6);
  assert.match(plain(h.api.riskView()).oneHop,/5 counterparties read/);
  await h.api.checkOneHop();
  assert.equal(analysis(h.calls).length,5,"a repeat costs nothing");
});

test("CHECK ONE HOP reports a wallet it could not read and stops when the search changes",async()=>{
  const failing=harness({respond:call=>call.url.endsWith("/crypto-analyze")?(call.body.query===addr(10)?{status:503,json:{error:"down"}}:{json:wallet(call.body.query,[])}):{json:{}}});
  failing.api.seed(wallet(addr(1),[tx("a",0,"OUT","USDT",9,addr(10),USDT),tx("b",1,"OUT","USDT",1,addr(11),USDT)]));
  await failing.api.checkOneHop();
  assert.match(plain(failing.api.riskView()).oneHop,/1 counterparty read, 1 could not be read/);

  let release;
  const stale=harness({respond:call=>new Promise(resolve=>{release=()=>resolve({json:wallet(call.body.query,[])});})});
  stale.api.seed(wallet(addr(1),[tx("a",0,"OUT","USDT",9,addr(10),USDT)]));
  const running=stale.api.checkOneHop();
  await new Promise(resolve=>setImmediate(resolve));
  stale.api.seed(wallet(addr(7),[tx("b",0,"OUT","USDT",1,addr(8),USDT)]));
  release();
  await running;
  assert.deepEqual(plain(stale.api.traceKeys()),[addr(7)]);
  assert.equal(stale.el("cryptoOneHop").disabled,false);
});

// ---------------------------------------------------------------- scoring the overlays

const scored=(h,base,overlays)=>plain(h.api.combineRisk(base,overlays));

test("without an overlay the Worker's label and score stand exactly",()=>{
  const h=harness();
  const result=scored(h,assessment({label:"ELEVATED",score:37,findings:[finding("X","FLOW","moderate",15)]}),[]);
  assert.equal(result.label,"ELEVATED");
  assert.equal(result.score,37);
});

test("an overlay scores like a Worker finding: best per family, exposure added on top",()=>{
  const h=harness();
  const peel=finding("PEEL_CHAIN","FRAGMENTATION","strong",30);
  const hop=finding("ONE_HOP_EXPOSURE","EXPOSURE","strong",45);
  assert.deepEqual([scored(h,assessment({findings:[finding("A","FRAGMENTATION","moderate",12)],score:12}),[peel]).score],[30],"12 and 30 in one family do not add up");
  const both=scored(h,assessment({findings:[finding("A","TEMPORAL","moderate",10)],score:10}),[peel,hop]);
  assert.equal(both.score,85);
  assert.equal(both.label,"HIGH");
});

test("behaviour alone reaches HIGH only with three strong families",()=>{
  const h=harness();
  const peel=finding("PEEL_CHAIN","FRAGMENTATION","strong",30);
  const two=scored(h,assessment({findings:[finding("A","FLOW","strong",30),finding("B","TEMPORAL","moderate",20)]}),[peel]);
  assert.equal(two.score,59);
  assert.equal(two.label,"ELEVATED");
  const three=scored(h,assessment({findings:[finding("A","FLOW","strong",30),finding("B","TEMPORAL","strong",20)]}),[peel]);
  assert.equal(three.score,80);
  assert.equal(three.label,"HIGH");
});

test("the service discount applies to behaviour only",()=>{
  const h=harness();
  const peel=finding("PEEL_CHAIN","FRAGMENTATION","strong",30);
  const hop=finding("ONE_HOP_EXPOSURE","EXPOSURE","strong",45);
  assert.equal(scored(h,assessment({service_discount:true,findings:[finding("A","FLOW","strong",30)]}),[peel,hop]).score,60);
  assert.equal(scored(h,assessment({service_discount:false,findings:[]}),[peel]).score,30);
});

test("each exposure code counts once, at its best, as the Worker scores it",()=>{
  const h=harness();
  const hop=finding("ONE_HOP_EXPOSURE","EXPOSURE","moderate",30);
  const twoLinks=[finding("LISTED_LINK","EXPOSURE","info",20),finding("LISTED_LINK","EXPOSURE","info",15)];
  assert.equal(scored(h,assessment({findings:twoLinks}),[hop]).score,50);
});

test("every scoring constant comes from the payload",()=>{
  const h=harness();
  const peel=finding("PEEL_CHAIN","FRAGMENTATION","strong",30);
  assert.equal(scored(h,assessment({thresholds:{elevated:35,high:70}}),[peel]).label,"LOW");
  const custom={elevated:25,high:60,behaviour_cap:40,strong_families_for_high:2,service_factor:0.5};
  assert.equal(scored(h,assessment({thresholds:custom,findings:[finding("A","FLOW","moderate",30)]}),[peel]).score,40,"one strong family: the payload's cap applies");
  assert.equal(scored(h,assessment({thresholds:custom,findings:[finding("A","FLOW","strong",30)]}),[peel]).score,60,"two strong families lift the cap here");
  assert.equal(scored(h,assessment({thresholds:custom,service_discount:true,findings:[finding("A","FLOW","strong",30)]}),[peel]).score,30,"the payload's service factor");
});

test("an overlay never lowers the Worker's result, and LOW never replaces NOT ASSESSED",()=>{
  const h=harness();
  const small=finding("ONE_HOP_EXPOSURE","EXPOSURE","moderate",30);
  const listed=scored(h,assessment({label:"HIGH",score:100,findings:[finding("LISTED_WALLET","EXPOSURE","strong",100,{floor:"HIGH"})]}),[small]);
  assert.equal(listed.label,"HIGH");
  assert.equal(listed.score,100);
  assert.equal(scored(h,assessment({label:"HIGH",score:70}),[small]).label,"HIGH","even if a floor is not marked on the finding");
  assert.equal(scored(h,assessment({label:"NOT_ASSESSED",score:0}),[finding("Z","OBFUSCATION","info",0)]).label,"NOT_ASSESSED");
  assert.equal(scored(h,assessment({label:"NOT ASSESSED",score:0}),[small]).label,"ELEVATED","an overlay with real evidence can still raise it");
});

// ---------------------------------------------------------------- the card

test("each label shows its agreed sentence and a score, and NOT ASSESSED shows no score",()=>{
  for(const [label,score] of [["HIGH",75],["ELEVATED",30],["LOW",5]]){
    const h=harness();
    h.api.seed(wallet(addr(1),[],{risk_assessment:assessment({label,score})}));
    const view=plain(h.api.riskView());
    assert.equal(view.summary,Report.RISK_WORDING[label]);
    assert.equal(view.score,score);
    assert.equal(view.labelText,label);
  }
  const h=harness();
  h.api.seed(wallet(addr(1),[],{risk_assessment:assessment({label:"NOT_ASSESSED",score:0})}));
  const view=plain(h.api.riskView());
  assert.equal(view.summary,Report.RISK_WORDING.NOT_ASSESSED);
  assert.equal(view.labelText,"NOT ASSESSED");
  assert.equal(view.score,null);
});

test("an unknown label reads as NOT ASSESSED, never as LOW",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[],{risk_assessment:assessment({label:"SOMETHING NEW",score:3})}));
  assert.equal(plain(h.api.riskView()).label,"NOT_ASSESSED");
});

test("the coverage line states the sample, its period and what was excluded",()=>{
  const h=harness();
  const rows=[tx("a",0,"IN","BTC",1,addr(2)),tx("b",1,"OUT","BTC",1,addr(3),{failed:true}),tx("c",2,"OUT","BTC",1,addr(3),{failed:true})];
  const coverage={rows:25,oldest:"2024-03-05T00:00:00Z",newest:"2025-10-20T00:00:00Z",complete:false,lifetime_tx_count:135,partial:false};
  h.api.seed(wallet(addr(1),rows,{risk_assessment:assessment({coverage})}));
  assert.equal(plain(h.api.riskView()).coverage,"25 of 135 transactions, Mar 2024 to Oct 2025, 2 failed rows excluded");

  const partial=harness();
  partial.api.seed(wallet(addr(1),rows.slice(0,1),{risk_assessment:assessment({coverage:{...coverage,rows:1,lifetime_tx_count:null,oldest:iso(0),newest:iso(0),partial:true}})}));
  assert.equal(plain(partial.api.riskView()).coverage,"1 transactions in this sample, Nov 2026, partial: a provider request failed");

  const complete=harness();
  complete.api.seed(wallet(addr(1),rows.slice(0,1),{risk_assessment:assessment({coverage:{...coverage,rows:1,lifetime_tx_count:null,complete:true,oldest:iso(0),newest:iso(0)}})}));
  assert.match(plain(complete.api.riskView()).coverage,/complete history/);

  const old=harness();
  old.api.seed(wallet(addr(1),rows.slice(0,1)));
  assert.equal(plain(old.api.riskView()).coverage,"1 transactions in this sample, Nov 2026","works from the rows when the Worker sends no coverage");
});

test("findings expand to what was observed, transaction links, ordinary explanations and limits",()=>{
  const h=harness();
  const item=finding("RAPID_PASS_THROUGH","FLOW","strong",30,{explanation:"Most of what arrived left within minutes.",tx_ids:["a","b"],metrics:{matched_pairs:3,pass_ratio:0.9},window:{from:iso(0),to:iso(60)}});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2),{explorer_url:"https://example.invalid/tx/a"}),tx("b",1,"OUT","ETH",1,addr(2),{explorer_url:"javascript:alert(1)"})],
    {risk_assessment:assessment({label:"ELEVATED",score:30,reasons:["Funds left soon after arriving"],findings:[item]})}));
  h.api.renderRisk();
  const html=h.el("cryptoRiskBody").innerHTML;
  assert.match(html,/<details class="risk-finding" data-code="RAPID_PASS_THROUGH">/);
  assert.match(html,/Observed:<\/strong> Most of what arrived left within minutes\./);
  assert.match(html,/matched pairs: 3/);
  assert.match(html,/2026-11-01 00:00 to 2026-11-01 01:00 UTC/);
  assert.match(html,/href="https:\/\/example\.invalid\/tx\/a"/);
  assert.ok(!/javascript:/.test(html),"only https links reach the page");
  assert.match(html,/Ordinary explanations:<\/strong> ordinary reason/);
  assert.match(html,/Limits of this sample:<\/strong> Only this sample was read/);
  assert.match(html,/Score 30\/100/);
  assert.match(html,/<ul class="risk-reasons"><li>Funds left soon after arriving<\/li><\/ul>/);
  assert.ok(html.includes(Report.RISK_WORDING.disclaimer));
});

test("rules not evaluated are listed with their reason, and the browser rules are not listed twice",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[],{risk_assessment:assessment({not_evaluated:[
    {code:"STRUCTURING_BAND",reason:"native assets not evaluated"},{code:"PEEL_STEP",reason:"Needs the wallet's complete history."},
    {code:"ONE_HOP_EXPOSURE",reason:"Runs in the browser, on request."},{code:"PEEL_CHAIN",reason:"Runs in the browser, on traced wallets."}
  ]})}));
  const rules=plain(h.api.riskView().notEvaluated);
  assert.deepEqual(rules.slice(0,2),[{rule:"Structuring band",reason:"native assets not evaluated"},{rule:"Peel step",reason:"Needs the wallet's complete history."}]);
  assert.equal(rules.length,4);
  assert.ok(rules.some(item=>item.rule==="One-hop exposure"&&/CHECK ONE HOP/.test(item.reason)));
  assert.ok(rules.some(item=>item.rule==="Multi-hop peel chain"&&/AUTO TRACE/.test(item.reason)));
  h.api.renderRisk();
  assert.match(h.el("cryptoRiskBody").innerHTML,/Rules not evaluated \(4\)/);
});

test("a browser rule leaves the list once it has run, whatever the Worker says",async()=>{
  const h=harness({respond:call=>call.url.endsWith("/crypto-analyze")?{json:wallet(call.body.query,[])}:{json:{}}});
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","USDT",1,addr(2),USDT)],{risk_assessment:assessment({not_evaluated:[{code:"ONE_HOP_EXPOSURE",reason:"Runs in the browser, on request."}]})}));
  await h.api.checkOneHop();
  assert.ok(!plain(h.api.riskView().notEvaluated).some(item=>/one.hop/i.test(item.rule)));
});

test("a service-like wallet and a stale list each show a chip",()=>{
  const h=harness();
  h.api.seed(wallet(addr(1),[],{risk_assessment:assessment({service_discount:true}),sanctions_screening:{status:"stale"}}));
  assert.deepEqual(plain(h.api.riskView().chips.map(chip=>chip.text)),["SERVICE-LIKE WALLET","LIST OLDER THAN 3 DAYS"]);
});

test("a list last refreshed over 3 days ago reads as stale, with its dates, while the Worker still says ok",()=>{
  const day=24*60*60*1000;
  const seeded=retrievedAt=>{
    const h=harness();
    h.api.seed(wallet(addr(1),[],{risk_assessment:assessment(),sanctions_screening:{status:"ok",hit:false,counterparties_checked:0,
      list:{retrieved_at:retrievedAt,address_count:1058,sources:[{id:"OFAC_SDN",name:"OFAC SDN",published:"2026-11-05"}]}}}));
    return h;
  };
  const retrievedAt=new Date(Date.now()-3*day-60*60*1000).toISOString();
  const old=seeded(retrievedAt);
  assert.deepEqual(plain(old.api.riskView().chips.map(chip=>chip.text)),["LIST OLDER THAN 3 DAYS"]);
  const view=plain(old.api.sanctionsView());
  assert.match(view.note,/published 2026-11-05/);
  assert.equal(view.badge.text,"NO MATCH");
  assert.deepEqual(view.warnings,["The sanctions list is older than 3 days or could not be refreshed (last refreshed "+
    retrievedAt.slice(0,10)+"); recent designations may be missing."]);
  const fresh=seeded(new Date(Date.now()-2*day).toISOString());
  assert.deepEqual(plain(fresh.api.riskView().chips),[]);
  assert.deepEqual(plain(fresh.api.sanctionsView().warnings),[]);
});

test("the overlays feed the card: a labelled mixer, a one-hop link and a peel chain all count",()=>{
  const h=harness();
  h.api.setLabels([label(addr(2),"MIXER","Mixer X")]);
  h.api.seed(wallet(addr(1),[tx("a",0,"IN","ETH",1,addr(2))],{risk_assessment:assessment()}));
  const view=plain(h.api.riskView());
  assert.equal(view.label,"ELEVATED");
  assert.equal(view.score,45);
  assert.equal(view.findings[0].code,"DIRECT_MIXER_EXPOSURE");
  assert.deepEqual(view.reasons,[view.findings[0].title]);
  const worker=harness();
  worker.api.setLabels([label(addr(2),"MIXER","Mixer X")]);
  worker.api.seed(wallet(addr(1),[tx("a",0,"IN","ETH",1,addr(2))],{risk_assessment:assessment({label:"ELEVATED",score:45,findings:[finding("DIRECT_MIXER_EXPOSURE","EXPOSURE","strong",45)]})}));
  assert.equal(plain(worker.api.riskView()).score,45,"not counted twice when the Worker already has it");
});

test("the card does not appear for a transaction lookup",()=>{
  const h=harness();
  h.api.render({kind:"transaction",chain:"bitcoin",query:"a".repeat(64),transaction:{}});
  assert.equal(h.el("cryptoRisk").hidden,true);
  assert.equal(h.api.riskView(),null);
});

test("hostile provider or Worker strings cannot reach the card as markup",()=>{
  const bad='"><img src=x onerror=alert(1)>';
  const h=harness();
  h.api.seed(wallet(addr(1),[tx(bad,0,"OUT",bad,1,addr(2))],{risk_assessment:assessment({label:bad,reasons:[bad],not_evaluated:[{rule:bad,reason:bad}],
    findings:[{code:bad,family:bad,strength:bad,points:1,title:bad,metrics:{[bad]:bad},tx_ids:[bad],benign:[bad],limits:bad,window:{from:bad,to:bad}}]})}));
  h.api.renderRisk();
  h.api.renderPatterns();
  assert.ok(!/<img/i.test(h.el("cryptoRiskBody").innerHTML));
  assert.ok(!/<img/i.test(h.el("cryptoPatternList").innerHTML));
});

test("generated titles and explanations avoid over-claiming words",()=>{
  const banned=/\b(proves?|confirmed|laundering|criminal|terrorist)\b/i;
  const h=harness();
  h.api.setLabels([label(addr(9),"MIXER","Mixer X")]);
  peelFixture(h,{seedRisk:assessment()});
  h.api.addTrace(addr(2),wallet(addr(2),[tx("h1",10,"IN","USDT",90,addr(1),USDT),tx("h2",40,"OUT","USDT",80,addr(3),USDT),tx("w2",50,"OUT","USDT",85,LISTED,USDT)],screened()),1);
  const overlays=plain(h.api.riskOverlays());
  assert.deepEqual(overlays.map(item=>item.code).sort(),["DIRECT_MIXER_EXPOSURE","ONE_HOP_EXPOSURE","PEEL_CHAIN"]);
  const view=plain(h.api.riskView());
  for(const item of overlays){
    assert.ok(item.explanation,item.code+" says what was observed");
    for(const value of [item.title,item.explanation,item.limits,...item.benign])assert.ok(!banned.test(value),value);
  }
  for(const item of view.notEvaluated)assert.ok(!banned.test(item.rule+" "+item.reason));
  for(const key of ["HIGH","ELEVATED","LOW","NOT_ASSESSED","missing"])assert.ok(!banned.test(Report.RISK_WORDING[key]),key);
});

test("the seed in the graph carries a small risk chip, and only when there is something to show",()=>{
  const h=harness();
  const seed=wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))],{risk_assessment:assessment({label:"HIGH",score:80})});
  h.api.seed(seed);
  h.api.paintGraphFrame(seed,h.api.buildNetworkModel(seed));
  const svg=h.el("flowGraph").innerHTML;
  assert.match(svg,/<g class="graph-seed"[\s\S]*<g class="graph-risk-chip high"[\s\S]*>HIGH<\/text><\/g><\/g>/);
  const old=harness();
  const bare=wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))]);
  old.api.seed(bare);
  old.api.paintGraphFrame(bare,old.api.buildNetworkModel(bare));
  assert.ok(!old.el("flowGraph").innerHTML.includes("graph-risk-chip"),"a Worker without assessments draws the graph as before");
});

test("the monitor baseline records the label it was taken under",()=>{
  const h=harness();
  assert.equal(h.api.snapshotFromPayload(wallet(addr(1),[],{risk_assessment:assessment({label:"ELEVATED"})})).risk_label,"ELEVATED");
  assert.equal(h.api.snapshotFromPayload(wallet(addr(1),[])).risk_label,"");
});

test("the full report and the Case PDF carry the same risk view",async()=>{
  const h=harness();
  let exported=null;
  h.context.window.CTAtlasPdf={download:async doc=>{exported=doc;return {};}};
  h.api.live().cases=[{id:"c1",name:"Case",notes:[],saved_paths:[],offchain_nodes:[],crosschain_links:[],seed_addresses:[]}];
  h.api.selectCase("c1");
  h.api.seed(wallet(addr(1),[tx("a",0,"OUT","ETH",1,addr(2))],{risk_assessment:assessment({label:"ELEVATED",score:30,findings:[finding("RAPID_PASS_THROUGH","FLOW","strong",30)]})}));
  const model=h.api.reportModel();
  assert.equal(plain(model.risk).summary,Report.RISK_WORDING.ELEVATED);
  const built=Report.build(plain(model));
  assert.ok(built.blocks.some(block=>block.text==="RISK INDICATORS (AUTOMATED, NOT A FINDING)"));
  await h.api.exportCasePdf();
  const texts=plain(exported.blocks).map(block=>block.text||"");
  assert.ok(texts.includes("RISK INDICATORS (AUTOMATED, NOT A FINDING)"));
  assert.ok(texts.includes(Report.RISK_WORDING.ELEVATED));
  assert.ok(texts.includes(Report.RISK_WORDING.disclaimer));
  assert.ok(texts.indexOf("RISK INDICATORS (AUTOMATED, NOT A FINDING)")<texts.indexOf("BEHAVIORAL PATTERNS"));
});

test("the strings the deployment checks look for are still there",()=>{
  assert.ok(fs.readFileSync("crypto.html","utf8").includes("Behavioral Pattern Detection"));
  assert.ok(fs.readFileSync("crypto.js","utf8").includes("detectPatterns"));
});

// ---------------------------------------------------------------- watchlist and alerts

const watchItem=(id,extra={})=>({id,chain:"ethereum",address:addr(1),label:"Wallet "+id,enabled:true,thresholds:{min_amount:5},last_snapshot:{checked_at:iso(0)},...extra});

test("the watchlist lists each wallet with its state, and works before any analysis",async()=>{
  const h=harness({respond:()=>({json:{ok:true,workspace:emptyWorkspace({watchlist:[watchItem("w1"),watchItem("w2",{enabled:false})],alerts:[{id:"a1",acknowledged:false},{id:"a2",acknowledged:true}]})}})});
  await h.api.loadCryptoWorkspace();
  const html=h.el("cryptoWatchlist").innerHTML;
  assert.match(html,/Wallet w1[\s\S]*ACTIVE[\s\S]*single transfer ≥ 5[\s\S]*data-watch-toggle="w1">PAUSE/);
  assert.match(html,/Wallet w2[\s\S]*PAUSED[\s\S]*data-watch-toggle="w2">RESUME/);
  assert.match(html,/data-watch-delete="w2"/);
  assert.equal(h.el("cryptoWatchCount").textContent,"2 of 300 wallets monitored · 1 unacknowledged alert(s)");
});

test("a watch whose checks fail says so, since when and why, and the panel shows the last automatic run",async()=>{
  const failing={failures:2,failing_since:iso(0),last_error:"Blockstream <transaction> history: HTTP 503",last_attempt_at:iso(0),last_success_at:""};
  const h=harness({respond:()=>({json:{ok:true,workspace:emptyWorkspace({watchlist:[
    watchItem("w1",{monitor:failing}),
    watchItem("w2",{monitor:{failures:0,last_error:"",failing_since:""}}),
    watchItem("w3",{enabled:false,monitor:failing}),
    watchItem("w4",{chain:"bsc",monitor:failing})
  ]}),monitor_run:{status:"degraded",summary:"2026-11-07 06:17 UTC · 7 of 8 wallets read · 1 failed"}}})});
  await h.api.loadCryptoWorkspace();
  const html=h.el("cryptoWatchlist").innerHTML;
  assert.ok(html.startsWith('<div class="intel-result">Last automatic run (all analysts\' wallets): 2026-11-07 06:17 UTC · 7 of 8 wallets read · 1 failed</div>'));
  const items=html.split('<div class="intel-item">').slice(1);
  assert.match(items[0],/intel-badge high">CHECK FAILING</);
  assert.match(items[0],/intel-detail">Check failing since \d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}, 2 check\(s\) in a row: new activity on this wallet may be missed\. Last error: Blockstream &lt;transaction&gt; history: HTTP 503<\/div>/);
  assert.match(items[1],/intel-badge clear">ACTIVE</);
  assert.doesNotMatch(items[1],/Check failing/);
  assert.match(items[2],/intel-badge unscreened">PAUSED</);
  assert.doesNotMatch(items[2],/Check failing/,"a paused wallet is not being checked");
  assert.match(items[3],/intel-badge unscreened">NOT CHECKED</);
  assert.doesNotMatch(items[3],/Check failing|CHECK FAILING/,"a retired chain is never counted as failing");
  assert.equal(h.el("cryptoWatchCount").textContent,"4 of 300 wallets monitored · 0 unacknowledged alert(s)");
});

test("pause, resume and delete change the workspace and are saved",async()=>{
  const h=harness({respond:call=>({json:{ok:true,workspace:call.method==="GET"?emptyWorkspace({watchlist:[watchItem("w1"),watchItem("w2")]}):call.body.workspace}})});
  await h.api.loadCryptoWorkspace();
  h.api.toggleWatch("w1");
  assert.equal(h.api.workspace().watchlist[0].enabled,false);
  h.api.toggleWatch("w1");
  assert.equal(h.api.workspace().watchlist[0].enabled,true);
  h.api.toggleWatch("w1");
  h.api.deleteWatch("w2");
  assert.deepEqual(h.api.workspace().watchlist.map(item=>item.id),["w1"]);
  await new Promise(resolve=>setTimeout(resolve,20));
  const saved=posts(h.calls).at(-1).body.workspace;
  assert.deepEqual(saved.watchlist.map(item=>[item.id,item.enabled]),[["w1",false]]);
});

test("an alert can be acknowledged once, and the state is saved and shown",async()=>{
  const alert={id:"a1",type:"LARGE_TRANSFER",severity:"HIGH",title:"Transfer",detail:"d",address:addr(1),created_at:iso(0),acknowledged:false};
  const h=harness({respond:call=>({json:{ok:true,workspace:call.method==="GET"?emptyWorkspace({alerts:[alert]}):call.body.workspace}})});
  await h.api.loadCryptoWorkspace();
  assert.match(h.el("cryptoAlerts").innerHTML,/data-alert-ack="a1">ACKNOWLEDGE/);
  h.api.acknowledgeAlert("a1");
  const html=h.el("cryptoAlerts").innerHTML;
  assert.ok(!html.includes("data-alert-ack"));
  assert.match(html,/alert-item high acknowledged/);
  assert.match(h.el("cryptoWatchCount").textContent,/0 unacknowledged/);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(posts(h.calls).at(-1).body.workspace.alerts[0].acknowledged,true);
});

test("a full watchlist says so and refuses another wallet instead of dropping the oldest",async()=>{
  const full=Array.from({length:300},(_,i)=>watchItem("w"+i,{address:addr(1000+i)}));
  const h=harness({respond:()=>({json:{ok:true,workspace:emptyWorkspace({watchlist:full})}})});
  await h.api.loadCryptoWorkspace();
  assert.match(h.el("cryptoWatchCount").textContent,/300 of 300 wallets monitored \(list full/);
  h.api.seed(wallet(addr(5),[]));
  h.api.monitorSeed();
  assert.equal(h.api.workspace().watchlist.length,300);
  assert.match(h.el("monitorStatus").textContent,/list is full/);
  h.api.seed(wallet(addr(1000),[]));
  h.api.monitorSeed();
  assert.match(h.el("monitorStatus").textContent,/Seed is monitored/,"updating a wallet already on the list still works");
});

test("with revisions, CHECK NOW runs in the Worker, because the gate only takes alerts and baselines from its monitor",async()=>{
  const alert={id:"srv",type:"NEW_TRANSACTION",severity:"LOW",title:"New transaction observed",created_at:iso(0),acknowledged:false};
  let reads=0;
  const h=harness({respond:call=>{
    if(call.url.endsWith("/crypto-monitor-check"))return call.body.watch_id==="w2"?{status:503,json:{error:"provider down"}}:{json:{ok:true,alerts_added:1}};
    if(call.method==="GET")return {json:{ok:true,revision:++reads,workspace:emptyWorkspace({watchlist:[watchItem("w1"),watchItem("w2"),watchItem("paused",{enabled:false})],alerts:reads>1?[alert]:[]})}};
    return {json:{}};
  }});
  await h.api.loadCryptoWorkspace();
  h.api.live().labels.unshift({id:"unsaved"});
  await h.api.checkMonitored();
  const checks=h.calls.filter(call=>call.url.endsWith("/crypto-monitor-check"));
  assert.deepEqual(checks.map(call=>call.body.watch_id),["w1","w2"],"paused wallets are skipped");
  assert.equal(checks[0].body.user_id,"analyst");
  assert.equal(analysis(h.calls).length,0,"the page no longer builds alerts itself");
  assert.deepEqual(h.api.workspace().alerts.map(item=>item.id),["srv"],"the server's alerts are read back");
  assert.equal(h.api.workspace().labels[0].id,"unsaved","an edit not saved yet survives the refresh");
  assert.equal(h.api.state().revision,2);
  assert.equal(h.el("monitorStatus").textContent,"Monitoring check complete · 1 wallet(s) checked · 1 new alert(s) · 1 could not be read in full (last reason: provider down).");
  assert.equal(h.el("monitorCheckButton").disabled,false);
});

test("CHECK NOW counts the alerts a partial read stored, a sanctions hit among them, and says why the read was incomplete",async()=>{
  const h=harness({respond:call=>{
    if(call.url.endsWith("/crypto-monitor-check"))return {status:503,json:{error:"Partial read: Blockstream older transactions could not be read.",alerts_added:1}};
    if(call.method==="GET")return {json:{ok:true,revision:1,workspace:emptyWorkspace({watchlist:[watchItem("w1")]})}};
    return {json:{}};
  }});
  await h.api.loadCryptoWorkspace();
  await h.api.checkMonitored();
  assert.equal(h.el("monitorStatus").textContent,
    "Monitoring check complete · 0 wallet(s) checked · 1 new alert(s) · 1 could not be read in full (last reason: Partial read: Blockstream older transactions could not be read).");
});

test("without revisions, an older Worker keeps the page's own check",async()=>{
  const h=harness({respond:call=>{
    if(call.url.endsWith("/crypto-analyze"))return {json:wallet(call.body.query,[tx("new",9999,"IN","ETH",1,addr(2))])};
    return {json:{ok:true,workspace:call.method==="GET"?emptyWorkspace({watchlist:[watchItem("w1",{last_snapshot:{checked_at:iso(0),newest_tx_id:"old",newest_tx_time:iso(0)}})]}):call.body.workspace}};
  }});
  await h.api.loadCryptoWorkspace();
  await h.api.checkMonitored();
  assert.equal(h.calls.filter(call=>call.url.endsWith("/crypto-monitor-check")).length,0);
  assert.equal(analysis(h.calls).length,1);
  assert.equal(h.api.workspace().alerts[0].type,"NEW_TRANSACTION");
});

test("a check whose refresh fails says so instead of showing stale alerts as current",async()=>{
  let reads=0;
  const h=harness({respond:call=>{
    if(call.url.endsWith("/crypto-monitor-check"))return {json:{ok:true,alerts_added:0}};
    return ++reads===1?{json:{ok:true,revision:1,workspace:emptyWorkspace({watchlist:[watchItem("w1")]})}}:{status:503,json:{error:"down"}};
  }});
  await h.api.loadCryptoWorkspace();
  await h.api.checkMonitored();
  assert.match(h.el("monitorStatus").textContent,/Reload the page to see them/);
});

test("an unexpected severity cannot break out of the class attribute",async()=>{
  const h=harness({respond:()=>({json:{ok:true,workspace:emptyWorkspace({alerts:[{id:"a",title:"t",severity:'x" onmouseover="alert(1)'}]})}})});
  await h.api.loadCryptoWorkspace();
  assert.ok(!h.el("cryptoAlerts").innerHTML.includes('" onmouseover'));
});

test("the watchlist and acknowledge controls are wired on the page",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  const client=fs.readFileSync("crypto.js","utf8");
  assert.ok(html.includes('id="cryptoWatchlist"')&&html.includes('id="cryptoWatchCount"'));
  const home=html.slice(html.indexOf('id="cryptoWorkspaceHome"'),html.indexOf('id="cryptoStatus"'));
  assert.ok(home.includes('id="cryptoWatchlist"'),"visible without running an analysis first");
  assert.ok(client.includes('getElementById("cryptoWatchlist")?.addEventListener("click"'));
  assert.ok(client.includes('getElementById("cryptoAlerts")?.addEventListener("click"'));
});

test("the privacy notice says indicators are automated and decide nothing",()=>{
  assert.match(fs.readFileSync("privacy.html","utf8"),/Automated risk indicators are generated[^<]*no decision is made automatically\./);
});

test("the Risk Indicators card sits directly above the sanctions card, with the exact title",()=>{
  const html=fs.readFileSync("crypto.html","utf8");
  assert.ok(html.indexOf('id="cryptoRisk"')>0&&html.indexOf('id="cryptoRisk"')<html.indexOf('id="cryptoSanctions"'));
  assert.ok(html.includes(">"+Report.RISK_WORDING.title+"<"));
  assert.ok(html.includes('id="cryptoOneHop"'));
});
