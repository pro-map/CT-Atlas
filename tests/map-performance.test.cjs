const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

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
