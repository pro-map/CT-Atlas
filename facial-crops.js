(function(root){
"use strict";

// Face crops for Facial Intelligence: cuts each detected face out of the ORIGINAL
// uploaded file, in the browser (canvas), so nothing extra leaves the machine and no
// server change is needed. Crops can be downloaded as JPEG (one by one or as a ZIP)
// and searched on free reverse-image engines.
//
// The pure helpers at the top are unit-tested in Node; the DOM part is below.

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const MARGINS={tight:0,standard:0.3,wide:0.6};
const MIN_SIDE=300;          // engines do poorly on tiny crops
const MAX_UPSCALE=6;
const JPEG_QUALITY=0.92;

// Haar boxes hug the face; a margin (relative to the face size) keeps hair, chin and ears,
// which reverse-image engines need. Clamped to the source bounds.
function paddedBox(box,marginRatio,srcW,srcH){
  const pad=Math.round(Math.max(box.w,box.h)*Math.max(0,marginRatio||0));
  const x=Math.max(0,box.x-pad);
  const y=Math.max(0,box.y-pad);
  const right=Math.min(srcW,box.x+box.w+pad);
  const bottom=Math.min(srcH,box.y+box.h+pad);
  return {x,y,w:Math.max(1,right-x),h:Math.max(1,bottom-y)};
}

function outputSize(w,h,upscale,minSide=MIN_SIDE){
  const longest=Math.max(w,h);
  if(!upscale||longest>=minSide)return {w,h,scale:1};
  const scale=Math.min(MAX_UPSCALE,minSide/longest);
  return {w:Math.round(w*scale),h:Math.round(h*scale),scale};
}

// The service reports boxes in the pixels of the frame it decoded. The browser normally
// decodes the same dimensions; if it does not (rotation metadata, a different decoder) the
// boxes cannot be trusted, so return null instead of cutting the wrong area.
function mapBoxToSource(box,frame,srcW,srcH){
  if(!frame||!frame.width||!frame.height||!srcW||!srcH)return null;
  const sx=srcW/frame.width;
  const sy=srcH/frame.height;
  if(Math.abs(sx-sy)>0.02*Math.max(sx,sy))return null;
  return {x:Math.round(box.x*sx),y:Math.round(box.y*sy),w:Math.max(1,Math.round(box.w*sx)),h:Math.max(1,Math.round(box.h*sy))};
}

function safeStem(name){
  const stem=String(name||"media").replace(/\.[^.\\/]+$/,"");
  const cleaned=stem.normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^A-Za-z0-9._-]+/g,"_").replace(/^[_.]+|[_.]+$/g,"").slice(0,48);
  return cleaned||"media";
}

function cropFileName(fileName,face,timestamp){
  const time=Number.isFinite(timestamp)?"_t"+String(Math.round(timestamp*10)/10).replace(".","p")+"s":"";
  return "CTAtlas_"+safeStem(fileName)+time+"_F"+String(face.face_id??"")+".jpg";
}

function uniqueName(name,used){
  if(!used.has(name)){used.add(name);return name;}
  const dot=name.lastIndexOf(".");
  const stem=dot>0?name.slice(0,dot):name;
  const ext=dot>0?name.slice(dot):"";
  let n=2;
  while(used.has(stem+"_"+n+ext))n++;
  const unique=stem+"_"+n+ext;
  used.add(unique);
  return unique;
}

const CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;
    table[n]=c>>>0;
  }
  return table;
})();

