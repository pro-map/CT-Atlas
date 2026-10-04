const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const html=fs.readFileSync("crypto.html","utf8");
const css=fs.readFileSync("crypto.css","utf8");
const client=fs.readFileSync("crypto.js","utf8");

test("graph playback bar exposes toggle, stop, speed and scrubber controls",()=>{
  for(const id of ["playbackToggle","playbackStop","playbackSpeed","playbackScrubber","playbackStatus"]){
    assert.ok(html.includes('id="'+id+'"'),"missing playback control "+id);
  }
  assert.ok(html.includes('<option value="1400">Slow</option>'));
  assert.ok(html.includes('<option value="600" selected>Normal</option>'));
  assert.ok(html.includes('<option value="150">Fast</option>'));
  assert.ok(css.includes(".crypto-playback-bar"));
});

test("crypto.js defines the full playback engine and wires it into bind()",()=>{
  for(const fn of [
    "function buildPlaybackTimeline","function playbackFrameModel","function updatePlaybackControls",
    "function renderPlaybackFrame","function schedulePlaybackTick","function startPlayback",
    "function pausePlayback","function resumePlayback","function togglePlayback",
    "function stopPlaybackSilently","function stopPlayback","function scrubPlayback"
  ]){
    assert.ok(client.includes(fn),"missing "+fn);
  }
  assert.ok(client.includes('getElementById("playbackToggle")?.addEventListener("click",togglePlayback)'));
  assert.ok(client.includes('getElementById("playbackStop")?.addEventListener("click",stopPlayback)'));
  assert.ok(client.includes('getElementById("playbackScrubber")?.addEventListener("input",event=>scrubPlayback(event.target.value))'));
});

test("renderGraph builds the model and delegates drawing to a pure paintGraphFrame, never letting playback corrupt currentNetworkModel",()=>{
  const renderGraphBody=client.match(/function renderGraph\(payload\)\{[\s\S]*?\n\}/)[0];
  assert.ok(/^function renderGraph\(payload\)\{\s*stopPlaybackSilently\(\);/.test(renderGraphBody),
    "renderGraph must cancel any running playback first, so a normal re-render can never race a playback frame");
  assert.ok(renderGraphBody.includes("currentNetworkModel=model"));
  assert.ok(renderGraphBody.includes("paintGraphFrame(payload,graphDisplayModel)"));
  assert.ok(renderGraphBody.includes("updatePlaybackControls()"));

  const paintFrameBody=client.match(/function paintGraphFrame\(payload,model\)\{[\s\S]*?\n\}/)[0];
  assert.ok(!paintFrameBody.includes("currentNetworkModel="),
    "paintGraphFrame must be a pure drawer: playback frames call it directly and must never overwrite the real model");
});

test("playback timeline derivation mirrors buildNetworkModel's own IN/OUT edge-direction rule",()=>{
  // buildNetworkModel: an IN row's counterparty produces an edge counterparty->source; OUT produces source->counterparty.
  assert.ok(client.includes('if(neighbor.incoming>0)addEdge(neighbor.id,source,neighbor.incoming,assets,childDepth);'));
  assert.ok(client.includes('if(neighbor.outgoing>0)addEdge(source,neighbor.id,neighbor.outgoing,assets,childDepth);'));
  const timelineBody=client.match(/function buildPlaybackTimeline\(model,payload\)\{[\s\S]*?\n\}/)[0];
  assert.ok(timelineBody.includes('const fromKey=direction==="IN"?cpKey:sourceKey;'));
  assert.ok(timelineBody.includes('const toKey=direction==="IN"?sourceKey:cpKey;'));
  // Only rows whose derived edge actually survives in the current (possibly filtered/capped) model are ever revealed.
  assert.ok(timelineBody.includes("edgeKeys.has(key)"));
  assert.ok(timelineBody.includes("allTraceRows(true)"),"must read the same filtered rows every other panel reads, not raw unfiltered transactions");
});

test("stop restores the exact selected graph and updatePlaybackControls disables controls with no active playback",()=>{
  const stopBody=client.match(/function stopPlayback\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(stopBody.includes("stopPlaybackSilently()"));
  assert.ok(stopBody.includes("paintGraphFrame(lastPayload,graphDisplayModel||currentNetworkModel)"));

  const controlsBody=client.match(/function updatePlaybackControls\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(controlsBody.includes('scrubber.max="0"'));
  assert.ok(controlsBody.includes("stop.disabled=true"));
});

test("scrubbing pauses auto-advance instead of racing the playback timer",()=>{
  const scrubBody=client.match(/function scrubPlayback\(index\)\{[\s\S]*?\n\}/)[0];
  assert.ok(scrubBody.includes("pausePlayback()"));
});
