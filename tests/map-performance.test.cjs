const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");
// This file writes one token per line; collapse whitespace so substring checks below don't
// depend on the exact line-wrapping style used at any given spot.
const norm=html.replace(/\s+/g," ");

function normBetween(startMarker,endMarker){
  const start=norm.indexOf(startMarker);
  assert.ok(start!==-1,"could not find start marker: "+startMarker);
  const end=norm.indexOf(endMarker,start+startMarker.length);
  assert.ok(end!==-1,"could not find end marker after start: "+endMarker);
  return norm.slice(start,end);
}

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

// The page froze 3-4 s on a fast desktop, about 30 s on a phone-class CPU, at load
// and on every minute tick: 16,464 formatters per pass on 6,381 events.
function parisDayContext(nowIso){
  let built=0,formatted=0,now=Date.parse(nowIso);
  class Clock extends Date { constructor(...args){if(args.length)super(...args);else super(now);} static now(){return now;} }
  class Counting extends Intl.DateTimeFormat {
    constructor(...args){super(...args);built++;}
    formatToParts(date){formatted++;return super.formatToParts(date);}
  }
  const c=vm.createContext({Date:Clock,Intl:{DateTimeFormat:Counting},Map,Number,Math});
  const start=html.indexOf("const PARIS_DAY_FORMAT");
  vm.runInContext(html.slice(start,html.indexOf("function parisCalendarDateString(",start))+
    extract("parisCalendarDateString")+extract("shiftCalendarDateString")+
    html.slice(html.indexOf("let parisYesterdayMinute"),html.indexOf("function parisYesterdayDateString("))+
    extract("parisYesterdayDateString"),c);
  return {c,counts:()=>({built,formatted}),at:iso=>{now=Date.parse(iso);},Clock};
}

test("one pass over thousands of events builds one Intl formatter and formats each timestamp once",()=>{
  const h=parisDayContext("2026-11-06T11:00:30Z");
  const published=Array.from({length:6381},(_,i)=>new h.Clock(Date.UTC(2026,5,1)+i*3600000));
  for(let pass=0;pass<3;pass++)for(const date of published){h.c.parisCalendarDateString(date);h.c.parisYesterdayDateString();}
  const counts=h.counts();
  assert.equal(counts.built,1);
  assert.equal(counts.formatted,published.length+1,"each event once, plus the clock once");
});

test("cached Paris days stay exact across midnight and both clock changes",()=>{
  const reference=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"});
  const h=parisDayContext("2026-11-06T11:00:00Z");
  for(const iso of ["2026-03-28T22:59:59Z","2026-03-28T23:00:00Z","2026-03-29T00:59:59Z","2026-03-29T01:00:00Z","2026-10-24T21:59:59Z",
    "2026-10-24T22:00:00Z","2026-10-25T00:59:59Z","2026-10-25T01:00:00Z","2026-11-05T22:59:59Z","2026-11-05T23:00:00Z"]){
    for(let repeat=0;repeat<2;repeat++)assert.equal(h.c.parisCalendarDateString(new h.Clock(iso)),reference.format(new Date(iso)),iso);
  }
  assert.equal(h.c.parisCalendarDateString(new h.Clock("not a date")),"");
  assert.equal(h.c.parisCalendarDateString("2026-11-05"),"");
});

test("yesterday in Paris follows the clock over midnight in the same minute it changes",()=>{
  const h=parisDayContext("2026-11-05T22:59:30Z");
  assert.equal(h.c.parisYesterdayDateString(),"2026-11-04");
  h.at("2026-11-05T22:59:59Z");
  assert.equal(h.c.parisYesterdayDateString(),"2026-11-04");
  h.at("2026-11-05T23:00:00Z");
  assert.equal(h.c.parisYesterdayDateString(),"2026-11-05");
});

test("the day cache of a tab left open for weeks stays bounded",()=>{
  const h=parisDayContext("2026-11-06T11:00:00Z");
  const limit=vm.runInContext("PARIS_DAY_CACHE_LIMIT",h.c);
  for(let i=0;i<limit+5;i++)h.c.parisCalendarDateString(new h.Clock(Date.UTC(2026,0,1)+i*1000));
  assert.ok(vm.runInContext("parisDayByTimestamp.size",h.c)<=limit);
});

