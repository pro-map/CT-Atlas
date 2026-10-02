// Regression test for a real, live-reported failure: Deep Search's own Gemini call
// (callGeminiJson, used for both the search planner and the final report synthesis) had zero
// retry logic -- any 429/5xx from Gemini failed the whole search immediately. Confirmed live:
// "gemini-3.5-flash-lite is currently experiencing high demand... 503 service_unavailable".
// The Report Generator (shared.js's callGemini) already retries with model alternation and
// backoff for exactly this "temporary overload" class of error; this brings Deep Search's
// callGeminiJson up to the same standard by reusing shared.js's waitBeforeGeminiRetry.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8')
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,'')
  .replace(/export /g,'');
// The model rotation is shared.js's own code, not a stub.
const rotationSource=fs.readFileSync('cloudflare-worker/shared.js','utf8')
  .match(/function geminiModelRotation\([\s\S]*?\r?\n\}\r?\n/)[0];

function harness(fetchImpl){
  const c=vm.createContext({
    fetch:fetchImpl,
    GEMINI_URL:'https://generativelanguage.googleapis.com/v1beta/interactions',
    URL,URLSearchParams,AbortSignal,
    // No real delay in tests -- resolve on the next microtask, same as the recall harness.
    setTimeout:(fn)=>fn(),
    cleanText:(v,n)=>String(v||'').trim().slice(0,n),
    extractGeminiText:async(payload)=>{
      if(Array.isArray(payload?.candidates)){
        return payload.candidates[0].content.parts.map(p=>p.text||'').join('');
      }
      throw new Error('no readable output');
    },
    waitBeforeGeminiRetry:async()=>{},
    GEMINI_SECOND_FALLBACK_MODEL:'gemini-3.1-flash-lite'
  });
  vm.runInContext(rotationSource,c);
  vm.runInContext(source,c);
  return vm.runInContext('({callGeminiJson,DEEP_SEARCH_MODEL,DEEP_SEARCH_FALLBACK_MODEL})',c);
}

function geminiResponse(text,status=200){
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text}]}}]}),{status});
}

test('a single 503 is retried against the fallback model and succeeds',async()=>{
  const calls=[];
  const h=harness(async(url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model);
    if(calls.length===1) return new Response('overloaded',{status:503});
    return geminiResponse(JSON.stringify({answer:'ok'}));
  });
  const result=await h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{answer:'ok'});
  assert.equal(calls.length,2);
  assert.equal(calls[0],h.DEEP_SEARCH_MODEL,'first attempt must use the primary model');
  assert.equal(calls[1],h.DEEP_SEARCH_FALLBACK_MODEL,'the retry must alternate to the fallback model, not hammer the same overloaded one');
});

test('exhausting every retry on repeated 503s throws, mentioning the temporary error',async()=>{
  const h=harness(async()=>new Response('{"error":{"message":"gemini-3.5-flash-lite is currently experiencing high demand","code":"service_unavailable"}}',{status:503}));
  await assert.rejects(
    h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100),
    /temporary error 503/
  );
});

test('a 429 that never clears throws with .code === 429 so the caller maps it to HTTP 429, not 503',async()=>{
  const h=harness(async()=>new Response('rate limited',{status:429}));
  await assert.rejects(
    h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100),
    (error)=>{ assert.equal(error.code,429); assert.match(error.message,/quota\/capacity temporarily unavailable/i); return true; }
  );
});

test('a 429 that clears on retry succeeds like any other transient error',async()=>{
  let calls=0;
  const h=harness(async()=>{
    calls++;
    if(calls===1) return new Response('rate limited',{status:429});
    return geminiResponse(JSON.stringify({answer:'recovered'}));
  });
  const result=await h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{answer:'recovered'});
  assert.equal(calls,2);
});

test('a non-retryable client error (e.g. 400) fails immediately, without retrying',async()=>{
  let calls=0;
  const h=harness(async()=>{ calls++; return new Response('bad request',{status:400}); });
  await assert.rejects(h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100),/Gemini Deep Search error 400/);
  assert.equal(calls,1,'a 400 is not transient -- retrying it would just waste the whole attempt budget on a request that will never succeed');
});

test('malformed JSON in an otherwise-ok response is retried, not a hard crash',async()=>{
  let calls=0;
  const h=harness(async()=>{
    calls++;
    if(calls===1) return geminiResponse('not valid json{{{');
    return geminiResponse(JSON.stringify({answer:'valid on retry'}));
  });
  const result=await h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{answer:'valid on retry'});
  assert.equal(calls,2);
});

test('with the primary and 3.6 Flash out of quota, Deep Search falls back to 3.1 Flash Lite',async()=>{
  const calls=[];
  const h=harness(async(url,init)=>{
    calls.push(JSON.parse(init.body).model);
    if(calls.length<=2) return new Response('quota',{status:429});
    return geminiResponse(JSON.stringify({answer:'third model'}));
  });
  const result=await h.callGeminiJson({GEMINI_API_KEY:'x'},'instr','input',{},100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{answer:'third model'});
  assert.deepEqual(calls,[h.DEEP_SEARCH_MODEL,h.DEEP_SEARCH_FALLBACK_MODEL,'gemini-3.1-flash-lite']);
});
