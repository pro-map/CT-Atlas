// The owner wants one agency's name out of everything a public visitor can
// read: GitHub shows every tracked file, and ct-atlas.com publishes the whole
// repository. This test fails if the name comes back in code, configuration,
// tests or docs, or in any file name.
//
// Collected data is exempt: press articles, their archives and caches, and the
// files the bots rewrite, which can quote an article on any day. Blocking a
// deploy because a news story names the agency would stop the map.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');

// Spelled from character codes so that this file does not contain it either.
const NAME=String.fromCharCode(105,110,116,101,114,112,111,108);
const pattern=new RegExp(NAME,'i');

const TEXT=/\.(html|js|mjs|cjs|css|py|yml|yaml|md|txt|toml|sh|svg|patch)$|(^|\/)\.git(ignore|attributes)$/;
const DATA_DIRS=/^(archive|data|quota|tests\/fixtures)\//;
// Hand-maintained JSON: keyword lists and runtime pins.
const CONFIG_JSON=new Set([
  '.claude/launch.json',
  'bio-monitoring-keywords.json',
  'chinese-map-backfill-queries.json',
  'ct-atlas-runtime.json',
  'radnuc-background-keywords.json',
  'radnuc-keywords.json',
  'threat-category-keywords.json',
  'tools/events-lite-excluded-fields.json',
]);

const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);

test('no tracked file name contains the name',()=>{
  assert.deepEqual(tracked.filter(path=>pattern.test(path)),[]);
});

test('code, configuration, tests and docs do not contain the name',()=>{
  const checked=tracked.filter(path=>!DATA_DIRS.test(path)&&(TEXT.test(path)||CONFIG_JSON.has(path)));
  assert.ok(checked.length>100,'the scan reaches the code');
  assert.ok(checked.includes('index.html')&&checked.includes('collector.py'));
  const hits=checked.filter(path=>fs.existsSync(path)&&pattern.test(fs.readFileSync(path,'utf8')));
  assert.deepEqual(hits,[],'remove the name or move the file to a data location');
});
