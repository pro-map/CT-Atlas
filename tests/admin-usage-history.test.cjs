// Admin usage panel: every nonzero number opens the details behind it (the searches, their
// filters and outcomes), and the event list records one search per settled query.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const client=fs.readFileSync("usage-admin.js","utf8");
const css=fs.readFileSync("usage-admin.css","utf8");

function helpers(){
  const start=client.indexOf("function escapeCell");
  const end=client.indexOf("function refreshAdminButton");
  assert.ok(start!==-1&&end>start,"helper block not found");
  const c=vm.createContext({document:{getElementById:()=>null}});
  vm.runInContext(client.slice(start,end)+
    "\nglobalThis.api={adminCountCell,adminHistoryEntry,adminHistoryHtml,adminUserCell};",c);
  return c.api;
}

test("a nonzero count is a button naming its user and counter; zero stays plain text",()=>{
  const api=helpers();
  const cell=api.adminCountCell(3,{username:"Group-I-11"},"blockchain_searches");
  assert.match(cell,/^<td class="admin-usage-nonzero"><button type="button" class="admin-count-link" data-user="group-i-11" data-metric="blockchain_searches" data-count="3"/);
  assert.equal(api.adminCountCell(0,{username:"group-i-11"},"blockchain_searches"),"<td>0</td>");
  assert.equal(api.adminCountCell(2),'<td class="admin-usage-nonzero">2</td>',"older callers keep the plain cell");
  assert.match(api.adminCountCell(1,{username:'x"><img src=x>'},"all"),/data-user="x&quot;&gt;&lt;img src=x&gt;"/);
  assert.match(api.adminUserCell({username:"group-i-11",display_name:"Kitty"},true),/class="admin-history-all" data-user="group-i-11" data-metric="all"/);
  assert.ok(!api.adminUserCell({username:"group-i-1"},false).includes("admin-history-all"),"idle users have nothing to show");
});

test("history rows read as what was searched, with its filters and outcome",()=>{
  const api=helpers();
  const at="2026-10-06T08:30:00.000Z";
  const [when,label,main,details]=api.adminHistoryEntry({at,feature:"report_generator",region:"REGION:AFRICA",topic:"ALL",actor_group:"ALL",period_days:1,compare:true,outcome:"cached",title:"Sahel brief"});
  assert.match(when,/06 Oct/);
  assert.match(when,/10:30/,"times are shown in Paris time");
  assert.equal(label,"SITUATION REPORT");
  assert.equal(main,"Region AFRICA · All · All · 24 hours");
  assert.deepEqual([...details].map(pair=>[...pair]),[["Comparison","Yes"],["Result","Sahel brief"],["Outcome","Served from cache"]]);
  const deep=api.adminHistoryEntry({at,feature:"deep_search",question:"Who claimed the attack?",scope:"Global",outcome:"generated",period:"Last 30 days"});
  assert.equal(deep[2],"Who claimed the attack?");
  assert.deepEqual([...deep[3]].map(pair=>pair[0]),["Database scope","Period found","Outcome"]);
  assert.equal(api.adminHistoryEntry({at,feature:"darkweb_search",outlet:"Outlet B"})[2],"(filters only)");
  assert.equal(api.adminHistoryEntry({at,feature:"facial_search",face:"F2 @ 3.5s",engines:["yandex"]})[2],"Face F2 @ 3.5s · reverse-image search");
  assert.equal(api.adminHistoryEntry({at,feature:"facial_extraction",files:3,videos:1,bytes:3145728})[3].find(pair=>pair[0]==="Upload size")[1],"3.0 MB");
  assert.match(api.adminHistoryHtml([{at,feature:"social",target:"Retired search"},{at,feature:"tab_social"}]),/No details recorded/);
  assert.equal(api.adminHistoryEntry({at,feature:"tab_crypto"})[1],"CRYPTO OPENED");
  assert.equal(api.adminHistoryEntry({at,feature:"ip_lookup",target:"8.8.8.8",kind:"ip"})[2],"8.8.8.8");
});

