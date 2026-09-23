(function(){
"use strict";

const PAGE_WIDTH=1024;
const PAGE_HEIGHT=1448;
const MARGIN_X=74;
const TOP=92;
const BOTTOM=82;
const CONTENT_WIDTH=PAGE_WIDTH-(MARGIN_X*2);

function clean(value){
  return String(value??"")
    .replace(/\u00a0/g," ")
    .replace(/\r\n?/g,"\n")
    .replace(/[ \t]+\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function safeFilename(value,fallback="CT-Atlas-Report"){
  const normalized=String(value||fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9_-]+/gi,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,90);
  return normalized||fallback;
}

function canvasContext(){
  const canvas=document.createElement("canvas");
  canvas.width=PAGE_WIDTH;
  canvas.height=PAGE_HEIGHT;
  const context=canvas.getContext("2d",{alpha:false});
  if(!context)throw new Error("PDF canvas is not available in this browser.");
  return {canvas,context};
}

function setFont(context,size,weight="400"){
  context.font=weight+" "+size+"px Arial, Helvetica, sans-serif";
}

function splitLongToken(context,token,maxWidth){
  const parts=[];
  let current="";
  for(const character of token){
    const candidate=current+character;
    if(current&&context.measureText(candidate).width>maxWidth){
      parts.push(current);
      current=character;
    }else current=candidate;
  }
  if(current)parts.push(current);
  return parts;
}

function wrapText(context,value,maxWidth){
  const output=[];
  const paragraphs=clean(value).split("\n");
  paragraphs.forEach((paragraph,index)=>{
    if(!paragraph.trim()){
      output.push("");
      return;
    }
    const words=paragraph.trim().split(/\s+/);
    let line="";
    for(const originalWord of words){
      const pieces=context.measureText(originalWord).width>maxWidth
        ?splitLongToken(context,originalWord,maxWidth)
        :[originalWord];
      for(const word of pieces){
        const candidate=line?line+" "+word:word;
        if(line&&context.measureText(candidate).width>maxWidth){
          output.push(line);
          line=word;
        }else line=candidate;
      }
    }
    if(line)output.push(line);
    if(index<paragraphs.length-1)output.push("");
  });
  return output.length?output:[""];
}

function dataUrlBytes(dataUrl){
  const comma=dataUrl.indexOf(",");
  if(comma<0)throw new Error("PDF page encoding failed.");
  const binary=atob(dataUrl.slice(comma+1));
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i+=1)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

function renderPages(options){
  const images=[];
  let canvas=null;
  let context=null;
  let y=TOP;
  let pageNumber=0;

  function finishPage(){
    if(!canvas||!context)return;
    context.strokeStyle="#d9e1e6";
    context.lineWidth=1;
    context.beginPath();
    context.moveTo(MARGIN_X,PAGE_HEIGHT-55);
    context.lineTo(PAGE_WIDTH-MARGIN_X,PAGE_HEIGHT-55);
    context.stroke();
    setFont(context,13,"600");
    context.fillStyle="#71808a";
    context.textAlign="left";
    context.direction="ltr";
    context.fillText("CT ATLAS",MARGIN_X,PAGE_HEIGHT-30);
    context.textAlign="right";
    context.fillText("PAGE "+pageNumber,PAGE_WIDTH-MARGIN_X,PAGE_HEIGHT-30);
    images.push(dataUrlBytes(canvas.toDataURL("image/jpeg",0.94)));
    canvas.width=1;
    canvas.height=1;
  }

  function newPage(){
    finishPage();
    const created=canvasContext();
    canvas=created.canvas;
    context=created.context;
    pageNumber+=1;
    context.fillStyle="#ffffff";
    context.fillRect(0,0,PAGE_WIDTH,PAGE_HEIGHT);
    setFont(context,15,"800");
    context.fillStyle="#135f84";
    context.textAlign="left";
    context.direction="ltr";
    context.fillText("CT ATLAS · GLOBAL COUNTER-TERRORISM INTELLIGENCE",MARGIN_X,48);
    context.strokeStyle="#9fc5d8";
    context.lineWidth=2;
    context.beginPath();
    context.moveTo(MARGIN_X,63);
    context.lineTo(PAGE_WIDTH-MARGIN_X,63);
    context.stroke();
    y=TOP;
  }

  function ensureSpace(height){
    if(y+height>PAGE_HEIGHT-BOTTOM)newPage();
  }

  const styles={
    title:{size:38,line:48,weight:"800",color:"#102e40",before:0,after:18},
    heading:{size:23,line:31,weight:"800",color:"#135f84",before:24,after:8,rule:true},
    body:{size:19,line:29,weight:"400",color:"#18252d",before:4,after:10},
    question:{size:19,line:29,weight:"600",color:"#18252d",before:4,after:12},
    meta:{size:16,line:24,weight:"400",color:"#596a74",before:2,after:8},
    highlight:{size:16,line:24,weight:"700",color:"#135f84",before:3,after:10},
    badge:{size:15,line:22,weight:"800",color:"#6b3b89",before:2,after:10},
    source:{size:16,line:23,weight:"400",color:"#283943",before:10,after:11,rule:true},
    small:{size:15,line:22,weight:"400",color:"#53636c",before:3,after:7},
    footer:{size:14,line:20,weight:"400",color:"#687780",before:22,after:0,rule:true}
  };

  function drawBlock(input){
    const block=typeof input==="string"?{text:input,type:"body"}:input||{};
    if(block.type==="image"&&block.image){
      const image=block.image;
      const naturalWidth=Number(image.naturalWidth||image.width||0);
      const naturalHeight=Number(image.naturalHeight||image.height||0);
      if(naturalWidth>0&&naturalHeight>0){
        const maxImageHeight=430;
        const scale=Math.min(CONTENT_WIDTH/naturalWidth,maxImageHeight/naturalHeight,1.5);
        const width=Math.max(1,Math.round(naturalWidth*scale));
        const height=Math.max(1,Math.round(naturalHeight*scale));
        const caption=clean(block.caption||block.text||"");
        setFont(context,14,"600");
        const captionLines=caption?wrapText(context,caption,CONTENT_WIDTH):[];
        const captionHeight=captionLines.length?captionLines.length*20+8:0;
        ensureSpace(height+captionHeight+24);
        y+=8;
        const x=MARGIN_X+Math.max(0,(CONTENT_WIDTH-width)/2);
        context.drawImage(image,x,y,width,height);
        y+=height+7;
        if(captionLines.length){
          setFont(context,14,"600");
          context.fillStyle="#53636c";
          context.direction="ltr";
          context.textAlign="left";
          for(const line of captionLines){
            context.fillText(line,MARGIN_X,y+14);
            y+=20;
          }
        }
        y+=9;
        return;
      }
    }
    const text=clean(block.text);
    if(!text)return;
    const style={...(styles[block.type]||styles.body),...(block.style||{})};
    setFont(context,style.size,style.weight);
    const lines=wrapText(context,text,CONTENT_WIDTH);
    const initialHeight=style.before+style.line*Math.min(lines.length,block.type==="heading"?2:1)+style.after+(style.rule?9:0);
    ensureSpace(initialHeight);
    y+=style.before;
    if(style.rule){
      context.strokeStyle=block.type==="heading"?"#b7d3df":"#d8e0e5";
      context.lineWidth=1;
      context.beginPath();
      context.moveTo(MARGIN_X,y);
      context.lineTo(PAGE_WIDTH-MARGIN_X,y);
      context.stroke();
      y+=9;
    }
    setFont(context,style.size,style.weight);
    context.fillStyle=style.color;
    for(const line of lines){
      ensureSpace(style.line);
      setFont(context,style.size,style.weight);
      context.fillStyle=style.color;
      if(!line){
        y+=Math.round(style.line*0.6);
        continue;
      }
      const rtl=/[\u0590-\u08ff]/.test(line);
      context.direction=rtl?"rtl":"ltr";
      context.textAlign=rtl?"right":"left";
      context.fillText(line,rtl?PAGE_WIDTH-MARGIN_X:MARGIN_X,y+style.size);
      y+=style.line;
    }
    y+=style.after;
  }

  newPage();
  if(options.eyebrow)drawBlock({text:options.eyebrow,type:"highlight"});
  drawBlock({text:options.title||"CT Atlas Report",type:"title"});
  if(options.meta)drawBlock({text:options.meta,type:"meta"});
  for(const block of options.blocks||[])drawBlock(block);
  if(options.footer)drawBlock({text:options.footer,type:"footer"});
  finishPage();
  return images;
}

function ascii(value){return new TextEncoder().encode(value);}

function joinBytes(chunks){
  const length=chunks.reduce((sum,item)=>sum+item.length,0);
  const output=new Uint8Array(length);
  let offset=0;
  for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
  return output;
}

function buildPdf(images){
  if(!images.length)throw new Error("PDF has no pages.");
  const objectCount=2+(images.length*3);
  const objects=new Array(objectCount+1);
  const pageIds=[];
  for(let index=0;index<images.length;index+=1){
    const pageId=3+(index*3);
    const imageId=pageId+1;
    const contentId=pageId+2;
    pageIds.push(pageId);
    objects[pageId]=[ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 "+imageId+" 0 R >> >> /Contents "+contentId+" 0 R >>")];
    objects[imageId]=[
      ascii("<< /Type /XObject /Subtype /Image /Width "+PAGE_WIDTH+" /Height "+PAGE_HEIGHT+" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "+images[index].length+" >>\nstream\n"),
      images[index],
      ascii("\nendstream")
    ];
    const commands="q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ";
    objects[contentId]=[ascii("<< /Length "+commands.length+" >>\nstream\n"+commands+"\nendstream")];
  }
  objects[1]=[ascii("<< /Type /Catalog /Pages 2 0 R >>")];
  objects[2]=[ascii("<< /Type /Pages /Count "+images.length+" /Kids ["+pageIds.map(id=>id+" 0 R").join(" ")+"] >>")];

  const chunks=[];
  let length=0;
  const offsets=new Array(objectCount+1).fill(0);
  const push=chunk=>{chunks.push(chunk);length+=chunk.length;};
  push(ascii("%PDF-1.4\n%CTATLAS\n"));
  for(let id=1;id<=objectCount;id+=1){
    offsets[id]=length;
    push(ascii(id+" 0 obj\n"));
    for(const part of objects[id])push(part);
    push(ascii("\nendobj\n"));
  }
  const xrefOffset=length;
  let xref="xref\n0 "+(objectCount+1)+"\n0000000000 65535 f \n";
  for(let id=1;id<=objectCount;id+=1)xref+=String(offsets[id]).padStart(10,"0")+" 00000 n \n";
  xref+="trailer\n<< /Size "+(objectCount+1)+" /Root 1 0 R >>\nstartxref\n"+xrefOffset+"\n%%EOF\n";
  push(ascii(xref));
  return joinBytes(chunks);
}

function blocksFromElement(root){
  const blocks=[];
  if(!root)return blocks;
  function visit(element){
    if(!(element instanceof Element))return;
    if(element.matches("script,style,button"))return;
    if(element.matches("img[data-pdf-image]")){
      const src=String(element.currentSrc||element.src||"").trim();
      if(src){
        blocks.push({
          type:"image",
          src,
          caption:clean(element.getAttribute("data-pdf-caption")||element.alt||"")
        });
      }
      return;
    }
    const text=clean(element.innerText||element.textContent||"");
    if(!text&&element.children.length){
      Array.from(element.children).forEach(visit);
      return;
    }
    if(!text)return;
    if(element.matches("h1,h2,h3,h4,h5,h6,.generated-report-section,.report-sources-heading,.qa-cited-head")){
      blocks.push({text,type:"heading"});
      return;
    }
    if(element.matches("li")){
      blocks.push({text:"• "+text,type:"body"});
      return;
    }
    if(element.matches("p,.generated-report-unsectioned")){
      blocks.push({text,type:"body"});
      return;
    }
    if(element.matches(".deep-evidence,.qa-cited-item")){
      blocks.push({text,type:"source"});
      return;
    }
    if(element.children.length){
      Array.from(element.children).forEach(visit);
      return;
    }
    blocks.push({text,type:"body"});
  }
  Array.from(root.children||[]).forEach(visit);
  if(!blocks.length&&clean(root.innerText||root.textContent||""))blocks.push({text:clean(root.innerText||root.textContent||""),type:"body"});
  return blocks;
}

function loadPdfImage(src){
  return new Promise(resolve=>{
    const image=new Image();
    image.crossOrigin="anonymous";
    image.decoding="async";
    const finish=value=>resolve(value);
    image.onload=()=>finish(image);
    image.onerror=()=>finish(null);
    try{image.src=src;}catch(_){finish(null);}
  });
}

async function prepareBlocks(blocks){
  const prepared=[];
  for(const raw of Array.isArray(blocks)?blocks:[]){
    const block=raw||{};
    if(block.type==="image"&&block.src){
      const image=await loadPdfImage(String(block.src));
      if(image)prepared.push({...block,image});
      else if(clean(block.caption||block.text||""))prepared.push({text:clean(block.caption||block.text||""),type:"small"});
    }else{
      prepared.push(block);
    }
  }
  return prepared;
}

async function download(options={}){
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(document.fonts?.ready){try{await document.fonts.ready;}catch(_){}}
  const preparedOptions={...options,blocks:await prepareBlocks(options.blocks||[])};
  const images=renderPages(preparedOptions);
  const bytes=buildPdf(images);
  const blob=new Blob([bytes],{type:"application/pdf"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;
  link.download=safeFilename(String(options.filename||"").replace(/\.pdf$/i,""),"CT-Atlas-Report")+".pdf";
  link.style.display="none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return {filename:link.download,pages:images.length,bytes:bytes.length};
}

window.CTAtlasPdf={download,blocksFromElement,safeFilename};
})();
