(function(root){
"use strict";

// Face crops for Facial Intelligence: cuts each detected face out of the ORIGINAL
// uploaded file, in the browser (canvas), so nothing extra leaves the machine while
// cropping. Crops can be downloaded as JPEG (one by one or as a ZIP) and searched on free
// reverse-image engines. A crop leaves the browser only through an explicit SEARCH click
// (see shareCrop) or when the user pastes it into a search page.
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
// Google Lens answers 403). Two ways to reach them:
//   - "direct": the engine is opened on a URL of the crop (search-by-URL). That needs the
//     crop to be reachable, so on an explicit click, and after a confirmation, this one
//     crop is hosted for a few minutes by the CT Atlas Worker (see shareCrop below);
//   - "paste": the engine's own upload page is opened and the crop is put on the clipboard
//     for Ctrl+V. Nothing is uploaded by CT Atlas; the crop reaches the service only when
//     the user pastes it. Used by engines that cannot search by URL, and as the fallback.
const encode=encodeURIComponent;
const SEARCH_ENGINES=Object.freeze([
  {id:"yandex",name:"Yandex Images",url:"https://yandex.com/images/search?rpt=imageview",note:"free · strongest on faces",
    direct:link=>"https://yandex.com/images/search?rpt=imageview&url="+encode(link)},
  {id:"bing",name:"Bing Visual Search",url:"https://www.bing.com/visualsearch",note:"free",
    direct:link=>"https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:"+encode(link)},
  {id:"google",name:"Google Images / Lens",url:"https://images.google.com/",note:"free",
    direct:link=>"https://lens.google.com/uploadbyurl?url="+encode(link)},
  {id:"tineye",name:"TinEye",url:"https://tineye.com/",note:"free · limited daily searches",
    direct:link=>"https://tineye.com/search?url="+encode(link)},
  {id:"baidu",name:"Baidu Images",url:"https://image.baidu.com/",note:"free · Chinese web",
    direct:link=>"https://graph.baidu.com/details?isfromtusoupc=1&tn=pc&image="+encode(link)},
  {id:"search4faces",name:"Search4faces",url:"https://search4faces.com/",note:"free · VK / OK / TikTok · paste only",direct:null}
]);
const SEARCH_ALL_IDS=Object.freeze(["yandex","bing","google","tineye"]);

// What is hosted for a direct search: ONE crop, re-encoded small (the Worker refuses more
// than 150 KB), with no metadata, deleted by the Worker after a few minutes.
const MAX_SHARE_BYTES=140*1024;
const MAX_SHARE_SIDE=900;
const SHARE_MIN_LIFETIME_MS=90*1000;     // an engine needs a moment to download the image
const UPLOAD_TIMEOUT_MS=20*1000;         // a stalled hosting request falls back to copy-and-paste
const SHARE_PATH_RE=/^\/face-share\/[A-Za-z0-9_-]{22}\.jpg$/;

function shareDimensions(w,h,maxSide=MAX_SHARE_SIDE){
  const longest=Math.max(w,h);
  if(!longest||longest<=maxSide)return {w,h};      // never upscale
  const scale=maxSide/longest;
  return {w:Math.max(1,Math.round(w*scale)),h:Math.max(1,Math.round(h*scale))};
}

function directSearchUrl(engine,shareUrl){
  if(!engine||typeof engine.direct!=="function")return null;
  return engine.direct(shareUrl);
}

// The link the Worker returns is what gets handed to third-party engines: only accept one
// that points at the CT Atlas API's own hosting path.
function validShareUrl(value,api){
  try{
    const url=new URL(value);
    return url.origin===new URL(api).origin&&SHARE_PATH_RE.test(url.pathname)&&!url.search&&!url.hash;
  }catch(_){return false;}
}

function shareUsable(share,now){
  return Boolean(share)&&Number.isFinite(share.expiresAt)&&share.expiresAt-now>SHARE_MIN_LIFETIME_MS;
}

const helpers={MARGINS,MIN_SIDE,MAX_UPSCALE,paddedBox,outputSize,mapBoxToSource,safeStem,cropFileName,uniqueName,crc32,buildZip,SEARCH_ENGINES,SEARCH_ALL_IDS,MAX_SHARE_BYTES,MAX_SHARE_SIDE,shareDimensions,directSearchUrl,validShareUrl,shareUsable};
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
        '<button type="button" class="fc-engine fc-all" data-fc-action="search-all" data-fc-key="'+esc(record.key)+'">'+
          '<b>Search all ('+SEARCH_ALL_IDS.length+' tabs)</b><span>hosts this crop ~10 min · '+esc(SEARCH_ALL_IDS.map(id=>SEARCH_ENGINES.find(e=>e.id===id).name.split(" ")[0]).join(", "))+'</span></button>'+
        SEARCH_ENGINES.map(engine=>engine.direct
          ?'<button type="button" class="fc-engine" data-fc-action="search-direct" data-fc-key="'+esc(record.key)+'" data-fc-engine="'+esc(engine.id)+'">'+
            '<b>'+esc(engine.name)+'</b><span>'+esc(engine.note)+' · direct result</span></button>'
          :'<a class="fc-engine" href="'+esc(engine.url)+'" target="_blank" rel="noopener noreferrer" data-fc-action="search" data-fc-key="'+esc(record.key)+'" data-fc-engine="'+esc(engine.id)+'">'+
            '<b>'+esc(engine.name)+'</b><span>'+esc(engine.note)+'</span></a>'
        ).join("")+
      '</div></details>';
  }
}

