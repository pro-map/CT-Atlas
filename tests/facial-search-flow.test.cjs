const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

// Runs the real facial-crops.js in a minimal fake browser (document, window.open, confirm,
// canvas, fetch, clipboard) and drives the SEARCH menu the way a click would.

const source=fs.readFileSync("facial-crops.js","utf8");
const API="https://api.test";
const SHARE_URL=API+"/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg";
const MAX=140*1024;

function harness(options={}){
  const {confirmAnswer=true,popupLimit=Infinity,token="tok-1",fetchImpl,clipboard=true}=options;
  const elements=new Map(),listeners={},opened=[],confirms=[],tabsAtPrompt=[],fetchCalls=[],clipboardWrites=[];
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
  const cells={actions:{innerHTML:""},thumb:{innerHTML:""}};
  const document={readyState:"complete",getElementById:el,createElement:tag=>tag==="canvas"?makeCanvas():{},
    querySelector:selector=>selector.includes(".fc-actions")?cells.actions:selector.includes(".fc-thumb")?cells.thumb:null,
    querySelectorAll:()=>[],addEventListener(){},body:{appendChild(){}}};
  class TestURL extends URL{static createObjectURL(){return "blob:test";}static revokeObjectURL(){}}
  const okShare=async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:new Date(Date.now()+600000).toISOString(),ttl_seconds:600})});
  // Long timers (the 20 s upload timeout) fire almost at once so the timeout path can be tested.
  const longTimers=[];
  const fastTimeout=(fn,ms)=>{
    if(ms>=60000){longTimers.push({fn,cleared:false});return longTimers.length;}   // not scheduled: tests fire them by hand
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
  // The in-page confirmation is replaced by a scripted answer; tabsAtPrompt records how many tabs were already open.
  crops.setConsentPrompt((text,accept,cancel)=>{
    confirms.push(text);
    tabsAtPrompt.push(opened.length);
    if(answer)accept();else if(cancel)cancel();
  });
  return {crops,el,listeners,opened,confirms,tabsAtPrompt,fireLongTimers:()=>longTimers.filter(t=>!t.cleared).forEach(t=>{t.cleared=true;t.fn();}),fetchCalls,clipboardWrites,window,cells,setAnswer:value=>{answer=value;},advance:ms=>{clock.offset+=ms;},
    async attach(){
      // one 1000x640 image with a large face: its crop is 1000x640 (~235 KB), so it must be shrunk to be hosted
      await crops.attach({
        payload:{files:[{kind:"image",filename:"a.jpg",width:1000,height:640,faces:[{face_id:1,box:{x:100,y:50,w:800,h:500}}]}],errors:[]},
        files:[{name:"a.jpg"}],api:API,getToken:()=>token
      });
    },
    click(action,engine){
      const target={dataset:{fcAction:action,fcKey:"0:0:1",...(engine?{fcEngine:engine}:{})},closest:()=>({removeAttribute(){},querySelector:()=>null})};
      return listeners.fiItems.click({target:{closest:()=>target}});
    },
    status:()=>el("fcStatus").textContent
  };
}

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