function crc32(bytes){
  let c=0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

// Minimal ZIP writer (method 0 = stored: JPEGs are already compressed). entries: [{name,data:Uint8Array}]
function buildZip(entries,date=new Date()){
  const encoder=new TextEncoder();
  const dosTime=((date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1))&0xFFFF;
  const dosDate=(((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate())&0xFFFF;
  const local=[];
  const central=[];
  let offset=0;
  for(const entry of entries){
    const name=encoder.encode(entry.name);
    const data=entry.data;
    const crc=crc32(data);
    const header=new DataView(new ArrayBuffer(30));
    header.setUint32(0,0x04034b50,true);header.setUint16(4,20,true);header.setUint16(6,0x0800,true);header.setUint16(8,0,true);
    header.setUint16(10,dosTime,true);header.setUint16(12,dosDate,true);header.setUint32(14,crc,true);
    header.setUint32(18,data.length,true);header.setUint32(22,data.length,true);header.setUint16(26,name.length,true);header.setUint16(28,0,true);
    local.push(new Uint8Array(header.buffer),name,data);
    const dir=new DataView(new ArrayBuffer(46));
    dir.setUint32(0,0x02014b50,true);dir.setUint16(4,20,true);dir.setUint16(6,20,true);dir.setUint16(8,0x0800,true);dir.setUint16(10,0,true);
    dir.setUint16(12,dosTime,true);dir.setUint16(14,dosDate,true);dir.setUint32(16,crc,true);
    dir.setUint32(20,data.length,true);dir.setUint32(24,data.length,true);dir.setUint16(28,name.length,true);
    dir.setUint16(30,0,true);dir.setUint16(32,0,true);dir.setUint16(34,0,true);dir.setUint16(36,0,true);dir.setUint32(38,0,true);dir.setUint32(42,offset,true);
    central.push(new Uint8Array(dir.buffer),name);
    offset+=30+name.length+data.length;
  }
  const centralSize=central.reduce((sum,part)=>sum+part.length,0);
  const end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true);end.setUint16(8,entries.length,true);end.setUint16(10,entries.length,true);
  end.setUint32(12,centralSize,true);end.setUint32(16,offset,true);
  const parts=[...local,...central,new Uint8Array(end.buffer)];
  const out=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));
  let position=0;
  for(const part of parts){out.set(part,position);position+=part.length;}
  return out;
}

// Free reverse-image tools. None of them accepts an upload from another site (tested:
// Yandex ignores the file, TinEye sits behind a Cloudflare check, Bing redirects home,
// Google Lens answers 403), so each is opened on its own upload page and the crop is put
// on the clipboard for Ctrl+V. The crop reaches a third party only when the user pastes it.
const SEARCH_ENGINES=Object.freeze([
  {id:"yandex",name:"Yandex Images",url:"https://yandex.com/images/search?rpt=imageview",note:"free · strongest on faces"},
  {id:"google",name:"Google Images / Lens",url:"https://images.google.com/",note:"free · camera icon"},
  {id:"bing",name:"Bing Visual Search",url:"https://www.bing.com/visualsearch",note:"free"},
  {id:"tineye",name:"TinEye",url:"https://tineye.com/",note:"free · limited daily searches"},
  {id:"search4faces",name:"Search4faces",url:"https://search4faces.com/",note:"free · VK / OK / TikTok profiles"},
  {id:"baidu",name:"Baidu Images",url:"https://image.baidu.com/",note:"free · Chinese web"}
]);

const helpers={MARGINS,MIN_SIDE,MAX_UPSCALE,paddedBox,outputSize,mapBoxToSource,safeStem,cropFileName,uniqueName,crc32,buildZip,SEARCH_ENGINES};
if(typeof module!=="undefined"&&module.exports)module.exports=helpers;
if(typeof document==="undefined"){root.CTAtlasFaceCropsHelpers=helpers;return;}

// ---------------------------------------------------------------------------
// DOM part
// ---------------------------------------------------------------------------
const $=id=>document.getElementById(id);
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

let generation=0;
let records=new Map();      // key -> {key,name,blob,url,width,height,upscaled,state,error,label}
let context=null;           // {payload,files}

function setStatus(message,tone){
  const el=$("fcStatus");
  if(!el)return;
  el.textContent=message||"";
  el.className="fc-status"+(tone?" "+tone:"");
}

function once(target,event,timeoutMs){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error("timeout"));},timeoutMs);
    const ok=()=>{cleanup();resolve();};
    const fail=()=>{cleanup();reject(new Error("decode error"));};
    function cleanup(){clearTimeout(timer);target.removeEventListener(event,ok);target.removeEventListener("error",fail);}
    target.addEventListener(event,ok);
    target.addEventListener("error",fail);
  });
}

function canvasToBlob(canvas,type,quality){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("encode failed")),type,quality));
}

