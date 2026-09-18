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
  put:async(k,v)=>{if(fail)throw Error('storage failure');if(k&&typeof k==='object'&&!Array.isArray(k)){for(const [key,value] of Object.entries(k))db.set(key,structuredClone(value));}else db.set(k,structuredClone(v));},
  delete:async k=>{db.delete(k);},
  list:async options=>{
    const prefix=String(options?.prefix||"");
    let entries=[...db.entries()]
      .filter(([k])=>String(k).startsWith(prefix))
      .sort(([a],[b])=>String(a).localeCompare(String(b)));
    if(options?.startAfter)entries=entries.filter(([k])=>String(k)>String(options.startAfter));
    if(options?.reverse)entries.reverse();
    if(options?.limit)entries=entries.slice(0,options.limit);
    return new Map(entries);
  },
  transaction:async fn=>{const saved=structuredClone(db);try{return await fn(storage);}catch(e){db=saved;throw e;}}
 };
 const testHash='a'.repeat(64);
 const testUsers={admin:testHash};
 for(const group of ['i','p','s']) for(let number=1;number<=10;number++) testUsers['group-'+group+'-'+number]=testHash;
 const testEnv={AUTH_USERS_JSON:JSON.stringify(testUsers)};
 const g=new c.Gate({storage},testEnv);
 return {g,db,fail:()=>{fail=true;},call:async(path,body)=>(await g.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)}))).json()};
}
const attempt={username:'group-i-1',quiz_date:'2026-09-14',quiz_id:'test',correct:false,selected_index:2,correct_index:1,category:'C',question:'Q?',options:['A','B','C'],explanation:'Evidence',source_url:'https://un.org/'};
test('quiz keeps first answer and restores it after reload',async()=>{
 const h=harness();await h.call('/quiz-answer-record',attempt);
 const retry=await h.call('/quiz-answer-record',{...attempt,correct:true,selected_index:1});
 assert.equal(retry.already_recorded,true);assert.equal(retry.correct,false);assert.equal(retry.selected_index,2);
 const state=await h.call('/quiz-state',attempt);assert.equal(state.answered,true);assert.equal(state.answer.selected_index,2);
 const r=(await h.g.usageStats('all')).users.find(x=>x.username===attempt.username);
 assert.equal(r.quiz_answers,1);assert.equal(r.quiz_correct,0);assert.equal(r.quiz_incorrect,1);
});
test('admin display labels cover configured names and omit unspecified users',async()=>{
 const h=harness();
 const stats=await h.g.usageStats('all');
 const rows=new Map(stats.users.map(row=>[row.username,row]));
 const expected={
  'group-i-1':'Ed','group-i-2':'Stephen','group-i-3':'Kayla','group-i-4':'Bridget',
  'group-i-5':'Alexandru','group-i-6':'Oskaras','group-i-7':'Elodie','group-i-8':'Marius',
  'group-i-9':'Kiara','group-i-10':'Sebastien','group-p-1':'Dritan','group-p-2':'Allyson',
  'group-p-3':'Roberto','group-p-4':'Daniele','group-p-5':'Simon','group-p-6':'Zaydoun',
  'group-p-7':'Saleh','group-p-8':'Lasha','group-p-9':'Saad','group-p-10':'Alexandre','group-s-1':'Maddy',
  'group-s-3':'Andreas','group-s-5':'Liman','group-s-6':'Juan','group-s-7':'Thierry'
 };
 for(const [username,name] of Object.entries(expected)) assert.equal(rows.get(username).display_name,name);
 for(const username of ['group-s-2','group-s-4','group-s-8','group-s-9','group-s-10']) assert.equal(rows.get(username).display_name,undefined);
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
test('admin quiz history returns given and correct answer labels',async()=>{
 const h=harness();await h.call('/quiz-answer-record',attempt);
 const history=await h.call('/quiz-history',{username:'admin',period:'all'});
 assert.equal(history.total,1);
 assert.equal(history.answers[0].selected_answer,'C');
 assert.equal(history.answers[0].correct_answer,'B');
 assert.equal(history.answers[0].correct,false);
 assert.equal(history.answers[0].display_name,"Ed");
 const retry=await h.call('/quiz-answer-record',{...attempt,correct:true,selected_index:1});
 assert.equal(retry.already_recorded,true);
 assert.equal((await h.call('/quiz-history',{username:'admin',period:'all'})).answers[0].correct_answer,'B');
});

test('quiz history rejects non-admin access',async()=>{
 const h=harness();
 const response=await h.call('/quiz-history',{username:'group-i-1',period:'all'});
 assert.equal(response.error,'Admin access required.');
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


test('quota reservation rolls back on failure and counts only committed work',async()=>{
 const h=harness();
 const first=await h.call('/quick-ask-acquire',{username:'group-i-1'});
 assert.ok(first.reservation_id);
 const released=await h.call('/quota-release',{
  username:'group-i-1',kind:'quick_ask',reservation_id:first.reservation_id
 });
 assert.equal(released.released,true);
 const second=await h.call('/quick-ask-acquire',{username:'group-i-1'});
 assert.ok(second.reservation_id);
 const committed=await h.call('/quota-commit',{
  username:'group-i-1',kind:'quick_ask',reservation_id:second.reservation_id
 });
 assert.equal(committed.committed,true);
 const row=(await h.g.usageStats('all')).users.find(x=>x.username==='group-i-1');
 assert.equal(row.quick_ask_requests,1);
});
