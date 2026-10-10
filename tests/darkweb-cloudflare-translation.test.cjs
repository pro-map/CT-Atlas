const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('cloudflare-worker/darkweb-translation.js','utf8')
  .replace(/\bexport\s+(?=(async\s+)?function\s)/g,'');
const context=vm.createContext({console,JSON,Set,String,Error});
vm.runInContext(source+'\nglobalThis.testExports={darkwebWorkersAiPermitted,translateDarkwebTitlesWithCloudflare};',context);
const {darkwebWorkersAiPermitted:allowed,translateDarkwebTitlesWithCloudflare:translate}=context.testExports;

const fakeItem = (id='id-1') => ({
  id, title: 'Comunicado número 12 publicado ayer',
  excerpt: 'La publicación indica una actualización.', source_language:'es',
  original_text:'SENSITIVE_FULL_ARTICLE_NEVER_FOR_VENDOR',
  url:'http://'+('a'.repeat(56))+'.onion/secret',
  pdf:'SENSITIVE_PDF_NEVER_FOR_VENDOR',
  operational_note:'INTERPOL_PRIVATE_NEVER_FOR_VENDOR',
});

const cleanText=(s,n)=>String(s||'').replace(/https?:\/\/\S+/g,'[URL redacted]').slice(0,n);

test('Cloudflare translation is OFF by default, even with an AI binding',async()=>{
  const env={AI:{run:async()=>{throw Error('MUST_NOT_CALL');}}};
  assert.equal(allowed(env),false);
  assert.equal(allowed({...env,DARKWEB_TRANSLATION_PROVIDER:'cloudflare'}),false);
  assert.equal(allowed({...env,DARKWEB_EXTERNAL_AI_APPROVED:'true'}),false);
  await assert.rejects(translate(env,[fakeItem()],cleanText),/not authorized/);
});

test('both external approval flags and AI binding are necessary',()=>{
  const flags={DARKWEB_TRANSLATION_PROVIDER:'cloudflare',DARKWEB_EXTERNAL_AI_APPROVED:'true'};
  assert.equal(allowed(flags),false);
  assert.equal(allowed({...flags,AI:{run(){}}}),true);
});

test('authorized small batch sends only title and excerpt, never source files, URLs or internal notes',async()=>{
  const calls=[];
  const env={
    DARKWEB_TRANSLATION_PROVIDER:'cloudflare',
    DARKWEB_EXTERNAL_AI_APPROVED:'true',
    AI:{run:async (model,body)=>{
      calls.push({model,body});
      return {response:JSON.stringify({titles:[{id:'id-1',
        title:'Statement number 12 was published yesterday',
        overview_en:'The fictional statement announces an update.'}]})};
    }},
  };
  const result=await translate(env,[fakeItem()],cleanText);
  assert.equal(result.titles.length,1);
  assert.equal(calls.length,1);
  assert.equal(calls[0].model,'@cf/zai-org/glm-4.7-flash');
  assert.equal(calls[0].body.chat_template_kwargs.enable_thinking,false);
  assert.equal(calls[0].body.response_format.type,'json_object');
  const raw=JSON.stringify(calls[0].body);
  assert.ok(raw.includes('Comunicado'));
  for(const secret of ['SENSITIVE_FULL_ARTICLE','SENSITIVE_PDF',
                       'INTERPOL_PRIVATE','onion/secret'])
    assert.equal(raw.includes(secret),false,'must never pass full source evidence');
});

test('limit 3 prevents unbounded or accidental bulk Dark Web transmission',async()=>{
  let calls=0;
  const env={DARKWEB_TRANSLATION_PROVIDER:'cloudflare',
    DARKWEB_EXTERNAL_AI_APPROVED:'true',AI:{run:async()=>{calls++;}}};
  await assert.rejects(translate(env,[1,2,3,4].map(i=>fakeItem('id-'+i)),cleanText),/batch exceeded/);
  assert.equal(calls,0);
});

test('bad JSON or skipped/duplicate ids does not leak raw response or accept partial saves',async()=>{
  const env={DARKWEB_TRANSLATION_PROVIDER:'cloudflare',
    DARKWEB_EXTERNAL_AI_APPROVED:'true',
    AI:{run:async()=>({response:'UNTRUSTED_PRIVATE_RESPONSE_DO_NOT_LOG'})}};
  await assert.rejects(translate(env,[fakeItem()],cleanText),err=>{
    assert.doesNotMatch(err.message,/UNTRUSTED_PRIVATE_RESPONSE/);return true;
  });
  env.AI.run=async()=>({response:JSON.stringify({titles:[
    {id:'wrong-id',title:'English',overview_en:''}]})});
  await assert.rejects(translate(env,[fakeItem()],cleanText),/invalid title item/);
});

test('Cloudflare title translations cannot silently drop entries',async()=>{
  const env={DARKWEB_TRANSLATION_PROVIDER:'cloudflare',
    DARKWEB_EXTERNAL_AI_APPROVED:'true',
    AI:{run:async()=>({response:JSON.stringify({titles:[{
      id:'id-1',title:'English Title',overview_en:'Neutral overview'}]})})}};
  await assert.rejects(translate(env,[fakeItem(),fakeItem('id-2')],cleanText),/incomplete/);
});
