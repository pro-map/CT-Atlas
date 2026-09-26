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
  const elements=new Map(),listeners={},opened=[],confirms=[],fetchCalls=[],clipboardWrites=[];
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
    },
    confirm:text=>{confirms.push(text);return confirmAnswer;}
  };
  const cells={actions:{innerHTML:""},thumb:{innerHTML:""}};
  const document={readyState:"complete",getElementById:el,createElement:tag=>tag==="canvas"?makeCanvas():{},
    querySelector:selector=>selector.includes(".fc-actions")?cells.actions:selector.includes(".fc-thumb")?cells.thumb:null,
    querySelectorAll:()=>[],addEventListener(){},body:{appendChild(){}}};
  class TestURL extends URL{static createObjectURL(){return "blob:test";}static revokeObjectURL(){}}
  const okShare=async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:new Date(Date.now()+600000).toISOString(),ttl_seconds:600})});
  const context=vm.createContext({
    window,document,URL:TestURL,TextEncoder,Uint8Array,Blob,Date,Promise,Number,Math,Error,JSON,setTimeout,console,
    navigator:clipboard?{clipboard:{write:async items=>{clipboardWrites.push(items);}}}:{},
    ClipboardItem:class{constructor(data){this.data=data;}},
    createImageBitmap:async input=>input&&input.w?{width:input.w,height:input.h,close(){}}:{width:1000,height:640,close(){}},
    fetch:async(url,init)=>{fetchCalls.push({url,init});return (fetchImpl||okShare)(url,init);}
  });
  vm.runInContext(source,context);
  const crops=window.CTAtlasFaceCrops;
  return {crops,el,listeners,opened,confirms,fetchCalls,clipboardWrites,window,cells,
    async attach(){
      // one 1000x640 image with a large face: its crop is 1000x640 (~235 KB), so it must be shrunk to be hosted
      await crops.attach({
        payload:{files:[{kind:"image",filename:"a.jpg",width:1000,height:640,faces:[{face_id:1,box:{x:100,y:50,w:800,h:500}}]}],errors:[]},
        files:[{name:"a.jpg"}],api:API,getToken:()=>token
      });
    },
    click(action,engine){
      const target={dataset:{fcAction:action,fcKey:"0:0:1",...(engine?{fcEngine:engine}:{})},closest:()=>({removeAttribute(){}})};
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

test("one engine: opens a tab inside the click, asks first, hosts a SMALL copy, then sends the tab to the engine on that link",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");

  assert.equal(h.opened.length,1);
  assert.equal(h.opened[0].url,"about:blank");
  assert.equal(h.opened[0].opener,null,"the search page gets no reference back to CT Atlas");

  assert.equal(h.confirms.length,1);
  assert.match(h.confirms[0],/Yandex Images/);
  assert.match(h.confirms[0],/about 10 minutes/);
  assert.match(h.confirms[0],/deleted automatically/);
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

test("declining the confirmation uploads nothing and closes the tab",async()=>{
  const h=harness({confirmAnswer:false});
  await h.attach();
  await h.click("search-direct","bing");
  assert.equal(h.fetchCalls.length,0);
  assert.equal(h.opened.length,1);
  assert.equal(h.opened[0].closed,true);
  assert.deepEqual(h.opened[0].locations,[]);
  assert.match(h.status(),/nothing was uploaded/);
});

test("a second engine on the same crop reuses the hosted link: no new confirmation, no new upload",async()=>{
  const h=harness();
  await h.attach();
  await h.click("search-direct","yandex");
  await h.click("search-direct","tineye");
  assert.equal(h.confirms.length,1);
  assert.equal(h.fetchCalls.length,1);
  assert.equal(h.opened.length,2);
  assert.equal(h.opened[1].locations[0],"https://tineye.com/search?url="+encodeURIComponent(SHARE_URL));
});

test("an expired hosted link is never reused: it is confirmed and hosted again",async()=>{
  const h=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,url:SHARE_URL,expires_at:new Date(Date.now()+20*1000).toISOString()})})});
  await h.attach();
  await h.click("search-direct","yandex");
  await h.click("search-direct","bing");
  assert.equal(h.fetchCalls.length,2,"a link about to expire is hosted again");
  assert.equal(h.confirms.length,2);
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

test("pop-ups blocked: nothing is asked, nothing is uploaded, the analyst is told what to do",async()=>{
  const h=harness({popupLimit:0});
  await h.attach();
  await h.click("search-direct","yandex");
  assert.equal(h.confirms.length,0);
  assert.equal(h.fetchCalls.length,0);
  assert.match(h.status(),/Allow pop-ups/);
});

test("search all with only some tabs allowed: uploads once, opens what it can, says how many were blocked",async()=>{
  const h=harness({popupLimit:2});
  await h.attach();
  await h.click("search-all");
  assert.equal(h.opened.length,2);
  assert.equal(h.fetchCalls.length,1);
  assert.deepEqual(h.opened.map(win=>win.locations.length),[1,1]);
  assert.match(h.status(),/2 tab\(s\) were blocked/);
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
