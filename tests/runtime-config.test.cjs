const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const config=JSON.parse(fs.readFileSync('ct-atlas-runtime.json','utf8'));
const html=fs.readFileSync('index.html','utf8');
const workflow=fs.readFileSync('.github/workflows/update-map.yml','utf8');

test('runtime configuration is internally consistent',()=>{
  assert.equal(config.ai_selection_threshold,60);
  assert.equal(config.collection_languages,12);
  assert.equal(config.translated_languages,11);
  assert.equal(config.language_codes.length,12);
  assert.equal(config.retention_days,180);
  assert.deepEqual(config.update_times,['10:17','18:17']);
});

test('UI and collection workflow consume the runtime configuration',()=>{
  for(const id of ['healthSchedule','healthThreshold','healthCollectionLanguages','healthTranslatedLanguages','healthRetention']){
    assert.match(html,new RegExp('id="' + id + '"'));
  }
  assert.match(html,/ct-atlas-runtime\.json/);
  assert.match(workflow,/AI_SELECTION_THRESHOLD=.*ct-atlas-runtime\.json/);
});