async function generate(){
  const token=++generation;
  release();
  showMoreLinks([]);
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
        const record={key,label,state:"error",error:failure,consented:new Set(),name:uniqueName(cropFileName(job.fileName,face,job.isVideo?job.frame.timestamp_seconds:null),used)};
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

// ---- Direct search: host ONE crop briefly, then open the engines on its URL ------------------
// Only requestSearch() below leads here, and only from a click on a SEARCH menu entry.

// A small JPEG (re-encoded from the crop: canvas output carries no EXIF/GPS) under the size
// the Worker accepts.
async function shrinkForSearch(record){
  const bitmap=await createImageBitmap(record.blob);
  try{
    let {w,h}=shareDimensions(bitmap.width,bitmap.height);
    for(let round=0;round<6;round++){
      const canvas=document.createElement("canvas");
      canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext("2d");
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
      ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
      ctx.drawImage(bitmap,0,0,w,h);
      for(const quality of [0.9,0.8,0.7,0.6]){
        const blob=await canvasToBlob(canvas,"image/jpeg",quality);
        if(blob.size<=MAX_SHARE_BYTES)return blob;
      }
      w=Math.max(1,Math.round(w*0.8));h=Math.max(1,Math.round(h*0.8));
    }
    throw new Error("the crop cannot be reduced under "+Math.round(MAX_SHARE_BYTES/1024)+" KB");
  }finally{bitmap.close?.();}
}

async function shareCrop(record){
  if(shareUsable(record.share,Date.now()))return record.share;      // already hosted, still fresh
  const api=context&&context.api;
  const token=context&&context.getToken?context.getToken():"";
  if(!api||!token)throw new Error("your session is not available: sign in again");
  const body=await shrinkForSearch(record);
  const controller=typeof AbortController==="function"?new AbortController():null;
  const timer=setTimeout(()=>{if(controller)controller.abort();},UPLOAD_TIMEOUT_MS);
  const sentAt=Date.now();
  let response;
  try{
    response=await fetch(api+"/face-share",{method:"POST",headers:{"X-Session-Token":token,"Content-Type":"image/jpeg"},body,...(controller?{signal:controller.signal}:{})});
  }catch(error){
    throw new Error(error&&error.name==="AbortError"?"CT Atlas did not answer in time":"CT Atlas could not be reached");
  }finally{clearTimeout(timer);}
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok)throw new Error(data.error||"the temporary hosting refused the image (HTTP "+response.status+")");
  if(!validShareUrl(data.url,api))throw new Error("the hosting answer was not a valid CT Atlas link");
  // The lifetime is taken from the relative ttl (measured from when the request left), not from
  // the server's absolute timestamp, so a wrong clock on this computer cannot mislead it.
  const ttl=Number(data.ttl_seconds);
  const expiresAt=Number.isFinite(ttl)&&ttl>0?sentAt+ttl*1000:Date.parse(data.expires_at);
  record.share={url:data.url,expiresAt:Number.isFinite(expiresAt)?expiresAt:sentAt+9*60*1000};
  record.consented=new Set();       // a new hosting: every engine has to be confirmed again
  return record.share;
}

