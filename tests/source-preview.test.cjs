const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

let source=fs.readFileSync("cloudflare-worker/source-preview.js","utf8")
  .replace(/^import[\s\S]*?from "\.\/shared\.js";\s*/,"")
  .replace(/export \{[\s\S]*?\};\s*$/,"");

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}
async function gateCall(){throw new Error("network not used");}
function corsHeaders(){return {"Access-Control-Allow-Origin":"*"};}

function harness(){
  const context=vm.createContext({
    cleanText,gateCall,corsHeaders,
    URL,Set,Number,String,Array,Object,RegExp,TextDecoder,Uint8Array,Headers,Response,
    console,fetch:async()=>{throw new Error("network not used");}
  });
  vm.runInContext(source,context);
  return vm.runInContext("({isSafePublicUrl,extractPreviewImageUrl,SOURCE_PREVIEW_VERSION})",context);
}

test("source preview URL guard rejects private and unsafe targets",()=>{
  const h=harness();
  assert.equal(h.isSafePublicUrl("https://example.com/article"),true);
  assert.equal(h.isSafePublicUrl("http://10.0.0.1/internal"),false);
  assert.equal(h.isSafePublicUrl("http://127.0.0.1/x"),false);
  assert.equal(h.isSafePublicUrl("http://192.168.1.10/x"),false);
  assert.equal(h.isSafePublicUrl("file:///etc/passwd"),false);
  assert.equal(h.isSafePublicUrl("javascript:alert(1)"),false);
});

test("extracts og:image and resolves relative URLs",()=>{
  const h=harness();
  const html='<html><head><meta property="og:image" content="/images/photo.jpg"></head></html>';
  assert.equal(
    h.extractPreviewImageUrl(html,"https://news.example.com/story"),
    "https://news.example.com/images/photo.jpg"
  );
});

test("supports twitter image metadata regardless of attribute order",()=>{
  const h=harness();
  const html='<meta content="https://cdn.example.com/a.webp" name="twitter:image">';
  assert.equal(h.extractPreviewImageUrl(html,"https://example.com"),"https://cdn.example.com/a.webp");
});

test("source preview version is explicit",()=>{
  const h=harness();
  assert.match(h.SOURCE_PREVIEW_VERSION,/source-preview/);
});

test("frontend contains authenticated hub and source visual surfaces",()=>{
  const index=fs.readFileSync("index.html","utf8");
  const deep=fs.readFileSync("deep-search.js","utf8");
  const pdf=fs.readFileSync("pdf-export.js","utf8");
  const main=fs.readFileSync("main.html","utf8");
  const social=fs.readFileSync("social.html","utf8");
  assert.ok(index.includes('window.location.href = "main.html"'));
  assert.ok(index.includes('id="mainHubButton"'));
  assert.ok(main.includes("Map and Intel Analysis"));
  assert.ok(main.includes("Cryptocurrency Investigations"));
  assert.ok(main.includes("Social Media Analysis"));
  assert.ok(social.includes("RUN SOCMINT INVESTIGATION"));
  assert.ok(index.includes('id="reportResultVisuals"'));
  assert.ok(deep.includes('id="deepSearchVisuals"'));
  assert.ok(pdf.includes('block.type==="image"'));
  assert.ok(pdf.includes("loadPdfImage"));
});
