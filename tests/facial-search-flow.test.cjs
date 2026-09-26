const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

// Runs the real facial-crops.js in a minimal fake browser (document, window.open, canvas, fetch, clipboard)
// and drives the SEARCH button the way a click would. The in-page confirmation and the "one more click"
// dialog are replaced by scripted hooks (their DOM is checked in a real browser).

const source=fs.readFileSync("facial-crops.js","utf8");
const API="https://api.test";
const SHARE_URL=API+"/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg";
const LINK=encodeURIComponent(SHARE_URL);
const YANDEX="https://yandex.com/images/search?rpt=imageview&url="+LINK;
const TINEYE="https://tineye.com/search?url="+LINK;
const YANDEX_PAGE="https://yandex.com/images/search?rpt=imageview";
const TINEYE_PAGE="https://tineye.com/";
const MAX=140*1024;

function harness(options={}){
  const {confirmAnswer=true,popupLimit=Infinity,token="tok-1",fetchImpl,clipboard=true}=options;
  const elements=new Map(),listeners={},opened=[],confirms=[],tabsAtPrompt=[],nextSteps=[],fetchCalls=[],clipboardWrites=[];
  let answer=confirmAnswer;
  const el=id=>{
    if(!elements.has(id))elements.set(id,{id,dataset:{},style:{},hidden:false,disabled:false,textContent:"",className:"",value:"standard",checked:true,
      addEventListener:(type,fn)=>{(listeners[id]??={})[type]=fn;},removeAttribute(){}});
    return elements.get(id);
  };
  const makeBlob=(type,w,h,quality)=>({type,w,h,size:Math.round(w*h*(quality||0.9)*0.4),arrayBuffer:async()=>new ArrayBuffer(0)});
  const makeCanvas=()=>{
    const canvas={width:0,height:0,getContext:()=>({imageSmoothingEnabled:true,fillRect(){},drawImage(){}}),
      toBlob:(callback,type,quality)=>callback(makeBlob(type,canvas.width,canvas.height,quality))};
    return canvas;
  };
  const window={
    innerWidth:1200,innerHeight:800,addEventListener(){},
    open:(url,target)=>{
      if(opened.length>=popupLimit)return null;
      const win={url,target,opener:{},closed:false,locations:[],document:{title:"",body:{style:{},textContent:""}},close(){win.closed=true;}};
      win.location={replace:u=>win.locations.push(u)};
      opened.push(win);
      return win;
    }
  };
  const cells={actions:{innerHTML:""},thumb:{innerHTML:""},links:{innerHTML:"",hidden:true}};
  const document={readyState:"complete",getElementById:el,createElement:tag=>tag==="canvas"?makeCanvas():{},
    querySelector:selector=>selector.includes("data-fc-links")?cells.links:selector.includes(".fc-actions")?cells.actions:selector.includes(".fc-thumb")?cells.thumb:null,
    querySelectorAll:()=>[],addEventListener(){},body:{appendChild(){}}};
  class TestURL extends URL{static createObjectURL(){return "blob:test";}static revokeObjectURL(){}}
  const okShare=async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:new Date(Date.now()+600000).toISOString(),ttl_seconds:600})});
  // Long timers (the 20 s upload timeout) fire almost at once so the timeout path can be tested; the 10-minute
  // "links expire" timers are recorded and fired by hand.
  const longTimers=[];
  const fastTimeout=(fn,ms)=>{
    if(ms>=60000){longTimers.push({fn,cleared:false});return longTimers.length;}
    return setTimeout(fn,ms>=10000?5:ms);
  };
  const clearTimer=id=>{if(typeof id==="number"&&longTimers[id-1])longTimers[id-1].cleared=true;else clearTimeout(id);};
  // The page sees a clock the test can move forward.
  const clock={offset:0};
  const realNow=Date.now.bind(Date);
  class TestDate extends Date{
    constructor(...args){if(args.length)super(...args);else super(realNow()+clock.offset);}
    static now(){return realNow()+clock.offset;}
  }
  const context=vm.createContext({
    window,document,URL:TestURL,TextEncoder,Uint8Array,Blob,Date:TestDate,Promise,Number,Math,Error,JSON,setTimeout:fastTimeout,clearTimeout:clearTimer,AbortController,console,
    navigator:clipboard?{clipboard:{write:async items=>{clipboardWrites.push(items);}}}:{},
    ClipboardItem:class{constructor(data){this.data=data;}},
    createImageBitmap:async input=>input&&input.w?{width:input.w,height:input.h,close(){}}:{width:1000,height:640,close(){}},
    fetch:async(url,init)=>{fetchCalls.push({url,init});return (fetchImpl||okShare)(url,init);}
  });
  vm.runInContext(source,context);
  const crops=window.CTAtlasFaceCrops;
  crops.setConsentPrompt((text,accept,cancel)=>{
    confirms.push(text);
    tabsAtPrompt.push(opened.length);
    if(answer)accept();else if(cancel)cancel();
  });
  crops.setNextStepPrompt((record,queued)=>nextSteps.push({label:record.label,ids:queued.map(item=>item.engine.id),urls:queued.map(item=>item.url)}));
  return {crops,el,listeners,opened,confirms,tabsAtPrompt,nextSteps,fetchCalls,clipboardWrites,window,cells,
    setAnswer:value=>{answer=value;},advance:ms=>{clock.offset+=ms;},
    fireLongTimers:()=>longTimers.filter(t=>!t.cleared).forEach(t=>{t.cleared=true;t.fn();}),
    async attach(){
      // one 1000x640 image with a large face: its crop is 1000x640 (~235 KB), so it must be shrunk to be hosted
      await crops.attach({
        payload:{files:[{kind:"image",filename:"a.jpg",width:1000,height:640,faces:[{face_id:1,box:{x:100,y:50,w:800,h:500}}]}],errors:[]},
        files:[{name:"a.jpg"}],api:API,getToken:()=>token
      });
    },
    click(action="search-all"){
      const target={dataset:{fcAction:action,fcKey:"0:0:1"},closest:()=>({removeAttribute(){},querySelector:()=>null})};
      return listeners.fiItems.click({target:{closest:()=>target}});
    },
    status:()=>el("fcStatus").textContent
  };
}

