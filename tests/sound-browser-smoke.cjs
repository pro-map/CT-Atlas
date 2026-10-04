const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),headless:true});
 try{
 const context=await browser.newContext();
 await context.addInitScript(()=>{
  sessionStorage.setItem('ct_map_session_token','sound-test');sessionStorage.setItem('ct_map_username','sound-test');sessionStorage.setItem('ct_map_authorized','yes');
  window.soundStarts=[];
  const original=AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator=function(){const node=original.call(this),start=node.start.bind(node);node.start=(...args)=>{window.soundStarts.push(node.frequency.value);return start(...args);};return node;};
 });
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='sound-test.invalid'){
   const file=path.join(root,decodeURIComponent(url.pathname));
   if(!file.startsWith(root)||!fs.existsSync(file)){await route.fulfill({status:404,body:''});return;}
   const ext=path.extname(file),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
   await route.fulfill({body:fs.readFileSync(file),contentType:types[ext]||'text/plain'});return;
  }
  if(url.pathname==='/session-check'){await route.fulfill({json:{ok:true,username:'sound-test',expires_at:'2099-01-01T00:00:00Z'}});return;}
  if(/crypto-analyze|visual-analyze|social-investigate|ip-intelligence\/lookup/.test(url.pathname)){
   await new Promise(r=>setTimeout(r,200));await route.fulfill({status:503,json:{error:'Controlled test failure'}});return;
  }
  await route.fulfill({json:{ok:true,items:[],reports:[],labels:[],cases:[],monitored:[],outlets:[],policy:{},sources:[],providers:[]}});
 });
 const page=await context.newPage();
 for(const name of ['main','index','crypto','facial','social','darkweb','ip']){
  await page.goto('https://sound-test.invalid/'+name+'.html');
  await page.locator('#ctSoundEffects').waitFor({state:'attached'});
  await page.evaluate(()=>document.documentElement.classList.remove('ct-loading'));
  assert.equal(await page.evaluate(()=>soundStarts.length),0,name+' startup must be silent');
  const toggle=page.locator('#ctSoundEffects');await toggle.click({force:true});
  assert.equal(await toggle.getAttribute('aria-checked'),'false');
  await page.evaluate(()=>CTAtlasSound.play('error'));assert.equal(await page.evaluate(()=>soundStarts.length),0);
  await page.reload();await page.locator('#ctSoundEffects').waitFor({state:'attached'});
  assert.equal(await page.locator('#ctSoundEffects').getAttribute('aria-checked'),'false');
  await page.evaluate(()=>document.documentElement.classList.remove('ct-loading'));
  await page.locator('#ctSoundEffects').click({force:true});
  await page.setViewportSize({width:390,height:844});
  const box=await page.locator('#ctSoundEffects').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=391,name+' mobile switch within viewport');
  await page.setViewportSize({width:1280,height:900});
  console.log(name+': global switch, persistence, silence and mobile layout OK');
 }
 for(const [name,input,value,button] of [
  ['crypto','#cryptoQuery','3FoD1f6Tfnq3s8MYHgJqFPWv9cUrtUdBSv','#cryptoRun'],
  ['ip','#ipAddress','8.8.8.8','#lookupButton']
 ]){
  await page.goto('https://sound-test.invalid/'+name+'.html');await page.evaluate(()=>document.documentElement.classList.remove('ct-loading'));
  await page.locator(input).fill(value);await page.locator(button).click();
  await page.waitForFunction(()=>soundStarts.length===2);console.log(name+': actual analysis start and failure feedback OK');
  await page.waitForTimeout(150);await page.locator('#ctSoundEffects').click();await page.locator(button).click();await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>soundStarts.length),2);console.log(name+': actual analysis stays silent while Off');
  await page.locator('#ctSoundEffects').click();
 }
 await page.goto('https://sound-test.invalid/social.html');
 await page.locator('#socialTarget').fill('Sound integration test');await page.locator('#socialRunButton').click();
 await page.waitForFunction(()=>soundStarts.length===2);console.log('social: actual investigation start and failure feedback OK');
 await page.goto('https://sound-test.invalid/facial.html');
 await page.locator('#fiFiles').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64')});
 await page.locator('#fiConsent').check();await page.locator('#fiRun').click();await page.waitForFunction(()=>soundStarts.length===2);
 console.log('facial: actual analysis start and failure feedback OK');
 await page.route('**/visual-analyze',async route=>{await new Promise(r=>setTimeout(r,200));await route.fulfill({json:{files:[],similarity_pairs:[],errors:[]}});});
 await page.waitForTimeout(150);await page.locator('#fiRun').click();await page.waitForFunction(()=>soundStarts.length===4);
 assert.equal(await page.locator('#fiStatus').textContent(),'Analysis complete.');console.log('facial: actual success feedback OK');
 await page.waitForTimeout(150);await page.locator('#fiRun').click();await page.locator('#ctSoundEffects').click();await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>soundStarts.length),5);console.log('facial: muting during analysis suppresses its late success');
 await page.locator('#ctSoundEffects').click();
 await page.goto('https://sound-test.invalid/darkweb.html');await page.evaluate(()=>document.documentElement.classList.remove('ct-loading'));
 await page.locator('[data-view="setup"]').click();assert.equal(await page.evaluate(()=>soundStarts.length),1);
 await page.waitForTimeout(150);await page.locator('[data-view="setup"]').click();assert.equal(await page.evaluate(()=>soundStarts.length),1);
 await page.locator('[data-view="outlets"]').click();await page.waitForTimeout(150);
 await page.route('**/darkweb/outlet',async route=>{await new Promise(r=>setTimeout(r,200));await route.fulfill({json:{ok:true}});});
 await page.evaluate(()=>{document.querySelector('#outletForm').hidden=false;document.querySelector('#outletName').value='Test';document.querySelector('#outletUrl').value='https://example.com';});
 await page.locator('#outletForm button[type=submit]').click();await page.waitForFunction(()=>soundStarts.length===4);
 console.log('darkweb: view change, repeated view silence and save confirmation OK');
 await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
