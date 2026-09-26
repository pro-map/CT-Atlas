const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const h=require("../facial-crops.js");
const read=file=>fs.readFileSync(file,"utf8");

test("paddedBox adds a margin relative to the face size and never leaves the image",()=>{
  assert.deepEqual(h.paddedBox({x:100,y:100,w:100,h:100},0,1000,800),{x:100,y:100,w:100,h:100},"tight = the detected box");
  assert.deepEqual(h.paddedBox({x:100,y:100,w:100,h:100},0.3,1000,800),{x:70,y:70,w:160,h:160});
  // near the top-left corner: clamped at 0, not negative
  assert.deepEqual(h.paddedBox({x:10,y:5,w:100,h:100},0.6,1000,800),{x:0,y:0,w:170,h:165});
  // near the bottom-right corner: clamped to the image size
  const corner=h.paddedBox({x:950,y:750,w:40,h:40},0.6,1000,800);
  assert.equal(corner.x+corner.w,1000);
  assert.equal(corner.y+corner.h,800);
  // degenerate input still yields a valid, non-empty area
  assert.ok(h.paddedBox({x:0,y:0,w:0,h:0},0.3,10,10).w>=1);
});

test("outputSize upscales small crops to 300px (capped at 6x), leaves large ones alone, and can be disabled",()=>{
  assert.deepEqual(h.outputSize(149,149,true),{w:300,h:300,scale:300/149});
  assert.equal(h.outputSize(500,400,true).scale,1);
  assert.equal(h.outputSize(40,20,true).scale,h.MAX_UPSCALE,"a tiny crop is not blown up more than 6x");
  assert.deepEqual(h.outputSize(149,149,false),{w:149,h:149,scale:1});
  const wide=h.outputSize(200,100,true);
  assert.equal(wide.w,300);assert.equal(wide.h,150,"aspect ratio is preserved");
});

test("mapBoxToSource trusts the service's boxes only when the browser decoded the same geometry",()=>{
  const frame={width:1000,height:640};
  const box={x:198,y:133,w:93,h:93};
  assert.deepEqual(h.mapBoxToSource(box,frame,1000,640),box,"same dimensions: unchanged");
  assert.deepEqual(h.mapBoxToSource(box,frame,2000,1280),{x:396,y:266,w:186,h:186},"same shape at another resolution: scaled");
  assert.equal(h.mapBoxToSource(box,frame,640,1000),null,"rotated (EXIF/metadata mismatch): refuse rather than cut the wrong area");
  assert.equal(h.mapBoxToSource(box,frame,1000,900),null,"different aspect ratio: refuse");
  assert.equal(h.mapBoxToSource(box,{width:0,height:0},1000,640),null);
});

