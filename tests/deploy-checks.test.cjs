// The UI deploy (deploy-current-ct-atlas-ui.yml) refuses to publish when one of
// its `grep -q` checks fails -- after the merge, where nobody sees it. Every
// positive check runs here too, so a pull request that removes a checked
// element fails its own tests instead of silently blocking the next deploys.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {execFileSync}=require("node:child_process");

const workflow=fs.readFileSync(".github/workflows/deploy-current-ct-atlas-ui.yml","utf8");
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
