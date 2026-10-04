const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function harness(){
 const timers=new Map(),listeners={},nodes=new Map();let id=0;
 class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.isConnected=true;this.dataset={};this.textContent='';this.classList={add:()=>{},remove:()=>{},contains:()=>false};}
  append(...items){this.children.push(...items);items.forEach(x=>x.parent=this);}
  setAttribute(k,v){this[k]=v;}
  insertAdjacentElement(where,node){this.append(node);}
  remove(){this.removed=true;this.isConnected=false;}
  contains(target){return target===this||this.children.some(x=>x.contains(target));}
  focus(){document.activeElement=this;}
  closest(selector){return this.matches?.[selector]||null;}
  hasAttribute(name){return Object.hasOwn(this,name);}
 }
 const classes=new Set(['ct-loading']);
 const document={documentElement:new Element('html'),body:new Element('body'),readyState:'loading',createElement:t=>new Element(t),getElementById:id=>nodes.get(id),addEventListener:(k,v)=>listeners[k]=v};
 document.documentElement.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)};document.activeElement=document.body;
 const window={addEventListener:(k,v)=>listeners[k]=v};
 const context={window,document,Element,URL,location:new URL('https://ct-atlas.com/main.html'),sessionStorage:{getItem:()=>null},Math,Set,MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>fn(),setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(fs.readFileSync('workspace-ui.js','utf8'),context);
 return {ui:window.CTAtlasUI,document,Element,classes,listeners,timers,fire(ms){for(const [id,t] of [...timers])if(t.ms===ms){timers.delete(id);t.fn();}}};
}
test('short jobs never flash a card; completed long jobs remove it; nested export reuses it',()=>{
 const h=harness(),anchor=new h.Element('div');
 let stop=h.ui.begin(anchor);stop();h.fire(1200);assert.equal(anchor.children.length,0);
 stop=h.ui.begin(anchor);h.fire(1200);assert.equal(anchor.children.length,1);
 const card=anchor.children[0],text=card.children[2].textContent;
 card.children[3].children[1].onclick();assert.notEqual(card.children[2].textContent,text);
 assert.match(card.children[3].children[0].href,/^https:\/\//);
 const nested=h.ui.begin(null);h.fire(1200);nested();assert.equal(h.document.body.children.length,0);
 stop();assert.equal(card.removed,true);assert.equal(h.timers.size,0);
});
test('navigation ignores modified/external clicks and restores after back or timeout',()=>{
 const h=harness(),link=new h.Element('a');link.href='https://ct-atlas.com/crypto.html';link.matches={'a[href]':link};
 h.ui.ready();h.listeners.click({target:link,button:0,ctrlKey:true});assert.equal(h.classes.has('ct-loading'),false);
 link.href='https://example.org/main.html';h.listeners.click({target:link,button:0});assert.equal(h.classes.has('ct-loading'),false);
 link.href='https://ct-atlas.com/crypto.html';h.listeners.click({target:link,button:0});assert.equal(h.classes.has('ct-loading'),true);
 h.listeners.pageshow({persisted:true});assert.equal(h.classes.has('ct-loading'),false);
 h.listeners.click({target:link,button:0});h.fire(10000);assert.equal(h.classes.has('ct-loading'),false);
});
test('every workspace ships the shared loader and hub order retains only Social beta',()=>{
 for(const name of ['main','index','crypto','facial','social','darkweb','ip']){
  const html=fs.readFileSync(name+'.html','utf8');
  assert.ok(html.includes('workspace-ui.js'));assert.ok(html.includes('workspace-ui.css'));assert.ok(html.includes('class="ct-page-loading"'));
  assert.ok(html.indexOf('<meta charset="UTF-8">')<1024);
 }
 const main=fs.readFileSync('main.html','utf8');
 const links=[...main.matchAll(/class="hub-card[^\"]*" href="([^\"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(links,['index.html?workspace=map','darkweb.html','facial.html','crypto.html','ip.html','social.html']);
 assert.equal((main.match(/class="hub-beta"/g)||[]).length,1);
 assert.match(main,/grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
});
test('hub grid steps down 6 -> 3 -> 2 -> 1 columns so titles never overflow tablet-width cards',()=>{
 const main=fs.readFileSync('main.html','utf8');
 const three=main.indexOf('@media(max-width:1180px){.hub-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}');
 const two=main.indexOf('@media(max-width:900px){.hub-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}');
 const one=main.indexOf('@media(max-width:760px)');
 assert.ok(three>0&&two>three&&one>two,'later, narrower breakpoints must follow the wider ones');
 assert.match(main,/\.hub-card-title\{[^}]*overflow-wrap:anywhere/);
});
