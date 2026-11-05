// Real-browser check of the paste fallback in facial-crops.js, which the fake browser in
// facial-search-flow.test.cjs cannot prove: a page without the focus cannot use the clipboard, and that
// fake clipboard always works. Drives Chromium over the DevTools protocol with real mouse events, against a
// local stub whose hosting always fails. yandex.com is mapped to a closed local port, so nothing leaves the machine.
//
// Run:  node tests/facial-fallback-browser.cjs      (CHROME_EXECUTABLE picks the browser)
// Like crypto-trace-browser.cjs it stays out of the tests/*.test.cjs glob: that glob gates deployments.
const fs=require("node:fs"),http=require("node:http"),os=require("node:os"),path=require("node:path");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");

const root=path.resolve(__dirname,"..");

function findChrome(){
  const playwright=path.join(os.homedir(),"AppData/Local/ms-playwright");
  const bundled=fs.existsSync(playwright)?fs.readdirSync(playwright).filter(name=>/^chromium-\d+$/.test(name)).sort().reverse().map(name=>path.join(playwright,name,"chrome-win64/chrome.exe")):[];
  const found=[process.env.CHROME_EXECUTABLE,...bundled,"C:/Program Files/Google/Chrome/Application/chrome.exe","/usr/bin/google-chrome","/usr/bin/chromium"].filter(Boolean).find(file=>fs.existsSync(file));
  if(!found)throw new Error("No Chromium found: set CHROME_EXECUTABLE");
  return found;
}

const PAGE=`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/facial.css"></head><body>
<div id="fcStatus"></div><input id="fcUpscale" type="checkbox"><select id="fcMargin"><option value="standard" selected>s</option></select><button id="fcZip">zip</button>
<table id="fiItems"><tbody><tr><td class="fc-thumb" data-fc-key="0:0:1"></td><td class="fc-actions" data-fc-key="0:0:1"></td></tr></tbody></table>
<script src="/facial-crops.js"></script>
<script>
window.setup=async()=>{
  const blob=await (await fetch("/fixture.jpg")).blob();
  const file=new File([blob],"astronaut.jpg",{type:"image/jpeg"});
  return CTAtlasFaceCrops.attach({payload:{files:[{kind:"image",filename:"astronaut.jpg",width:512,height:512,faces:[{face_id:1,quality:"HIGH",box:{x:178,y:63,w:91,h:113}}]}],errors:[]},files:[file],api:location.origin,getToken:()=>"t"});
};
</script></body></html>`;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function until(check,label,timeoutMs=8000){
  const started=Date.now();
  for(;;){
    const value=await check();
    if(value)return value;
    if(Date.now()-started>timeoutMs)throw new Error("Timed out waiting for "+label);
    await sleep(100);
  }
}