async function loadImage(file){
  // createImageBitmap applies EXIF orientation by default, like the decoder that produced the boxes.
  if(typeof createImageBitmap==="function"){
    return createImageBitmap(file,{imageOrientation:"from-image"});
  }
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();
    img.src=url;
    await img.decode();
    return img;
  }finally{URL.revokeObjectURL(url);}
}

async function openVideo(file){
  const url=URL.createObjectURL(file);
  const video=document.createElement("video");
  video.muted=true;video.playsInline=true;video.preload="auto";video.src=url;
  await once(video,"loadedmetadata",10000);
  return {video,url};
}

async function videoFrame(handle,seconds){
  const {video}=handle;
  const target=Math.min(Math.max(0,seconds||0),Math.max(0,(video.duration||0)-0.05));
  video.currentTime=target;
  await once(video,"seeked",10000);
  const canvas=document.createElement("canvas");
  canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  canvas.getContext("2d").drawImage(video,0,0);
  return canvas;
}

function cropFromSource(source,srcW,srcH,frame,face,options){
  const mapped=mapBoxToSource(face.box,frame,srcW,srcH);
  if(!mapped)throw new Error("the browser decodes this media with different dimensions or orientation than the analysis service");
  const area=paddedBox(mapped,options.margin,srcW,srcH);
  const out=outputSize(area.w,area.h,options.upscale);
  const canvas=document.createElement("canvas");
  canvas.width=out.w;canvas.height=out.h;
  const ctx=canvas.getContext("2d");
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.fillStyle="#fff";ctx.fillRect(0,0,out.w,out.h);   // JPEG has no alpha
  ctx.drawImage(source,area.x,area.y,area.w,area.h,0,0,out.w,out.h);
  return {canvas,width:out.w,height:out.h,upscaled:out.scale>1,sourceWidth:area.w,sourceHeight:area.h};
}

function options(){
  return {
    margin:MARGINS[$("fcMargin")?.value]??MARGINS.standard,
    upscale:Boolean($("fcUpscale")?.checked)
  };
}

function release(){
  for(const record of records.values())if(record.url)URL.revokeObjectURL(record.url);
  records=new Map();
}

function cell(key,selector){
  return document.querySelector('[data-fc-key="'+key+'"]'+(selector||""));
}

function paintCell(record){
  const thumb=cell(record.key,".fc-thumb");
  const actions=cell(record.key,".fc-actions");
  if(thumb){
    thumb.innerHTML=record.state==="ready"
      ?'<img src="'+esc(record.url)+'" alt="Cropped face '+esc(record.label)+'" width="'+esc(Math.min(72,record.width))+'">'
      :'<span class="fc-fail" title="'+esc(record.error||"")+'">n/a</span>';
  }
  if(actions){
    if(record.state!=="ready"){
      actions.innerHTML='<span class="fc-fail-note">'+esc(record.error||"Crop unavailable")+'</span>';
      return;
    }
    actions.innerHTML=
      '<div class="fc-buttons">'+
        '<button type="button" class="fc-btn" data-fc-action="download" data-fc-key="'+esc(record.key)+'">JPEG</button>'+
        '<button type="button" class="fc-btn" data-fc-action="copy" data-fc-key="'+esc(record.key)+'">COPY</button>'+
      '</div>'+
      '<details class="fc-search"><summary>SEARCH ▾</summary><div class="fc-menu">'+
        SEARCH_ENGINES.map(engine=>
          '<a class="fc-engine" href="'+esc(engine.url)+'" target="_blank" rel="noopener noreferrer" data-fc-action="search" data-fc-key="'+esc(record.key)+'" data-fc-engine="'+esc(engine.id)+'">'+
          '<b>'+esc(engine.name)+'</b><span>'+esc(engine.note)+'</span></a>'
        ).join("")+
      '</div></details>';
  }
}

