// Audit, 6 Nov, at 390x844: #map was 230 px wide, the right 160 px of the screen was
// empty, the sidebar covered x=7-198 leaving about 32 px of map, all 9 sampled points
// hit sidebar controls, and the zoom buttons sat under the sidebar with no way to hide it.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8").replace(/\r\n/g,"\n");

function extract(name){
  const start=html.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  let depth=0,i=html.indexOf("{",start);
  for(;i<html.length;i++){
    if(html[i]==="{")depth++;
    else if(html[i]==="}"&&--depth===0)break;
  }
  return html.slice(start,i+1);
}

const phoneBlock=html.slice(html.indexOf("PORTRAIT PHONE"),html.indexOf("</style>",html.indexOf("PORTRAIT PHONE")));

test("the phone rule comes after both !important desktop grids, so it wins",()=>{
  const grids=[...html.matchAll(/grid-template-columns: (?:250|230)px minmax\(0, 1fr\) !important;/g)];
  assert.equal(grids.length,2);
  const phone=html.indexOf("grid-template-columns: minmax(0, 1fr) !important;",html.indexOf("PORTRAIT PHONE"));
  assert.ok(phone>grids[1].index,"the map would stay 230 px wide");
  assert.match(phoneBlock,/@media \(max-width: 640px\) \{\n    #main \{\n        grid-template-columns: minmax\(0, 1fr\) !important;/);
});

test("on a phone the panel starts closed, and only on a phone",()=>{
  assert.match(phoneBlock,/body:not\(\.sidebar-open\) #sidebar \{\n        display: none !important;/);
  const media=phoneBlock.indexOf("@media (max-width: 640px)");
  assert.ok(phoneBlock.indexOf("body:not(.sidebar-open)")>media,"it must not hide the desktop sidebar");
  assert.match(html,/<body class="locked" data-ct-tab="map">/,"no sidebar-open class to begin with");
  assert.match(phoneBlock,/#sidebarToggle \{\n    display: none;/,"the button is for phones");
});

test("the panel opens from its own button, which says what it will do",()=>{
  const body={classes:new Set(),classList:{toggle(name,on){on?body.classes.add(name):body.classes.delete(name);},contains:name=>body.classes.has(name)}};
  const toggle={attributes:{},setAttribute(key,value){this.attributes[key]=value;},textContent:"FILTERS"};
  const c=vm.createContext({document:{body,getElementById:()=>toggle},String});
  vm.runInContext(extract("setPhoneSidebarOpen"),c);
  c.setPhoneSidebarOpen(true);
  assert.ok(body.classes.has("sidebar-open"));
  assert.equal(toggle.attributes["aria-expanded"],"true");
  assert.equal(toggle.textContent,"CLOSE");
  c.setPhoneSidebarOpen(false);
  assert.ok(!body.classes.has("sidebar-open"));
  assert.equal(toggle.attributes["aria-expanded"],"false");
  assert.equal(toggle.textContent,"FILTERS");
  assert.match(html,/<button id="sidebarToggle" type="button" aria-controls="sidebar" aria-expanded="false">FILTERS<\/button>/);
});

test("the zoom control moves clear of the panel on a phone and back on a wider screen",()=>{
  const positions=[];let resized=0;
  const phoneLayout={matches:true};
  const c=vm.createContext({phoneLayout,map:{zoomControl:{setPosition:position=>positions.push(position)},invalidateSize(){resized++;}}});
  vm.runInContext(extract("applyPhoneLayout"),c);
  c.applyPhoneLayout();
  phoneLayout.matches=false;
  c.applyPhoneLayout();
  assert.deepEqual(positions,["topright","topleft"]);
  assert.equal(resized,2,"Leaflet must learn the new width");
  assert.match(html,/phoneLayout\.addEventListener\("change", applyPhoneLayout\);\napplyPhoneLayout\(\);/);
});

test("the Deep Search panel cannot take the map's height while its stylesheet loads",()=>{
  // Measured: for one frame #deepSearchPanel stood in the flow at 320 px on a desktop and
  // 740 px at 360x740, so #main fell to 487 and 0. Leaflet kept that size on about half of
  // the loads: 6 tiles instead of 18, and an IndexSizeError from leaflet.heat on each zoom.
  const rule=html.indexOf("#deepSearchPanel:not(.open) {\n    display: none;");
  assert.ok(rule>=0);
  assert.ok(rule<html.indexOf("<body"),"in the page's own stylesheet, which is there before the panel is");
  const css=fs.readFileSync("deep-search.css","utf8");
  assert.match(css,/#deepSearchPanel\.open\{display:flex\}/,"opening it must still win");
});

test("the status line uses the width of the phone instead of 72 px",()=>{
  assert.match(phoneBlock,/#updated \{\n        flex: 1 1 100% !important;\n        min-width: 0 !important;\n        max-width: none !important;/);
});
