const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function harness(){
 const shared=fs.readFileSync('cloudflare-worker/shared.js','utf8').replace(/export\s*\{[\s\S]*?\};?\s*$/,'');
 const source=fs.readFileSync('cloudflare-worker/report-gate.js','utf8').replace(/^import[^\n]*\n/,'').replace('export class','class');
 const c=vm.createContext({Response,Request,URL,crypto,TextEncoder});
 vm.runInContext(shared+'\n'+source+'\nglobalThis.Gate=ReportGate;',c);
 let db=new Map(), fail=false;
 const storage={
  get:async k=>{if(Array.isArray(k)){assert.ok(k.length<=128);return new Map(k.filter(x=>db.has(x)).map(x=>[x,structuredClone(db.get(x))]));}return structuredClone(db.get(k));},
  put:async(k,v)=>{if(fail)throw Error('storage failure');db.set(k,structuredClone(v));},
  transaction:async fn=>{const saved=structuredClone(db);try{return await fn(storage);}catch(e){db=saved;throw e;}}
 };
 const g=new c.Gate({storage},{});
 return {g,db,fail:()=>{fail=true;},call:async(path,body)=>(await g.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)}))).json()};
}
const attempt={username:'group-i-1',quiz_date:'2026-09-14',quiz_id:'test',correct:false,selected_index:2,correct_index:1,explanation:'Evidence',source_url:'https://un.org/'};
test('quiz keeps first answer and restores it after reload',async()=>{
 const h=harness();await h.call('/quiz-answer-record',attempt);
 const retry=await h.call('/quiz-answer-record',{...attempt,correct:true,selected_index:1});
 assert.equal(retry.already_recorded,true);assert.equal(retry.correct,false);assert.equal(retry.selected_index,2);
 const state=await h.call('/quiz-state',attempt);assert.equal(state.answered,true);assert.equal(state.answer.selected_index,2);
 const r=(await h.g.usageStats('all')).users.find(x=>x.username===attempt.username);
 assert.equal(r.quiz_answers,1);assert.equal(r.quiz_correct,0);assert.equal(r.quiz_incorrect,1);
});
test('different user has independent attempt; 30-day statistics batch storage reads',async()=>{
 const h=harness();await h.call('/quiz-answer-record',attempt);
 assert.equal((await h.call('/quiz-state',{...attempt,username:'group-i-2'})).answered,false);
 await h.g.usageStats('30');await h.g.usageStats('7');
});
test('storage failure does not leave a counted attempt',async()=>{
 const h=harness();h.fail();await assert.rejects(h.call('/quiz-answer-record',attempt));
 assert.equal((await h.call('/quiz-state',attempt)).answered,false);
});
function apiHarness(){
 const q={date:'2026-09-14',question:'Q?',options:['A','B','C'],correct_index:1,explanation:'E',source_url:'https://un.org/'};
 const calls=[];
 const c=vm.createContext({URL,AbortSignal,Response,
 jsonResponse:(v,status)=>Response.json(v,{status}),sha256:async()=> 'current-id',
 fetch:async()=>Response.json(q),
 gateCall:async(e,path,payload)=>{calls.push({path,payload});return Response.json(path==='/session-get'?{username:'group-i-1'}:path==='/quiz-state'?{answered:false,answer:null}:{ok:true});}
 });
 vm.runInContext(fs.readFileSync('cloudflare-worker/quiz.js','utf8').replace(/^import[^\n]*\n/,'').replace('export async function','async function')+'\nglobalThis.handle=handleQuiz;',c);
 return {calls,call:(path,body,token='valid')=>c.handle(new Request('https://api'+path,{method:body?'POST':'GET',headers:token?{'X-Session-Token':token}:{},...(body?{body:JSON.stringify(body)}:{})}),{})};
}
test('quiz API denies anonymous access',async()=>{assert.equal((await apiHarness().call('/quiz-state',null,'')).status,401);});
test('quiz state omits correct answer before submission',async()=>{
 const r=await (await apiHarness().call('/quiz-state')).json();assert.equal(r.quiz.correct_index,undefined);assert.equal(r.quiz.explanation,undefined);
});
test('quiz API rejects stale question and non-integer choice',async()=>{
 const h=apiHarness();assert.equal((await h.call('/quiz-answer',{quiz_id:'old',selected_index:1})).status,409);
 assert.equal((await h.call('/quiz-answer',{quiz_id:'current-id',selected_index:null})).status,400);
});
test('quiz identity and correctness come from server, never client claims',async()=>{
 const h=apiHarness();await h.call('/quiz-answer',{quiz_id:'current-id',username:'admin',selected_index:0,correct:true});
 const record=h.calls.find(c=>c.path==='/quiz-answer-record');assert.equal(record.payload.username,'group-i-1');assert.equal(record.payload.correct,false);
});