// ---------------------------------------------------------------- what the page offers

test("only Yandex Images and TinEye are offered, behind one SEARCH button (no engine menu)",async()=>{
  const h=harness();
  await h.attach();
  const html=h.cells.actions.innerHTML;
  assert.match(html,/data-fc-action="download"/);
  assert.match(html,/data-fc-action="copy"/);
  assert.equal((html.match(/data-fc-action="search-all"/g)||[]).length,1);
  assert.match(html,/>SEARCH<\/button>/);
  assert.match(html,/Yandex \+ TinEye/);
  assert.match(html,/data-fc-links=/,"the row has its own place for engines that got no tab");
  assert.doesNotMatch(html,/<details|fc-menu|search-direct|Bing|Google|Baidu|Search4faces/i);
  assert.equal(JSON.stringify(h.crops.helpers.SEARCH_ENGINES.map(engine=>engine.id)),JSON.stringify(["yandex","tineye"]));
  assert.equal(JSON.stringify([...h.crops.helpers.SEARCH_ALL_IDS]),JSON.stringify(["yandex","tineye"]));
});

test("cutting the faces sends nothing anywhere",async()=>{
  const h=harness();
  await h.attach();
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,0);
  assert.equal(h.confirms.length,0);
  assert.match(h.status(),/1 face crop\(s\) ready/);
});

test("JPEG download and COPY never touch the network",async()=>{
  const h=harness();
  await h.attach();
  await h.click("copy");
  assert.equal(h.clipboardWrites.length,1);
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,0);
});

// ---------------------------------------------------------------- SEARCH

test("SEARCH asks BEFORE opening anything, then opens both engines on ONE small hosted copy",async()=>{
  const h=harness();
  await h.attach();
  await h.click();

  assert.deepEqual(h.tabsAtPrompt,[0],"no tab exists while the confirmation is on screen (a dialog raised from a tab that lost the focus can be suppressed)");
  assert.equal(h.confirms.length,1);
  assert.match(h.confirms[0],/^Search face F1 directly on Yandex Images, TinEye\?/);
  assert.match(h.confirms[0],/about 10 minutes/);
  assert.match(h.confirms[0],/deletes its copy automatically/);
  assert.match(h.confirms[0],/its own retention rules/);
  assert.match(h.confirms[0],/Nothing is uploaded unless you press OK/);

  assert.equal(h.opened.length,2,"one tab per engine");
  assert.ok(h.opened.every(win=>win.url==="about:blank"&&win.opener===null),"blank tabs first, no reference back to CT Atlas");
  assert.equal(h.fetchCalls.length,1);
  const call=h.fetchCalls[0];
  assert.equal(call.url,API+"/face-share");
  assert.equal(call.init.method,"POST");
  assert.equal(call.init.headers["X-Session-Token"],"tok-1");
  assert.equal(call.init.headers["Content-Type"],"image/jpeg");
  assert.equal(call.init.body.type,"image/jpeg");
  assert.ok(call.init.body.size<=MAX,"hosted copy is "+call.init.body.size+" bytes, must be <= "+MAX);
  assert.ok(call.init.body.w<=900&&call.init.body.h<=900,"downscaled to at most 900 px");

  assert.deepEqual(h.opened[0].locations,[YANDEX]);
  assert.deepEqual(h.opened[1].locations,[TINEYE]);
  assert.match(h.status(),/Yandex Images, TinEye opened on the hosted crop/);
  assert.match(h.status(),/deleted automatically/);
  assert.equal(h.nextSteps.length,0,"both opened: nothing more to click");
  assert.match(h.cells.links.innerHTML,/<span>Reopen:<\/span>/);
  assert.equal(h.cells.links.hidden,false);
});

