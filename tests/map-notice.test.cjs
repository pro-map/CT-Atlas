const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8").replace(/\r\n/g,"\n");
const source=html.match(/function updateMapNotice\(published, now = Date\.now\(\)\) \{[\s\S]*?\nsetInterval\(\(\) => updateMapNotice\(\), 60000\);/)[0];

function notice(){
  const element={hidden:true,textContent:""};
  const timers=[];
  const context=vm.createContext({
    document:{getElementById:id=>id==="mapNotice"?element:null},
    setInterval:(fn,ms)=>timers.push({fn,ms})
  });
  vm.runInContext(source,context);
  return {element,timers,update:(...args)=>vm.runInContext("updateMapNotice",context)(...args)};
}
const at=iso=>Date.parse(iso);

test("the map has the notice element, red and hidden until the script decides",()=>{
  assert.match(html,/<div id="mapNotice" role="status" hidden><\/div>\n\n    <div id="map"><\/div>/);
  assert.match(html,/#mapNotice \{[\s\S]*?background: #b3121b;[\s\S]*?animation: mapNoticeBlink/);
  assert.match(html,/@media \(prefers-reduced-motion: reduce\) \{\n    #mapNotice \{\n        animation: none;/);
});

test("it shows until a collection published after 09:00 Paris reaches the map",()=>{
  const {element,update}=notice();
  update(at("2026-11-24T04:00:46Z"),at("2026-11-24T07:45:00+01:00"));
  assert.equal(element.hidden,false);
  assert.match(element.textContent,/between 9:00 and 10:00 \(Paris time\)/);
  update(at("2026-11-24T04:00:46Z"),at("2026-11-24T09:55:00+01:00"));
  assert.equal(element.hidden,false);
  update(at("2026-11-24T09:48:00+01:00"),at("2026-11-24T09:55:00+01:00"));
  assert.equal(element.hidden,true);
});

test("it hides itself at noon even if no new collection arrived",()=>{
  const {element,update}=notice();
  update(at("2026-11-24T04:00:46Z"),at("2026-11-24T11:59:00+01:00"));
  assert.equal(element.hidden,false);
  update(at("2026-11-24T04:00:46Z"),at("2026-11-24T12:00:00+01:00"));
  assert.equal(element.hidden,true);
  update(null,at("2026-11-25T08:00:00+01:00"));
  assert.equal(element.hidden,true);
});

test("the page calls it with each publication and rechecks it every minute",()=>{
  const {element,timers,update}=notice();
  assert.equal(timers.length,1);
  assert.equal(timers[0].ms,60000);
  assert.ok(html.includes("updateMapNotice(dataPublishedTime(mapDataFacts));"));
  // The minute timer passes no date and keeps the last publication it was given.
  update(at("2026-11-24T09:48:00+01:00"),at("2026-11-24T09:55:00+01:00"));
  update(undefined,at("2026-11-24T09:56:00+01:00"));
  assert.equal(element.hidden,true);
});

test("a call before any publication was read shows the notice instead of failing",()=>{
  const {element,update}=notice();
  update(undefined,at("2026-11-24T07:30:00+01:00"));
  assert.equal(element.hidden,false);
});
