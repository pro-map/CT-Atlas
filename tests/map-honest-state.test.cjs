// The silent failure of 5 Nov: the run left 2,616 of 4,194 recent candidates
// unreviewed, published 7 records against about 140, and the page said nothing. Its
// only trace was a 7.2 px date; the status card is hidden. After 3.5 days without
// data the 24H view read 'No attack reported in this period' and 0/0/0/0 under
// FULL DAY.
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

const statusBlock=html.slice(html.indexOf("// Update completeness is collection metadata"),html.indexOf("// Written where it shows: in the header and the ticker."));

// The live collection status of 5 Nov 23:10 UTC, trimmed to the fields in play.
const fiveNovember={
  status:"partial",run_started_at:"2026-11-05T22:40:38.730513+00:00",last_attempt_at:"2026-11-05T22:40:38.730513+00:00",
  published_at:"2026-11-05T23:10:25.362007+00:00",finalized_at:"2026-11-05T23:11:04.833230+00:00",
  recent:{candidates:4194,reviewed:1578,new_reviews:0,pending:2616},backlog:{pending:1612},maintenance:{pending:0},
  source:{errors:0,status:"complete"},geolocation:{status:"complete",pending:0,completed_unlocated:199,review_required:125},
  reasons:["transient_error","historical_budget","recent_pending","backlog_pending","category_pending","geolocation_review_required"],
  collect_outcome:"success"
};
// A normal run of the same shape: 800 reviewed, a queue left over.
const goodRun={...fiveNovember,recent:{candidates:2000,reviewed:1500,new_reviews:800,pending:500}};
const published=Date.parse(fiveNovember.published_at);
const hours=count=>published+count*3600000;

function statusContext(document={getElementById:()=>null}){
  const c=vm.createContext({document,Date,Number,Array,Set,Math});
  vm.runInContext(statusBlock,c);
  return c;
}
const facts=status=>({collection_status:status,last_updated:status?.published_at});

test("the 5 Nov run reads as stalled even in a file with no health field",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(fiveNovember),"stalled");
  const view=c.dataStateView(facts(fiveNovember),hours(1));
  assert.equal(view.level,"bad");
  assert.equal(view.text,"UPDATE STALLED");
  assert.match(view.detail,/Latest update partial/);
  assert.match(view.detail,/AI service temporarily unavailable/);
});

test("a normal run is not flagged: partial is the everyday state, and the backlog does not count",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(goodRun),"ok");
  const view=c.dataStateView(facts(goodRun),hours(1));
  assert.equal(view.level,"ok");
  assert.equal(view.text,"UPDATE OK");
});

test("the pipeline's health field wins, in either shape, and a value it adds later is ignored",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth({...goodRun,health:"behind"}),"behind");
  assert.equal(c.collectionHealth({...fiveNovember,health:"ok"}),"ok");
  assert.equal(c.collectionHealth({...goodRun,health:{state:"stalled",last_ok_at:"2026-11-04T18:00:00Z"}}),"stalled");
  assert.equal(c.collectionHealth({...goodRun,health:"unheard-of"}),"ok","falls back to the counters");
  assert.equal(c.dataStateView(facts({...goodRun,health:"behind"}),hours(1)).text,"UPDATE BEHIND");
  assert.equal(c.dataStateView(facts({...goodRun,health:"failed"}),hours(1)).text,"UPDATE FAILED");
});

test("a file without health or counters stays neutral, never green",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(undefined),"");
  assert.equal(c.collectionHealth({status:"partial",recent:{candidates:50,reviewed:30,pending:20}}),"");
  assert.equal(c.collectionHealth({status:"failed"}),"failed");
  const partial=c.dataStateView(facts({status:"partial",published_at:fiveNovember.published_at,recent:{candidates:50,reviewed:30,pending:20},backlog:{pending:0}}),hours(1));
  assert.deepEqual([partial.level,partial.text],["neutral","UPDATE PARTIAL"]);
  const none=c.dataStateView({last_updated:fiveNovember.published_at},hours(1));
  assert.deepEqual([none.level,none.text],["neutral","STATUS NOT REPORTED"]);
  const nothing=c.dataStateView(null,hours(1));
  assert.deepEqual([nothing.level,nothing.text],["neutral","STATUS NOT REPORTED"]);
});

