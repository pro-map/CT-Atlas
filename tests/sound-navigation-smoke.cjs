const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--autoplay-policy=user-gesture-required'],...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage(),starts=[];
  await page.exposeFunction('recordSoundStart',time=>starts.push(time));
  await page.addInitScript(()=>{
   const createOscillator=AudioContext.prototype.createOscillator;
   AudioContext.prototype.createOscillator=function(){const source=createOscillator.call(this),start=source.start.bind(source);source.start=(...args)=>{void recordSoundStart(Date.now());return start(...args);};return source;};
  });
  const script=fs.readFileSync(path.resolve(__dirname,'../sound-effects.js'),'utf8');
  await page.route('https://sound-test.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<div class="hub-actions"></div><a href="crypto.html">Crypto</a><script>'+script+'</script>'}));
  await page.goto('https://sound-test.invalid/main.html');
  await page.getByRole('switch').click();assert.equal(starts.length,0);
  await page.getByRole('switch').click();await page.waitForTimeout(150);
  assert.equal(starts.length,1,'enabling gives an immediate preview');
  await page.goto('https://sound-test.invalid/main.html');starts.length=0;
  let arrived=0;page.on('framenavigated',()=>arrived=Date.now());
  await page.getByText('Crypto',{exact:true}).click();await page.waitForURL('**/crypto.html');
  assert.equal(starts.length,1);assert.ok(arrived-starts[0]>=80,'navigation preserves the complete 60 ms transient');
  // Offline rendering checks the actual waveform even on hosts without an audio output device.
  await page.goto('https://sound-test.invalid/main.html');
  const waveform=await page.evaluate(async source=>{
   const offline=new OfflineAudioContext(1,4800,48000);
   window.AudioContext=function(){return new Proxy(offline,{get(target,key){if(key==='state')return 'running';const value=target[key];return typeof value==='function'?value.bind(target):value;}});};
   eval(source);
   await CTAtlasSound.play('click');
   const audio=(await offline.startRendering()).getChannelData(0);
   let peak=0,energy=0;for(const sample of audio){peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;}
   return {peak,rms:Math.sqrt(energy/audio.length)};
  },script);
  assert.ok(waveform.peak>.02&&waveform.peak<.08);assert.ok(waveform.rms>.005);
  console.log('PASS: On preview, rendered waveform, and completed navigation click under gesture-required autoplay policy',waveform);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