// Opened synchronously inside the click (so pop-up blockers allow it), navigated once the
// crop is hosted. Without an opener reference, the engine's page cannot reach CT Atlas.
function openPlaceholder(){
  let win=null;
  try{win=window.open("about:blank","_blank");}catch(_){win=null;}
  if(win){
    try{
      win.opener=null;
      win.document.title="CT Atlas · preparing face search";
      win.document.body.style.cssText="margin:0;padding:28px;font:14px system-ui,sans-serif;background:#0d1620;color:#cbd9e0";
      win.document.body.textContent="Preparing the face search…";
    }catch(_){/* a blocked document write is harmless */}
  }
  return win;
}

function confirmText(record,engines,hostedShare){
  const names=engines.map(engine=>engine.name).join(", ");
  if(hostedShare){
    const minutes=Math.max(1,Math.round((hostedShare.expiresAt-Date.now())/60000));
    return "Also search face "+record.label+" on "+names+"?\n\n"+
      "This crop is already hosted on CT Atlas's temporary storage (EU) and will be deleted automatically in about "+minutes+" minute(s). "+
      "Pressing OK gives the same link to "+names+", which will download the crop and apply its own retention rules to it.\n\n"+
      "Nothing is shared with "+names+" unless you press OK.";
  }
  return "Search face "+record.label+" directly on "+names+"?\n\n"+
    "These services can only search by web address, so this ONE crop (a small JPEG without metadata) will be hosted on CT Atlas's temporary storage (EU) for about 10 minutes. "+
    "Anyone holding its unguessable link can view it during that time, it is downloaded by the search service(s) you picked (each applies its own retention rules to what it downloads), and CT Atlas deletes its copy automatically afterwards.\n\n"+
    "Nothing is uploaded unless you press OK.";
}

