const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/quick-ask.js','utf8').replace(/^import[\s\S]*?from "\.\/shared.js";\s*/,'').replace(/export /g,'');

function parseEventDate(event){
 const raw=event?.date;
 if(!raw) return null;
 const d=new Date(raw);
 return Number.isNaN(d.getTime())?null:d;
}

function harness(){
 const c=vm.createContext({parseEventDate});
 vm.runInContext(source,c);
 return vm.runInContext('({localEventMatches,quickAskTokens:typeof quickAskTokens!=="undefined"?quickAskTokens:null,QUICK_ASK_VERSION,sanitizeAnswerText})',c);
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
 assert.ok(result.length<=10,`expected at most 10 matches, got ${result.length}`);
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