test("one engine: asks BEFORE opening anything, then opens the tab, hosts a SMALL copy and sends the tab to the engine on that link",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");

  assert.deepEqual(h.tabsAtPrompt,[0],"no tab exists while the confirmation is on screen (a dialog raised from a tab that lost the focus can be suppressed)");
  assert.equal(h.opened.length,1);
  assert.equal(h.opened[0].url,"about:blank");
  assert.equal(h.opened[0].opener,null,"the search page gets no reference back to CT Atlas");

  assert.equal(h.confirms.length,1);
  assert.match(h.confirms[0],/Yandex Images/);
  assert.match(h.confirms[0],/about 10 minutes/);
  assert.match(h.confirms[0],/deletes its copy automatically/);
  assert.match(h.confirms[0],/its own retention rules/);
  assert.match(h.confirms[0],/Nothing is uploaded unless you press OK/);

  assert.equal(h.fetchCalls.length,1);
  const call=h.fetchCalls[0];
  assert.equal(call.url,API+"/face-share");
  assert.equal(call.init.method,"POST");
  assert.equal(call.init.headers["X-Session-Token"],"tok-1");
  assert.equal(call.init.headers["Content-Type"],"image/jpeg");
  assert.equal(call.init.body.type,"image/jpeg");
  assert.ok(call.init.body.size<=MAX,"hosted copy is "+call.init.body.size+" bytes, must be <= "+MAX);
  assert.ok(call.init.body.w<=900&&call.init.body.h<=900,"downscaled to at most 900 px");

  assert.deepEqual(h.opened[0].locations,["https://yandex.com/images/search?rpt=imageview&url="+encodeURIComponent(SHARE_URL)]);
  assert.equal(h.opened[0].closed,false);
  assert.match(h.status(),/Yandex Images opened on the hosted crop/);
  assert.match(h.status(),/deleted automatically/);
});

test("declining the confirmation uploads nothing and never opens a tab",async()=>{
  const h=harness({confirmAnswer:false});
  await h.attach();
  await h.click("search-direct","bing");
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,0);
  assert.match(h.status(),/nothing was uploaded/);
});

test("a second engine on the same crop reuses the hosted link (no new upload) but is confirmed on its own; a repeat of a confirmed engine is not asked again",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");
  await h.click("search-direct","tineye");
  assert.equal(h.fetchCalls.length,1,"one hosting for the crop");
  assert.equal(h.confirms.length,2,"TinEye was never confirmed: it is asked about");
  assert.match(h.confirms[1],/Also search face F1 on TinEye/);
  assert.doesNotMatch(h.confirms[1],/Yandex/,"only the engine that is new is named");
  assert.match(h.confirms[1],/already hosted/);
  assert.match(h.confirms[1],/Nothing is shared with TinEye unless you press OK/);
  assert.equal(h.opened.length,2);
  assert.equal(h.opened[1].locations[0],"https://tineye.com/search?url="+encodeURIComponent(SHARE_URL));
  await h.click("search-direct","yandex");
  assert.equal(h.confirms.length,2,"Yandex was already confirmed for this hosting");
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.opened.length,3);
});

test("declining the confirmation for an additional engine hands it nothing",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");
  h.setAnswer(false);
  await h.click("search-direct","baidu");
  assert.equal(h.opened.length,1,"no tab for the declined engine");
  assert.equal(h.fetchCalls.length,1);
  assert.match(h.status(),/the link was not given to Baidu Images/);
});

test("an expired hosted link is never reused: it is hosted again and every engine is confirmed again",async()=>{
  const h=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:20})})});
  await h.attach();
  await h.click("search-direct","yandex");
  await h.click("search-direct","yandex");
  assert.equal(h.fetchCalls.length,2,"a link about to expire is hosted again");
  assert.equal(h.confirms.length,2,"a new hosting is a new decision, even for the same engine");
  assert.match(h.confirms[1],/^Search face F1 directly on Yandex Images/);
});

test("confirmations belong to ONE hosting: after a re-hosting, an engine confirmed earlier is asked about again",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");                 // hosting #1, Yandex confirmed
  h.advance(9.5*60*1000);                                  // <90 s left: the link is no longer reusable
  await h.click("search-direct","bing");                   // hosting #2, Bing confirmed
  assert.equal(h.fetchCalls.length,2);
  assert.equal(h.confirms.length,2);
  await h.click("search-direct","yandex");                 // Yandex never saw hosting #2's link
  assert.equal(h.confirms.length,3,"Yandex is asked again for the new link");
  assert.match(h.confirms[2],/Also search face F1 on Yandex Images/);
  assert.equal(h.fetchCalls.length,2,"but nothing is uploaded again");
});

