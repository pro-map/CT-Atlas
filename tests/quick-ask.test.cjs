const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/quick-ask.js','utf8').replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'').replace(/export /g,'');

function parseEventDate(event){
 const raw=event?.date;
 if(!raw) return null;
 const d=new Date(raw);
 return Number.isNaN(d.getTime())?null:d;
}

function harness(){
 const c=vm.createContext({parseEventDate});
 vm.runInContext(source,c);
 return vm.runInContext('({localEventMatches,quickAskTokens:typeof quickAskTokens!=="undefined"?quickAskTokens:null,QUICK_ASK_VERSION,QUICK_ASK_MAX_MATCHED_EVENTS,sanitizeAnswerText})',c);
}

function event(overrides){
 return {
  id:'e1', title:'', summary:'', actor_group:'', country:'', region:'', city:'',
  categories:[], date:'2026-06-01T00:00:00Z',
  ...overrides
 };
}

test('matches an event by actor_group even when the question uses different casing',()=>{
 const h=harness();
 const events=[event({id:'a1',actor_group:'ISIS-K',title:'Attack claimed by ISIS-K in Kabul'})];
 const result=h.localEventMatches(events,'tell me about isis-k');
 assert.equal(result.length,1);
 assert.equal(result[0].id,'a1');
});

test('does not match unrelated events (score stays 0 and is filtered out)',()=>{
 const h=harness();
 const events=[event({id:'b1',title:'Local council budget meeting',summary:'Routine municipal spending review.'})];
 const result=h.localEventMatches(events,'what is Boko Haram');
 assert.equal(result.length,0);
});

test('diacritic-insensitive: "feto" matches actor_group "FETO" with diacritic',()=>{
 const h=harness();
 const events=[event({id:'c1',actor_group:'FETO',title:'Coup plot investigation'})];
 const result=h.localEventMatches(events,'who is feto');
 assert.equal(result.length,1);
 assert.equal(result[0].id,'c1');
});

test('a question made only of stopwords yields no tokens and no matches',()=>{
 const h=harness();
 const events=[event({id:'d1',title:'Some article about an attack'})];
 const result=h.localEventMatches(events,'what is this');
 assert.equal(result.length,0);
});

test('ranks higher keyword-overlap scores first, then more recent events',()=>{
 const h=harness();
 const events=[
  event({id:'low',title:'Afghanistan mentioned once',date:'2026-06-05T00:00:00Z'}),
  event({id:'high',title:'Afghanistan Taliban attack Afghanistan',actor_group:'Taliban',country:'Afghanistan',date:'2026-01-01T00:00:00Z'}),
  event({id:'old-high',title:'Afghanistan Taliban attack Afghanistan',actor_group:'Taliban',country:'Afghanistan',date:'2026-05-01T00:00:00Z'})
 ];
 const result=h.localEventMatches(events,'Afghanistan Taliban attack');
 assert.equal(result[0].id,'old-high','same top score, but more recent of the two high-scoring events must rank first');
 assert.equal(result[2].id,'low','lowest keyword overlap ranks last');
});

test('caps results at the configured limit even with many equally-good matches',()=>{
 const h=harness();
 const events=Array.from({length:25},(_,i)=>event({id:`m${i}`,title:'Afghanistan Taliban attack report',date:`2026-01-${String((i%28)+1).padStart(2,'0')}T00:00:00Z`}));
 const result=h.localEventMatches(events,'Afghanistan Taliban attack');
 assert.equal(result.length,h.QUICK_ASK_MAX_MATCHED_EVENTS);
 assert.ok(h.QUICK_ASK_MAX_MATCHED_EVENTS<=15,'keep Atlas AI a single fast answer, not a report');
});

test('QUICK_ASK_VERSION is exported for cache-busting on schema changes',()=>{
 const h=harness();
 assert.equal(typeof h.QUICK_ASK_VERSION,'string');
 assert.ok(h.QUICK_ASK_VERSION.length>0);
});

test('regression: "isis" must not match purely because it is a substring of "crisis" (whole-word matching)',()=>{
 const h=harness();
 const events=[event({id:'unrelated',title:'Government faces constitutional crisis',summary:'A political crisis over budget authority.'})];
 const result=h.localEventMatches(events,'isis attack');
 assert.equal(result.length,0,'a bare substring hit inside "crisis" must not count as an ISIS match');
});

test('a short but meaningful acronym like "ai" is matched as a whole word, not filtered out as too short',()=>{
 const h=harness();
 const events=[event({id:'ai-event',title:'Group uses AI to generate propaganda videos',summary:'AI-generated content spread online.'})];
 const result=h.localEventMatches(events,'how is AI used by terrorists');
 assert.equal(result.length,1);
 assert.equal(result[0].id,'ai-event');
});