test("file names are safe, informative and unique",()=>{
  assert.equal(h.safeStem("Photo Été 2026 (1).JPG"),"Photo_Ete_2026_1");
  assert.equal(h.safeStem("../../etc/passwd"),"etc_passwd","path separators can never survive into a download name");
  assert.ok(!/[\\/:*?"<>|\s]/.test(h.safeStem("a/b\\c:d*e?f")));
  assert.equal(h.safeStem(""),"media");
  assert.equal(h.safeStem("....."),"media");
  assert.equal(h.cropFileName("test faces.jpg",{face_id:2},null),"CTAtlas_test_faces_F2.jpg");
  assert.equal(h.cropFileName("clip.mp4",{face_id:1},12.5),"CTAtlas_clip_t12p5s_F1.jpg","video crops carry their timestamp");
  const used=new Set();
  assert.equal(h.uniqueName("a.jpg",used),"a.jpg");
  assert.equal(h.uniqueName("a.jpg",used),"a_2.jpg");
  assert.equal(h.uniqueName("a.jpg",used),"a_3.jpg");
});

test("crc32 matches the standard check value",()=>{
  assert.equal(h.crc32(new TextEncoder().encode("123456789")),0xCBF43926);
  assert.equal(h.crc32(new Uint8Array(0)),0);
});

test("buildZip produces an archive that Python's zipfile reads back byte for byte",()=>{
  const python=spawnSync("python3",["--version"]);
  if(python.status!==0){console.log("python3 not available: skipping the zipfile cross-check");return;}
  const entries=[
    {name:"CTAtlas_a_F1.jpg",data:Uint8Array.from({length:5000},(_,i)=>(i*7)%256)},
    {name:"CTAtlas_été_F2.jpg",data:Uint8Array.from({length:1234},(_,i)=>(i*13)%256)},
    {name:"empty.bin",data:new Uint8Array(0)}
  ];
  const zip=h.buildZip(entries,new Date(2026,8,26,10,30,0));
  const file=path.join(os.tmpdir(),"ct-atlas-crops-test-"+process.pid+".zip");
  fs.writeFileSync(file,zip);
  const script=[
    "import zipfile,sys,json",
    "z=zipfile.ZipFile(sys.argv[1])",
    "assert z.testzip() is None,'CRC mismatch'",
    "print(json.dumps({n:z.read(n).hex() for n in z.namelist()}))"
  ].join(";");
  const result=spawnSync("python3",["-c",script,file],{encoding:"utf8"});
  fs.rmSync(file,{force:true});
  assert.equal(result.status,0,result.stderr);
  const read=JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(read).sort(),entries.map(e=>e.name).sort());
  for(const entry of entries)assert.equal(read[entry.name],Buffer.from(entry.data).toString("hex"),entry.name);
});

test("search engines: free tools only, https, distinct, opened on their own upload page",()=>{
  const engines=h.SEARCH_ENGINES;
  assert.ok(engines.length>=5);
  assert.equal(new Set(engines.map(e=>e.id)).size,engines.length);
  for(const engine of engines){
    assert.match(engine.url,/^https:\/\/[a-z0-9.-]+\//,engine.id);
    assert.ok(engine.name&&engine.note,engine.id);
    assert.doesNotMatch(engine.note,/paid|subscription|credit/i,engine.id+" must be free");
  }
  for(const id of ["yandex","google","bing","tineye"])assert.ok(engines.some(e=>e.id===id),id);
  assert.ok(Object.isFrozen(engines));
});

test("PRIVACY GUARD: the crop script never sends anything anywhere by itself",()=>{
  const src=read("facial-crops.js");
  // A face may reach a third party only when the user pastes it into that service's own page.
  for(const forbidden of ["fetch(","XMLHttpRequest","sendBeacon","FormData","WebSocket","window.open(","location.href","location.assign"]){
    assert.ok(!src.includes(forbidden),"facial-crops.js must not use "+forbidden);
  }
  // Engines are plain links the user clicks, without an opener reference.
  assert.ok(src.includes('target="_blank" rel="noopener noreferrer"'));
});

test("the UI wires the crops in, states the third-party disclosure, and keeps the non-identification guardrails",()=>{
  const html=read("facial.html");
  const js=read("facial.js");
  for(const id of ["fcBar","fcZip","fcMargin","fcUpscale","fcStatus"])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/<script src="facial-crops\.js\?v=\d+"><\/script>\s*<script src="facial\.js/,"crops module loads before facial.js");
  assert.ok(html.includes("THIRD-PARTY SEARCH"));
  assert.match(html,/never sent to CT Atlas/);
  assert.match(html,/only when you paste it there/);
  assert.match(html,/leads, not identifications/);
  assert.ok(html.includes("NON-IDENTIFYING ANALYSIS"),"the existing guardrail must remain");
  assert.match(html,/outside CT Atlas's retention controls/);
  assert.ok(js.includes("window.CTAtlasFaceCrops?.attach({payload,files:lastFiles})"));
  assert.ok(js.includes("lastFiles=files"));
  assert.ok(js.includes('class="fc-thumb"')&&js.includes('class="fc-actions"'));
  // The consent checkbox required before analysis is untouched.
  assert.ok(js.includes("#fiConsent")||js.includes('$("fiConsent").checked'));
});

test("the crop component ships everywhere the Facial page does",()=>{
  assert.ok(read("tools/deploy_mirror.sh").includes("facial-crops.js"));
  const ui=read(".github/workflows/deploy-current-ct-atlas-ui.yml");
  assert.ok(ui.includes('"facial-crops.js"'));
  const css=read("facial.css");
  for(const selector of [".fc-bar",".fc-menu",".fc-engine",".fc-thumb"])assert.ok(css.includes(selector),selector);
  assert.match(css,/\.fc-menu\{position:fixed/,"the menu must not be clipped by .preview-card{overflow:hidden}");
});
