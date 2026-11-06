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

test("the ticker shares one date formatter instead of building one per row",()=>{
  assert.match(html,/const TICKER_TIME_FORMAT = new Intl\.DateTimeFormat\(/);
  assert.match(extract("renderAttackTicker"),/TICKER_TIME_FORMAT\.format\(date\)/);
  assert.doesNotMatch(extract("renderAttackTicker"),/toLocaleString\("en-GB", \{/);
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
  const loopBlock=normBetween("visible.forEach(","markerCluster.addLayers(");
  assert.ok(/\btry\s*\{/.test(loopBlock),"createMarker(event) must be called inside a try block");
  assert.ok(loopBlock.includes("catch (markerError)"),"missing a catch around createMarker(event)");
  assert.ok(loopBlock.includes("console.warn"));
  assert.ok(loopBlock.includes("Skipping unmappable event"));
});

test("markers are added in one bulk addLayers() call so chunkedLoading actually applies",()=>{
  // addLayer() (singular) always inserts synchronously in Leaflet.markercluster -- chunkedLoading
  // only chunks the bulk addLayers() method. Regression guard against reintroducing a per-event
  // markerCluster.addLayer(...) call in the main render loop, which would silence the perf fix below
  // while leaving the chunkedLoading:true option looking like it does something.
  assert.ok(norm.includes("markerCluster.addLayers( newMarkers );"),
    "expected a bulk markerCluster.addLayers(newMarkers) call");
  const clusterOptions=normBetween("const markerCluster = L.markerClusterGroup({","});");
  assert.ok(clusterOptions.includes("chunkedLoading: true"));
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