test("searched text is escaped before it reaches the page",()=>{
  const api=helpers();
  const html=api.adminHistoryHtml([{at:"2026-10-06T08:30:00.000Z",feature:"event_list",text:'<img src=x onerror=alert(1)>',country:"<b>"}]);
  assert.ok(!html.includes("<img")&&!html.includes("<b>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(api.adminHistoryHtml([]),/No details recorded for this period/);
});

test("both tables wire every count to its counter, with the new columns",()=>{
  const loader=client.slice(client.indexOf("async function loadAdmin"),client.indexOf("\ndocument.addEventListener"));
  for(const tab of ["crypto","facial","map","darkweb","ip"])assert.ok(loader.includes('adminCountCell(item.'+tab+',item,"tab:'+tab+'")'),tab);
  for(const metric of ["report_generator_requests","deep_search_requests","event_list_searches","blockchain_searches","facial_extractions","facial_searches","darkweb_searches","ip_lookups","quick_ask_requests"]){
    assert.ok(loader.includes("adminCountCell(item."+metric+',item,"'+metric+'")'),metric);
  }
  assert.ok(client.includes("<th>EVENT LIST SEARCH</th>")&&client.includes("<th>DARK WEB SEARCH</th>")&&client.includes("<th>IP LOOKUP</th>"));
  assert.ok(loader.includes('colspan="10"'));
  assert.ok(loader.includes('colspan="6"'));
  assert.ok(!client.includes('<th>SOCIAL</th>')&&!client.includes('SOCIAL MEDIA SEARCH'));
  const opener=client.slice(client.indexOf("async function openUsageHistory"),client.indexOf("function closeAdmin"));
  assert.match(opener,/nativeFetch\(API_BASE\+"\/usage-history"\+query,\{method:"GET",headers:\{"X-Session-Token":token\(\)\}\}\)/);
  assert.ok(opener.includes("adminHistoryHtml(rows)"),"rows are rendered through the escaping helper");
  assert.ok(opener.includes("request!==historyRequest"),"a slow answer for an earlier click never overwrites a newer one");
  assert.ok(opener.includes("const period=adminRenderedPeriod;"),"the details use the period the clicked table was rendered for");
  assert.ok(opener.includes('setAttribute("inert","")'),"the statistics behind the details are inert while it is open");
  assert.ok(opener.includes("if(payload.truncated)"),"a list cut at 500 is not described as counts without details");
  assert.ok(loader.includes("if(request!==adminLoadRequest)return;"),"an older period never overwrites a newer one");
  assert.match(client,/if\(history&&!history\.hidden\)closeUsageHistory\(\);\s*else closeAdmin\(\);/,"Escape closes the details first");
  assert.ok(fs.readFileSync("usage-auth-fix.js","utf8").includes("|usage-history|"));
  assert.ok(css.includes(".admin-count-link{")&&css.includes("#adminHistoryPanel[hidden]{display:none}"));
  assert.ok(!client.includes("not search terms, questions, addresses"),"the admin note no longer promises that searches are not recorded");
});

function eventListHarness(){
  const listeners={},timers=[],sent=[];
  const el=id=>({id,value:"",listeners:{},addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);},fire(type,event={}){for(const fn of this.listeners[type]||[])fn(event);}});
  const input=el("chronologySearch"),country=el("chronologyCountry"),sort=el("chronologySort"),region=el("reportRegion");
  sort.value="newest";
  const filters={region:"GLOBAL",topic:"Attacks",actor_group:"ALL",period_days:7};
  const elements={chronologySearch:input,chronologyCountry:country,chronologySort:sort,reportRegion:region};
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]||null},
    window:{CTAtlasDatabase:{filters:()=>({...filters}),label:()=>"Global · Attacks · last 7 days"}},
    chronologyFilteredEvents:()=>[1,2,3],
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    addEventListener:(type,fn)=>{(listeners[type]||=[]).push(fn);},
    API_BASE:"https://worker.test",user:()=>"group-i-11",token:()=>"tok",console,
    nativeFetch:async(url,options)=>{sent.push({url,body:JSON.parse(options.body),headers:options.headers});return {ok:true};}
  });
  const start=client.indexOf("async function recordUsage");
  const end=client.indexOf("function escapeCell");
  vm.runInContext(client.slice(start,end)+"\nattachEventListTracking();",context);
  return {input,country,region,filters,sent,timers,listeners,runTimers:()=>{while(timers.length)timers.shift()();}};
}

test("the event list records one search per settled query, with its filters, never per keystroke",async()=>{
  const h=eventListHarness();
  for(const value of ["B","Bo","Bok","Boko"]){h.input.value=value;h.input.fire("input");}
  assert.equal(h.sent.length,0,"typing alone sends nothing");
  h.input.fire("keydown",{key:"Enter"});
  await Promise.resolve();
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].url,"https://worker.test/usage-record");
  assert.equal(h.sent[0].headers["X-Session-Token"],"tok");
  const {action,details,username}=h.sent[0].body;
  assert.equal(action,"event_list_search");
  assert.equal(username,"group-i-11");
  assert.deepEqual({...details},{text:"Boko",region:"GLOBAL",topic:"Attacks",actor_group:"ALL",period_days:7,scope:"Global · Attacks · last 7 days",sort:"newest",results:3});
  h.runTimers();h.input.fire("blur");h.input.fire("keydown",{key:"Enter"});
  assert.equal(h.sent.length,1,"the same search is not recorded twice");
  h.country.value="Niger";h.country.fire("change");h.runTimers();
  assert.equal(h.sent.length,2,"changing a filter for the same text is a new search");
  assert.equal(h.sent[1].body.details.country,"Niger");
  h.filters.region="REGION:AFRICA";h.region.fire("change");h.runTimers();
  assert.equal(h.sent.length,3,"a Database filter change for the same text is a new search");
  assert.equal(h.sent[2].body.details.region,"REGION:AFRICA");
  h.input.value="B";h.input.fire("input");h.runTimers();
  assert.equal(h.sent.length,3,"one letter is not a search");
  h.input.value="Boko Haram";h.input.fire("input");
  for(const fn of h.listeners.pagehide||[])fn();
  assert.equal(h.sent.length,4,"a pending search is sent when the page closes");
});
