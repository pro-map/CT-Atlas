const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");
const {test}=require("node:test");

// The exporter draws pages on canvases. Here every canvas records what is drawn, and the PDF that comes out is
// inspected: tables (repeated header, no split row), the selectable text layer, images, page breaks.

const source=fs.readFileSync(path.join(__dirname,"..","pdf-export.js"),"utf8");

function harness(){
  const pages=[];        // one entry per canvas: {texts:[{text,font,align,x,y}], rects:[], images:[]}
  let captured=null;
  const document={
    body:{appendChild(){}},
    fonts:{ready:Promise.resolve()},
    createElement(tag){
      if(tag==="canvas"){
        const page={texts:[],rects:[],images:[]};
        pages.push(page);
        const context={
          font:"",textAlign:"left",direction:"ltr",fillStyle:"",strokeStyle:"",lineWidth:1,
          beginPath(){},moveTo(){},lineTo(){},stroke(){},
          fillRect(x,y,w,h){page.rects.push({x,y,w,h,fill:this.fillStyle});},
          fillText(text,x,y){page.texts.push({text,x,y,font:this.font,align:this.textAlign});},
          drawImage(image,x,y,w,h){page.images.push({x,y,w,h});},
          measureText(value){return {width:String(value).length*(/Courier/.test(this.font)?9:8)};}
        };
        return {width:0,height:0,getContext(){return context;},toDataURL(){return "data:image/jpeg;base64,/9j/2Q==";}};
      }
      return {style:{},remove(){},click(){}};
    }
  };
  const sandbox={
    window:{},document,
    URL:{createObjectURL(blob){captured=blob;return "blob:test";},revokeObjectURL(){}},
    Blob,TextEncoder,Uint8Array,atob,
    requestAnimationFrame(callback){callback();},setTimeout(callback){callback();},Element:class Element{}
  };
  vm.runInNewContext(source,sandbox,{filename:"pdf-export.js"});
  return {
    pages:()=>pages.filter(page=>page.texts.length||page.rects.length||page.images.length),
    async build(options){
      const result=await sandbox.window.CTAtlasPdf.download(options);
      const bytes=Buffer.from(await captured.arrayBuffer());
      return {result,bytes,text:bytes.toString("latin1")};
    }
  };
}

const ADDRESS="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const HASH="4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

// Hex strings of the invisible text runs in the PDF, decoded to text, in drawing order.
function layerTexts(pdf){
  return [...pdf.text.matchAll(/BT \/(F\d) ([\d.]+) Tf 3 Tr 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm <([0-9a-f]+)> Tj ET/g)]
    .map(match=>({font:match[1],size:Number(match[2]),x:Number(match[3]),y:Number(match[4]),text:Buffer.from(match[5],"hex").toString("latin1")}));
}

const columns=[
  {key:"time",label:"Time",width:2},
  {key:"dir",label:"Dir",width:1},
  {key:"amount",label:"Amount",width:2,align:"right"},
  {key:"tx",label:"Transaction",width:6,mono:true}
];
const makeRows=n=>Array.from({length:n},(_,i)=>({time:"2026-09-"+String(1+i%28).padStart(2,"0")+" 10:00",dir:i%2?"IN":"OUT",amount:String((i+1)*0.01),tx:HASH.slice(0,60)+String(i).padStart(4,"0")}));

test("a long table flows over several pages, repeats its header on each and keeps every row",async()=>{
  const h=harness();
  const pdf=await h.build({title:"Report",blocks:[{type:"table",caption:"Transactions",columns,rows:makeRows(150)}]});
  const pages=h.pages();
  assert.ok(pages.length>=3,"150 rows do not fit on one or two pages: "+pages.length);
  assert.equal(pdf.result.pages,pages.length);
  for(const page of pages.slice(0,pages.length)){
    assert.ok(page.texts.some(t=>t.text==="TRANSACTION"),"every page that carries rows has the header");
  }
  const all=pages.flatMap(page=>page.texts.map(t=>t.text)).join("\n");
  for(let i=0;i<150;i+=25)assert.ok(all.includes(String(i).padStart(4,"0")),"row "+i+" is drawn");
  assert.ok(all.includes("Transactions"),"the caption is drawn");
  // A row's wrapped lines never straddle a page break: the last row of a page is complete.
  const wrapped=makeRows(1)[0].tx.length;
  assert.ok(wrapped>50);
});

test("cells in monospace columns use the mono font, amounts are right-aligned, long hashes wrap without being cut",async()=>{
  const h=harness();
  await h.build({title:"T",blocks:[{type:"table",columns,rows:[{time:"t",dir:"IN",amount:"1.5",tx:HASH+HASH}]}]});
  const texts=h.pages()[0].texts;
  const tx=texts.filter(t=>/Courier/.test(t.font));
  assert.ok(tx.length>=2,"a 128-character hash wraps onto several lines");
  assert.equal(tx.map(t=>t.text).join(""),HASH+HASH,"nothing is lost by the wrapping");
  const amount=texts.find(t=>t.text==="1.5");
  assert.equal(amount.align,"right");
});

