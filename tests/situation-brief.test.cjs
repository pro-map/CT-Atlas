const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const html=fs.readFileSync("index.html","utf8");

// The map header has many stacked CSS layers, all with !important. What matters is
// the LAST declaration of each property for the Situation 24H block.
function lastRule(selector){
  const rules=[...html.matchAll(new RegExp("(?:^|\\n)\\s*"+selector.replace(/[#.]/g,"\\$&")+"\\s*\\{([^}]*)\\}","g"))];
  // Comments inside a rule may mention property names; only declarations count.
  return rules.map(match=>match[1].replace(/\/\*[\s\S]*?\*\//g,""));
}
function lastValue(selector,property){
  let value=null;
  for(const body of lastRule(selector)){
    const match=body.match(new RegExp("(?:^|[;\\s])"+property+"\\s*:\\s*([^;!]+?)\\s*(?:!important)?\\s*(?:;|$)"));
    if(match)value=match[1].trim();
  }
  return value;
}

test("Situation 24H brief no longer has a max-height that clips its last line",()=>{
  // The old cap was 80px, but buttons row + title + 3 text lines needed ~86px, so the
  // 3rd line was cut by the bar between the header and the map.
  assert.equal(lastValue("#headerSituationBrief","max-height"),"none");
});

test("Situation 24H text keeps its 3-line clamp (pinned by the deploy workflows)",()=>{
  assert.equal(lastValue("#headerSituationText","-webkit-line-clamp"),"3");
  assert.equal(lastValue("#headerSituationText","max-height"),"42px");
  assert.ok(html.includes("V12 — COMPACT HEADER"));
});

test("Situation 24H title and buttons share one row so the text keeps enough room",()=>{
  assert.equal(lastValue("#headerSituationTopline","flex-direction"),"row");
  assert.equal(lastValue("#headerSituationTopline","justify-content"),"space-between");
  assert.equal(lastValue("#headerSituationActions","width"),"auto");
});
