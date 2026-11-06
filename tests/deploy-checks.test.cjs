// The UI deploy (deploy-current-ct-atlas-ui.yml) refuses to publish when one of
// its `grep -q` checks fails -- after the merge, where nobody sees it. Every
// positive check runs here too, so a pull request that removes a checked
// element fails its own tests instead of silently blocking the next deploys.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {execFileSync}=require("node:child_process");

// Normalised: a Windows checkout (core.autocrlf) has CRLF line endings.
const workflow=fs.readFileSync(".github/workflows/deploy-current-ct-atlas-ui.yml","utf8").replace(/\r\n/g,"\n");
const checks=workflow.split("\n").map(line=>line.trim()).filter(line=>/^grep -q /.test(line));

test("the deploy workflow has its grep checks",()=>{
  assert.ok(checks.length>=40,"found "+checks.length+" checks");
});

test("every check of the UI deploy passes on this tree",()=>{
  const failing=checks.filter(line=>{
    try{execFileSync("bash",["-c",line],{stdio:"ignore"});return false;}catch(_){return true;}
  });
  assert.deepEqual(failing,[],"these deploy checks fail, so the site would not be published");
});

test("every file the deploy checks or syntax-checks exists",()=>{
  const files=new Set();
  for(const line of workflow.split("\n")){
    const check=line.trim().match(/^node --check (\S+)/);
    if(check)files.add(check[1]);
  }
  for(const file of files)assert.ok(fs.existsSync(file),file);
});


test("every page asks for one version of a shared script, the one live-smoke pins",()=>{
  const versions=new Map();
  for(const page of ["index.html","main.html","crypto.html","sound-check.html","privacy.html"]){
    for(const [,script,version] of fs.readFileSync(page,"utf8").matchAll(/src="([\w-]+\.js)\?v=([^"]+)"/g)){
      if(!versions.has(script))versions.set(script,new Set());
      versions.get(script).add(version);
    }
  }
  for(const [script,seen] of versions)assert.equal(seen.size,1,script+": "+[...seen].join(", "));
  const smoke=fs.readFileSync(".github/workflows/live-smoke.yml","utf8");
  const pins=[...smoke.matchAll(/([\w-]+\.js)\?v=([\w-]+)/g)];
  assert.ok(pins.length>0);
  for(const [,script,version] of pins)assert.ok(versions.get(script)?.has(version),script+" is pinned at "+version);
});

test("the UI deploy runs the whole Node suite before it publishes",()=>{
  // Map and Database logic inline in index.html is tested only by this suite.
  const steps=workflow.split(/\n      - /);
  const suite=steps.findIndex(step=>/^\s*run: node --test tests\/\*\.test\.cjs\s*$/m.test(step));
  const configure=steps.findIndex(step=>step.startsWith("name: Configure GitHub Pages"));
  assert.ok(suite>0,"node --test tests/*.test.cjs step is missing");
  assert.ok(configure>suite,"the suite must pass before Pages is configured");
});

test("the UI deploy watches the pages it publishes that had no trigger",()=>{
  const paths=workflow.match(/^    paths:\n((?:      - .*\n)+)/m)[1];
  for(const file of ["privacy.html","robots.txt","CT-ATLAS.png"])assert.ok(paths.includes(`- "${file}"`),file);
});

test("UI publication shares the data-update lock from checkout through deployment",()=>{
  const daily=fs.readFileSync(".github/workflows/update-map.yml","utf8").replace(/\r\n/g,"\n");
  const concurrency=source=>source.match(/^concurrency:\n([\s\S]*?)(?=^\S)/m)?.[1]||"";
  for(const source of [workflow,daily]){
    assert.match(concurrency(source),/group: ct-map-update-main/);
    assert.match(concurrency(source),/cancel-in-progress: false/);
    assert.match(concurrency(source),/queue: max/);
  }
});
