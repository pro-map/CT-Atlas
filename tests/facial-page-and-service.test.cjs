const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");

const read=file=>fs.readFileSync(file,"utf8");

// ---------------------------------------------------------------- layout: results at the top, not 1500 px down

test("hidden elements really are hidden: the empty placeholder no longer pushes the report down the page",()=>{
  const css=read("facial.css");
  // .empty{display:flex} (an author rule) overrides the browser's [hidden] rule, so without this the placeholder
  // stayed on screen, ~1500 px tall, above the report.
  assert.match(css,/\.empty\{[^}]*display:flex/,"the rule that used to defeat [hidden]");
  assert.match(css,/\[hidden\]\{display:none!important\}/);
  const js=read("facial.js");
  assert.ok(js.includes('$("fiEmpty").hidden=true'),"render() hides the placeholder with the hidden attribute");
  const html=read("facial.html");
  assert.match(html,/<div id="fiEmpty" class="empty">/);
  assert.match(html,/<div id="fiReport" hidden>/);
});

test("on narrow screens (results stacked under the form) the report is scrolled into view after an analysis",()=>{
  const js=read("facial.js");
  assert.match(js,/scrollIntoView\(\{behavior:"smooth",block:"start"\}\)/);
  assert.ok(js.indexOf("scrollIntoView")<js.indexOf("CTAtlasFaceCrops?.attach"),"before the crops are cut");
});

// ---------------------------------------------------------------- the face table

test("the face table shows the detector's confidence and its narrow-screen column hiding still targets Sharpness and Brightness",()=>{
  const js=read("facial.js");
  const head=js.match(/<thead><tr>(.*?)<\/tr><\/thead>/)[1];
  const columns=[...head.matchAll(/<th>([^<]+)<\/th>/g)].map(m=>m[1]);
  assert.deepEqual(columns,["Crop","Face","Confidence","Quality","Sharpness","Brightness","Image area","Actions"]);
  assert.ok(js.includes("f.detection_score"));
  const css=read("facial.css");
  const hidden=[...css.matchAll(/\.face-table th:nth-child\((\d+)\)/g)].map(m=>Number(m[1]));
  assert.deepEqual([...new Set(hidden)].sort(),[5,6].sort(),"nth-child(5) and (6) = Sharpness and Brightness");
  assert.equal(columns[4],"Sharpness");
  assert.equal(columns[5],"Brightness");
  // Each row has as many cells as the header has columns.
  const row=js.match(/faces\.map\(f=>\{.*?return '<tr>(.*?)<\/tr>'/s)[1];
  assert.equal((row.match(/<td/g)||[]).length,columns.length);
});

// ---------------------------------------------------------------- cache busting

test("the page loads the changed assets under new version numbers so cached copies are not reused",()=>{
  const html=read("facial.html");
  assert.match(html,/facial\.css\?v=([5-9]|\d{2,})"/);
  assert.match(html,/facial-crops\.js\?v=([4-9]|\d{2,})"/);
  assert.match(html,/facial\.js\?v=([4-9]|\d{2,})"/);
});

// ---------------------------------------------------------------- the face detection service

test("the service image ships the pinned detector model, and the pin matches the file",()=>{
  const source=read("visual-intel-service/app.py");
  const pinned=source.match(/YUNET_SHA256 = "([0-9a-f]{64})"/)[1];
  const model=fs.readFileSync("visual-intel-service/models/face_detection_yunet_2023mar.onnx");
  assert.equal(crypto.createHash("sha256").update(model).digest("hex"),pinned);
  assert.ok(model.length>100_000&&model.length<400_000);
  assert.match(read("visual-intel-service/Dockerfile"),/^COPY models \.\/models$/m);
});

test("the detector is YuNet with a landmark check; the profile cascade that reported body parts is gone; no identity or embedding",()=>{
  const source=read("visual-intel-service/app.py");
  assert.ok(source.includes("cv2.FaceDetectorYN.create"));
  assert.ok(source.includes("_plausible_face("));
  assert.ok(!source.includes("haarcascade_profileface"));
  assert.match(source,/"identity_recognition": False/);
  assert.match(source,/"biometric_embeddings": False/);
  for(const forbidden of ["FaceRecognizerSF","face_recognition","embedding_vector"])assert.ok(!source.includes(forbidden),forbidden);
  assert.match(source,/SERVICE_VERSION = "ct-atlas-visual-intel-v2"/);
});

test("deployment runs the detector tests in the built image before pushing it, then checks a real portrait on the live service",()=>{
  const wf=read(".github/workflows/deploy-visual-intel.yml");
  const test_=wf.indexOf("python /tests/visual_intel_detector_test.py");
  assert.ok(test_>-1);
  assert.ok(test_>wf.indexOf("docker build")&&test_<wf.indexOf("docker push"),"tested after the build and before the push");
  assert.match(wf,/"tests\/visual_intel_detector_test\.py"/);
  assert.match(wf,/"tests\/fixtures\/\*\*"/);
  assert.match(wf,/"face_detection":"yunet_2023mar"/);
  assert.match(wf,/astronaut\.jpg/);
  assert.match(wf,/face_count"\] == 1/);
  assert.ok(fs.statSync("tests/fixtures/astronaut.jpg").size>20_000);
});