test("the heat layer can never abort refreshDashboard(): its construction is wrapped in try/catch",()=>{
  const heatBlock=normBetween("if ( showHeat","const totalSelected =");
  assert.ok(/\btry\s*\{/.test(heatBlock),"heat layer construction must be inside a try block");
  assert.ok(heatBlock.includes("catch (heatError)"),"missing a catch for the heat layer");
  assert.ok(heatBlock.includes("heatLayer = null;"),
    "on failure heatLayer must be reset to null, not left pointing at a half-built layer");
  // Regression guard: a 0-height map container at init throws IndexSizeError inside leaflet.heat's
  // own draw(); this must be a caught warning, never an uncaught exception that skips every call
  // after renderEvents() in refreshDashboard() (updateCoverage, updateTrends, renderChronology...).
  assert.ok(heatBlock.includes("console.warn"));
  assert.ok(heatBlock.includes("Heat layer unavailable for this render"));
});

test("a single malformed event can never abort marker rendering for every event after it",()=>{
  const loopBlock=normBetween("visible.forEach(","addMarkersInChunks(");
  assert.ok(/\btry\s*\{/.test(loopBlock),"createMarker(event) must be called inside a try block");
  assert.ok(loopBlock.includes("catch (markerError)"),"missing a catch around createMarker(event)");
  assert.ok(loopBlock.includes("console.warn"));
  assert.ok(loopBlock.includes("Skipping unmappable event"));
});

test("markers go in bulk, in slices this page can cancel, not through the plugin's chunkedLoading",()=>{
  // addLayer() (singular) refreshes the clusters per marker. Regression guard against
  // reintroducing a per-event call in the main render loop. The plugin's chunkedLoading cannot be
  // cancelled by clearLayers(): at 4x CPU, 6 MONTHS then 24H left 2,243-3,843 markers where 6 belonged.
  assert.ok(norm.includes("addMarkersInChunks( newMarkers );"),"expected the bulk slice loader");
  assert.ok(!/markerCluster\.addLayer\(/.test(norm));
  const clusterOptions=normBetween("const markerCluster = L.markerClusterGroup({","});");
  assert.ok(!clusterOptions.includes("chunkedLoading"));
});

function chunkHarness(){
  const added=[],timers=[];
  const c=vm.createContext({markerCluster:{addLayers:layers=>added.push(...layers)},setTimeout:callback=>timers.push(callback)});
  const start=html.indexOf("const MARKER_CHUNK_SIZE");
  vm.runInContext(html.slice(start,html.indexOf("function addMarkersInChunks(",start))+extract("addMarkersInChunks"),c);
  return {c,added,timers,flush(){while(timers.length)timers.shift()();}};
}

test("a large period reaches the map in full, slice by slice",()=>{
  const h=chunkHarness();
  const markers=Array.from({length:6037},(_,index)=>index);
  h.c.addMarkersInChunks(markers);
  assert.equal(h.added.length,vm.runInContext("MARKER_CHUNK_SIZE",h.c),"the first slice goes in at once");
  h.flush();
  assert.deepEqual(h.added,markers);
});

test("a small period reaches the map in the same tick, with no timer",()=>{
  const h=chunkHarness();
  h.c.addMarkersInChunks([1,2,3,4,5,6]);
  assert.equal(h.added.length,6);
  assert.equal(h.timers.length,0);
});

test("a newer render ends the older one: 6 MONTHS then 24H leaves only the 24H markers",()=>{
  const h=chunkHarness();
  h.c.addMarkersInChunks(Array.from({length:6037},(_,index)=>"old"+index));
  h.added.length=0;
  vm.runInContext("markerRenderGeneration += 1",h.c);
  h.c.addMarkersInChunks(["a","b","c","d","e","f"]);
  h.flush();
  assert.deepEqual(h.added,["a","b","c","d","e","f"]);
});

test("renderEvents cancels pending slices before it clears the cluster",()=>{
  const body=extract("renderEvents");
  assert.ok(body.indexOf("markerRenderGeneration += 1")<body.indexOf("markerCluster.clearLayers()"));
});

function agingHarness(){
  let draws=0;
  const c=vm.createContext({renderEvents(){draws++;},updateCoverage(){},updateTopLocations(){}});
  vm.runInContext("let mapPopupOpen = false; let mapSpiderfied = false; let mapRebuildDeferred = true;"+extract("rebuildAgedMap"),c);
  return {c,draws:()=>draws,set:code=>vm.runInContext(code,c)};
}

test("an event ageing out waits for an open popup or a spiderfied stack, then the map catches up",()=>{
  // Verified live: an open popup closed by itself about every 15 minutes.
  const h=agingHarness();
  h.set("mapPopupOpen = true");
  h.c.rebuildAgedMap();
  assert.equal(h.draws(),0);
  h.set("mapPopupOpen = false; mapSpiderfied = true");
  h.c.rebuildAgedMap();
  assert.equal(h.draws(),0);
  h.set("mapSpiderfied = false");
  h.c.rebuildAgedMap();
  assert.equal(h.draws(),1);
  h.c.rebuildAgedMap();
  assert.equal(h.draws(),1,"once per change");
});

test("closing a popup lets a waiting rebuild run, after the next popup had the chance to open",()=>{
  assert.match(html,/map\.on\("popupclose", \(\) => \{ mapPopupOpen = false; setTimeout\(rebuildAgedMap, 0\); \}\);/);
  assert.match(html,/markerCluster\.on\("unspiderfied", \(\) => \{ mapSpiderfied = false; setTimeout\(rebuildAgedMap, 0\); \}\);/);
  assert.match(extract("refreshTimeSensitiveDashboard"),/mapRebuildDeferred = true;\s*rebuildAgedMap\(\);/);
});

test("a marker still waiting for its slice falls back to centring the map instead of throwing",()=>{
  assert.match(extract("focusChronologyEvent"),/!marker\s*\|\|\s*!markerCluster\.hasLayer\(\s*marker\s*\)/);
});

test("both basemap tile layers keep a larger tile buffer and skip mid-zoom refetches",()=>{
  const baseBlock=normBetween("const englishBaseLayer = L.tileLayer(","addTo( map );");
  const afterBase=norm.indexOf("addTo( map );",norm.indexOf("const englishBaseLayer ="))+"addTo( map );".length;
  const refBlock=normBetween("const englishReferenceLayer = L.tileLayer(","addTo( map );");
  assert.ok(norm.indexOf("const englishReferenceLayer =")>afterBase,"reference layer must be defined after the base layer");
  for(const block of [baseBlock,refBlock]){
    assert.ok(block.includes("TILE_LOAD_TUNING"),"tile layer must spread the shared load-tuning options");
  }
  assert.ok(norm.includes("keepBuffer: 6"));
  assert.ok(norm.includes("updateWhenZooming: false"));
});
