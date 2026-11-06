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
test('every workspace ships the shared loader and the hub lists the three that remain, in order',()=>{
 for(const name of ['main','index','crypto','ip']){
  const html=fs.readFileSync(name+'.html','utf8');
  assert.ok(html.includes('workspace-ui.js'));assert.ok(html.includes('workspace-ui.css'));assert.ok(html.includes('class="ct-page-loading"'));
  assert.ok(html.indexOf('<meta charset="UTF-8">')<1024);
 }
 const main=fs.readFileSync('main.html','utf8');
 const links=[...main.matchAll(/class="hub-card[^\"]*" href="([^\"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(links,['index.html?workspace=map','crypto.html','ip.html']);
 assert.doesNotMatch(main,/hub-beta|class="under"|\.under\{/);
});
test('the README waits behind a native button: closed by default, keyboard-operable, text intact',()=>{
 const main=fs.readFileSync('main.html','utf8');
 const open=main.match(/<details id="readme"[^>]*>/);
 assert.ok(open,'id="readme" is the disclosure itself, and the UI deploy greps it');
 assert.doesNotMatch(open[0],/\sopen\b/,'closed until the user opens it');
 assert.doesNotMatch(main,/\.open=|setAttribute\("open"|<section id="readme"/,'nothing opens it for the user or shows it in full');
 const readme=main.slice(main.indexOf('<details id="readme"'),main.indexOf('</details>'));
 assert.match(readme,/^<details id="readme"[^>]*>\s*<summary class="hub-readme-toggle"><h2 id="readmeTitle"[^>]*>README<\/h2><\/summary>/,'the summary comes first, so everything else is hidden');
 assert.doesNotMatch(readme,/tabindex|role="button"/,'a native summary is already focusable and answers Enter and Space');
 assert.match(main,/\.hub-readme-toggle\{[^}]*list-style:none/);
 assert.match(main,/\.hub-readme-toggle::-webkit-details-marker\{display:none\}/);
 assert.match(main,/\.hub-readme-toggle:focus-visible\{[^}]*outline:2px solid/,'keyboard focus stays visible');
 for(const text of ['Use only for authorised duties.','Verify before relying on results.','Keep outputs transparent.','Protect access and report concerns.','Do not use CT ATLAS for prohibited purposes.','Do not enter confidential or sensitive information.','Do not search sensitive categories during the pilot.','Do not ingest or share unverified outputs.','Do not retain results on CT ATLAS beyond relevance assessment.']){
  assert.ok(readme.includes(text),text);
 }
 assert.doesNotMatch(readme,/facial|dark web|social|socmint/i,'no wording about a retired tool');
 assert.ok(readme.includes('Coverage may be incomplete or outdated. IP location and cryptocurrency links do not establish identity, ownership or criminal involvement.'));
});
test('hub grid shows three equal columns, then one: no orphan card on a row of its own',()=>{
 const main=fs.readFileSync('main.html','utf8');
 assert.match(main,/\.hub-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:12px\}/);
 assert.doesNotMatch(main,/\.hub-grid\{grid-template-columns:repeat\((?:2|6),/,'two columns would leave the third card alone on its row');
 assert.match(main,/@media\(max-width:760px\)\{[^\n]*\.hub-grid\{grid-template-columns:1fr\}/);
 assert.match(main,/\.hub-card-title\{[^}]*overflow-wrap:anywhere/);
});