test("the badge warns after one missed run, and says how old the data is",()=>{
  const c=statusContext();
  assert.equal(c.dataStateView(facts(goodRun),hours(13.9)).text,"UPDATE OK");
  const missed=c.dataStateView(facts(goodRun),hours(14));
  assert.deepEqual([missed.level,missed.text],["warn","NO UPDATE FOR 14 H"]);
  assert.deepEqual((({level,text})=>[level,text])(c.dataStateView(facts(goodRun),hours(84))),["bad","NO UPDATE FOR 3 DAYS"]);
  assert.equal(c.dataStateView(facts(fiveNovember),hours(15)).text,"UPDATE STALLED · 15 H OLD");
  assert.equal(c.dataStateView(facts(fiveNovember),hours(84)).text,"UPDATE STALLED · 3 DAYS OLD");
});

test("age is taken from the publication, not from a status refresh that moved last_updated",()=>{
  const c=statusContext();
  assert.equal(c.dataPublishedTime({collection_status:{published_at:fiveNovember.published_at},last_updated:"2026-11-07T00:00:00Z"}),published);
  assert.equal(c.dataPublishedTime({last_updated:fiveNovember.published_at}),published);
  assert.equal(c.dataPublishedTime({}),null);
  assert.equal(c.dataPublishedTime(null),null);
});

test("the badge is real text on the page, next to the Published date, and reaches the Health panel",()=>{
  const nodes=new Map([["dataStateBadge",{hidden:true,dataset:{}}],["healthDataState",{textContent:""}]]);
  const c=statusContext({getElementById:id=>nodes.get(id)||null});
  vm.runInContext("mapDataFacts = "+JSON.stringify(facts(fiveNovember)),c);
  c.renderDataStateBadge();
  const badge=nodes.get("dataStateBadge");
  assert.equal(badge.hidden,false);
  assert.equal(badge.dataset.state,"bad");
  assert.match(badge.textContent,/^UPDATE STALLED/);
  assert.equal(nodes.get("healthDataState").textContent,badge.textContent);
  assert.ok(html.indexOf('id="lastUpdated"')<html.indexOf('id="dataStateBadge"'));
  assert.ok(html.indexOf('id="dataStateBadge"')<html.indexOf('id="headerCasualties24"'));
  assert.doesNotMatch(html.slice(html.indexOf("#dataStateBadge {"),html.indexOf("#dataStateBadge[hidden]")),/display: none/);
});

function headerContext(now){
  class Clock extends Date { constructor(...args){if(args.length)super(...args);else super(now);} static now(){return now;} }
  const c=vm.createContext({document:{getElementById:()=>null},Date:Clock,Intl,Map,Number,Array,Set,Math});
  vm.runInContext(statusBlock+html.slice(html.indexOf("const PARIS_DAY_FORMAT"),html.indexOf("function parisCalendarDateString("))+
    html.slice(html.indexOf("let parisYesterdayMinute"),html.indexOf("function parisYesterdayDateString("))+
    ["parisCalendarDateString","shiftCalendarDateString","parisYesterdayDateString","headerCasualtyDayState","parisCasualtyWindowLabel","shiftCalendarDateStringToDate"].map(extract).join("\n"),c);
  return c;
}
const dayState=(status,nowIso)=>{
  const c=headerContext(Date.parse(nowIso));
  return c.headerCasualtyDayState(facts(status),c.parisYesterdayDateString());
};