async function generate(){
  const token=++generation;
  release();
  const {payload,files}=context;
  const byName=new Map();
  const duplicates=new Set();
  for(const file of files){
    if(byName.has(file.name))duplicates.add(file.name);
    byName.set(file.name,file);
  }
  // The service answers in upload order. When every file was analysed (no errors), match by
  // position: it also works if the name was altered on the way (multipart quoting, unusual
  // characters). Otherwise fall back to the name.
  const byPosition=files.length===(payload.files||[]).length&&!(payload.errors||[]).length;
  const opts=options();
  const used=new Set();
  const work=[];   // {fileName,fileIndex,frame,frameIndex,isVideo,faces}
  (payload.files||[]).forEach((item,fi)=>{
    if(item.kind==="video")(item.sampled_frames||[]).forEach((frame,ri)=>work.push({fileName:item.filename,fi,ri,frame,isVideo:true}));
    else work.push({fileName:item.filename,fi,ri:0,frame:item,isVideo:false});
  });
  const total=work.reduce((n,job)=>n+(job.frame.faces||[]).length,0);
  let done=0;
  setStatus(total?"Cutting "+total+" face(s) in your browser…":"");
  const videoHandles=new Map();
  const bitmaps=new Map();

  try{
    for(const job of work){
      const faces=job.frame.faces||[];
      if(!faces.length)continue;
      const file=byPosition?files[job.fi]:byName.get(job.fileName);
      let failure="";
      let source=null,srcW=0,srcH=0;
      if(!file||(!byPosition&&duplicates.has(job.fileName))){
        failure=!byPosition&&duplicates.has(job.fileName)?"two uploaded files share this name":"original file not available";
      }else{
        try{
          if(job.isVideo){
            let handle=videoHandles.get(job.fileName);
            if(!handle){handle=await openVideo(file);videoHandles.set(job.fileName,handle);}
            if(token!==generation)return;
            source=await videoFrame(handle,job.frame.timestamp_seconds);
            srcW=source.width;srcH=source.height;
          }else{
            let bitmap=bitmaps.get(job.fileName);
            if(!bitmap){bitmap=await loadImage(file);bitmaps.set(job.fileName,bitmap);}
            source=bitmap;srcW=bitmap.width;srcH=bitmap.height;
          }
        }catch(error){
          failure=job.isVideo?"this browser cannot decode the video":"this browser cannot decode the image";
        }
      }
      if(token!==generation)return;
      for(const face of faces){
        const key=job.fi+":"+job.ri+":"+face.face_id;
        const label="F"+face.face_id+(job.isVideo?" @ "+job.frame.timestamp_seconds+"s":"");
        const record={key,label,state:"error",error:failure,name:uniqueName(cropFileName(job.fileName,face,job.isVideo?job.frame.timestamp_seconds:null),used)};
        if(!failure){
          try{
            const crop=cropFromSource(source,srcW,srcH,job.frame,face,opts);
            record.blob=await canvasToBlob(crop.canvas,"image/jpeg",JPEG_QUALITY);
            record.url=URL.createObjectURL(record.blob);
            Object.assign(record,{state:"ready",error:"",width:crop.width,height:crop.height,upscaled:crop.upscaled,sourceWidth:crop.sourceWidth,sourceHeight:crop.sourceHeight});
          }catch(error){record.error=error.message||"crop failed";}
        }
        records.set(key,record);
        paintCell(record);
        done++;
        setStatus("Cutting faces… "+done+" / "+total);
      }
    }
  }finally{
    for(const handle of videoHandles.values())URL.revokeObjectURL(handle.url);
    for(const bitmap of bitmaps.values())bitmap.close?.();
  }
  if(token!==generation)return;
  const ready=[...records.values()].filter(r=>r.state==="ready").length;
  const failed=records.size-ready;
  const zip=$("fcZip");
  if(zip)zip.disabled=!ready;
  setStatus(total
    ?ready+" face crop(s) ready"+(failed?" · "+failed+" unavailable":"")+" · cut locally, EXIF/GPS is not carried over to the crops."
    :"No face detected, so there is nothing to crop.",failed&&!ready?"error":"");
}

function download(blob,name){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}

// The clipboard only accepts PNG, so the JPEG crop is re-encoded on demand. The promise form
// of ClipboardItem keeps the user activation alive while that happens.
function pngFor(record){
  return (async()=>{
    const bitmap=await createImageBitmap(record.blob);
    const canvas=document.createElement("canvas");
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.getContext("2d").drawImage(bitmap,0,0);
    bitmap.close?.();
    return canvasToBlob(canvas,"image/png");
  })();
}