test("the lifetime comes from the relative ttl, so a wrong clock on this computer changes nothing",async()=>{
  const past=new Date(Date.now()-3600*1000).toISOString();
  const skewed=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:past,ttl_seconds:600})})});
  await skewed.attach();
  await skewed.click("search-direct","yandex");
  await skewed.click("search-direct","yandex");
  assert.equal(skewed.fetchCalls.length,1,"server timestamp in the past is ignored: the ttl says 10 minutes");
  const future=new Date(Date.now()+3600*1000).toISOString();
  const other=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:future,ttl_seconds:20})})});
  await other.attach();
  await other.click("search-direct","yandex");
  await other.click("search-direct","yandex");
  assert.equal(other.fetchCalls.length,2,"a timestamp far in the future does not keep a 20 s link alive");
});

test("a stalled hosting request times out and falls back instead of leaving blank tabs",async()=>{
  const fetchImpl=(url,init)=>new Promise((resolve,reject)=>{
    init.signal.addEventListener("abort",()=>{const e=new Error("aborted");e.name="AbortError";reject(e);});
  });
  const h=harness({fetchImpl});
  await h.attach();
  await h.click("search-direct","bing");
  assert.match(h.status(),/did not answer in time/);
  assert.deepEqual(h.opened[0].locations,["https://www.bing.com/visualsearch"]);
});

test("repeated clicks while a search is in flight neither host twice nor ask twice",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({fetchImpl:async()=>{await gate;return {ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:600})};}});
  await h.attach();
  const first=h.click("search-direct","yandex");
  await new Promise(resolve=>setTimeout(resolve,20));
  await h.click("search-direct","yandex");
  assert.match(h.status(),/already in progress/);
  assert.equal(h.opened.length,1,"the second click opens no second tab");
  release();
  await first;
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.confirms.length,1);
  await h.click("search-direct","bing");
  assert.equal(h.opened.length,2,"searching is possible again once the first finished");
});

test("search all: one confirmation and one upload for four tabs, each engine on the same link",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-all");
  assert.equal(h.opened.length,4);
  assert.equal(h.confirms.length,1);
  assert.equal(h.fetchCalls.length,1);
  const link=encodeURIComponent(SHARE_URL);
  assert.deepEqual(h.opened.map(win=>win.locations[0]),[
    "https://yandex.com/images/search?rpt=imageview&url="+link,
    "https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:"+link,
    "https://lens.google.com/uploadbyurl?url="+link,
    "https://tineye.com/search?url="+link
  ]);
  assert.ok(h.opened.every(win=>win.opener===null&&!win.closed));
});

test("pop-ups blocked: nothing is uploaded, no consent is recorded, the analyst is told what to do",async()=>{
  const h=harness({popupLimit:0});
  await h.attach();
  await h.click("search-direct","yandex");
  assert.equal(h.fetchCalls.length,0);
  assert.match(h.status(),/Allow pop-ups/);
  h.setAnswer(true);
  await h.click("search-direct","yandex");
  assert.equal(h.confirms.length,2,"nothing was hosted, so the engine is asked about again");
});

test("a search tab that was closed before the result arrived is offered as a link instead of being lost",async()=>{
  let closeIt;
  const h=harness({fetchImpl:async()=>{if(closeIt)closeIt();return {ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,ttl_seconds:600})};}});
  await h.attach();
  closeIt=()=>{h.opened[0].closed=true;};
  await h.click("search-direct","yandex");
  assert.deepEqual(h.opened[0].locations,[],"a closed tab is not navigated");
  assert.match(h.el("fcMore").innerHTML,/Also open:.*Yandex Images/s);
  assert.match(h.status(),/search tab\(s\) were closed before the results could load/);
  assert.doesNotMatch(h.status(),/opened on the hosted crop/,"it must not claim a tab opened when none did");
  assert.doesNotMatch(h.status(),/one tab per click/,"and must not blame the browser's tab limit");
});

