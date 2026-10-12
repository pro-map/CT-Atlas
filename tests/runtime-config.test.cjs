const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const config=JSON.parse(fs.readFileSync('ct-atlas-runtime.json','utf8'));
const html=fs.readFileSync('index.html','utf8');
const workflow=fs.readFileSync('.github/workflows/update-map.yml','utf8');

test('runtime configuration is internally consistent',()=>{
  assert.equal(config.ai_selection_threshold,60);
  assert.equal(config.collection_languages,20);
  assert.equal(config.translated_languages,19);
  assert.equal(config.language_codes.length,21);
  assert.equal(config.language_variants,21);
  assert.equal(config.translated_language_variants,20);
  assert.equal(new Set(config.language_codes.map(code=>code.split('-')[0])).size,config.collection_languages);
  assert.ok(config.language_codes.includes('zh') && config.language_codes.includes('zh-Hant'));
  assert.equal(config.retention_days,180);
  assert.deepEqual(config.update_times,['10:17','18:17']);
});

test('UI and collection workflow consume the runtime configuration',()=>{
  for(const id of ['healthSchedule','healthThreshold','healthCollectionLanguages','healthTranslatedLanguages','healthRetention']){
    assert.match(html,new RegExp('id="' + id + '"'));
  }
  assert.match(html,/ct-atlas-runtime\.json/);
  assert.match(workflow,/AI_SELECTION_THRESHOLD[\s\S]*ct-atlas-runtime\.json/);
});


test('status and summary describe configured languages and both Chinese scripts, not completed translations',()=>{
  const vm=require('node:vm');
  const elements={};
  const context={document:{getElementById(id){return elements[id] ||= {textContent:''};}}};
  vm.createContext(context);
  const start=html.indexOf('let ctAtlasRuntimeConfig =');
  const end=html.indexOf('async function loadCtAtlasRuntimeConfig',start);
  assert.ok(start>=0 && end>start);
  vm.runInContext(html.slice(start,end),context);
  context.applyCtAtlasRuntimeConfig(config);
  assert.equal(elements.healthCollectionLanguages.textContent,'20 languages / 21 codes');
  assert.equal(elements.healthTranslatedLanguages.textContent,'19 languages → English');
  assert.equal(elements.railTranslationLanguages.textContent,19);
  assert.match(elements.healthStatusNote.textContent,/configured searches, not completed coverage/);
  assert.match(html,/id="railTranslationLanguages"/);
});
