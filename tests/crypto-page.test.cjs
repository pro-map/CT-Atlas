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
