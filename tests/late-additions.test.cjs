// An incident that reaches CT Atlas after its article is a day old still shows in the
// periods of the day it arrived (owner's request of 2026-11-26). From 12 to 26 Nov 2026,
// 141 of the 607 attacks added to the map (23%) arrived with an article already more
// than 24 hours old, and the "last 24 hours" view, keyed on the article alone, never
// showed them. See also tests/late_additions_test.py for the collector side.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {pathToFileURL}=require("node:url");

const html=fs.readFileSync("index.html","utf8").replace(/\r\n/g,"\n");

function extract(name){
  const start=html.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  let depth=0,i=html.indexOf("{",start);
  for(;i<html.length;i++){
    if(html[i]==="{")depth++;
    else if(html[i]==="}"&&--depth===0)break;
  }
  return html.slice(start,i+1);
}
const formats=html.slice(html.indexOf("const POPUP_DATE_FORMAT"),html.indexOf("function createMarker("));
const hour=3600000, day=24*hour;

function page(now){
  class Clock extends Date {
    constructor(...args){ super(...(args.length ? args : [now])); }
    static now(){ return now; }
  }
  const c=vm.createContext({Date:Clock,Intl,Number,String});
  vm.runInContext(formats+extract("withinDays")+extract("inPeriod")+extract("addedLateText"),c);
  return c;
}
const at=ms=>new Date(ms).toISOString();

test("a late arrival is in the last 24 hours for a whole day after it reaches CT Atlas",()=>{
  const now=Date.parse("2026-11-26T10:00:00Z");
  const c=page(now);
  const late={published:at(now-2*day),added_at:at(now-3*hour)};
  assert.equal(c.inPeriod(late,1),true,"article of two days ago, added this morning");
  assert.equal(c.inPeriod({...late,added_at:at(now-25*hour)},1),false,"arrived more than a day ago");
  assert.equal(c.inPeriod({...late,added_at:at(now-25*hour)},7),true,"still in the 7 days by its article");
  assert.equal(c.inPeriod({published:at(now-3*hour)},1),true,"no added_at: the article decides, as before");
  assert.equal(c.inPeriod({published:at(now-2*day)},1),false);
  assert.equal(c.inPeriod({},1),false);
  assert.equal(c.inPeriod({published:"not a date",added_at:at(now-hour)},1),true);
});

test("the event says when it reached CT Atlas only when its article is more than a day older",()=>{
  const c=page(Date.parse("2026-11-26T10:00:00Z"));
  assert.equal(c.addedLateText({published:"2026-11-24T08:00:00Z",added_at:"2026-11-26T05:31:12Z"}),
    "Added to CT Atlas 26 Nov 2026, 06:31 Paris");
  assert.equal(c.addedLateText({published:"2026-11-26T04:00:00Z",added_at:"2026-11-26T05:31:12Z"}),"","same-day arrival");
  assert.equal(c.addedLateText({published:"2026-11-24T08:00:00Z"}),"","collected before the field existed");
  assert.equal(c.addedLateText({added_at:"2026-11-26T05:31:12Z"}),"");
});

test("every period check of the map uses the same rule",()=>{
  assert.doesNotMatch(html,/withinDays\(\s*event\.published/,"no article-only period check is left");
  const uses=html.match(/(?<!function )inPeriod\(event, (?:selectedDays|days)\)/g)||[];
  assert.equal(uses.length,7,"map scope, filtered events, heat, analytics, two button counts, the card note");
});

test("the popup, the Database list and the Database card show the arrival note",()=>{
  assert.match(extract("createMarker"),/addedLateText\(event\) \? `<div class="popup-added-late">\$\{escapeHtml\(addedLateText\(event\)\)\}<\/div>` : ""/);
  assert.match(html,/addedCell\.className = "chronology-added-late";\n\s*addedCell\.textContent = addedLate;/);
  assert.match(extract("showDatabaseEventCard"),/addedLateText\(event\) \? `<div class="database-event-added-late">/);
  assert.match(html,/\.popup-added-late, \.chronology-added-late, \.database-event-added-late \{/);
  const popup={html:""};
  const c=vm.createContext({
    categoryStyle:{},L:{divIcon:icon=>icon,marker:()=>({bindPopup(text){popup.html=text;return this;},on(){return this;}})},
    escapeHtml:String,eventCategories:()=>["Attacks"],isMapAttackEvent:()=>true,safeHttpUrl:()=>"",Number,Date,Intl});
  vm.runInContext(formats+extract("addedLateText")+extract("createMarker"),c);
  c.createMarker({latitude:1,longitude:2,title:"x",published:"2026-11-24T08:00:00Z",added_at:"2026-11-26T05:31:12Z"});
  assert.match(popup.html,/<div class="popup-added-late">Added to CT Atlas 26 Nov 2026, 06:31 Paris<\/div>/);
  c.createMarker({latitude:1,longitude:2,title:"x",published:"2026-11-26T05:00:00Z",added_at:"2026-11-26T05:31:12Z"});
  assert.doesNotMatch(popup.html,/popup-added-late/);
});

test("the Database panel counts a late arrival in its period too, and its rows carry the date",async()=>{
  const shared=await import(pathToFileURL(path.resolve("cloudflare-worker/shared.js")).href);
  const query=await import(pathToFileURL(path.resolve("cloudflare-worker/database-query.js")).href);
  const now=new Date("2026-11-26T10:00:00Z");
  const filters=shared.parseDatabaseFilters({period_days:1});
  const late={id:"a",title:"Attack",categories:["Attacks"],published:"2026-11-24T08:00:00Z",added_at:"2026-11-26T05:31:12Z"};
  assert.equal(shared.matchesDatabaseFilters(late,filters,now),true);
  assert.equal(shared.matchesDatabaseFilters({...late,added_at:undefined},filters,now),false,"article only, as before");
  assert.equal(shared.matchesDatabaseFilters({...late,added_at:"2026-11-27T05:00:00Z"},filters,now),false,"not in the future");
  assert.equal(shared.matchesDatabaseFilters({...late,added_at:"garbage"},filters,now),false);
  assert.equal(shared.matchesDatabaseFilters(late,shared.parseDatabaseFilters({}),now),true,"no period");
  assert.equal(query.databaseEventRow(late,0).added_at,"2026-11-26T05:31:12Z");
  assert.equal(query.databaseEventRow({...late,added_at:undefined},0).added_at,"");
});

test("the page loads the changed Database module, not a cached one",()=>{
  assert.match(html,/const DATABASE_QUERY_MODULE = "\.\/cloudflare-worker\/database-query\.js\?v=20261126";/);
});
