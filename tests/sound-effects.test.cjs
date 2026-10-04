const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function harness({stored=null,blocked=false,suspended=false,unsupported=false}={}){
 const listeners={},sources=[],gains=[],contexts=[];let now=1000,resume;
 const on=(type,fn)=>(listeners[type]??=[]).push(fn);
 const host={append:b=>host.button=b};
 const document={body:host,hidden:false,readyState:'complete',querySelector:()=>host,addEventListener:on,createElement:()=>({setAttribute(k,v){this[k]=v;},addEventListener(type,fn){this[type]=fn;}})};
 class Param{constructor(){this.value=0;}setValueAtTime(v){this.value=v;}cancelScheduledValues(){}linearRampToValueAtTime(v){this.value=v;}exponentialRampToValueAtTime(v){this.value=v;}}
 class AudioContext{
  constructor(){this.state=suspended?'suspended':'running';this.currentTime=0;this.destination={};contexts.push(this);}
  createGain(){const n={gain:new Param(),connect(){},disconnect(){this.disconnected=true;}};gains.push(n);return n;}
  createOscillator(){const n={frequency:new Param(),connect(){},disconnect(){},start(){this.started=true;},stop(time){if(time===undefined)this.stopped=true;else this.end=time;}};sources.push(n);return n;}
  resume(){return new Promise(resolve=>{resume=()=>{this.state='running';resolve();};});}
 }
 const window={addEventListener:on,...(!unsupported?{AudioContext}:{})};
 class Element{closest(selector){return this.matches?.[selector]||null;}hasAttribute(){return false;}}
 const location=new URL('https://ct-atlas.com/main.html');location.assign=()=>{};
 const context={window,document,Element,URL,location,setTimeout,clearTimeout,performance:{now:()=>now},localStorage:{getItem(){if(blocked)throw Error();return stored;},setItem(k,v){if(blocked)throw Error();stored=v;}}};
 vm.runInNewContext(fs.readFileSync('sound-effects.js','utf8'),context);
 return {sound:window.CTAtlasSound,sources,gains,contexts,host,Element,document,advance(){now+=200;},resume(){resume();},stored:()=>stored,fire(type,event){for(const fn of listeners[type]||[])fn(event);},listeners};
}
test('lazy, quiet audio; short click and bounded single voice under rapid input',async()=>{
 const h=harness();assert.equal(h.contexts.length,0);
 await h.sound.play();assert.equal(h.sources.length,1);assert.equal(h.sources[0].end,.06);assert.equal(h.gains[0].gain.value,.12);
 await h.sound.play();assert.equal(h.sources.length,1);
 h.advance();await h.sound.play('error');assert.equal(h.sources[0].stopped,true);assert.equal(h.sources[1].end,.085);
 h.advance();await h.sound.play('success');assert.equal(h.sources[1].stopped,true);assert.equal(h.sources[2].end,.1);
});
test('mute stops current audio and invalidates delayed completion across off/on',async()=>{
 const h=harness(),finish=h.sound.begin();h.sound.setEnabled(false);
 assert.equal(h.sources[0].stopped,true);assert.equal(h.gains[0].gain.value,0);assert.equal(h.stored(),'off');
 h.advance();await h.sound.play('error');assert.equal(h.sources.length,1);
 h.sound.setEnabled(true);finish('success');assert.equal(h.sources.length,1);
 const off=harness({stored:'off'});assert.equal(off.host.button['aria-checked'],'false');await off.sound.play();assert.equal(off.contexts.length,0);
});
test('mute during AudioContext resume cannot leak a late sound',async()=>{
 const h=harness({suspended:true}),pending=h.sound.play();h.sound.setEnabled(false);h.resume();await pending;assert.equal(h.sources.length,0);
});
test('cross-tab mute, background visibility, unsupported audio and denied storage',async()=>{
 const h=harness();await h.sound.play();h.fire('storage',{key:'ct_atlas_sound_effects',newValue:'off'});assert.equal(h.sources[0].stopped,true);assert.equal(h.sound.enabled,false);
 h.sound.setEnabled(true);h.document.hidden=true;await h.sound.play();assert.equal(h.sources.length,1);
 const noAudio=harness({unsupported:true});await noAudio.sound.play();assert.equal(noAudio.contexts.length,0);
 const blocked=harness({blocked:true});blocked.sound.setEnabled(false);await blocked.sound.play();assert.equal(blocked.sound.enabled,false);
});
test('only module navigation is audible; modified/external clicks and arbitrary input stay silent',async()=>{
 const h=harness(),link=new h.Element();link.matches={'a[href]':link};link.href='https://ct-atlas.com/crypto.html';
 h.fire('click',{target:link,button:0,ctrlKey:true});assert.equal(h.sources.length,0);
 link.href='https://example.org/crypto.html';h.fire('click',{target:link,button:0});assert.equal(h.sources.length,0);
 h.fire('click',{target:new h.Element(),button:0});assert.equal(h.sources.length,0);
 link.href='https://ct-atlas.com/crypto.html';h.fire('click',{target:link,button:0,preventDefault(){},stopImmediatePropagation(){}});assert.equal(h.sources.length,1);
 for(const event of ['mouseover','scroll','input','change'])assert.equal(h.listeners[event],undefined);
});
test('all workspaces and both hosting builds include sound assets',()=>{
 for(const name of ['main','index','crypto','facial','social','darkweb','ip','privacy','sound-check']){
  const html=fs.readFileSync(name+'.html','utf8');assert.match(html,/sound-effects\.js\?v=20261004c/);if(html.includes('workspace-ui.js'))assert.ok(html.indexOf('sound-effects.js')<html.indexOf('workspace-ui.js'));
 }
 assert.match(fs.readFileSync('tools/deploy_mirror.sh','utf8'),/sound-effects\.js/);
 assert.match(fs.readFileSync('.github/workflows/deploy-current-ct-atlas-ui.yml','utf8'),/sound-effects\.js/);
});
