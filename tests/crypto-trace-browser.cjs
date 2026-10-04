const fs=require("fs"),path=require("path"),assert=require("node:assert/strict");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=path.resolve(__dirname,"..");
const address=i=>"0x"+String(i).padStart(40,"0");
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE});
 try{
  const context=await browser.newContext();
  await context.addInitScript(()=>{
   sessionStorage.setItem("ct_map_session_token","test");
   sessionStorage.setItem("ct_map_username","analyst");
   sessionStorage.setItem("ct_map_authorized","yes");
  });
  const calls=[],errors=[];
  await context.route("**/*",async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==="crypto-test.invalid"){
    const file=path.join(root,url.pathname),ext=path.extname(file);
    return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):"",
     contentType:({".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json"})[ext]||"text/plain"});
   }
   if(url.pathname==="/session-check")return route.fulfill({json:{ok:true,username:"analyst"}});
   if(url.pathname==="/crypto-analyze"){
    const query=route.request().postDataJSON().query;calls.push(query);
    const i=Number(query);
    return route.fulfill({json:{kind:"address",chain:"ethereum",query,provider:"Fixture",summary:{},
     transactions:[{id:"tx"+i,direction:"OUT",asset:"ETH",amount:1,confirmed:true,time:"2026-10-01T10:00:00Z",counterparties:[address(i+1)]}],
     exchange_behavior:i===2?{status:"behavioral_candidate",score:95,evidence:["Synthetic high-throughput fixture"],metrics:{}}:null,
     exchange_labels:i===3?[{address:address(4),chain:"ethereum",category:"EXCHANGE",name:"Example Exchange",source_title:"Fixture public list",source_url:"https://example.org/wallets"}]:[]
    }});
   }
   if(url.pathname==="/crypto-exchange-attribution")return route.fulfill({json:{attributions:[]}});
   return route.fulfill({json:{ok:true,workspace:{labels:[],watchlist:[],cases:[],alerts:[]}}});
  });
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  await page.goto("https://crypto-test.invalid/crypto.html");
  await page.evaluate(()=>document.documentElement.classList.remove("ct-loading"));
  assert.equal(await page.locator("#traceMaxDepth").inputValue(),"6");
  assert.equal(await page.locator("#traceBranch").inputValue(),"8");
  assert.equal(await page.locator("#filterGraphNodes").inputValue(),"80");
  await page.locator("#cryptoQuery").fill(address(1));
  await page.locator("#cryptoChain").selectOption("ethereum");
  await page.locator("#cryptoRun").click();
  await page.waitForFunction(()=>document.querySelector("#cryptoStatus").textContent.includes("Analysis completed"));
  await page.locator("#cryptoAutoTrace").click();
  await page.waitForFunction(()=>document.querySelector("#cryptoTraceStatus").textContent.includes("Automatic trace complete"));
  assert.deepEqual(calls,[address(1),address(2),address(3)]);
  assert.match(await page.locator("#cryptoTraceStatus").textContent(),/1 documented exchange\(s\), 1 behavioural candidate/);
  assert.deepEqual(errors,[]);
  console.log("Chrome: maximum defaults, behavioural continuation, documented stop and rendering passed");
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
