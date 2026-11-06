// A blocked or slow third-party host must not cost the analyst the map. With
// Leaflet on unpkg, a corporate proxy left no map, list or error at all, and a
// hung cdn.sheetjs.com held the data request back 15 s for a library used only
// on export.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");
const main=fs.readFileSync("main.html","utf8");

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

test("the page loads no script or stylesheet from a third-party host at start-up",()=>{
  const tags=[...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/g)].map(match=>match[1]);
  assert.ok(tags.length>=8,"found "+tags.length);
  assert.deepEqual(tags.filter(url=>/^(?:https?:)?\/\//.test(url)),[]);
});

test("every map library is on disk at the version it replaces",()=>{
  for(const file of ["vendor/leaflet-1.9.4/leaflet.js","vendor/leaflet-1.9.4/leaflet.css",
    "vendor/leaflet.markercluster-1.5.3/leaflet.markercluster.js","vendor/leaflet.markercluster-1.5.3/MarkerCluster.css",
    "vendor/leaflet.markercluster-1.5.3/MarkerCluster.Default.css","vendor/leaflet.heat-0.2.0/leaflet-heat.js"]){
    assert.ok(html.includes(`"${file}"`),file+" is not referenced");
    assert.ok(fs.statSync(file).size>500,file);
  }
  assert.match(fs.readFileSync("vendor/leaflet-1.9.4/leaflet.js","utf8"),/version="1\.9\.4"|var version = "1\.9\.4"/);
  // Relative to the stylesheet: a page icon missing here would 404 in production only.
  for(const image of fs.readFileSync("vendor/leaflet-1.9.4/leaflet.css","utf8").matchAll(/url\((images\/[^)]+)\)/g)){
    assert.ok(fs.existsSync("vendor/leaflet-1.9.4/"+image[1]),image[1]);
  }
});

test("the Excel library loads on the first export, once, and a failure can be retried",async()=>{
  assert.doesNotMatch(html,/<script[^>]*sheetjs/);
  const appended=[];
  const c=vm.createContext({Promise,Error,document:{createElement:()=>({}),head:{appendChild:script=>appended.push(script)}}});
  vm.runInContext("let xlsxLoaderPromise = null;"+extract("loadXlsxForExport"),c);
  const first=c.loadXlsxForExport();
  assert.equal(c.loadXlsxForExport(),first,"two clicks share one download");
  appended[0].onerror();
  await assert.rejects(first,/Unable to load the Excel export library/);
  const second=c.loadXlsxForExport();
  assert.equal(appended.length,2,"a failed download is tried again on the next click");
  c.XLSX={};appended[1].onload();
  await second;
  await c.loadXlsxForExport();
  assert.equal(appended.length,2);
});

test("a blocked Excel library tells the analyst and gives the button back",async()=>{
  const messages=[],button={textContent:"EXPORT EXCEL",disabled:false};
  const c=vm.createContext({Promise,console:{error(){}},alert:text=>messages.push(text),
    document:{getElementById:()=>button},selectedDatabaseEvents:()=>[{id:"a"}],databaseExportBlockedText:()=>"blocked",
    loadXlsxForExport:()=>Promise.reject(new Error("offline"))});
  vm.runInContext(extract("exportChronologyExcel"),c);
  const pending=c.exportChronologyExcel();
  assert.equal(button.textContent,"PREPARING…");
  assert.equal(button.disabled,true);
  await pending;
  assert.deepEqual(messages,["The Excel export library could not be loaded."]);
  assert.equal(button.textContent,"EXPORT EXCEL");
  assert.equal(button.disabled,false);
});

test("the map and the hub serve the 20 KB logo, and its version matches the bytes",()=>{
  const logo=fs.readFileSync("CT-ATLAS-256.png");
  assert.ok(logo.length<200*1024,"logo is "+logo.length+" bytes");
  assert.equal(logo.readUInt32BE(16),256,"width in the PNG header");
  const version=crypto.createHash("sha256").update(logo).digest("hex").slice(0,16);
  const urls=[...html.matchAll(/(?:src|href)="(CT-ATLAS[^"]*\.png[^"]*)"/g)].map(match=>match[1]);
  assert.equal(urls.length,3);
  for(const url of urls)assert.equal(url,"CT-ATLAS-256.png?v="+version);
  assert.doesNotMatch(main,/(?:src|href)="CT-ATLAS\.png/);
  assert.match(main,/src="CT-ATLAS-256\.png"/);
});

test("the deploys ship the libraries and the logo",()=>{
  const ui=fs.readFileSync(".github/workflows/deploy-current-ct-atlas-ui.yml","utf8");
  assert.match(ui,/- "vendor\/\*\*"/);
  assert.match(ui,/- "CT-ATLAS-256\.png"/);
  assert.match(ui,/test -s vendor\/leaflet-1\.9\.4\/leaflet\.js/);
  const mirror=fs.readFileSync("tools/deploy_mirror.sh","utf8");
  assert.match(mirror,/cp -R vendor "\$STAGING\/vendor"/);
  assert.match(mirror,/cp CT-ATLAS-256\.png "\$STAGING\/CT-ATLAS-256\.png"/);
});