test("the header's day is finished only by a healthy run that started after it ended",()=>{
  const lateRun={...goodRun,run_started_at:"2026-11-06T12:30:00Z",last_attempt_at:"2026-11-06T12:30:00Z",published_at:"2026-11-06T13:00:00Z"};
  assert.equal(dayState(lateRun,"2026-11-06T14:00:00Z"),"finished");
  // The run of 23:40 Paris started before 5 Nov ended, whatever time it published.
  assert.equal(dayState(goodRun,"2026-11-06T09:00:00Z"),"incomplete");
  assert.equal(dayState({...lateRun,recent:fiveNovember.recent},"2026-11-06T14:00:00Z"),"incomplete","a later run that reviewed nothing");
  assert.equal(dayState({...lateRun,status:"failed"},"2026-11-06T14:00:00Z"),"incomplete");
  assert.equal(dayState({...lateRun,health:"behind"},"2026-11-06T14:00:00Z"),"incomplete");
  assert.equal(dayState(goodRun,"2026-11-08T09:00:00Z"),"missing","no run at all on 7 Nov");
});

test("an unfinished day never says FULL DAY",()=>{
  const c=headerContext(Date.parse("2026-11-06T09:00:00Z"));
  assert.equal(c.parisCasualtyWindowLabel("finished"),"NOV 5, 2026 · FULL DAY (PARIS)");
  assert.equal(c.parisCasualtyWindowLabel("incomplete"),"NOV 5, 2026 · INCOMPLETE (PARIS)");
  assert.equal(c.parisCasualtyWindowLabel("missing"),"NOV 5, 2026 · NO DATA (PARIS)");
  const markup=html.slice(html.indexOf('id="headerCasualtiesWindow"'),html.indexOf('id="headerVictimsDeaths24"'));
  assert.doesNotMatch(markup,/FULL DAY/,"not before anything is known");
  const title=html.slice(html.indexOf('id="headerCasualties24" title="'),html.indexOf('id="headerCasualtiesWindow"'));
  assert.doesNotMatch(title,/Event date is preferred/,"0 of 6,381 records have an event date");
  assert.match(title,/by publication date/);
});

function renderHeader(events,state){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:""});return nodes.get(id);};
  const c=vm.createContext({document:{getElementById:node},allEvents:events,recentContextEvents:[],mapDataFacts:null,
    isCurrentCasualtyEvent:()=>true,eventCategories:event=>event.categories,parisYesterdayDateString:()=>"2026-11-05",
    headerCasualtyDayState:()=>state,parisCasualtyWindowLabel:value=>value,
    extractStrict24hCasualtyBreakdown:(event,kind)=>kind==="death"?{terrorist:0,victim:event.killed||0}:{terrorist:0,victim:0},
    extractStrict24hCapturedCount:()=>0});
  vm.runInContext(extract("updateHeaderCasualties24"),c);
  c.updateHeaderCasualties24();
  return id=>node(id).textContent;
}

test("a day the collection did not finish shows a dash, not 0; figures already read stay as a floor",()=>{
  const read=renderHeader([{categories:["Attacks"],killed:1}],"incomplete");
  assert.equal(read("headerVictimsDeaths24"),"1");
  assert.equal(read("headerVictimsWounded24"),"—");
  assert.equal(read("headerTerroristsDeaths24"),"—");
  assert.equal(read("headerTerroristsCaptured24"),"—");
  assert.equal(read("headerCasualtiesWindow"),"incomplete");
  const finished=renderHeader([],"finished");
  assert.equal(finished("headerVictimsDeaths24"),"0","a finished quiet day is a real zero");
});

function tickerContext(status,nowMs,selectedDays){
  const c=vm.createContext({Date:{now:()=>nowMs,parse:Date.parse},Intl,Number,selectedDays,collectionStatusDate:value=>"DATE("+new Date(value).toISOString()+")",
    formatTrendGeneratedAt:()=>"06 Nov, 00:10",mapDataFacts:facts(status)});
  vm.runInContext(extract("dataPublishedTime")+extract("mapDataOlderThan")+"const MAP_WINDOW_NOTE_MS = 60 * 60 * 1000;"+extract("attackTickerTitle")+extract("attackTickerEmptyText"),c);
  return c;
}