test('"ai" as a whole-word token does not falsely match events whose text merely contains the letters a-i inside other words',()=>{
 const h=harness();
 const events=[event({id:'no-ai',title:'Suspect claimed he remained at the scene',summary:'Witnesses said little.'})];
 const result=h.localEventMatches(events,'how is AI used by terrorists');
 assert.equal(result.length,0,'"claimed", "remained" and "said" contain the letters a-i but are not the word "ai"');
});

test('sanitizeAnswerText preserves paragraph breaks (unlike shared.js cleanText, which would flatten them)',()=>{
 const h=harness();
 const raw='Paragraph one.\r\n\r\nParagraph   two   with  extra   spaces.\n\n\n\nParagraph three.';
 const result=h.sanitizeAnswerText(raw,5000);
 assert.equal(result,'Paragraph one.\n\nParagraph two with extra spaces.\n\nParagraph three.');
});

test('sanitizeAnswerText trims and caps length without breaking on the cut',()=>{
 const h=harness();
 const result=h.sanitizeAnswerText('  padded text  ',6);
 assert.equal(result,'padded');
});


test('matches local events written in Arabic script',()=>{
 const h=harness();
 const events=[event({
  id:'arabic-1',
  title:'هجوم لتنظيم الدولة في أفغانستان',
  summary:'تقرير عن هجوم مسلح في أفغانستان'
 })];
 const result=h.localEventMatches(events,'ما هو الهجوم في أفغانستان؟');
 assert.equal(result.length,1);
 assert.equal(result[0].id,'arabic-1');
});

// ---- handleQuickAsk --------------------------------------------------------
function handlerHarness({quotaOk=true,events=[],answer}={}){
 const strip=text=>text.replace(/^import[\s\S]*?from "\.\/[^"]+";\s*/gm,'').replace(/export\s*\{[\s\S]*?\};?\s*$/,'');
 const calls=[];
 const c=vm.createContext({crypto:globalThis.crypto,TextEncoder,Intl,console,setTimeout});
 vm.runInContext(strip(fs.readFileSync('cloudflare-worker/shared.js','utf8')),c);
 Object.assign(c,{
  isAllowedUser:()=>true,
  jsonResponse:(body,status)=>({status,body}),
  gateCall:async(env,path)=>{
   calls.push(path);
   if(path==='/session-get')return {ok:true,json:async()=>({username:'analyst'})};
   if(path==='/quick-ask-acquire')return quotaOk
    ?{ok:true,status:200,json:async()=>({reservation_id:'r1'})}
    :{ok:false,status:429,json:async()=>({error:'Quick question limit reached.'})};
   if(path==='/cache-get')return {ok:true,json:async()=>({hit:false})};
   return {ok:true,json:async()=>({})};
  },
  fetchEventsDatabase:async()=>{calls.push('events');return {ok:true,db:{events}};},
  searchCorpusForQuestion:async()=>{calls.push('archive');return {items:[]};},
  extractGeminiText:async payload=>payload.text,
  fetch:async(url,init)=>{
   calls.push('gemini');
   c.lastGeminiInput=JSON.parse(init.body).input;
   return {ok:true,status:200,json:async()=>({text:JSON.stringify(answer)})};
  }
 });
 vm.runInContext(strip(fs.readFileSync('cloudflare-worker/quick-ask.js','utf8')),c);
 const request=body=>({json:async()=>body,headers:{get:()=>'token'}});
 return {c,calls,ask:body=>c.handleQuickAsk(request({user_id:'analyst',...body}),{})};
}

test('a refused quota costs neither the events fetch nor the archive query',async()=>{
 const h=handlerHarness({quotaOk:false});
 const result=await h.ask({question:'Al-Shabaab attacks in Somalia'});
 assert.equal(result.status,429);
 assert.deepEqual(h.calls,['/session-get','/quick-ask-acquire']);
});

test('citations name the exact record even when two events share an id',async()=>{
 const now=new Date().toISOString();
 const events=[
  {id:'shared-id',title:'Mogadishu hotel attack',summary:'Al-Shabaab attack',country:'Somalia',published:now,category:'Attacks'},
  {id:'shared-id',title:'Kismayo arrests',summary:'Al-Shabaab cell arrested',country:'Somalia',published:now,category:'Arrests'},
 ];
 const answer={answer:'Answer.',grounded_in_ct_atlas_data:true,cited_event_ids:['R02'],cited_context_ids:[]};
 const h=handlerHarness({events,answer});
 const result=JSON.parse(JSON.stringify(await h.ask({question:'Al-Shabaab Somalia'})));
 assert.equal(result.status,200);
 assert.deepEqual(result.body.cited_events.map(e=>[e.id,e.title]),[['shared-id','Kismayo arrests']]);
 const records=JSON.parse(h.c.lastGeminiInput.slice(h.c.lastGeminiInput.indexOf('{'))).ct_atlas_records;
 assert.deepEqual(records.map(r=>r.id).sort(),['R01','R02']);
 assert.ok(h.calls.indexOf('/quick-ask-acquire')<h.calls.indexOf('events'),'quota before the database');
});
