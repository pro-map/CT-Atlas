(function(){
"use strict";

const PAGE_WIDTH=1024;
const PAGE_HEIGHT=1448;
const MARGIN_X=74;
const TOP=92;
const BOTTOM=82;
const CONTENT_WIDTH=PAGE_WIDTH-(MARGIN_X*2);
const PDF_WIDTH=595.28;
const PDF_HEIGHT=841.89;
const PDF_SCALE=PDF_WIDTH/PAGE_WIDTH;

function clean(value){
  return String(value??"")
    .replace(/ /g," ")
    .replace(/\r\n?/g,"\n")
    .replace(/[ \t]+\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function safeFilename(value,fallback="CT-Atlas-Report"){
  const normalized=String(value||fallback)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g,"")
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

function setFont(context,size,weight="400",mono=false){
  context.font=weight+" "+size+"px "+(mono?'"Courier New", Courier, monospace':"Arial, Helvetica, sans-serif");
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

// Like wrapText, but a newline is just a new line (no blank line between paragraphs): for table cells and detail lines.
function wrapLines(context,value,maxWidth){
  const lines=[];
  for(const paragraph of clean(value).split("\n")){
    if(!paragraph.trim()){lines.push("");continue;}
    lines.push(...wrapText(context,paragraph,maxWidth));
  }
  return lines.length?lines:[""];
}

// Letters of the right-to-left scripts, including Hebrew and Arabic presentation forms.
const RTL_LETTER=/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
function paragraphIsRtl(lines,start){
  for(let index=start;index<lines.length&&lines[index];index+=1){
    const strong=/\p{L}/u.exec(lines[index]);
    if(strong)return RTL_LETTER.test(strong[0]);
  }
  return false;
}

function dataUrlBytes(dataUrl){
  const comma=dataUrl.indexOf(",");
  if(comma<0)throw new Error("PDF page encoding failed.");
  const binary=atob(dataUrl.slice(comma+1));
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i+=1)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Selectable text layer. Pages are drawn as images (so any script, font or layout renders), and every line of
// text is ALSO written into the PDF as invisible text (render mode 3) with the standard Helvetica / Courier fonts,
// positioned over the drawn line: nothing changes visually, but addresses, hashes and words can be selected,
// copied and searched. Arial and Courier New are metric-compatible with Helvetica and Courier, so the boxes line up.
// Text that the standard fonts cannot encode (Arabic, CJK...) has no layer; a left-to-right line keeps its encodable start.
// ---------------------------------------------------------------------------
const CP1252={0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F};
const ASCII_FALLBACK={0x2192:"->",0x2190:"<-",0x2194:"<->",0x2197:"",0x2265:">=",0x2264:"<=",0x2212:"-",0x2011:"-",0x2009:" ",0x202F:" ",0x2002:" ",0x2003:" ",0x25CF:"o",0x2713:"v"};

function winAnsiHex(text){
  let hex="";
  for(const character of String(text)){
    const code=character.codePointAt(0);
    let byte;
    if(code<0x20)byte=0x20;
    else if(code<0x80)byte=code;
    else if(code>=0xA0&&code<=0xFF)byte=code;
    else if(CP1252[code]!==undefined)byte=CP1252[code];
    else if(ASCII_FALLBACK[code]!==undefined){
      for(const ch of ASCII_FALLBACK[code])hex+=ch.charCodeAt(0).toString(16).padStart(2,"0");
      continue;
    }else return null;      // not representable with the standard fonts: no text layer for this run
    hex+=byte.toString(16).padStart(2,"0");
  }
  return hex;
}

function fontKey(run){
  if(run.mono)return "F3";
  return Number(run.weight)>=600?"F2":"F1";
}

// Leading part of a left-to-right line that the standard fonts can encode ("Case reference: CASE-" before Arabic or CJK).
function encodablePrefix(text){
  let prefix="";
  for(const character of text){
    if(winAnsiHex(character)===null)break;
    prefix+=character;
  }
  return prefix.trimEnd();
}

function textLayer(runs){
  let out="";
  for(const run of runs){
    if(run.rtl||!run.text)continue;
    let hex=winAnsiHex(run.text);
    if(hex===null&&run.align==="left"){
      const prefix=encodablePrefix(run.text);
      hex=prefix?winAnsiHex(prefix):null;
    }
    if(hex===null||!hex.length)continue;
    const size=Math.max(1,run.size*PDF_SCALE);
    const left=run.align==="right"?run.x-run.width:run.x;
    const x=(left*PDF_SCALE).toFixed(2);
    const y=(PDF_HEIGHT-run.y*PDF_SCALE).toFixed(2);
    out+="BT /"+fontKey(run)+" "+size.toFixed(2)+" Tf 3 Tr 1 0 0 1 "+x+" "+y+" Tm <"+hex+"> Tj ET\n";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------
function renderPages(options){
  const images=[];
  const pageRuns=[];
  let canvas=null;
  let context=null;
  let runs=[];
  let y=TOP;
  let pageNumber=0;

  // Draws a line of text and remembers it for the selectable layer.
  function put(text,x,baseline,size,weight,mono=false){
    context.fillText(text,x,baseline);
    runs.push({
      text,x,y:baseline,size,weight,mono,
      align:context.textAlign==="right"?"right":"left",
      rtl:context.direction==="rtl",
      width:context.measureText(text).width
    });
  }

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
    put("CT ATLAS",MARGIN_X,PAGE_HEIGHT-30,13,"600");
    context.textAlign="right";
    put("PAGE "+pageNumber,PAGE_WIDTH-MARGIN_X,PAGE_HEIGHT-30,13,"600");
    images.push(dataUrlBytes(canvas.toDataURL("image/jpeg",0.94)));
    pageRuns.push(runs);
    canvas.width=1;
    canvas.height=1;
  }

  function newPage(){
    finishPage();
    const created=canvasContext();
    canvas=created.canvas;
    context=created.context;
    runs=[];
    pageNumber+=1;
    context.fillStyle="#ffffff";
    context.fillRect(0,0,PAGE_WIDTH,PAGE_HEIGHT);
    setFont(context,15,"800");
    context.fillStyle="#135f84";
    context.textAlign="left";
    context.direction="ltr";
    put("CT ATLAS · GLOBAL COUNTER-TERRORISM INTELLIGENCE",MARGIN_X,48,15,"800");
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
    subheading:{size:19,line:27,weight:"800",color:"#243b49",before:14,after:6},
    body:{size:19,line:29,weight:"400",color:"#18252d",before:4,after:10},
    question:{size:19,line:29,weight:"600",color:"#18252d",before:4,after:12},
    meta:{size:16,line:24,weight:"400",color:"#596a74",before:2,after:8},
    highlight:{size:16,line:24,weight:"700",color:"#135f84",before:3,after:10},
    badge:{size:15,line:22,weight:"800",color:"#6b3b89",before:2,after:10},
    alert:{size:17,line:25,weight:"700",color:"#8a1f2c",before:6,after:10},
    source:{size:16,line:23,weight:"400",color:"#283943",before:10,after:11,rule:true},
    small:{size:15,line:22,weight:"400",color:"#53636c",before:3,after:7},
    mono:{size:15,line:22,weight:"400",color:"#18252d",before:3,after:7,mono:true},
    footer:{size:14,line:20,weight:"400",color:"#687780",before:22,after:0,rule:true}
  };

  function drawImageBlock(block){
    const image=block.image;
    const naturalWidth=Number(image.naturalWidth||image.width||0);
    const naturalHeight=Number(image.naturalHeight||image.height||0);
    if(!(naturalWidth>0&&naturalHeight>0))return false;
    const maxImageHeight=Number(block.maxHeight)||430;
    const scale=Math.min(CONTENT_WIDTH/naturalWidth,maxImageHeight/naturalHeight,Number(block.maxScale)||1.5);
    const width=Math.max(1,Math.round(naturalWidth*scale));
    const height=Math.max(1,Math.round(naturalHeight*scale));
    const caption=clean(block.caption||block.text||"");
    // Small local flag plus selectable jurisdiction text; does not depend on emoji fonts.
    if(block.inline&&caption){
      setFont(context,14,"600");
      const lines=wrapText(context,caption,Math.max(80,CONTENT_WIDTH-width-12));
      const rowHeight=Math.max(height,lines.length*20);
      ensureSpace(rowHeight+18);y+=8;
      context.drawImage(image,MARGIN_X,y,width,height);
      setFont(context,14,"600");context.fillStyle="#243b49";context.direction="ltr";context.textAlign="left";
      for(let i=0;i<lines.length;i++)put(lines[i],MARGIN_X+width+12,y+15+i*20,14,"600");
      y+=rowHeight+10;
      return true;
    }
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
        put(line,MARGIN_X,y+14,14,"600");
        y+=20;
      }
    }
    y+=9;
    return true;
  }

  // A table: columns [{key,label,width(relative),align?,mono?}], rows [{key:text | {text,color,bold}}].
  // The header row is repeated on every page and a row is never split across two pages.
  function drawTable(block){
    const columns=(Array.isArray(block.columns)?block.columns:[]).filter(column=>column&&column.key);
    const rows=Array.isArray(block.rows)?block.rows:[];
    if(!columns.length)return;
    const size=Number(block.fontSize)||14;
    const line=Math.round(size*1.42);
    const padX=7;
    const padY=6;
    const total=columns.reduce((sum,column)=>sum+(Number(column.width)||1),0);
    const widths=columns.map(column=>Math.floor(CONTENT_WIDTH*((Number(column.width)||1)/total)));
    widths[widths.length-1]+=CONTENT_WIDTH-widths.reduce((sum,value)=>sum+value,0);
    const offsets=[];
    widths.reduce((sum,value,index)=>{offsets[index]=sum;return sum+value;},0);
    const headerHeight=line+padY*2;

    const cellOf=(row,column)=>{
      const raw=Array.isArray(row)?row[columns.indexOf(column)]:row?.[column.key];
      return raw&&typeof raw==="object"?raw:{text:raw};
    };
    const measureRow=row=>{
      const cells=columns.map((column,index)=>{
        const cell=cellOf(row,column);
        setFont(context,size,cell.bold?"700":"400",Boolean(column.mono));
        const lines=wrapLines(context,clean(cell.text??""),widths[index]-padX*2);
        return {cell,lines};
      });
      const count=Math.max(1,...cells.map(item=>item.lines.length));
      // Optional full-width second line (a transaction hash, a list of counterparties...) that stays in one piece.
      const detail=!Array.isArray(row)&&row&&row.detail?(typeof row.detail==="object"?row.detail:{text:row.detail}):null;
      let detailLines=[];
      if(detail){
        setFont(context,size-1,"400",detail.mono!==false);
        detailLines=wrapLines(context,clean(detail.text??""),CONTENT_WIDTH-padX*2);
      }
      return {cells,detail,detailLines,height:count*line+detailLines.length*(line-2)+padY*2};
    };

    const drawHeader=()=>{
      context.fillStyle="#e6f0f5";
      context.fillRect(MARGIN_X,y,CONTENT_WIDTH,headerHeight);
      context.fillStyle="#135f84";
      context.direction="ltr";
      columns.forEach((column,index)=>{
        setFont(context,size-1,"800");
        const right=column.align==="right";
        context.textAlign=right?"right":"left";
        put(String(column.label||"").toUpperCase(),right?MARGIN_X+offsets[index]+widths[index]-padX:MARGIN_X+offsets[index]+padX,y+padY+size,size-1,"800");
      });
      context.textAlign="left";
      context.strokeStyle="#9fc5d8";
      context.lineWidth=1;
      context.beginPath();
      context.moveTo(MARGIN_X,y+headerHeight);
      context.lineTo(PAGE_WIDTH-MARGIN_X,y+headerHeight);
      context.stroke();
      y+=headerHeight;
    };

    const caption=clean(block.caption||"");
    if(caption)drawBlock({text:caption,type:"subheading"});
    if(!rows.length){
      drawBlock({text:clean(block.empty||"No records."),type:"small"});
      return;
    }
    const first=measureRow(rows[0]);
    ensureSpace(headerHeight+first.height+12);
    y+=6;
    drawHeader();
    rows.forEach((row,rowIndex)=>{
      const measured=rowIndex===0?first:measureRow(row);
      if(y+measured.height>PAGE_HEIGHT-BOTTOM){
        newPage();
        drawHeader();
      }
      if(rowIndex%2===1){
        context.fillStyle="#f6f9fb";
        context.fillRect(MARGIN_X,y,CONTENT_WIDTH,measured.height);
      }
      measured.cells.forEach((item,index)=>{
        const column=columns[index];
        const right=column.align==="right";
        setFont(context,size,item.cell.bold?"700":"400",Boolean(column.mono));
        context.fillStyle=item.cell.color||"#18252d";
        context.direction="ltr";
        context.textAlign=right?"right":"left";
        item.lines.forEach((text,lineIndex)=>{
          if(!text)return;
          put(text,right?MARGIN_X+offsets[index]+widths[index]-padX:MARGIN_X+offsets[index]+padX,y+padY+size+lineIndex*line,size,item.cell.bold?"700":"400",Boolean(column.mono));
        });
      });
      if(measured.detail&&measured.detailLines.length){
        const cellLines=Math.max(1,...measured.cells.map(item=>item.lines.length));
        setFont(context,size-1,"400",measured.detail.mono!==false);
        context.fillStyle=measured.detail.color||"#3b4c56";
        context.textAlign="left";
        measured.detailLines.forEach((text,lineIndex)=>{
          if(!text)return;
          put(text,MARGIN_X+padX,y+padY+cellLines*line+(lineIndex*(line-2))+size-1,size-1,"400",measured.detail.mono!==false);
        });
      }
      context.textAlign="left";
      context.strokeStyle="#e1e8ec";
      context.lineWidth=1;
      context.beginPath();
      context.moveTo(MARGIN_X,y+measured.height);
      context.lineTo(PAGE_WIDTH-MARGIN_X,y+measured.height);
      context.stroke();
      y+=measured.height;
    });
    y+=14;
  }

  function drawBlock(input){
    const block=typeof input==="string"?{text:input,type:"body"}:input||{};
    if(block.type==="pagebreak"){
      newPage();
      return;
    }
    if(block.type==="spacer"){
      y+=Math.max(0,Number(block.height)||16);
      return;
    }
    if(block.type==="table"){
      drawTable(block);
      return;
    }
    if(block.type==="image"&&block.image){
      if(drawImageBlock(block))return;
    }
    const text=clean(block.text);
    if(!text)return;
    const style={...(styles[block.type]||styles.body),...(block.style||{})};
    setFont(context,style.size,style.weight,Boolean(style.mono));
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
    setFont(context,style.size,style.weight,Boolean(style.mono));
    context.fillStyle=style.color;
    let rtl=null;
    for(let index=0;index<lines.length;index+=1){
      const line=lines[index];
      ensureSpace(style.line);
      setFont(context,style.size,style.weight,Boolean(style.mono));
      context.fillStyle=style.color;
      if(!line){
        rtl=null;
        y+=Math.round(style.line*0.6);
        continue;
      }
      // Like dir="auto": the first strong letter of the paragraph (lines up to the next blank line) sets its direction.
      if(rtl===null)rtl=paragraphIsRtl(lines,index);
      context.direction=rtl?"rtl":"ltr";
      context.textAlign=rtl?"right":"left";
      put(line,rtl?PAGE_WIDTH-MARGIN_X:MARGIN_X,y+style.size,style.size,style.weight,Boolean(style.mono));
      y+=style.line;
    }
    context.direction="ltr";
    context.textAlign="left";
    y+=style.after;
  }

  newPage();
  if(options.eyebrow)drawBlock({text:options.eyebrow,type:"highlight"});
  drawBlock({text:options.title||"CT Atlas Report",type:"title"});
  if(options.meta)drawBlock({text:options.meta,type:"meta"});
  for(const block of options.blocks||[])drawBlock(block);
  if(options.footer)drawBlock({text:options.footer,type:"footer"});
  finishPage();
  return {images,pageRuns};
}

function ascii(value){return new TextEncoder().encode(value);}

function joinBytes(chunks){
  const length=chunks.reduce((sum,item)=>sum+item.length,0);
  const output=new Uint8Array(length);
  let offset=0;
  for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
  return output;
}

function buildPdf(images,pageRuns=[]){
  if(!images.length)throw new Error("PDF has no pages.");
  const fontBase=3+(images.length*3);            // three shared fonts: Helvetica, Helvetica-Bold, Courier
  const objectCount=fontBase+2;
  const objects=new Array(objectCount+1);
  const pageIds=[];
  for(let index=0;index<images.length;index+=1){
    const pageId=3+(index*3);
    const imageId=pageId+1;
    const contentId=pageId+2;
    pageIds.push(pageId);
    objects[pageId]=[ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+PDF_WIDTH+" "+PDF_HEIGHT+"] /Resources << /XObject << /Im0 "+imageId+" 0 R >> /Font << /F1 "+fontBase+" 0 R /F2 "+(fontBase+1)+" 0 R /F3 "+(fontBase+2)+" 0 R >> >> /Contents "+contentId+" 0 R >>")];
    objects[imageId]=[
      ascii("<< /Type /XObject /Subtype /Image /Width "+PAGE_WIDTH+" /Height "+PAGE_HEIGHT+" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "+images[index].length+" >>\nstream\n"),
      images[index],
      ascii("\nendstream")
    ];
    const commands="q\n"+PDF_WIDTH+" 0 0 "+PDF_HEIGHT+" 0 0 cm\n/Im0 Do\nQ\n"+textLayer(pageRuns[index]||[]);
    objects[contentId]=[ascii("<< /Length "+commands.length+" >>\nstream\n"+commands+"\nendstream")];
  }
  objects[1]=[ascii("<< /Type /Catalog /Pages 2 0 R >>")];
  objects[2]=[ascii("<< /Type /Pages /Count "+images.length+" /Kids ["+pageIds.map(id=>id+" 0 R").join(" ")+"] >>")];
  ["Helvetica","Helvetica-Bold","Courier"].forEach((name,offset)=>{
    objects[fontBase+offset]=[ascii("<< /Type /Font /Subtype /Type1 /BaseFont /"+name+" /Encoding /WinAnsiEncoding >>")];
  });

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
    // [data-pdf-skip]: on screen only (e.g. a caption the image block already carries).
    if(element.matches("script,style,button,[data-pdf-skip]"))return;
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

async function downloadRaw(options={}){
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(document.fonts?.ready){try{await document.fonts.ready;}catch(_){}}
  const preparedOptions={...options,blocks:await prepareBlocks(options.blocks||[])};
  const {images,pageRuns}=renderPages(preparedOptions);
  const bytes=buildPdf(images,pageRuns);
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

async function download(options={}){
  const finishWait=window.CTAtlasUI?.begin(null);
  try{return await downloadRaw(options);}finally{finishWait?.();}
}

window.CTAtlasPdf={download,blocksFromElement,safeFilename};
})();