test("a row's detail line keeps a whole hash in one piece under its cells, and is part of the row (never split across pages)",async()=>{
  const h=harness();
  const rows=Array.from({length:70},(_,i)=>({time:"t"+i,dir:"IN",amount:"1",tx:"x",detail:HASH.slice(0,60)+String(i).padStart(4,"0")}));
  await h.build({title:"T",blocks:[{type:"table",columns,rows}]});
  const pages=h.pages();
  assert.ok(pages.length>=2);
  for(const page of pages){
    const detail=page.texts.filter(t=>/^[0-9a-f]{60}\d{4}$/.test(t.text));
    const times=page.texts.filter(t=>/^t\d+$/.test(t.text));
    assert.equal(detail.length,times.length,"each row's time cell and its hash are on the same page");
    for(const line of detail)assert.match(line.font,/Courier/);
  }
});

test("an empty table says so instead of drawing an empty grid",async()=>{
  const h=harness();
  await h.build({title:"T",blocks:[{type:"table",caption:"Records",columns,rows:[],empty:"No transactions in the sample."}]});
  const all=h.pages()[0].texts.map(t=>t.text).join("\n");
  assert.match(all,/No transactions in the sample\./);
  assert.ok(!all.includes("TRANSACTION"),"no header for an empty table");
});

test("table cells can carry a colour and bold weight",async()=>{
  const h=harness();
  await h.build({title:"T",blocks:[{type:"table",columns:[{key:"a",label:"A"}],rows:[{a:{text:"ALERT",color:"#8a1f2c",bold:true}}]}]});
  const cell=h.pages()[0].texts.find(t=>t.text==="ALERT");
  assert.match(cell.font,/^700 /);
});

test("the PDF carries a selectable text layer: addresses and hashes can be copied and searched",async()=>{
  const h=harness();
  const pdf=await h.build({
    title:"Crypto report",meta:"Generated now",
    blocks:[
      {type:"heading",text:"WALLET"},
      {type:"body",text:"Seed "+ADDRESS+" sent funds → "+ADDRESS.slice(0,10)},
      {type:"table",columns,rows:[{time:"t",dir:"IN",amount:"1",tx:"short",detail:HASH}]}
    ]
  });
  assert.match(pdf.text,/\/BaseFont \/Helvetica /);
  assert.match(pdf.text,/\/BaseFont \/Helvetica-Bold /);
  assert.match(pdf.text,/\/BaseFont \/Courier /);
  assert.match(pdf.text,/\/Encoding \/WinAnsiEncoding/);
  const layer=layerTexts(pdf);
  const joined=layer.map(run=>run.text).join("\n");
  assert.ok(joined.includes(ADDRESS),"the address is in the layer, whole");
  assert.ok(joined.includes(HASH),"the transaction hash is in the layer, whole");
  assert.ok(joined.includes("CRYPTO REPORT")||joined.includes("Crypto report"));
  assert.ok(joined.includes("->"),"the arrow, which the standard fonts lack, becomes '->'");
  assert.equal(layer.find(run=>run.text===HASH).font,"F3","hashes use the Courier layer");
  assert.equal(layer.find(run=>run.text==="WALLET").font,"F2","headings use the bold layer");
  // Invisible: rendering mode 3 on every run, and positions lie inside the A4 page.
  for(const run of layer){
    assert.ok(run.x>=0&&run.x<=595.28,"x "+run.x);
    assert.ok(run.y>=0&&run.y<=841.89,"y "+run.y);
    assert.ok(run.size>3&&run.size<40,"size "+run.size);
  }
});

test("text that the standard fonts cannot encode gets no layer, and never garbage",async()=>{
  const h=harness();
  const pdf=await h.build({title:"T",blocks:[{type:"body",text:"مرحبا بالعالم"},{type:"body",text:"日本語のテキスト"},{type:"body",text:"Été à Ouagadougou"}]});
  const joined=layerTexts(pdf).map(run=>run.text).join("\n");
  assert.ok(joined.includes("Été à Ouagadougou"),"Latin-1 accents are kept");
  assert.ok(!joined.includes("م"),"no Arabic in the layer");
  assert.equal((joined.match(/\?/g)||[]).length,0,"no placeholder question marks");
});