// A browser lets one click open one tab: the engines that did not get a tab are offered as
// real links (a click on a link is its own gesture, and rel=noreferrer keeps CT Atlas out of the request).
// "Reopen" repeats the opened ones, as a manual way back if a tab was closed or did not load.
function moreLinks(items){
  return items.map(item=>'<a class="fc-more-link" href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.engine.name)+'</a>').join(" ");
}
function showMoreLinks(queued,opened=[]){
  const box=$("fcMore");
  if(!box)return;
  box.innerHTML=(queued.length?'<span>Also open:</span> '+moreLinks(queued):"")+
    (opened.length?(queued.length?' ':"")+'<span>Reopen:</span> '+moreLinks(opened):"");
  box.hidden=!(queued.length||opened.length);
}

// In-page confirmation. The browser's built-in confirm box is NOT used: the search tab is opened in the same click,
// takes the focus, and a dialog raised by the tab that just went to the background can be suppressed
// by the browser, which reads as "cancel" (the tab appears and vanishes). This dialog belongs to the
// page the analyst is looking at, and its OK button is itself a click, so the tabs are opened
// inside that click and keep their permission to open.
function askConsent(text,onAccept,onCancel){
  const dialog=document.createElement("dialog");
  dialog.className="fc-consent";
  dialog.innerHTML='<div class="fc-consent-title">THIRD-PARTY FACE SEARCH</div><div class="fc-consent-text"></div>'+
    '<div class="fc-consent-actions"><button type="button" class="fc-btn" data-fc-consent="cancel">CANCEL</button>'+
    '<button type="button" class="fc-btn fc-btn-primary" data-fc-consent="ok">OK — HOST &amp; SEARCH</button></div>';
  dialog.querySelector(".fc-consent-text").textContent=text;
  let accepted=false;
  dialog.addEventListener("click",event=>{
    const choice=event.target.closest?.("[data-fc-consent]")?.dataset.fcConsent;
    if(choice==="ok"){
      accepted=true;
      if(typeof dialog.close==="function")dialog.close();
      dialog.remove();
      onAccept();
    }else if(choice==="cancel"){
      if(typeof dialog.close==="function")dialog.close();else{dialog.remove();if(onCancel)onCancel();}
    }
  });
  dialog.addEventListener("close",()=>{dialog.remove();if(!accepted&&onCancel)onCancel();});   // CANCEL or Escape
  document.body.appendChild(dialog);
  if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");
  const safe=dialog.querySelector('[data-fc-consent="cancel"]');
  if(safe)safe.focus();     // the safe answer is the default one
}
let consentPrompt=askConsent;

// Entry point of a direct search, called from a click. Nothing is opened or uploaded before the analyst
// has confirmed every engine that is new for the current hosting.
function requestSearch(record,engines){
  if(record.searching){setStatus("A search for face "+record.label+" is already in progress.");return;}
  const hosted=shareUsable(record.share,Date.now());
  const consented=hosted?record.consented:new Set();
  const fresh=engines.filter(engine=>!consented.has(engine.id));
  if(!fresh.length)return startSearch(record,engines);       // nothing new to confirm: open the tabs right in this click
  let running;
  consentPrompt(confirmText(record,fresh,hosted?record.share:null),
    ()=>{running=startSearch(record,engines);},               // the OK click: still a user gesture
    ()=>setStatus(hosted?"Search cancelled: the link was not given to "+fresh.map(engine=>engine.name).join(", ")+".":"Search cancelled: nothing was uploaded."));
  return running;
}

async function startSearch(record,engines){
  if(record.searching)return;
  record.searching=true;
  try{await runDirectSearch(record,engines);}
  finally{record.searching=false;}
}

async function runDirectSearch(record,engines){
  showMoreLinks([]);
  const windows=engines.map(()=>openPlaceholder());       // synchronous: still inside the click / the OK click
  if(windows.every(win=>!win)){
    setStatus("The browser blocked the search window(s). Allow pop-ups for this site, then try again.","error");
    return;
  }
  try{
    setStatus("Hosting face "+record.label+" for a few minutes…");
    const share=await shareCrop(record);
    for(const engine of engines)record.consented.add(engine.id);
    const opened=[],queued=[];
    engines.forEach((engine,index)=>{
      const url=directSearchUrl(engine,share.url);
      const win=windows[index];
      if(win&&!win.closed){win.location.replace(url);opened.push({engine,url});}
      else queued.push({engine,url});
    });
    showMoreLinks(queued,opened);
    const minutes=Math.max(1,Math.round((share.expiresAt-Date.now())/60000));
    setStatus("Face "+record.label+": "+opened.map(item=>item.engine.name).join(", ")+" opened on the hosted crop. The link stays valid for about "+minutes+" more minute(s), then the image is deleted automatically. Results are leads, not identifications."+
      (queued.length?" Your browser opens one tab per click: use the links below for "+queued.map(item=>item.engine.name).join(", ")+".":""));
  }catch(error){
    // Fall back to the paste flow: each window goes to the engine's own upload page.
    engines.forEach((engine,index)=>{try{if(windows[index])windows[index].location.replace(engine.url);}catch(_){/* window closed by the user */}});
    const copied=await copy(record);
    setStatus("Direct search unavailable ("+(error.message||"error")+"). "+(copied
      ?"The crop was copied instead: on the engine's page open its image-upload box and press Ctrl+V."
      :"Download the JPEG and drag it onto the engine's page."),"error");
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
  if(action==="search-direct"||action==="search-all"){
    const engines=action==="search-all"
      ?SEARCH_ALL_IDS.map(id=>SEARCH_ENGINES.find(item=>item.id===id))
      :[SEARCH_ENGINES.find(item=>item.id===target.dataset.fcEngine&&item.direct)].filter(Boolean);
    target.closest("details")?.removeAttribute("open");
    if(engines.length)await requestSearch(record,engines);   // synchronous up to the tabs: they are opened inside this click (or the OK click)
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
  const width=menu.offsetWidth||230,height=menu.offsetHeight||330;
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
  // The menu scrolls itself on small screens: only a scroll OUTSIDE it closes it.
  window.addEventListener("scroll",event=>{
    const target=event.target;
    if(target&&target.nodeType===1&&target.closest&&target.closest(".fc-menu"))return;
    closeMenus();
  },true);
  window.addEventListener("resize",()=>closeMenus());
}

root.CTAtlasFaceCrops={attach,helpers,setConsentPrompt:fn=>{consentPrompt=typeof fn==="function"?fn:askConsent;}};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bindControls);
else bindControls();
})(typeof window!=="undefined"?window:globalThis);
