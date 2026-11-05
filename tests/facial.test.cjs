const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

// Runs the real facial.js against a minimal fake page and submits the form once.
async function analyse(answer,{status=200}={}){
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id))elements.set(id,{id,hidden:false,className:"",textContent:"",innerHTML:"",checked:true,disabled:false,listeners:{},
      files:id==="fiFiles"?[{name:"a.jpg",size:10,type:"image/jpeg"}]:undefined,
      addEventListener(type,fn){this.listeners[type]=fn;},
      insertAdjacentHTML(_,html){this.innerHTML+=html;},
      getBoundingClientRect:()=>({top:0})});
    return elements.get(id);
  };
  const json=body=>({ok:status<400,status,json:async()=>body});
  vm.runInNewContext(fs.readFileSync("facial.js","utf8"),{
    document:{getElementById:el},
    sessionStorage:{getItem:()=>"tok",setItem(){},removeItem(){}},
    location:{replace(){}},window:{innerHeight:800},
    fetch:async url=>String(url).includes("/session-check")?{ok:true,status:200,json:async()=>({ok:true,username:"alice"})}:json(answer),
    FormData:class{append(){}},URL,Blob,setTimeout,console
  });
  await el("fiForm").listeners.submit({preventDefault(){}});
  return {status:el("fiStatus"),items:el("fiItems").innerHTML};
}

const frame=extra=>({kind:"image",filename:"a.jpg",label:"a.jpg",width:10,height:10,face_count:0,faces:[],...extra});

test("an analysis in which no file could be read is an error, not 'Analysis complete'",async()=>{
  const {status,items}=await analyse({ok:false,files:[],errors:[{filename:"a.gif",error:"Unable to decode image."}]});
  assert.equal(status.className,"status error");
  assert.match(status.textContent,/^Analysis failed/);
  assert.match(items,/PROCESSING WARNINGS/);
  assert.match(items,/Unable to decode image/);
});

test("a working analysis still reports success, and says when OCR ran out of time",async()=>{
  const done=await analyse({ok:true,files:[frame()],errors:[]});
  assert.equal(done.status.className,"status");
  assert.equal(done.status.textContent,"Analysis complete.");
  const partial=await analyse({ok:true,files:[frame({ocr_status:"skipped"})],ocr_skipped:1,errors:[]});
  assert.equal(partial.status.className,"status");
  assert.match(partial.status.textContent,/^Analysis complete\. OCR was skipped on 1 frame/);
});

test("each frame says how OCR went, so no text is not mistaken for text that was not read",async()=>{
  const shown=async extra=>(await analyse({ok:true,files:[frame(extra)],errors:[]})).items;
  assert.match(await shown({ocr_status:"no_text"}),/<b>OCR<\/b><br>No text found\./);
  assert.match(await shown({ocr_status:"timeout"}),/Timed out on this frame/);
  assert.match(await shown({ocr_status:"failed"}),/Failed on this frame/);
  assert.match(await shown({ocr_status:"skipped"}),/reached its OCR time limit/);
  assert.match(await shown({ocr_status:"ok",ocr_text:"<b>wanted</b>"}),/&lt;b&gt;wanted&lt;\/b&gt;/);
  assert.doesNotMatch(await shown({ocr_status:"not_run"}),/<b>OCR<\/b>/);
  assert.doesNotMatch(await shown({}),/<b>OCR<\/b>/,"an older service sends no status");
});

test("only a JPEG data URI from the service is rendered as the preview",async()=>{
  const shown=async annotated_preview=>(await analyse({ok:true,files:[frame({annotated_preview})],errors:[]})).items;
  assert.match(await shown("data:image/jpeg;base64,AAAA+/=="),/<img src="data:image\/jpeg;base64,AAAA\+\/=="/);
  for(const bad of ['x" onerror="alert(1)','data:text/html;base64,AAAA','data:image/jpeg;base64,AA" onerror="x','https://example.org/a.jpg']){
    assert.doesNotMatch(await shown(bad),/<img/,bad);
  }
});

test("the file picker and its help text offer only what the service can decode",()=>{
  const html=fs.readFileSync("facial.html","utf8");
  const accept=html.match(/<input id="fiFiles"[^>]*accept="([^"]+)"/)[1];
  assert.doesNotMatch(accept,/image\/\*|video\/\*|gif|avif|heic/i);
  const service=fs.readFileSync("visual-intel-service/app.py","utf8");
  for(const suffix of [...service.matchAll(/suffix in \{([^}]+)\}/g)].flatMap(m=>m[1].match(/\.[a-z0-9]+/g))){
    if(suffix===".jpeg"||suffix===".tif")continue;     // the help text names JPG and TIFF
    assert.match(html,new RegExp("drop-help[^<]*\\b"+suffix.slice(1).toUpperCase()+"\\b"),suffix);
  }
  assert.match(html,/GIF, AVIF and HEIC are not supported/);
  assert.doesNotMatch(html,/common formats/);
});

test("Facial Intelligence requires an explicit lawful-basis consent checkbox before analysis runs",()=>{
  const html=fs.readFileSync("facial.html","utf8");
  const js=fs.readFileSync("facial.js","utf8");
  assert.ok(html.includes('id="fiConsent"'),"the form must render a consent checkbox");
  assert.match(html,/lawful basis/i,"the consent copy must name the lawful-basis requirement");
  assert.ok(js.includes('$("fiConsent").checked'),"submission must check the consent checkbox state");
  // The consent check must run before the network request, not after.
  const consentIndex=js.indexOf('$("fiConsent").checked');
  const fetchIndex=js.indexOf("visual-analyze");
  assert.ok(consentIndex>-1 && fetchIndex>-1 && consentIndex<fetchIndex,
    "consent must be verified before the analysis request is sent");
});

test("Facial Intelligence discloses a retention statement for uploaded media",()=>{
  const html=fs.readFileSync("facial.html","utf8");
  assert.match(html,/RETENTION/i);
  assert.match(html,/not stored/i);
});