(async()=>{
  const uploads=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,"http://stub");
    const send=(type,body,status=200)=>{res.writeHead(status,{"Content-Type":type});res.end(body);};
    if(url.pathname==="/")return send("text/html",PAGE);
    if(url.pathname==="/facial-crops.js")return send("text/javascript",fs.readFileSync(path.join(root,"facial-crops.js")));
    if(url.pathname==="/facial.css")return send("text/css",fs.readFileSync(path.join(root,"facial.css")));
    if(url.pathname==="/fixture.jpg")return send("image/jpeg",fs.readFileSync(path.join(root,"tests/fixtures/astronaut.jpg")));
    if(url.pathname==="/face-share"){req.resume();uploads.push(req.url);return send("application/json",JSON.stringify({error:"stub hosting failure"}),500);}
    send("text/plain","not found",404);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+server.address().port;
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),"ct-atlas-facial-"));
  const chrome=spawn(findChrome(),["--headless=new","--remote-debugging-port=0","--user-data-dir="+profile,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--disable-component-update","--host-resolver-rules=MAP yandex.com 127.0.0.1:9","about:blank"],{stdio:["ignore","ignore","pipe"]});
  try{
    const wsUrl=await new Promise((resolve,reject)=>{
      let log="";
      const timer=setTimeout(()=>reject(new Error("Chromium did not start")),30000);
      chrome.stderr.on("data",data=>{log+=data;const match=/DevTools listening on (ws:\S+)/.exec(log);if(match){clearTimeout(timer);resolve(match[1]);}});
    });
    const ws=new WebSocket(wsUrl);
    await new Promise(resolve=>ws.addEventListener("open",resolve));
    let nextId=1;
    const pending=new Map();
    ws.addEventListener("message",event=>{
      const message=JSON.parse(event.data);
      if(message.id&&pending.has(message.id)){
        const {resolve,reject}=pending.get(message.id);
        pending.delete(message.id);
        if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result);
      }
    });
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=nextId++;
      pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
    const {targetId}=await send("Target.createTarget",{url:origin+"/"});
    const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
    await send("Runtime.enable",{},sessionId);
    await send("Page.enable",{},sessionId);
    await send("Page.bringToFront",{},sessionId);
    const evaluate=async expression=>{
      const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},sessionId);
      if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails).slice(0,400));
      return result.result.value;
    };
    const click=async selector=>{
      const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(const type of ["mouseMoved","mousePressed","mouseReleased"]){
        await send("Input.dispatchMouseEvent",{type,x:point.x,y:point.y,button:type==="mouseMoved"?"none":"left",clickCount:type==="mouseMoved"?0:1},sessionId);
      }
    };
    const pages=async()=>(await send("Target.getTargets")).targetInfos.filter(target=>target.type==="page"&&(target.url!=="about:blank"||target.targetId===targetId));
    const status=()=>evaluate(`document.getElementById("fcStatus").textContent`);

    await until(()=>evaluate(`document.readyState==="complete"&&typeof setup==="function"`),"the page");
    await evaluate("setup()");
    await click('[data-fc-action="search-all"]');
    await until(()=>evaluate(`Boolean(document.querySelector('[data-fc-consent="ok"]'))`),"the confirmation");
    await click('[data-fc-consent="ok"]');

    await until(()=>evaluate(`Boolean(document.querySelector('[data-fc-paste="copy"]'))`),"the fallback dialog");
    assert.equal(uploads.length,1,"hosting was tried once");
    assert.match(await status(),/stub hosting failure/);
    assert.match(await status(),/Nothing was sent/);
    await until(async()=>(await pages()).length===1,"the placeholder tab to close");
    await until(()=>evaluate("document.hasFocus()"),"the focus to come back to CT Atlas");
    assert.match(await evaluate(`document.querySelector("#fcPasteText").textContent`),/nothing was sent to Yandex Images/);

    await click('[data-fc-paste="copy"]');
    await until(async()=>/Face F1 copied/.test(await status())||/blocked/.test(await status()),"the copy");
    // A click may open a tab for 5 s. On a busy machine the copy can outlast that (6.9 s measured under full CPU
    // load): the tab is then blocked and the row's real link, a fresh gesture, has to do the same job.
    const blocked=/blocked the new tab/.test(await status());
    if(blocked)await click(".fc-more-link");
    else assert.match(await status(),/Face F1 copied\. On Yandex Images open the image-upload box and press Ctrl\+V/);
    const yandex=await until(async()=>(await pages()).find(target=>target.url.startsWith("https://yandex.com/")),"the Yandex tab");
    assert.match(yandex.url,/^https:\/\/yandex\.com\/images\/search\?rpt=imageview$/);
    assert.ok(!yandex.url.includes("url="),"its own upload page, no link");
    assert.equal(await evaluate(`Boolean(document.querySelector("dialog"))`),false,"the dialog is gone");

    // Read the clipboard back: the promise resolving is not enough to prove a crop is there to paste.
    await send("Browser.grantPermissions",{origin,permissions:["clipboardReadWrite"]});
    await send("Page.bringToFront",{},sessionId);
    await sleep(300);
    const stored=await evaluate(`(async()=>{const [item]=await navigator.clipboard.read();const blob=await item.getType("image/png");const bitmap=await createImageBitmap(blob);return {types:item.types,size:blob.size,width:bitmap.width,height:bitmap.height};})()`);
    assert.deepEqual(stored.types,["image/png"]);
    assert.ok(stored.size>10000&&stored.width>=100,"a real crop is on the clipboard: "+JSON.stringify(stored));
    ws.close();
    console.log("Chrome: hosting failure closed the blank tab, the dialog click copied a "+stored.width+"x"+stored.height+" crop and "+(blocked?"the row's link":"the same click")+" opened Yandex's own page");
  }finally{
    const exited=new Promise(resolve=>chrome.once("exit",resolve));
    chrome.kill();
    server.close();
    await exited;
    await sleep(1000);       // Chromium's helper processes hold the profile a moment longer
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:500});}catch(_){/* a temporary folder, not worth failing for */}
  }
  process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
