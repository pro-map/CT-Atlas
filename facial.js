(()=>{"use strict";
const API="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN="ct_map_session_token",USER="ct_map_username",EXPIRY="ct_map_session_expires",AUTHORIZED="ct_map_authorized";
let lastPayload=null,lastFiles=[];
const $=id=>document.getElementById(id);
function clear(){for(const k of [TOKEN,USER,EXPIRY,AUTHORIZED])sessionStorage.removeItem(k);}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function verify(){
 const token=String(sessionStorage.getItem(TOKEN)||"");
 if(!token){location.replace("index.html");return false;}
 try{
  const r=await fetch(API+"/session-check",{headers:{"X-Session-Token":token},cache:"no-store"});
  const p=await r.json().catch(()=>({}));
  if(!r.ok||!p.ok||!p.username)throw new Error("Session expired");
  sessionStorage.setItem(USER,String(p.username).toLowerCase());
  sessionStorage.setItem(AUTHORIZED,"yes");sessionStorage.setItem(EXPIRY,String(p.expires_at||""));
  $("fiUser").textContent=String(p.username).toUpperCase();return true;
 }catch(_){clear();location.replace("index.html");return false;}
}
function listFiles(){
 const files=[...$("fiFiles").files];
 $("fiFileList").innerHTML=files.map(f=>'<span class="file-chip">'+esc(f.name)+' · '+(f.size/1024/1024).toFixed(1)+' MB</span>').join("");
}
// prefix = "<file index>:<frame index>"; with the face id it keys the crop cells filled by facial-crops.js.
function faceTable(faces,prefix){
 if(!faces?.length)return '<div class="media-meta">No face detected in this frame.</div>';
 return '<table class="face-table"><thead><tr><th>Crop</th><th>Face</th><th>Quality</th><th>Sharpness</th><th>Brightness</th><th>Image area</th><th>Actions</th></tr></thead><tbody>'+
 faces.map(f=>{const key=esc(prefix+':'+f.face_id);return '<tr><td class="fc-thumb" data-fc-key="'+key+'"><span class="fc-pending">…</span></td><td>F'+esc(f.face_id)+'</td><td><span class="quality">'+esc(f.quality)+' '+esc(f.quality_score)+'</span></td><td>'+esc(f.sharpness)+'</td><td>'+esc(f.brightness)+'</td><td>'+esc((Number(f.size_ratio||0)*100).toFixed(1))+'%</td><td class="fc-actions" data-fc-key="'+key+'"></td></tr>';}).join("")+'</tbody></table>';
}
function previewCard(frame,prefix){
 return '<div class="preview-card">'+
  (frame.annotated_preview?'<img src="'+frame.annotated_preview+'" alt="Annotated visual analysis preview">':'')+
  '<div class="preview-info"><div class="media-meta">'+esc(frame.label)+(frame.timestamp_seconds!=null?' · '+esc(frame.timestamp_seconds)+'s':'')+' · '+esc(frame.width)+'×'+esc(frame.height)+' · '+esc(frame.face_count)+' face(s)</div>'+
  faceTable(frame.faces,prefix)+
  (frame.ocr_text?'<div class="ocr"><b>OCR</b><br>'+esc(frame.ocr_text)+'</div>':'')+
  '</div></div>';
}
function render(payload){
 lastPayload=payload;$("fiEmpty").hidden=true;$("fiReport").hidden=false;
 const files=payload.files||[];
 const frames=files.reduce((n,f)=>n+(f.kind==="video"?(f.sampled_frames||[]).length:1),0);
 const faces=files.reduce((n,f)=>n+Number(f.face_count||0),0);
 const gps=files.filter(f=>f.exif&&f.exif.GPS).length;
 $("fiSummary").innerHTML=[
  [files.length,"FILES ANALYZED"],[frames,"IMAGES / FRAMES"],[faces,"FACE DETECTIONS"],[(payload.similarity_pairs||[]).length,"SIMILAR PAIRS"]
 ].map(x=>'<div class="summary-card"><b>'+esc(x[0])+'</b><span>'+esc(x[1])+'</span></div>').join("");
 const pairs=payload.similarity_pairs||[];
 $("fiSimilaritySection").hidden=!pairs.length;
 $("fiSimilarity").innerHTML=pairs.map(p=>'<div class="similarity-row"><span>'+esc(p.a)+'</span><span class="sim-badge">'+esc(p.similarity)+' · d='+esc(p.phash_distance)+'</span><span>'+esc(p.b)+'</span></div>').join("");
 $("fiItems").innerHTML=files.map((f,fi)=>{
  const exif=f.exif&&Object.keys(f.exif).length?'<div class="exif"><b>EXIF / EMBEDDED METADATA</b><br>'+esc(JSON.stringify(f.exif,null,2))+'</div>':'';
  if(f.kind==="video"){
   return '<section class="media-item"><div class="media-head"><h3>'+esc(f.filename)+'</h3><div class="media-meta">VIDEO · '+esc(f.duration_seconds)+'s · '+esc(f.fps)+' FPS · '+esc(f.face_count)+' detections</div></div><div class="preview-grid">'+(f.sampled_frames||[]).map((frame,ri)=>previewCard(frame,fi+':'+ri)).join("")+'</div></section>';
  }
  return '<section class="media-item"><div class="media-head"><h3>'+esc(f.filename)+'</h3><div class="media-meta">IMAGE · '+esc(f.width)+'×'+esc(f.height)+' · '+esc(f.face_count)+' face(s)</div></div><div class="preview-grid">'+previewCard(f,fi+':0')+'</div>'+exif+'</section>';
 }).join("");
 // Cut the faces out of the original files, in the browser (see facial-crops.js).
 window.CTAtlasFaceCrops?.attach({payload,files:lastFiles,api:API,getToken:()=>String(sessionStorage.getItem(TOKEN)||"")});
 if((payload.errors||[]).length)$("fiItems").insertAdjacentHTML("beforeend",'<section class="media-item"><h3>PROCESSING WARNINGS</h3><div class="ocr">'+esc(JSON.stringify(payload.errors,null,2))+'</div></section>');
}
$("fiFiles").addEventListener("change",listFiles);
$("fiForm").addEventListener("submit",async e=>{
 e.preventDefault();const files=[...$("fiFiles").files];const status=$("fiStatus");
 if(!files.length){status.className="status error";status.textContent="Select at least one image or video.";return;}
 if(!$("fiConsent").checked){status.className="status error";status.textContent="Confirm you have a lawful basis to process this media before running analysis.";return;}
 if(files.length>10){status.className="status error";status.textContent="Maximum 10 files.";return;}
 const total=files.reduce((n,f)=>n+f.size,0);if(total>30*1024*1024){status.className="status error";status.textContent="Combined upload exceeds 30 MB.";return;}
 const token=String(sessionStorage.getItem(TOKEN)||"");const data=new FormData();files.forEach(f=>data.append("files",f,f.name));lastFiles=files;
 $("fiRun").disabled=true;status.className="status";status.textContent="Analyzing visual evidence…";
 try{
  const r=await fetch(API+"/visual-analyze",{method:"POST",headers:{"X-Session-Token":token},body:data});
  const p=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(p.error||p.detail||"Visual analysis failed.");
  render(p);status.textContent="Analysis complete.";
 }catch(err){status.className="status error";status.textContent=err.message||"Visual analysis failed.";}
 finally{$("fiRun").disabled=false;}
});
$("fiDownload").addEventListener("click",()=>{
 if(!lastPayload)return;const blob=new Blob([JSON.stringify(lastPayload,null,2)],{type:"application/json"});
 const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="CT_Atlas_Visual_Intelligence_"+new Date().toISOString().slice(0,10)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
verify();
})();