test("after a search every engine is also offered as a link to reopen (manual way back if a tab did not load)",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");
  const box=h.el("fcMore");
  assert.equal(box.hidden,false);
  assert.match(box.innerHTML,/<span>Reopen:<\/span> <a class="fc-more-link" href="https:\/\/yandex\.com\/images\/search\?rpt=imageview&amp;url=/);
  assert.match(box.innerHTML,/rel="noopener noreferrer"/);
});

test("default browsers allow ONE tab per click: search all opens one and offers the others as real links, with a single confirmation and upload",async()=>{
  const h=harness({popupLimit:1});
  await h.attach();
  await h.click("search-all");
  assert.equal(h.opened.length,1);
  assert.equal(h.confirms.length,1);
  assert.match(h.confirms[0],/Yandex Images, Bing Visual Search, Google Images \/ Lens, TinEye/,"the one confirmation names all four engines");
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.opened[0].locations.length,1);
  const more=h.el("fcMore");
  assert.equal(more.hidden,false);
  const link=encodeURIComponent(SHARE_URL);
  const also=more.innerHTML.split("<span>Reopen:</span>")[0];
  const hrefs=[...also.matchAll(/<a class="fc-more-link" href="([^"]+)" target="_blank" rel="noopener noreferrer">([^<]+)<\/a>/g)];
  assert.deepEqual(hrefs.map(m=>m[2]),["Bing Visual Search","Google Images / Lens","TinEye"]);
  assert.deepEqual(hrefs.map(m=>m[1].replace(/&amp;/g,"&")),[
    "https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:"+link,
    "https://lens.google.com/uploadbyurl?url="+link,
    "https://tineye.com/search?url="+link
  ]);
  assert.match(h.status(),/Yandex Images opened on the hosted crop/);
  assert.match(h.status(),/Bing Visual Search, Google Images \/ Lens, TinEye got no tab/);
  assert.match(h.status(),/use the links below/);
  // A later search clears the previous links; the other engines are already confirmed.
  await h.click("search-direct","yandex");
  assert.equal(h.el("fcMore").hidden,true);
  assert.equal(h.confirms.length,1);
});

test("search all with two tabs allowed: opens two, offers the remaining two as links",async()=>{
  const h=harness({popupLimit:2});
  await h.attach();
  await h.click("search-all");
  assert.equal(h.opened.length,2);
  assert.equal(h.fetchCalls.length,1);
  assert.deepEqual(h.opened.map(win=>win.locations.length),[1,1]);
  const html=h.el("fcMore").innerHTML;
  assert.equal((html.split("<span>Reopen:</span>")[0].match(/fc-more-link/g)||[]).length,2,"the two engines without a tab");
  assert.equal((html.split("<span>Reopen:</span>")[1].match(/fc-more-link/g)||[]).length,2,"the two that opened, to reopen");
  assert.match(h.status(),/Google Images \/ Lens, TinEye got no tab/);
});

test("if hosting fails the tab falls back to the engine's upload page and the crop is copied for Ctrl+V",async()=>{
  const cases=[
    ["network down",async()=>{throw new Error("offline");},/could not be reached/],
    ["server refusal",async()=>({ok:false,status:503,json:async()=>({error:"Face search hosting is not configured."})}),/not configured/],
    ["session expired",async()=>({ok:false,status:401,json:async()=>({error:"Session expired."})}),/Session expired/],
    ["garbage answer",async()=>({ok:true,status:200,json:async()=>{throw new Error("bad json");}}),/refused the image/]
  ];
  for(const [label,fetchImpl,expected] of cases){
    const h=harness({fetchImpl});
    await h.attach();
    await h.click("search-direct","google");
    assert.deepEqual(h.opened[0].locations,["https://images.google.com/"],label+": engine's own upload page");
    assert.equal(h.clipboardWrites.length,1,label+": crop copied");
    assert.match(h.status(),expected,label);
    assert.match(h.status(),/Ctrl\+V/,label);
  }
});

