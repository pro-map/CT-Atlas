const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(labels={}){
  const controls=Object.fromEntries(['exchangePathControls','exchangePathSelect','exchangePathToggle','exchangePathDetails'].map(id=>[id,{setAttribute(){}}]));
  const context=vm.createContext({document:{readyState:'loading',addEventListener(){},getElementById:id=>controls[id]},labels});
  const source=fs.readFileSync('crypto.js','utf8').replace(/\}\)\(\);\s*$/,`
    labelForAddress=address=>labels[address]||null;
    exchangeBehaviorForAddress=address=>labels[address]?.behavior||null;
    globalThis.api={directedExchangePath,documentedExchangePaths,rowsForExchangePath,exchangeGraphView,buildNetworkModel,
      mode:value=>{exchangeGraphMode=value;}, select:value=>{selectedExchangePath=value;},
      setup:payload=>{lastPayload=payload;resetTraceState(payload);},
      active:()=>activeExchangePath};
  })();`);
  vm.runInContext(source,context);
  return {api:context.api,controls};
}
const label={category:'EXCHANGE',name:'Documented Exchange',source_url:'https://example.org/wallets'};
const model={rootKey:'target',nodes:['target','middle','exchange','noise','other'].map((key,i)=>({key,id:key,depth:i,assets:[]})),
 edges:[['exchange','middle'],['middle','target'],['noise','target'],['target','middle'],['other','target']].map(([fromKey,toKey])=>({fromKey,toKey}))};
