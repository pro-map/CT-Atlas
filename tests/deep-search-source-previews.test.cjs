const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

// Regression test for a real, 100%-reproducible crash: "Attach cited article previews to Deep
// Search reports" (commit 389c0cb) put `source_previews: sourcePreviews` into the `dataset`
// object sent to Gemini -- built and used well before `const sourcePreviews = await
// createSourcePreviews(...)` runs later in the same function. Every Deep Search request that
// found at least one piece of evidence hit the object-literal property access immediately and
// threw "Cannot access 'sourcePreviews' before initialization" (a temporal-dead-zone
// ReferenceError), never reaching Gemini at all. Confirmed live: "Maritime incidents in and near
// Djibouti last year".
const source=fs.readFileSync('cloudflare-worker/deep-search.js','utf8');

test('the dataset object built for Gemini does not reference sourcePreviews (it is not computed yet at that point)',()=>{
  const datasetStart=source.indexOf('const dataset = {');
  assert.ok(datasetStart!==-1,'could not find the dataset object literal');
  const datasetEnd=source.indexOf('};',datasetStart);
  const datasetLiteral=source.slice(datasetStart,datasetEnd);
  assert.ok(!datasetLiteral.includes('sourcePreviews'),
    'the Gemini input dataset must not reference sourcePreviews -- it is declared later in the same function scope, so referencing it here is a TDZ ReferenceError on every request that reaches this line');
});

test('sourcePreviews is declared before anything in the function references it',()=>{
  const declIndex=source.indexOf('const sourcePreviews = await createSourcePreviews(');
  assert.ok(declIndex!==-1,'could not find the sourcePreviews declaration');
  const firstUseIndex=source.indexOf('sourcePreviews');
  assert.equal(firstUseIndex,declIndex+'const '.length,
    'the declaration must be the first mention of sourcePreviews in the file; a reference earlier in the same scope would throw before this line ever runs');
});

test('the report actually returned to the client carries source_previews',()=>{
  const reportStart=source.indexOf('const report = {');
  assert.ok(reportStart!==-1,'could not find the report object literal');
  const reportEnd=source.indexOf('\n    };',reportStart);
  const reportLiteral=source.slice(reportStart,reportEnd);
  assert.ok(reportLiteral.includes('source_previews: sourcePreviews'),
    'the client-facing report must carry source_previews -- that was the entire point of the feature, and it was missing even before the crash was fixed');
});

test('the frontend is already wired to read report.source_previews (only the backend was broken)',()=>{
  const client=fs.readFileSync('deep-search.js','utf8');
  assert.ok(client.includes('payload?.source_previews'));
  assert.ok(client.includes('lastPayload.source_previews'));
});