async function copy(record){
  if(!navigator.clipboard||typeof ClipboardItem==="undefined"){
    setStatus("This browser cannot copy images: download the JPEG and drag it onto the search page.","error");
    return false;
  }
  try{
    await navigator.clipboard.write([new ClipboardItem({"image/png":pngFor(record)})]);
    return true;
  }catch(error){
    setStatus("Copy was blocked ("+(error.message||"permission")+"): download the JPEG and drag it onto the search page.","error");
    return false;
  }
}

async function onClick(event){
  const target=event.target.closest("[data-fc-action]");
  if(!target)return;
  const action=target.dataset.fcAction;
  const record=records.get(target.dataset.fcKey);
  if(!record||record.state!=="ready")return;
  if(action==="download"){download(record.blob,record.name);setStatus("Downloaded "+record.name+".");return;}
  if(action==="copy"){
    if(await copy(record))setStatus("Face "+record.label+" copied to the clipboard.");
    return;
  }
  if(action==="search"){
    // The link opens the engine's page natively (never popup-blocked); meanwhile put the crop on the clipboard.
    const engine=SEARCH_ENGINES.find(item=>item.id===target.dataset.fcEngine);
    const copied=await copy(record);
    if(copied)setStatus("Face "+record.label+" copied. On "+engine.name+", open its image-upload box and press Ctrl+V (or drag the JPEG). The crop is sent to "+engine.name+" only when you paste it there.");
    target.closest("details")?.removeAttribute("open");
  }
}

async function downloadZip(){
  const ready=[...records.values()].filter(r=>r.state==="ready");
  if(!ready.length)return;
  setStatus("Building ZIP…");
  const entries=[];
  for(const record of ready)entries.push({name:record.name,data:new Uint8Array(await record.blob.arrayBuffer())});
  const zip=buildZip(entries);
  download(new Blob([zip],{type:"application/zip"}),"CTAtlas_face_crops_"+new Date().toISOString().slice(0,10)+".zip");
  setStatus(ready.length+" face crop(s) added to the ZIP.");
}

function attach(next){
  context=next;
  const bar=$("fcBar");
  if(bar)bar.hidden=false;
  const items=$("fiItems");
  if(items&&!items.dataset.fcBound){items.addEventListener("click",onClick);items.dataset.fcBound="1";}
  const zip=$("fcZip");
  if(zip)zip.disabled=true;
  return generate();
}

// The engine menu is position:fixed (an absolute one would be clipped by the card), so it is
// placed from the SEARCH button when it opens, flipped upward if there is no room below.
function closeMenus(except){
  document.querySelectorAll("details.fc-search[open]").forEach(details=>{if(details!==except)details.removeAttribute("open");});
}
function placeMenu(details){
  const menu=details.querySelector(".fc-menu");
  const rect=details.querySelector("summary").getBoundingClientRect();
  const width=menu.offsetWidth||230,height=menu.offsetHeight||260;
  const left=Math.min(Math.max(8,rect.left),Math.max(8,window.innerWidth-width-8));
  let top=rect.bottom+4;
  if(top+height>window.innerHeight-8)top=Math.max(8,rect.top-height-4);
  menu.style.left=left+"px";menu.style.top=top+"px";
}

function bindControls(){
  $("fcMargin")?.addEventListener("change",()=>{if(context)generate();});
  $("fcUpscale")?.addEventListener("change",()=>{if(context)generate();});
  $("fcZip")?.addEventListener("click",downloadZip);
  // 'toggle' does not bubble, hence the capture phase.
  document.addEventListener("toggle",event=>{
    const details=event.target;
    if(details.matches?.("details.fc-search")&&details.open){closeMenus(details);placeMenu(details);}
  },true);
  document.addEventListener("click",event=>{if(!event.target.closest?.("details.fc-search"))closeMenus();});
  window.addEventListener("scroll",()=>closeMenus(),true);
  window.addEventListener("resize",()=>closeMenus());
}

root.CTAtlasFaceCrops={attach,helpers};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bindControls);
else bindControls();
})(typeof window!=="undefined"?window:globalThis);
