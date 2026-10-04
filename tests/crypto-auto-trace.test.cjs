const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

function harness(nodes,fail=false){
  const calls=[],statuses=[];
  const controls={traceMaxDepth:{value:"6"},traceBranch:{value:"8"},cryptoAutoTrace:{}};
  const context=vm.createContext({
    console:{warn(){}},document:{readyState:"loading",addEventListener(){},getElementById:id=>controls[id]},
    nodes,calls,statuses,fail
  });
  const source=fs.readFileSync("crypto.js","utf8").replace(/\}\)\(\);\s*$/, `
    lastPayload={kind:"address",chain:"tron",query:"root"};
    traceExpanded=new Set(["root"]);
    tracePayloads=new Map([["root",{depth:0}]]);
    buildNetworkModel=()=>({rootKey:"root",nodes:nodes.filter(n=>n.depth<=1||traceExpanded.has(n.parent)),
      edges:nodes.filter(n=>n.parent).map(n=>({fromKey:n.parent,toKey:n.key,hop:n.depth}))});
    exchangeStatusOf=address=>nodes.find(n=>n.id===address)?.status||null;
    expandTraceNode=async address=>{
      calls.push(address);
      if(fail)throw new Error("provider failure");
      const n=nodes.find(n=>n.id===address);
      traceExpanded.add(address);tracePayloads.set(address,{depth:n.depth});return true;
    };
    displayAddressForKey=key=>key;
    setTraceStatus=message=>statuses.push(message);
    requestExchangeAttributions=async()=>0;
    renderFilteredViews=()=>{};
    sleep=async()=>{};
    globalThis.api={autoTrace,traceSettings,run:()=>autoTraceRun};
  })();`);
  vm.runInContext(source,context);
  return {api:context.api,calls,statuses};
}
const node=(id,depth,parent,status)=>({id,key:id,depth,parent,status,searchable:true,total:100-depth});
test("behavioural candidate continues to documented exchange, whose branch stops",async()=>{
  const h=harness([node("root",0),node("candidate",1,"root",{basis:"behavioral",score:95}),
    node("exchange",2,"candidate",{basis:"sourced",name:"Example Exchange",source:"Published list"}),
    node("beyond",3,"exchange")]);
  await h.api.autoTrace();
  assert.deepEqual(h.calls,["candidate"]);
  assert.equal(h.api.run().exchanges.length,2);
  assert.match(h.statuses.at(-1),/1 documented exchange\(s\), 1 behavioural candidate/);
});
test("an unlabelled chain explores through H5 and discovers H6",async()=>{
  const h=harness(Array.from({length:8},(_,i)=>node(i?"w"+i:"root",i,i===1?"root":"w"+(i-1))));
  await h.api.autoTrace();
  assert.deepEqual(h.calls,["w1","w2","w3","w4","w5"]);
  assert.match(h.api.run().stop,/maximum depth H6/);
});
test("automatic tracing never spends more than 30 wallet expansions",async()=>{
  const nodes=[node("root",0)];
  for(let d=1;d<=6;d++)for(let b=0;b<8;b++)nodes.push(node("w"+d+"-"+b,d,d===1?"root":"w"+(d-1)+"-"+b));
  const h=harness(nodes);
  await h.api.autoTrace();
  assert.equal(h.calls.length,30);
  assert.match(h.api.run().stop,/wallet budget/);
});
test("provider failures are reported and do not become exchange findings",async()=>{
  const h=harness([node("root",0),node("a",1,"root")],true);
  await h.api.autoTrace();
  assert.equal(h.api.run().failed,1);
  assert.equal(h.api.run().exchanges.length,0);
});