test("declining the confirmation uploads nothing and never opens a tab",async()=>{
  const h=harness({confirmAnswer:false});
  await h.attach();
  await h.click();
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,0);
  assert.match(h.status(),/nothing was uploaded/);
});

test("default browsers allow ONE tab per click: Yandex opens, TinEye is offered through a real link and a one-more-click prompt, with a single confirmation and upload",async()=>{
  const h=harness({popupLimit:1});
  await h.attach();
  await h.click();
  assert.equal(h.opened.length,1);
  assert.equal(h.confirms.length,1);
  assert.equal(h.fetchCalls.length,1);
  assert.deepEqual(h.opened[0].locations,[YANDEX]);

  const also=h.cells.links.innerHTML.split("<span>Reopen:</span>")[0];
  assert.match(also,/<span>Also open:<\/span> <a class="fc-more-link" href="[^"]+" target="_blank" rel="noopener noreferrer">TinEye<\/a>/);
  assert.equal(h.nextSteps.length,1,"the analyst is told, in the page, to click once more");
  assert.equal(JSON.stringify(h.nextSteps[0].ids),JSON.stringify(["tineye"]));
  assert.equal(h.nextSteps[0].urls[0],TINEYE);
  assert.match(h.status(),/Yandex Images opened on the hosted crop/);
  assert.match(h.status(),/TinEye got no tab/);
  assert.match(h.status(),/window that just appeared/);
});

test("pop-ups blocked altogether: nothing is uploaded, no consent is recorded, the analyst is told what to do",async()=>{
  const h=harness({popupLimit:0});
  await h.attach();
  await h.click();
  assert.equal(h.fetchCalls.length,0);
  assert.match(h.status(),/Allow pop-ups/);
  await h.click();
  assert.equal(h.confirms.length,2,"nothing was hosted, so it is asked about again");
});

test("searching the same face again while its hosting lives: no new confirmation, no new upload, both tabs open at once",async()=>{
  const h=harness();
  await h.attach();
  await h.click();
  await h.click();
  assert.equal(h.confirms.length,1);
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.opened.length,4);
  assert.deepEqual(h.opened[2].locations,[YANDEX]);
  assert.deepEqual(h.opened[3].locations,[TINEYE]);
});

test("an expired hosting is never reused: it is confirmed and hosted again",async()=>{
  const h=harness();
  await h.attach();
  await h.click();
  h.advance(9.5*60*1000);                                  // 30 s left: not enough for an engine to download it
  await h.click();
  assert.equal(h.fetchCalls.length,2);
  assert.equal(h.confirms.length,2,"a new hosting is a new decision");
  assert.match(h.confirms[1],/^Search face F1 directly on Yandex Images, TinEye/);
});

test("the lifetime comes from the relative ttl, so a wrong clock on this computer changes nothing",async()=>{
  const past=new Date(Date.now()-3600*1000).toISOString();
  const skewed=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:past,ttl_seconds:600})})});
  await skewed.attach();
  await skewed.click();
  await skewed.click();
  assert.equal(skewed.fetchCalls.length,1,"a server timestamp in the past is ignored: the ttl says 10 minutes");
  const future=new Date(Date.now()+3600*1000).toISOString();
  const other=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:future,ttl_seconds:20})})});
  await other.attach();
  await other.click();
  await other.click();
  assert.equal(other.fetchCalls.length,2,"a timestamp far in the future does not keep a 20 s link alive");
});

test("a stalled hosting request times out and falls back instead of leaving blank tabs",async()=>{
  const fetchImpl=(url,init)=>new Promise((resolve,reject)=>{
    init.signal.addEventListener("abort",()=>{const e=new Error("aborted");e.name="AbortError";reject(e);});
  });
  const h=harness({fetchImpl});
  await h.attach();
  await h.click();
  assert.match(h.status(),/did not answer in time/);
  assert.deepEqual(h.opened.map(win=>win.locations[0]),[YANDEX_PAGE,TINEYE_PAGE]);
});