test("older data than the window says so instead of 'No attack reported'",()=>{
  // Measured: 3.5 days after publication the 24H view read as a quiet world.
  const stale=tickerContext(goodRun,hours(84),1);
  assert.equal(stale.attackTickerEmptyText(),"No data published since DATE(2026-11-05T23:10:25.362Z).");
  const week=tickerContext(goodRun,hours(84),7);
  assert.equal(week.attackTickerEmptyText(),"No attack reported in this period.","the data still reaches into 7 days");
  const fresh=tickerContext(goodRun,hours(2),1);
  assert.equal(fresh.attackTickerEmptyText(),"No attack reported in this period.");
});

test("24h figures say where the data ends once it stops being current",()=>{
  assert.equal(tickerContext(goodRun,hours(0.5),1).attackTickerTitle(),"ATTACKS · LAST 24H");
  assert.equal(tickerContext(goodRun,hours(8),1).attackTickerTitle(),"ATTACKS · LAST 24H · DATA TO 06 NOV, 00:10 PARIS");
  assert.equal(tickerContext(goodRun,hours(8),7).attackTickerTitle(),"ATTACKS · LAST 7 DAYS");
  assert.match(extract("updateFacetCounts"),/Rolling 24 hours from now; the data ends/);
});

test("a period the data no longer reaches shows a dash on its button and in the ticker count",()=>{
  assert.match(extract("updateFacetCounts"),/count === 0 && mapDataOlderThan\(days\)\s*\?\s*"—"/);
  assert.match(extract("renderAttackTicker"),/!events\.length && mapDataOlderThan\(selectedDays\) \? "—"/);
});

test("the ticker's title follows the data age on the minute tick, without waiting for the list to change",()=>{
  assert.match(extract("refreshTimeSensitiveDashboard"),/tickerTitle\.textContent !== attackTickerTitle\(\)/);
  assert.match(extract("refreshTimeSensitiveDashboard"),/renderDataStateBadge\(\);/);
  assert.match(extract("refreshDashboard"),/renderDataStateBadge\(\);/);
});

function briefContext(brief){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:""});return nodes.get(id);};
  const c=vm.createContext({document:{getElementById:node},Date,Number,trendSummaryData:brief,SITUATION_BRIEF_LOW_EVENTS:30});
  vm.runInContext(extract("formatTrendGeneratedAt")+extract("situationBriefTitle")+extract("renderHeaderSituationBrief"),c);
  c.renderHeaderSituationBrief();
  return {title:node("headerSituationTitle").textContent,text:node("headerSituationText").textContent};
}

test("the brief carries its date, and says when it rests on few events (8 instead of about 80 on 5 Nov)",()=>{
  const ok=briefContext({status:"ok",overview:"Recent developments include...",generated_at:"2026-11-05T23:09:58Z",candidate_events:80});
  assert.equal(ok.title,"SITUATION 24H · AS OF 06 NOV, 00:09 PARIS");
  assert.equal(ok.text,"Recent developments include...");
  const thin=briefContext({status:"ok",overview:"Recent developments include...",generated_at:"2026-11-05T23:09:58Z",candidate_events:8});
  assert.equal(thin.title,"SITUATION 24H · AS OF 06 NOV, 00:09 PARIS · ONLY 8 EVENTS REVIEWED");
});

test("a failed brief promises nothing the page cannot show, and an empty one is no all-clear",()=>{
  const fallback=briefContext({status:"fallback",overview:"AI trend synthesis was unavailable for this update. The highest-relevance CT events reported or updated in the last 24 hours are shown below without additional analytical synthesis.",
    generated_at:"2026-11-05T18:00:00Z",candidate_events:40});
  assert.doesNotMatch(fallback.text,/shown below/);
  assert.match(fallback.text,/AI brief was unavailable/);
  const empty=briefContext({status:"ok",overview:"No significant CT developments were available for the 24-hour trend brief at the time of this update.",
    generated_at:"2026-11-05T18:00:00Z",candidate_events:0});
  assert.doesNotMatch(empty.text,/No significant/);
  assert.match(empty.text,/does not mean that nothing happened/);
  assert.equal(briefContext(null).title,"SITUATION 24H");
});