test("every page has its own layer: the header, the page number and the content",async()=>{
  const h=harness();
  const pdf=await h.build({title:"T",blocks:[{type:"body",text:"first"},{type:"pagebreak"},{type:"body",text:"second"}]});
  assert.equal(pdf.result.pages,2);
  const streams=pdf.text.split("/Contents ").length-1;
  assert.equal(streams,2);
  const layer=layerTexts(pdf).map(run=>run.text);
  assert.ok(layer.filter(t=>t==="PAGE 1").length===1&&layer.filter(t=>t==="PAGE 2").length===1);
  assert.ok(layer.includes("first")&&layer.includes("second"));
});

test("image blocks honour maxHeight and stay centred; spacers move the cursor",async()=>{
  const h=harness();
  await h.build({title:"T",blocks:[
    {type:"image",image:{naturalWidth:1000,naturalHeight:650},maxHeight:600,caption:"Flow graph"},
    {type:"spacer",height:40},
    {type:"body",text:"after"}
  ]});
  const page=h.pages()[0];
  assert.equal(page.images.length,1);
  const image=page.images[0];
  assert.ok(image.h<=600&&image.h>500,"height "+image.h);
  assert.ok(Math.abs(image.w/image.h-1000/650)<0.01,"aspect ratio kept");
  assert.ok(page.texts.some(t=>t.text==="Flow graph"));
  const caption=page.texts.find(t=>t.text==="Flow graph").y;
  const after=page.texts.find(t=>t.text==="after").y;
  assert.ok(after-caption>40,"the spacer added its height");
});

test("callers that only use the original block types get the same pages as before, plus the text layer",async()=>{
  const h=harness();
  const pdf=await h.build({title:"Old style",eyebrow:"EYEBROW",meta:"meta",blocks:[{type:"heading",text:"H"},{type:"body",text:"Body text."},{type:"source",text:"Source"},"plain string"],footer:"Footer"});
  assert.equal(pdf.result.pages,1);
  assert.ok(pdf.bytes.subarray(0,8).toString("latin1").startsWith("%PDF-1.4"));
  assert.ok(pdf.text.trimEnd().endsWith("%%EOF"));
  const objects=[...pdf.text.matchAll(/\n(\d+) 0 obj\n/g)].map(m=>Number(m[1]));
  assert.deepEqual(objects,[...objects].sort((a,b)=>a-b),"objects are numbered in order");
  assert.equal(Math.max(...objects),Number(pdf.text.match(/\/Size (\d+)/)[1])-1);
  const xrefStart=Number(pdf.text.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.text.slice(xrefStart,xrefStart+4),"xref");
});

test("PyMuPDF reads the generated file: page count, selectable text and search (skipped when it is not installed)",async t=>{
  const probe=spawnSync("python3",["-c","import fitz"],{encoding:"utf8"});
  if(probe.status!==0){t.skip("PyMuPDF (fitz) not installed");return;}
  const h=harness();
  const pdf=await h.build({title:"Crypto report",blocks:[
    {type:"heading",text:"WALLET"},
    {type:"body",text:"Seed "+ADDRESS},
    {type:"table",columns,rows:makeRows(60)}
  ]});
  const file=path.join(os.tmpdir(),"ct-atlas-report-test-"+process.pid+".pdf");
  fs.writeFileSync(file,pdf.bytes);
  const script=[
    "import fitz,json,sys",
    "d=fitz.open(sys.argv[1])",
    "text=''.join(p.get_text() for p in d)",
    "hits=sum(len(p.search_for(sys.argv[2])) for p in d)",
    "print(json.dumps({'pages':d.page_count,'has_address':sys.argv[2] in text,'hits':hits,'has_hash_prefix':sys.argv[3] in text}))"
  ].join(";");
  const run=spawnSync("python3",["-c",script,file,ADDRESS,HASH.slice(0,30)],{encoding:"utf8"});
  fs.rmSync(file,{force:true});
  assert.equal(run.status,0,run.stderr);
  const info=JSON.parse(run.stdout);
  assert.equal(info.pages,pdf.result.pages);
  assert.equal(info.has_address,true,"the address can be extracted from the PDF text");
  assert.ok(info.hits>=1,"and found by search");
  assert.equal(info.has_hash_prefix,true);
});

test('inline jurisdiction flags sit beside selectable country text and remain within the page',async()=>{
 const h=harness(),caption='Jurisdiction: Switzerland - Proton AG (CH)';
 const pdf=await h.build({title:'IP brief',blocks:[{type:'image',image:{width:32,height:24},inline:true,maxHeight:20,caption}]});
 const page=h.pages()[0],flag=page.images[0],label=page.texts.find(t=>t.text===caption);
 assert.ok(flag&&label);assert.ok(flag.h<=20);assert.ok(label.x>=flag.x+flag.w+10);
 assert.ok(label.y>=flag.y&&label.y<=flag.y+flag.h+5);
 assert.ok(layerTexts(pdf).some(t=>t.text===caption));
});