test("a hosting answer that is not a CT Atlas link is never handed to a search engine",async()=>{
  for(const url of ["https://evil.example/face-share/AAAAAAAAAAAAAAAAAAAAAA.jpg",API+"/face-share/x.jpg","javascript:alert(1)",undefined]){
    const h=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url,expires_at:new Date(Date.now()+600000).toISOString()})})});
    await h.attach();
    await h.click("search-direct","yandex");
    assert.deepEqual(h.opened[0].locations,["https://yandex.com/images/search?rpt=imageview"],String(url));
    assert.ok(!h.opened[0].locations.some(l=>l.includes("evil")||l.includes("javascript")),String(url));
    assert.match(h.status(),/not a valid CT Atlas link/);
  }
});

test("without a session no upload is attempted",async()=>{
  const h=harness({token:""});
  await h.attach();
  await h.click("search-direct","bing");
  assert.equal(h.fetchCalls.length,0);
  assert.match(h.status(),/sign in again/);
  assert.deepEqual(h.opened[0].locations,["https://www.bing.com/visualsearch"]);
});

test("Search4faces (no search-by-URL) stays a paste-only flow: no upload, no tab opened by the script",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search","search4faces");
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,0);
  assert.equal(h.confirms.length,0);
  assert.equal(h.clipboardWrites.length,1);
  assert.match(h.status(),/Ctrl\+V/);
});

test("if the hosting the dialog described expires while the dialog is open, OK does not silently upload a new copy: it asks again",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");                       // hosting #1
  h.advance(505*1000);                                            // 95 s left: still reusable when SEARCH ALL is clicked
  let calls=0;
  h.crops.setConsentPrompt((text,accept)=>{
    h.confirms.push(text);
    calls++;
    if(calls===1)h.advance(20*1000);                              // the analyst reads for 20 s: the hosting is now gone
    accept();
  });
  await h.click("search-all");
  assert.equal(h.confirms.length,3,"1 for the first search + the dialog that described the old hosting + a new one");
  assert.match(h.confirms[1],/already hosted/);
  assert.match(h.confirms[2],/^Search face F1 directly on Yandex Images, Bing Visual Search, Google Images \/ Lens, TinEye/,"the new dialog describes a fresh hosting");
  assert.doesNotMatch(h.confirms[2],/already hosted/);
  assert.equal(h.fetchCalls.length,2,"one upload for each hosting, the second only after its own confirmation");
});

test("the links belong to one face and are removed when the hosting expires",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");
  const box=h.el("fcMore");
  assert.match(box.innerHTML,/<b class="fc-more-face">F1<\/b>/);
  assert.equal(box.hidden,false);
  h.fireLongTimers();                                             // the hosted image is deleted at that moment
  assert.equal(box.hidden,true);
  assert.equal(box.innerHTML,"");
});

test("the rendered menu offers search-all, five direct engines and one paste-only link, plus JPEG and COPY",async()=>{
  const h=harness();
  await h.attach();
  const html=h.cells.actions.innerHTML;
  assert.equal((html.match(/data-fc-action="search-all"/g)||[]).length,1);
  const direct=[...html.matchAll(/data-fc-action="search-direct"[^>]*data-fc-engine="([a-z0-9]+)"/g)].map(m=>m[1]).sort();
  assert.equal(JSON.stringify(direct),JSON.stringify(["baidu","bing","google","tineye","yandex"]));
  const paste=[...html.matchAll(/<a class="fc-engine" href="([^"]+)" target="_blank" rel="noopener noreferrer" data-fc-action="search"[^>]*data-fc-engine="([a-z0-9]+)"/g)].map(m=>m[2]);
  assert.equal(JSON.stringify(paste),JSON.stringify(["search4faces"]));
  assert.ok(html.includes('data-fc-action="download"')&&html.includes('data-fc-action="copy"'));
  assert.match(html,/hosts this crop ~10 min/);
  assert.match(html,/direct result/);
});