const payload={chain:'tron',query:'target'};
test('documented exchange auto-focuses with intermediate hops and hides unrelated and reverse edges',()=>{
 const {api,controls}=harness({exchange:label});
 const view=api.exchangeGraphView(model,payload);
 assert.deepEqual(Array.from(view.nodes,n=>n.key),['target','middle','exchange']);
 assert.deepEqual(Array.from(view.edges,e=>[e.fromKey,e.toKey]),[['exchange','middle'],['middle','target']]);
 assert.equal(api.active().incoming,true);
 assert.match(controls.exchangePathDetails.textContent,/exchange → middle → target/);
 assert.equal(model.edges.length,5);
 api.mode('all');
 assert.equal(api.exchangeGraphView(model,payload),model);
 assert.equal(api.active(),null);
 api.mode('auto');
 assert.equal(api.exchangeGraphView(model,payload).edges.length,2);
});
test('behavioral candidates and labels without documentary sources never trigger focus',()=>{
 const {api}=harness({exchange:{category:'EXCHANGE',name:'Guess'}});
 assert.equal(api.documentedExchangePaths(model,'tron').length,0);
 assert.equal(api.exchangeGraphView(model,payload),model);
});
test('reverse-only path is identified as target to exchange; mixed directions and cycles do not fabricate flow',()=>{
 const {api}=harness({exchange:label});
 const reverse={...model,edges:[{fromKey:'target',toKey:'middle'},{fromKey:'middle',toKey:'exchange'},{fromKey:'middle',toKey:'target'}]};
 const paths=api.documentedExchangePaths(reverse,'tron');
 assert.equal(paths.length,1);assert.equal(paths[0].incoming,false);
 assert.equal(api.directedExchangePath({...model,edges:[{fromKey:'exchange',toKey:'middle'},{fromKey:'target',toKey:'middle'}]},'exchange','target'),null);
});
test('multiple exchanges can be selected independently and transaction restoration is lossless',()=>{
 const {api}=harness({exchange:label,other:{...label,name:'Second Exchange'}});
 api.select('other|in');api.exchangeGraphView(model,payload);
 const rows=[{id:'a',_trace_source:'target',direction:'IN',counterparties:['other']},{id:'b',_trace_source:'target',direction:'IN',counterparties:['noise']},
 {id:'c',_trace_source:'other',direction:'OUT',counterparties:['target']},{id:'d',_trace_source:'target',direction:'OUT',counterparties:['other']}];
 assert.deepEqual(Array.from(api.rowsForExchangePath(rows,api.active(),'tron'),r=>r.id),['a','c']);
 api.mode('all');api.exchangeGraphView(model,payload);
 assert.equal(api.rowsForExchangePath(rows,api.active(),'tron'),rows);
});
test('complete analyzed graph recovers a low-ranked documented exchange beyond display branch limits',()=>{
 const {api}=harness({exchange:label});
 const p={...payload,transactions:Array.from({length:20},(_,i)=>({id:'tx'+i,direction:'IN',asset:'TRX',counterparties:[i===19?'exchange':'wallet'+i]}))};
 api.setup(p);
 assert.equal(api.buildNetworkModel(p).nodes.some(n=>n.id==='exchange'),false);
 const full=api.buildNetworkModel(p,true);
 assert.equal(full.nodes.length,21);
 assert.equal(api.exchangeGraphView(full,p).nodes.length,2);
});
test('mixed-direction documented Bitcoin connection enables focus and keeps real transfer arrows',()=>{
 const {api,controls}=harness({exchange:{...label,name:'Binance'}});
 const mixed={...model,root:'target',edges:[{fromKey:'exchange',toKey:'middle'},{fromKey:'target',toKey:'middle'},{fromKey:'noise',toKey:'target'}]};
 const view=api.exchangeGraphView(mixed,{...payload,chain:'bitcoin'});
 assert.equal(controls.exchangePathToggle.disabled,false);
 assert.equal(controls.exchangePathSelect.disabled,false);
 assert.equal(api.active().mixed,true);
 assert.deepEqual(Array.from(api.active().keys),['exchange','middle','target']);
 assert.deepEqual(Array.from(view.edges,e=>[e.fromKey,e.toKey]),[['exchange','middle'],['target','middle']]);
 assert.match(controls.exchangePathDetails.textContent,/mixed transfer directions/);
 assert.doesNotMatch(controls.exchangePathDetails.textContent,/exchange → middle → target/);
 api.mode('all');assert.equal(api.exchangeGraphView(mixed,payload),mixed);
 api.mode('auto');assert.equal(api.exchangeGraphView(mixed,payload).edges.length,2);
});
test('an exchange discovered on a subsequent trace makes the previously disabled control usable',()=>{
 const labels={};const {api,controls}=harness(labels);
 api.exchangeGraphView(model,payload);
 assert.equal(controls.exchangePathToggle.disabled,true);
 assert.match(controls.exchangePathDetails.textContent,/AI-assessed name is a lead/);
 labels.exchange={...label,name:'Binance'};
 api.exchangeGraphView(model,payload);
 assert.equal(controls.exchangePathToggle.disabled,false);
 assert.equal(api.active().name,'Binance');
});
test('a disconnected documented exchange cannot produce an invented path and has an explanation',()=>{
 const {api,controls}=harness({exchange:label});
 const disconnected={...model,edges:[{fromKey:'noise',toKey:'target'}]};
 assert.equal(api.exchangeGraphView(disconnected,payload),disconnected);
 assert.equal(controls.exchangePathToggle.disabled,true);
 assert.equal(controls.exchangePathDetails.hidden,false);
 assert.match(controls.exchangePathDetails.textContent,/observed links/);
});
test('a Binance behavioral lead is inspectable by explicit choice but never auto-focused or documented',()=>{
 const {api,controls}=harness({exchange:{behavior:{score:95,related_exchange:{name:'Binance'}}}});
 assert.equal(api.documentedExchangePaths(model,'bitcoin').length,0);
 assert.equal(api.exchangeGraphView(model,{...payload,chain:'bitcoin'}),model);
 assert.equal(api.active(),null);
 assert.equal(controls.exchangePathToggle.disabled,false);
 assert.equal(controls.exchangePathToggle.textContent,'SHOW CANDIDATE CONNECTION');
 assert.match(controls.exchangePathDetails.textContent,/UNVERIFIED LEAD: Binance/);
 api.mode('focus');
 assert.equal(api.exchangeGraphView(model,payload).edges.length,2);
 assert.equal(api.active().basis,'behavioral');
 assert.match(controls.exchangePathDetails.textContent,/identity is not established/);
 api.mode('all');assert.equal(api.exchangeGraphView(model,payload),model);
});



