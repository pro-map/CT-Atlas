// The report's picture (cloudflare-worker/report-illustration.js): which cited
// articles are candidates, how a Google News link is resolved, which share
// images count as photos, which one is chosen, the endpoint, and the wiring
// into the Report Generator, Deep Search, their pages and PDF exports.
// No network: fetch and the gate are fakes.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

function moduleSource(file){
  return fs.readFileSync(file,"utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/[^"']+["'];\s*/g,"")
    .replace(/export\s*\{[\s\S]*?\};?\s*$/,"");
}

function cleanText(value,max=10000){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

// source-preview.js and report-illustration.js in one context, with a fake
// fetch (routes: url -> Response or function) and a fake gate.
function harness({routes={},gate={},users=["analyst"]}={}){
  const fetched=[];
  const gateCalls=[];
  const context=vm.createContext({
    cleanText,console:{warn(){},error(){},log(){}},
    URL,Set,Map,Number,String,Array,Object,RegExp,JSON,Promise,Date,Math,
    TextDecoder,TextEncoder,Uint8Array,Headers,Response,crypto:globalThis.crypto,
    encodeURIComponent,decodeURIComponent,setTimeout,
    fetch:async(url,init={})=>{
      fetched.push({url:String(url),init});
      const key=Object.keys(routes).find(prefix=>String(url).startsWith(prefix));
      if(!key)return new Response("not found",{status:404});
      const route=routes[key];
      return typeof route==="function"?route(String(url),init):route.clone();
    },
    gateCall:async(env,path,body)=>{
      gateCalls.push({path,body});
      const answer=gate[path]?gate[path](body):{};
      return new Response(JSON.stringify(answer),{status:answer?.status||200});
    },
    corsHeaders:()=>({}),
    jsonResponse:(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json"}}),
    normalizeUsername:value=>String(value||"").trim().toLowerCase(),
    isAllowedUser:name=>users.includes(name)
  });
  vm.runInContext(moduleSource("cloudflare-worker/source-preview.js"),context);
  vm.runInContext(moduleSource("cloudflare-worker/report-illustration.js"),context);
  const names=["illustrationCandidates","citationCounts","parseCandidates","googleNewsArticleId","parseDecodedUrl",
    "resolveArticleUrl","imageVerdict","photoTitle","chooseIllustration","findIllustration","handleReportIllustration",
    "extractArticleImage","readHtmlHead","fetchArticleImage","MAX_CANDIDATES"];
  const api=vm.runInContext("({"+names.join(",")+"})",context);
  return {...api,fetched,gateCalls};
}

const html=(head)=>new Response("<html><head>"+head+"</head><body>"+"x".repeat(1000)+"</body></html>",
  {status:200,headers:{"Content-Type":"text/html; charset=utf-8"}});

// ---------------------------------------------------------------- candidates

test("candidates are the cited articles, most cited first, then in the report's order",()=>{
  const h=harness();
  const sources=[
    {id:"S01",title:"First",source:"A",url:"https://a.test/1"},
    {id:"S02",title:"Second",source:"B",url:"https://b.test/2"},
    {id:"S03",title:"Third",source:"C",url:"https://c.test/3"},
    {id:"C01",title:"Archive",source:"D",url:"https://d.test/4"}
  ];
  const analysis="Attack [S02]. More [S03, S02]. Context [C01]. Again [S02].";
  const ids=h.illustrationCandidates(sources,analysis).map(c=>c.id);
  assert.deepEqual(ids,["S02","S03","C01"],"S01 is not cited; S02 cited three times");
  assert.equal(h.illustrationCandidates(sources,analysis)[0].citations,3);
});

test("a report citing nothing offers its first sources, and unsafe links never become candidates",()=>{
  const h=harness();
  const sources=[
    {id:"S01",title:"Local",url:"http://127.0.0.1/admin"},
    {id:"S02",title:"Fine",url:"https://b.test/2"},
    {id:"S03",title:"No link",url:""}
  ];
  assert.deepEqual(h.illustrationCandidates(sources,"No citations here.").map(c=>c.id),["S02"]);
  const many=Array.from({length:10},(_,i)=>({id:"S"+String(i+1).padStart(2,"0"),url:"https://x.test/"+i}));
  assert.equal(h.illustrationCandidates(many,"").length,h.MAX_CANDIDATES);
});

test("the endpoint only accepts safe, distinct links, at most MAX_CANDIDATES",()=>{
  const h=harness();
  const parsed=h.parseCandidates([
    {id:"S01",url:"https://a.test/1",citations:"2"},
    {id:"S01",url:"https://a.test/1"},
    {id:"bad id",url:"https://b.test/2"},
    {url:"file:///etc/passwd"},
    ...Array.from({length:10},(_,i)=>({url:"https://x.test/"+i}))
  ]);
  assert.equal(parsed.length,h.MAX_CANDIDATES);
  assert.deepEqual([parsed[0].id,parsed[0].citations,parsed[1].id],["S01",2,""]);
});

// ---------------------------------------------------------------- Google News links

const GOOGLE_ID="CBMi0wFBVV95cUxNeWVHYXk5Ni1SS01lU1RQUnEyMEtVdDlj";
const GOOGLE_LINK="https://news.google.com/rss/articles/"+GOOGLE_ID+"?oc=5";
const BATCH_ANSWER=")]}'\n\n"+JSON.stringify([["wrb.fr","Fbv4je",
  JSON.stringify(["garturlres","https://outlet.test/story-1",1]),null,null,null,"generic"],["di",42]])+"\n";

test("a Google News article id is read from its rss, articles or read link only",()=>{
  const h=harness();
  assert.equal(h.googleNewsArticleId(GOOGLE_LINK),GOOGLE_ID);
  assert.equal(h.googleNewsArticleId("https://news.google.com/articles/"+GOOGLE_ID),GOOGLE_ID);
  assert.equal(h.googleNewsArticleId("https://news.google.com/read/"+GOOGLE_ID),GOOGLE_ID);
  assert.equal(h.googleNewsArticleId("https://outlet.test/rss/articles/"+GOOGLE_ID),"");
  assert.equal(h.parseDecodedUrl(BATCH_ANSWER),"https://outlet.test/story-1");
  assert.equal(h.parseDecodedUrl(")]}'\n\n[[\"er\",null]]"),"");
});

test("a Google News link is exchanged for the outlet's own address with the page's signature",async()=>{
  const h=harness({routes:{
    "https://news.google.com/rss/articles/":new Response('<c-wiz><div data-n-a-sg="SIG123" data-n-a-ts="1790976275"></div></c-wiz>',{status:200}),
    "https://news.google.com/_/DotsSplashUi/data/batchexecute":(url,init)=>{
      const request=JSON.parse(decodeURIComponent(String(init.body).slice("f.req=".length)));
      const inner=JSON.parse(request[0][0][1]);
      assert.deepEqual(inner.slice(2),[GOOGLE_ID,1790976275,"SIG123"]);
      assert.match(init.headers.Cookie,/CONSENT=YES/);
      return new Response(BATCH_ANSWER,{status:200});
    }
  }});
  assert.equal(await h.resolveArticleUrl(GOOGLE_LINK),"https://outlet.test/story-1");
  assert.equal(await h.resolveArticleUrl("https://outlet.test/direct"),"https://outlet.test/direct","other links are kept");
});

test("a Google News page without a signature (consent wall, rate limit) resolves to nothing",async()=>{
  const h=harness({routes:{"https://news.google.com/rss/articles/":new Response("<html>sorry</html>",{status:200})}});
  assert.equal(await h.resolveArticleUrl(GOOGLE_LINK),"");
  assert.equal(h.fetched.length,1,"the decoder is not asked without a signature");
});

// ---------------------------------------------------------------- which images are photos

test("aggregator artwork, site logos, icons, small images and banners are not photos",()=>{
  const h=harness();
  const verdict=(url,width=0,height=0)=>h.imageVerdict({url,width,height});
  assert.equal(verdict("https://lh3.googleusercontent.com/J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20nuUhkREQyrpY4bEeIBuc=s0-w300").reason,"aggregator artwork");
  assert.equal(verdict("https://outlet.test/assets/site-logo.png").reason,"site artwork");
  assert.equal(verdict("https://outlet.test/img/default-share.jpg").reason,"site artwork");
  assert.equal(verdict("https://outlet.test/img/spinner.gif").reason,"not a photo");
  assert.equal(verdict("https://outlet.test/img/mark.svg").reason,"not a photo");
  assert.equal(verdict("https://outlet.test/img/a.jpg",300,200).reason,"too small");
  assert.equal(verdict("https://outlet.test/img/a.jpg",1600,300).reason,"banner proportions");
  assert.deepEqual({...verdict("https://outlet.test/sites/default/files/2026/10/blast.jpg",1200,800)},{ok:true,large:true},
    "Drupal's /sites/default/ folder holds real photos");
  assert.deepEqual({...verdict("https://outlet.test/photo.jpg")},{ok:true,large:false},"an undeclared size is accepted");
});

test("the photo's title is the report's English headline; the page's caption is kept for the alt text",()=>{
  const h=harness();
  const titled=h.photoTitle({alt:"Sosyal medyada terör propagandasına jandarma engeli",title:"x"},
    {title:"Gendarmerie crackdown on terrorist propaganda"});
  assert.equal(titled.title,"Gendarmerie crackdown on terrorist propaganda");
  assert.equal(titled.photo_caption,"Sosyal medyada terör propagandasına jandarma engeli");
  assert.equal(h.photoTitle({alt:""},{title:"Headline"}).photo_caption,"");
});

// ---------------------------------------------------------------- choosing

const result=(id,citations,url,width=1200,height=700)=>({candidate:{id,citations},image:{url,width,height}});

test("the most cited article with a real photo wins, a large photo first among equals",()=>{
  const h=harness();
  const best=h.chooseIllustration([
    result("S01",1,"https://a.test/photo.jpg"),
    result("S02",3,"https://b.test/logo.png"),
    result("S03",2,"https://c.test/small.jpg",500,300),
    result("S04",2,"https://d.test/big.jpg")
  ]);
  assert.equal(best.candidate.id,"S04","S02's logo is out; S04's large photo beats S03's smaller one");
  assert.equal(h.chooseIllustration([{candidate:{id:"S01",citations:1},image:null}]),null);
});

test("a picture two articles share is a site's default artwork, never chosen",()=>{
  const h=harness();
  const best=h.chooseIllustration([
    result("S01",5,"https://outlet.test/share.jpg"),
    result("S02",4,"https://outlet.test/share.jpg"),
    result("S03",1,"https://other.test/real.jpg")
  ]);
  assert.equal(best.candidate.id,"S03");
});

test("articles are inspected three at a time and the search stops at the first batch with a photo",async()=>{
  const h=harness();
  const inspected=[];
  const candidates=Array.from({length:6},(_,i)=>({id:"S0"+(i+1),citations:1,url:"https://x.test/"+i}));
  const best=await h.findIllustration(candidates,async candidate=>{
    inspected.push(candidate.id);
    return {candidate,image:candidate.id==="S02"?{url:"https://x.test/p.jpg",width:1200,height:700}:null};
  });
  assert.equal(best.candidate.id,"S02");
  assert.deepEqual(inspected,["S01","S02","S03"]);
  const none=await h.findIllustration(candidates,async candidate=>{throw new Error("refused");});
  assert.equal(none,null,"a failing article is skipped, never an error");
});

// ---------------------------------------------------------------- reading articles

test("the share image and its metadata are read from the page's head",()=>{
  const h=harness();
  const image=h.extractArticleImage(`
    <meta property="og:title" content="Blast in Quetta">
    <meta property="og:site_name" content="Outlet">
    <meta property="og:image" content="/img/blast.jpg">
    <meta property="og:image:width" content="1280"><meta property="og:image:height" content="720">
    <meta property="og:image:alt" content="Rescue workers at the site">`,"https://outlet.test/news/1");
  assert.deepEqual({...image},{url:"https://outlet.test/img/blast.jpg",width:1280,height:720,
    alt:"Rescue workers at the site",title:"Blast in Quetta",site:"Outlet"});
});

test("a long article page is read up to its </head>, not refused for its size",async()=>{
  const h=harness();
  const head="<html><head><meta property=\"og:image\" content=\"https://outlet.test/a.jpg\"></head><body>";
  const chunks=[head,...Array.from({length:60},()=>"y".repeat(16000))];
  let served=0;
  const body=new ReadableStream({pull(controller){
    if(served<chunks.length)controller.enqueue(new TextEncoder().encode(chunks[served++]));
    else controller.close();
  }});
  const text=await h.readHtmlHead(new Response(body),350000);
  assert.ok(text.includes("</head>"));
  assert.ok(served<5,"the body after </head> is not downloaded");
  const endless=new ReadableStream({pull(controller){controller.enqueue(new TextEncoder().encode("z".repeat(16000)));}});
  const capped=await h.readHtmlHead(new Response(endless),100000);
  assert.ok(capped.length>=100000&&capped.length<140000,"a page without </head> stops at the limit");
});

// ---------------------------------------------------------------- endpoint

function request(body,token="tok"){
  return new Request("https://worker.test/report-illustration",{method:"POST",
    headers:token?{"X-Session-Token":token,"Content-Type":"application/json"}:{"Content-Type":"application/json"},
    body:JSON.stringify(body)});
}

const signedIn={"/session-get":()=>({username:"analyst"})};

test("the endpoint needs a signed-in analyst",async()=>{
  const h=harness({gate:signedIn});
  const response=await h.handleReportIllustration(request({user_id:"analyst",candidates:[]},""),{});
  assert.equal(response.status,401);
});

test("the endpoint finds the photo through the Google News link, returns it with its title, and caches it",async()=>{
  const cache=new Map();
  const h=harness({
    gate:{
      ...signedIn,
      "/cache-get":body=>cache.has(body.cacheKey)?{hit:true,report:cache.get(body.cacheKey)}:{hit:false},
      "/cache-put":body=>{cache.set(body.cacheKey,body.report);return {ok:true};},
      "/source-image-token-put":()=>({token:"t".repeat(32)})
    },
    routes:{
      "https://news.google.com/rss/articles/":new Response('<div data-n-a-sg="SIG" data-n-a-ts="1790976275"></div>',{status:200}),
      "https://news.google.com/_/DotsSplashUi/data/batchexecute":new Response(BATCH_ANSWER,{status:200}),
      "https://outlet.test/story-1":html('<meta property="og:image" content="https://cdn.outlet.test/blast.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">')
    }
  });
  const body={user_id:"analyst",candidates:[{id:"S03",title:"Blast kills 12 in Quetta",source:"Outlet",url:GOOGLE_LINK,date:"2026-10-01",citations:2}]};
  const payload=await (await h.handleReportIllustration(request(body),{})).json();
  assert.equal(payload.illustration.image_path,"/source-image/"+"t".repeat(32));
  assert.equal(payload.illustration.title,"Blast kills 12 in Quetta");
  assert.equal(payload.illustration.source_id,"S03");
  assert.equal(payload.illustration.article_url,"https://outlet.test/story-1");
  const token=h.gateCalls.find(call=>call.path==="/source-image-token-put");
  assert.equal(token.body.image_url,"https://cdn.outlet.test/blast.jpg");

  const fetchedBefore=h.fetched.length;
  const again=await (await h.handleReportIllustration(request(body),{})).json();
  assert.equal(again.cached,true);
  assert.equal(h.fetched.length,fetchedBefore,"a cached answer fetches nothing");
});

test("no usable photo is an empty answer, not an error",async()=>{
  const h=harness({gate:{...signedIn,"/cache-get":()=>({hit:false}),"/cache-put":()=>({ok:true})},
    routes:{"https://outlet.test/":html('<meta property="og:image" content="https://outlet.test/logo.png">')}});
  const response=await h.handleReportIllustration(request({user_id:"analyst",candidates:[{id:"S01",url:"https://outlet.test/a"}]}),{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).illustration,null);
});

// ---------------------------------------------------------------- wiring

test("both report tools return illustration candidates instead of fetching pictures themselves",()=>{
  const index=fs.readFileSync("cloudflare-worker/index.js","utf8");
  const deep=fs.readFileSync("cloudflare-worker/deep-search.js","utf8");
  assert.ok(index.includes('url.pathname === "/report-illustration" && request.method === "POST"'));
  assert.ok(index.includes("illustration_candidates: illustrationCandidates(eventSources, analysisText)"));
  assert.ok(/illustration_candidates: illustrationCandidates\(\s*evidence\.filter\(item => !NOT_ILLUSTRATIONS\.has\(item\.corpus_kind\)\), generated\.analysis\)/.test(deep),
    "archive commentary and off-scope rows never illustrate a Deep Search report");
  for(const source of [index,deep])assert.ok(!source.includes("createSourcePreviews"),"no picture search inside the report request");
  const reportAt=deep.indexOf("const report = {");
  assert.ok(deep.indexOf("const generated = unwrapGeneratedReport")<reportAt,"candidates come from the generated analysis");
});

test("the pages show the picture above the report text and put it in the PDF",()=>{
  const index=fs.readFileSync("index.html","utf8");
  const deep=fs.readFileSync("deep-search.js","utf8");
  const client=fs.readFileSync("report-illustration.js","utf8");
  const auth=fs.readFileSync("usage-auth-fix.js","utf8");
  const pdf=fs.readFileSync("pdf-export.js","utf8");
  assert.ok(index.indexOf('id="reportResultIllustration"')<index.indexOf('id="reportResultContent"'));
  assert.ok(index.includes('<script src="report-illustration.js'));
  assert.ok(index.includes("payload.illustration_candidates"));
  assert.ok(deep.indexOf('id="deepSearchIllustration"')<deep.indexOf('id="deepSearchReport"'));
  assert.ok(deep.includes("payload.illustration_candidates"));
  assert.ok(!index.includes("reportResultVisuals")&&!deep.includes("deepSearchVisuals"),"the old two-thumbnail strip is gone");
  assert.ok(client.includes("data-pdf-image")&&client.includes("data-pdf-skip"));
  assert.ok(index.includes("CTAtlasIllustration?.ready")&&deep.includes("CTAtlasIllustration?.ready"),"the PDF waits for a picture still loading");
  assert.match(auth,/report-illustration/,"the session token is sent with the request");
  assert.ok(pdf.includes("[data-pdf-skip]"));
});
