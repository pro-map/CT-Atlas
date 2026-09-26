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

test("direct search: every engine that can search by URL builds an https address carrying the encoded hosted-crop link",()=>{
  const link="https://ct-report-generator.fairpeace.workers.dev/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg";
  const direct=h.SEARCH_ENGINES.filter(engine=>engine.direct);
  assert.deepEqual(direct.map(e=>e.id).sort(),["baidu","bing","google","tineye","yandex"]);
  for(const engine of direct){
    const url=h.directSearchUrl(engine,link);
    assert.match(url,/^https:\/\/[a-z0-9.-]+\//,engine.id);
    assert.ok(url.includes(encodeURIComponent(link)),engine.id+" must carry the URL-encoded link");
    assert.ok(!url.includes(link),engine.id+" must not leave the link unencoded");
    assert.equal(new URL(url).protocol,"https:");
  }
  const search4faces=h.SEARCH_ENGINES.find(e=>e.id==="search4faces");
  assert.equal(h.directSearchUrl(search4faces,link),null,"Search4faces cannot search by URL: paste only");
  assert.equal(h.directSearchUrl(null,link),null);
  assert.deepEqual([...h.SEARCH_ALL_IDS],["yandex","bing","google","tineye"]);
  for(const id of h.SEARCH_ALL_IDS)assert.ok(h.SEARCH_ENGINES.find(e=>e.id===id)?.direct,id+" must support direct search");
});

test("the hosted-crop link is only accepted when it points at the CT Atlas API's own hosting path",()=>{
  const api="https://ct-report-generator.fairpeace.workers.dev";
  const good=api+"/face-share/AbCdEfGhIjKlMnOpQrStUv.jpg";
  assert.equal(h.validShareUrl(good,api),true);
  for(const bad of [
    "https://evil.example/face-share/AbCdEfGhIjKlMnOpQrStUv.jpg",
    api+"/face-share/short.jpg",
    api+"/face-share/AbCdEfGhIjKlMnOpQrStUv.png",
    api+"/other/AbCdEfGhIjKlMnOpQrStUv.jpg",
    api+"/face-share/AbCdEfGhIjKlMnOpQrStUv.jpg?x=1",
    api+"/face-share/AbCdEfGhIjKlMnOpQrStUv.jpg#f",
    "http://ct-report-generator.fairpeace.workers.dev/face-share/AbCdEfGhIjKlMnOpQrStUv.jpg",
    "javascript:alert(1)","not a url","",undefined,null
  ])assert.equal(h.validShareUrl(bad,api),false,String(bad));
});

test("hosted crops are re-sized down only, and a share is reused only while an engine still has time to download it",()=>{
  assert.deepEqual(h.shareDimensions(300,300),{w:300,h:300},"small crops are never upscaled");
  assert.deepEqual(h.shareDimensions(900,600),{w:900,h:600});
  assert.deepEqual(h.shareDimensions(1800,1200),{w:900,h:600},"aspect ratio preserved");
  assert.deepEqual(h.shareDimensions(1000,4000),{w:225,h:900});
  assert.equal(h.MAX_SHARE_BYTES<150*1024,true,"under the Worker's 150 KB limit");
  const now=1_000_000;
  assert.equal(h.shareUsable({url:"u",expiresAt:now+5*60*1000},now),true);
  assert.equal(h.shareUsable({url:"u",expiresAt:now+30*1000},now),false,"about to expire: host again");
  assert.equal(h.shareUsable({url:"u",expiresAt:now-1},now),false);
  assert.equal(h.shareUsable(null,now),false);
  assert.equal(h.shareUsable({url:"u",expiresAt:NaN},now),false);
});

test("PRIVACY GUARD: a crop leaves the browser only through an explicit SEARCH click, after a confirmation, to the CT Atlas hosting endpoint",()=>{
  const src=read("facial-crops.js");
  for(const forbidden of ["XMLHttpRequest","sendBeacon","FormData","WebSocket","location.href","location.assign","navigator.share"]){
    assert.ok(!src.includes(forbidden),"facial-crops.js must not use "+forbidden);
  }
  // Exactly one network call, and it goes to the CT Atlas API's own hosting endpoint.
  assert.equal((src.match(/\bfetch\(/g)||[]).length,1);
  assert.ok(src.includes('fetch(api+"/face-share",{method:"POST"'));
  // ...reachable from one place only (runDirectSearch), which is started only through requestSearch, which only a click handler calls.
  assert.equal((src.match(/shareCrop\(record\)/g)||[]).length,2,"definition + the single call in runDirectSearch");
  assert.equal((src.match(/runDirectSearch\(record,engines\)/g)||[]).length,2,"definition + the single call in startSearch");
  assert.equal((src.match(/startSearch\(record,engines\)/g)||[]).length,3,"definition + the immediate path + the OK click of the confirmation");
  assert.equal((src.match(/requestSearch\(record,engines,/g)||[]).length,3,"definition + the single call in onClick + the re-ask when the described hosting expired");
  // The confirmation is IN the page (window.confirm from a tab that just lost focus can be suppressed) and comes first:
  // the only immediate path is for engines already confirmed for the current hosting.
  assert.ok(!src.includes("window.confirm("),"no window.confirm: it is unreliable next to window.open");
  const request=src.slice(src.indexOf("function requestSearch"),src.indexOf("async function startSearch"));
  assert.ok(request.includes("consentPrompt(confirmText("));
  assert.ok(request.indexOf("if(!fresh.length)return startSearch(record,engines)")>-1&&request.indexOf("if(!fresh.length)")<request.indexOf("consentPrompt("),"immediate start only when there is nothing new to confirm");
  assert.ok(request.includes("running=startSearch(record,engines);"),"the OK click starts the search");
  const flow=src.slice(src.indexOf("async function runDirectSearch"),src.indexOf("async function onClick"));
  assert.ok(flow.indexOf("openPlaceholder()")>-1&&flow.indexOf("openPlaceholder()")<flow.indexOf("await shareCrop(record)"),"tabs are opened synchronously, before the upload");
  // The dialog: native <dialog>, safe default focus, OK calls onAccept inside its own click.
  const dialog=src.slice(src.indexOf("function askConsent"),src.indexOf("let consentPrompt"));
  assert.ok(dialog.includes('document.createElement("dialog")')&&dialog.includes("showModal"));
  assert.ok(dialog.indexOf("onAccept();")>dialog.indexOf('choice==="ok"'),"OK runs the search inside the click handler");
  assert.match(dialog,/safe\.focus\(\)/);
  assert.match(dialog,/aria-labelledby/);
  assert.match(dialog,/aria-describedby/);
  assert.match(dialog,/restoreFocus/,"focus goes back to the menu button after the dialog closes");
  assert.ok(request.includes("shareUsable(record.share,Date.now())")&&request.includes("confirm again"),"OK re-checks that the hosting the dialog described still exists");
  // What is uploaded is the small re-encoded copy, never the full-size crop.
  const share=src.slice(src.indexOf("async function shareCrop"),src.indexOf("function openPlaceholder"));
  assert.ok(share.includes("const body=await shrinkForSearch(record)"));
  assert.ok(!/body:\s*record\.blob/.test(share));
  // Windows: about:blank only, no opener kept by the engine, navigation only through location.replace.
  const opens=src.match(/window\.open\([^)]*\)/g)||[];
  assert.deepEqual(opens,['window.open("about:blank","_blank")']);
  assert.ok(src.includes("win.opener=null"));
  // Paste-only engines are still plain links opened without an opener reference.
  assert.ok(src.includes('target="_blank" rel="noopener noreferrer"'));
});

test("the UI wires the crops in, states the third-party disclosure, and keeps the non-identification guardrails",()=>{
  const html=read("facial.html");
  const js=read("facial.js");
  for(const id of ["fcBar","fcZip","fcMargin","fcUpscale","fcStatus"])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/<script src="facial-crops\.js\?v=\d+"><\/script>\s*<script src="facial\.js/,"crops module loads before facial.js");
  assert.ok(html.includes("THIRD-PARTY SEARCH"));
  assert.match(html,/hosted on CT Atlas's temporary storage for about 10 minutes/);
  assert.match(html,/deletes its hosted copy automatically/);
  assert.match(html,/its own retention rules/);
  assert.match(html,/after a confirmation/);
  assert.match(html,/asks for its own confirmation/);
  // Engines must not learn that the request came from CT Atlas (script navigations use the page's policy).
  assert.match(html,/<meta name="referrer" content="no-referrer">/);
  assert.ok(html.includes('id="fcMore"'),"container for the engines that did not get a tab");
  assert.match(html,/only when you paste it there/);
  assert.match(html,/leads, not identifications/);
  assert.ok(html.includes("NON-IDENTIFYING ANALYSIS"),"the existing guardrail must remain");
  assert.match(html,/outside CT Atlas's retention controls/);
  assert.ok(js.includes("window.CTAtlasFaceCrops?.attach({payload,files:lastFiles,api:API,getToken:()=>String(sessionStorage.getItem(TOKEN)||\"\")})"));
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