test("repeated clicks while a search is in flight neither host twice nor ask twice",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({fetchImpl:async()=>{await gate;return {ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:600})};}});
  await h.attach();
  const first=h.click();
  await new Promise(resolve=>setTimeout(resolve,20));
  await h.click();
  assert.match(h.status(),/already in progress/);
  assert.equal(h.opened.length,2,"the second click opens no further tabs");
  release();
  await first;
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.confirms.length,1);
});

test("a search tab that was closed before the result arrived is offered as a link instead of being lost",async()=>{
  let closeIt;
  const h=harness({fetchImpl:async()=>{if(closeIt)closeIt();return {ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:600})};}});
  await h.attach();
  closeIt=()=>{h.opened[1].closed=true;};                   // the TinEye tab is closed while hosting
  await h.click();
  assert.deepEqual(h.opened[0].locations,[YANDEX]);
  assert.deepEqual(h.opened[1].locations,[],"a closed tab is not navigated");
  assert.match(h.cells.links.innerHTML,/Also open:.*TinEye/s);
  assert.equal(h.nextSteps.length,1);
  assert.match(h.status(),/TinEye got no tab/);
});

test("if every tab was closed the status does not claim anything opened",async()=>{
  let closeAll;
  const h=harness({fetchImpl:async()=>{if(closeAll)closeAll();return {ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:600})};}});
  await h.attach();
  closeAll=()=>h.opened.forEach(win=>{win.closed=true;});
  await h.click();
  assert.match(h.status(),/search tab\(s\) were closed before the results could load/);
  assert.doesNotMatch(h.status(),/opened on the hosted crop/);
  assert.equal(h.nextSteps.length,1);
  assert.equal(JSON.stringify(h.nextSteps[0].ids),JSON.stringify(["yandex","tineye"]));
});

test("the row's links belong to one hosting and are removed when it expires",async()=>{
  const h=harness();
  await h.attach();
  await h.click();
  assert.equal(h.cells.links.hidden,false);
  h.fireLongTimers();                                       // the hosted image is deleted at that moment
  assert.equal(h.cells.links.hidden,true);
  assert.equal(h.cells.links.innerHTML,"");
});

// ---------------------------------------------------------------- failures never lose the search

test("if hosting fails both tabs fall back to the engines' own upload pages and the crop is copied for Ctrl+V",async()=>{
  const cases=[
    ["network down",async()=>{throw new Error("offline");},/could not be reached/],
    ["server refusal",async()=>({ok:false,status:503,json:async()=>({error:"Face search hosting is not configured."})}),/not configured/],
    ["session expired",async()=>({ok:false,status:401,json:async()=>({error:"Session expired."})}),/Session expired/],
    ["garbage answer",async()=>({ok:true,status:200,json:async()=>{throw new Error("bad json");}}),/refused the image/]
  ];
  for(const [label,fetchImpl,expected] of cases){
    const h=harness({fetchImpl});
    await h.attach();
    await h.click();
    assert.deepEqual(h.opened.map(win=>win.locations[0]),[YANDEX_PAGE,TINEYE_PAGE],label+": each engine's own upload page");
    assert.equal(h.clipboardWrites.length,1,label+": crop copied");
    assert.match(h.status(),expected,label);
    assert.match(h.status(),/Ctrl\+V/,label);
    assert.equal(h.nextSteps.length,0,label);
  }
});

test("a hosting answer that is not a CT Atlas link is never handed to a search engine",async()=>{
  for(const url of ["https://evil.example/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg",API+"/face-share/x.jpg","javascript:alert(1)",undefined]){
    const h=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url,ttl_seconds:600})})});
    await h.attach();
    await h.click();
    assert.deepEqual(h.opened.map(win=>win.locations[0]),[YANDEX_PAGE,TINEYE_PAGE],String(url));
    assert.ok(!h.opened.some(win=>win.locations.some(l=>l.includes("evil")||l.includes("javascript"))),String(url));
    assert.match(h.status(),/not a valid CT Atlas link/);
  }
});

test("without a session no upload is attempted",async()=>{
  const h=harness({token:""});
  await h.attach();
  await h.click();
  assert.equal(h.fetchCalls.length,0);
  assert.match(h.status(),/sign in again/);
  assert.deepEqual(h.opened.map(win=>win.locations[0]),[YANDEX_PAGE,TINEYE_PAGE]);
});
