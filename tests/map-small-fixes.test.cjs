// The smaller findings of the 6 Nov audit, each on the case that was measured.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");

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

test("the event list search waits for a pause: at six months each render blocks 1.2-1.5 s",()=>{
  const listeners={};
  let timers=[],renders=0;
  const input={value:"",addEventListener:(type,fn)=>{listeners[type]=fn;}};
  const c=vm.createContext({document:{getElementById:()=>input},renderChronology(){renders++;},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{timers[id-1]=null;}});
  const start=html.indexOf("const CHRONOLOGY_SEARCH_DELAY_MS");
  const end=html.indexOf('"chronologyCountry"\r\n).addEventListener(',start);
  vm.runInContext(html.slice(start,html.lastIndexOf("document.getElementById(",end))+"var read=()=>chronologySearchText;let chronologySearchText=\"\";",c);
  for(const value of ["B","Bo","Bok","Boko"]){input.value=value;listeners.input.call(input);}
  assert.equal(renders,0,"typing renders nothing");
  const pending=timers.filter(Boolean);
  assert.equal(pending.length,1,"one render waits");
  assert.equal(pending[0].ms,200);
  pending[0].fn();
  assert.equal(renders,1);
  assert.equal(c.read(),"boko","the text itself is never late");
});

test("a javascript: source URL never reaches a link, in popups or report sources",()=>{
  const c=vm.createContext({});
  vm.runInContext(extract("safeHttpUrl"),c);
  assert.equal(c.safeHttpUrl("javascript:alert(1)"),"");
  assert.equal(c.safeHttpUrl("https://example.test/a"),"https://example.test/a");
  const marker=extract("createMarker");
  assert.match(marker,/href="\$\{escapeHtml\(safeHttpUrl\(event\.url\)\)\}"/);
  assert.doesNotMatch(marker,/href="\$\{escapeHtml\(event\.url\)\}"/);
  assert.match(extract("reportSourcesHtml"),/safeHttpUrl\(item\.url\) \? `<a href="\$\{escapeHtml\(safeHttpUrl\(item\.url\)\)\}"/);
});

test("a marker with a bad source URL still gets its popup, without the link",()=>{
  let popup="";
  const c=vm.createContext({
    categoryStyle:{},L:{divIcon:icon=>icon,marker:(position,options)=>({options,bindPopup(text){popup=text;return this;}})},
    escapeHtml:String,eventCategories:()=>["Attacks"],isMapAttackEvent:()=>true,Number,Date,Intl});
  vm.runInContext(formats+extract("safeHttpUrl")+extract("createMarker"),c);
  c.createMarker({latitude:1,longitude:2,title:"x",source:"Paper",url:"javascript:alert(1)",published:"2026-11-05T23:10:00Z"});
  assert.doesNotMatch(popup,/javascript:/);
  assert.match(popup,/06\/11\/2026 Paris/,"23:10 UTC on 5 Nov is the 6th in Paris");
  c.createMarker({latitude:1,longitude:2,title:"x",published:"not a date"});
  assert.doesNotMatch(popup,/Invalid/,"an unreadable date is left out, and does not cost the marker");
});

test("every date on the page is Paris time and says so",()=>{
  const c=vm.createContext({});
  vm.runInContext(formats,c);
  const when=new Date("2026-11-05T23:10:25Z");
  assert.equal(vm.runInContext("EVENT_TIME_FORMAT",c).format(when),"06 Nov 2026, 00:10");
  assert.match(html,/const TICKER_TIME_FORMAT = new Intl\.DateTimeFormat\("en-GB", \{ timeZone: "Europe\/Paris"/);
  assert.match(html,/Executed, attempted and foiled attacks, in Paris time\./);
  assert.match(html,/Attacks over time · 30 days · Paris days/);
  assert.match(extract("renderChronology"),/" · times in Paris time"/);
  assert.match(extract("showDatabaseEventCard"),/EVENT_TIME_FORMAT\.format\(published\) \+ " Paris"/);
  assert.match(extract("applyMapDatabase"),/"Published "\s*\+\s*collectionStatusDate\(/);
});

test("the timeline counts Paris days: a reader in Auckland saw a last bar dated 07 Nov",()=>{
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:"",innerHTML:""});
    return nodes.get(id);
  };
  const now=Date.parse("2026-11-05T22:30:00Z");
  class Clock extends Date { constructor(...args){if(args.length)super(...args);else super(now);} }
  const events=[{published:"2026-11-05T22:50:00Z"},{published:"2026-11-05T23:10:00Z"},{published:"2026-11-05T21:00:00Z"},{published:"2026-11-04T23:30:00Z"},{published:""},{}];
  const c=vm.createContext({Date:Clock,Intl,Map,Math,document:{getElementById:node},allEvents:[],updateHeaderCasualties24(){},
    visibleEventsForPeriod:()=>[],isCurrentCasualtyEvent:()=>false,extractStrict24hDeathCount:()=>0,eventCategories:()=>[]});
  const start=html.indexOf("const PARIS_DAY_FORMAT");
  vm.runInContext(html.slice(start,html.indexOf("function parisCalendarDateString(",start))+
    html.slice(html.indexOf("const TIMELINE_DAY_FORMAT"),html.indexOf("function updateCommandCenterPanels("))+
    ["parisCalendarDateString","shiftCalendarDateString","shiftCalendarDateStringToDate","updateCommandCenterPanels"].map(extract).join("\n"),c);
  c.allEvents=events;
  c.updateCommandCenterPanels();
  const bars=node("timelineBars").innerHTML;
  // 22:30 UTC is 23:30 in Paris, so today is 5 Nov. 23:30 UTC on the 4th was already
  // the 5th there, and 23:10 UTC on the 5th already belongs to the 6th.
  assert.equal(node("timelineTodayLabel").textContent,"Today 3");
  assert.match(bars,/title="05 Nov: 3 attacks"/);
  assert.match(bars,/title="04 Nov: 0 attacks"/);
  assert.doesNotMatch(bars,/06 Nov/);
  assert.equal(node("timelineStartLabel").textContent,"07 Oct");
  assert.equal((bars.match(/class="timeline-bar/g)||[]).length,30);
});

test("heat weighs a capital placeholder less, by the value the data really uses",()=>{
  // 1,785 of 6,381 records are country_capital; the old check on "country" matched none.
  const body=html.slice(html.indexOf("async function exportDatabaseMapJpeg"),html.indexOf("Dots as small DOM markers"));
  assert.match(body,/event\.location_precision === "country_capital" \? 0\.4 : 1/);
  assert.doesNotMatch(body,/location_precision === "country" /);
});

test("the Weekly Analysis is gone from the page, the 24H brief is not",()=>{
  assert.doesNotMatch(html,/weekly/i);
  assert.match(html,/id="headerSituationBrief"/);
  assert.match(html,/trendSummaryData =\s*data\.trend_summary/);
});

test("the page no longer computes a trends panel it never shows, nor offers Key Developments for rating",()=>{
  assert.ok(!html.includes("Top trends"));
  assert.ok(!/\bupdateTrends\b/.test(html));
  assert.ok(!html.includes('id="trendCard"'));
  assert.ok(!html.includes('id="trendList"'));
  assert.ok(!fs.readFileSync("cloudflare-worker/feedback.js","utf8").includes("key_developments"));
});
