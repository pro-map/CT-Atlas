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

const statusBlock=html.slice(html.indexOf("// Update completeness is collection metadata"),html.indexOf("// Written in the header, which every width shows."));

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
  const c=vm.createContext({document,Date,Number,Array,Set,Math,selectedDays:7});
  vm.runInContext(statusBlock+extract("formatTrendGeneratedAt"),c);
  return c;
}
const facts=status=>({collection_status:status,last_updated:status?.published_at});

test("the 5 Nov run reads as stalled even in a file with no health field",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(fiveNovember),"stalled");
  const view=c.dataStateView(facts(fiveNovember),hours(0.5));
  assert.equal(view.level,"bad");
  assert.equal(view.text,"UPDATE STALLED");
  assert.match(view.detail,/Latest update partial/);
  assert.match(view.detail,/AI service temporarily unavailable/);
});

test("a normal run is not flagged: partial is the everyday state, and the backlog does not count",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(goodRun),"ok");
  const view=c.dataStateView(facts(goodRun),hours(0.5));
  assert.equal(view.level,"ok");
  assert.equal(view.text,"UPDATE OK");
});

// As tools/finalize_daily_status.py writes it: state is healthy, degraded or starved.
const health=state=>({state,reasons:[],events_published_last_24h:140,events_published_median_14d:130,new_reviews:800,recent_pending:500,review_share:0.615});

test("the pipeline's health state wins, and a value it adds later is ignored",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth({...fiveNovember,health:health("healthy")}),"ok");
  assert.equal(c.collectionHealth({...goodRun,health:health("degraded")}),"behind");
  assert.equal(c.collectionHealth({...goodRun,health:health("starved")}),"stalled");
  assert.equal(c.collectionHealth({...goodRun,health:health("unheard-of")}),"ok","falls back to the counters");
  assert.equal(c.collectionHealth({...goodRun,health:{}}),"ok");
  assert.equal(c.dataStateView(facts({...goodRun,health:health("degraded")}),hours(0.5)).text,"UPDATE BEHIND");
  assert.equal(c.dataStateView(facts({...goodRun,health:health("starved")}),hours(0.5)).text,"UPDATE STALLED");
  assert.equal(c.dataStateView(facts({...fiveNovember,health:health("healthy")}),hours(0.5)).text,"UPDATE OK");
});

test("a failed collection says so, although the pipeline calls it starved too",()=>{
  const c=statusContext();
  assert.equal(c.dataStateView(facts({...goodRun,status:"failed",health:health("starved")}),hours(0.5)).text,"UPDATE FAILED");
});

test("a file without health or counters stays neutral, never green",()=>{
  const c=statusContext();
  assert.equal(c.collectionHealth(undefined),"");
  assert.equal(c.collectionHealth({status:"partial",recent:{candidates:50,reviewed:30,pending:20}}),"");
  assert.equal(c.collectionHealth({status:"failed"}),"failed");
  const partial=c.dataStateView(facts({status:"partial",published_at:fiveNovember.published_at,recent:{candidates:50,reviewed:30,pending:20},backlog:{pending:0}}),hours(0.5));
  assert.deepEqual([partial.level,partial.text],["neutral","UPDATE PARTIAL"]);
  const none=c.dataStateView({last_updated:fiveNovember.published_at},hours(0.5));
  assert.deepEqual([none.level,none.text],["neutral","STATUS NOT REPORTED"]);
  const nothing=c.dataStateView(null,hours(0.5));
  assert.deepEqual([nothing.level,nothing.text],["neutral","STATUS NOT REPORTED"]);
});

test("the badge warns after one missed run, and says how old the data is",()=>{
  const c=statusContext();
  const end=" · DATA TO 06 NOV, 00:10 PARIS";
  assert.equal(c.dataStateView(facts(goodRun),hours(18.7),7).level,"ok","the measured overnight gap is a normal day");
  assert.equal(c.dataStateView(facts(goodRun),hours(19.9),7).text,"UPDATE OK · 19 H OLD"+end);
  const missed=c.dataStateView(facts(goodRun),hours(20),7);
  assert.deepEqual([missed.level,missed.text],["warn","NO UPDATE FOR 20 H"+end]);
  assert.deepEqual((({level,text})=>[level,text])(c.dataStateView(facts(goodRun),hours(84),7)),["bad","NO UPDATE FOR 3 DAYS"+end]);
  assert.equal(c.dataStateView(facts(fiveNovember),hours(21),7).text,"UPDATE STALLED · 21 H OLD"+end);
  assert.equal(c.dataStateView(facts(fiveNovember),hours(84),7).text,"UPDATE STALLED · 3 DAYS OLD"+end);
});

test("the badge says where the data ends as soon as it stops being current, on every period",()=>{
  const c=statusContext();
  assert.equal(c.dataStateView(facts(goodRun),hours(0.5),1).text,"UPDATE OK");
  for(const days of [1,7,30])assert.equal(c.dataStateView(facts(goodRun),hours(8),days).text,"UPDATE OK · 8 H OLD · DATA TO 06 NOV, 00:10 PARIS");
  const partial=c.dataStateView({collection_status:{status:"partial",published_at:fiveNovember.published_at,recent:{candidates:50,reviewed:30,pending:20},backlog:{pending:0}}},hours(8),7);
  assert.equal(partial.text,"UPDATE PARTIAL · 8 H OLD · DATA TO 06 NOV, 00:10 PARIS");
  assert.equal(c.dataStateView(null,hours(8),7).text,"STATUS NOT REPORTED","no date, nothing to say about it");
});

test("a period the data no longer reaches reads as no data, not as a quiet world",()=>{
  // Measured: 3.5 days after publication the 24H view read as a quiet world.
  const c=statusContext();
  assert.equal(c.dataStateView(facts(goodRun),hours(84),1).text,"NO UPDATE FOR 3 DAYS · NO DATA SINCE 06 NOV, 00:10 PARIS");
  assert.equal(c.dataStateView(facts(goodRun),hours(84),7).text,"NO UPDATE FOR 3 DAYS · DATA TO 06 NOV, 00:10 PARIS","the data still reaches into 7 days");
  assert.equal(c.dataStateView(facts(goodRun),hours(23.9),1).text,"NO UPDATE FOR 23 H · DATA TO 06 NOV, 00:10 PARIS");
  assert.equal(c.dataStateView(facts(goodRun),hours(24.1),1).text,"NO UPDATE FOR 24 H · NO DATA SINCE 06 NOV, 00:10 PARIS");
  assert.equal(c.dataStateView(facts(fiveNovember),hours(84),1).text,"UPDATE STALLED · 3 DAYS OLD · NO DATA SINCE 06 NOV, 00:10 PARIS");
});

test("the badge reads the period the map is showing",()=>{
  const nodes=new Map([["dataStateBadge",{hidden:true,dataset:{}}]]);
  const c=statusContext({getElementById:id=>nodes.get(id)||null});
  c.Date=class extends Date { static now(){return hours(84);} };
  vm.runInContext("mapDataFacts = "+JSON.stringify(facts(goodRun))+"; selectedDays = 1;",c);
  c.renderDataStateBadge();
  assert.match(nodes.get("dataStateBadge").textContent,/NO DATA SINCE/);
  vm.runInContext("selectedDays = 7;",c);
  c.renderDataStateBadge();
  assert.match(nodes.get("dataStateBadge").textContent,/ DATA TO /);
});

test("age is taken from the collection, not from a repair that moved last_updated",()=>{
  const c=statusContext();
  assert.equal(c.dataPublishedTime({collection_status:{published_at:fiveNovember.published_at},last_updated:"2026-11-07T00:00:00Z"}),published);
  assert.equal(c.dataPublishedTime({last_updated:fiveNovember.published_at}),published);
  assert.equal(c.dataPublishedTime({}),null);
  assert.equal(c.dataPublishedTime(null),null);
});

test("a repair moves neither the badge nor the age: 6 Nov read DATA TO 20:42 for a collection of 18:39",()=>{
  const collection=Date.parse("2026-11-06T17:39:56Z"),repair="2026-11-06T19:42:31.840026+00:00";
  const collected={collection_status:{...goodRun,published_at:new Date(collection).toISOString()},last_updated:new Date(collection).toISOString()};
  // As tools/repair_map_evidence.py writes it: a new version, the collection's date untouched.
  const repaired={last_updated:repair,collection_status:{...collected.collection_status,
    data_maintenance:{kind:"reviewed_map_evidence_repair",applied_at:repair,changed_records:7,removed_records:0,new_records:0,ai_calls:0}}};
  const c=statusContext();
  const shown=(document,now)=>(({level,text,detail})=>({level,text,detail}))(c.dataStateView(document,now,1));
  for(const [elapsed,text] of [[3,"UPDATE OK · 3 H OLD · DATA TO 06 NOV, 18:39 PARIS"],[19,"UPDATE OK · 19 H OLD · DATA TO 06 NOV, 18:39 PARIS"],
    [20,"NO UPDATE FOR 20 H · DATA TO 06 NOV, 18:39 PARIS"],[25,"NO UPDATE FOR 25 H · NO DATA SINCE 06 NOV, 18:39 PARIS"]]){
    const now=collection+elapsed*3600000;
    assert.equal(shown(repaired,now).text,text);
    assert.deepEqual(shown(repaired,now),shown(collected,now));
  }
  assert.equal(c.dataPublishedTime(repaired),collection,"the header date, the 24H window and the period dashes all read this");
  assert.equal(c.collectionStatusView(repaired).published,"06 Nov 2026, 18:39 Paris");
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
  assert.ok(html.indexOf('id="dataStateBadge"')<html.indexOf('id="sessionCheckNote"'));
  assert.doesNotMatch(html.slice(html.indexOf("#dataStateBadge {"),html.indexOf("#dataStateBadge[hidden]")),/display: none/);
});

test("the badge's two lines fit the header, so its text costs the map no height",()=>{
  // Measured at 1000-1920 px: at 118 px wide it took three lines and the header grew by 16.
  const css=html.replace(/\r\n/g,"\n");
  assert.match(css,/#updated \{\n    order: 3 !important;\n    flex-basis: 172px !important;/);
  assert.match(css,/@media \(max-width: 1250px\) \{[\s\S]{0,400}#updated \{\n        flex-basis: 160px !important;/);
});

test("the header casualty counter stays removed",()=>{
  // Removed on 17 Nov at the owner's request: read from article text, it gave
  // 3 killed for 15 Nov while that day's records described dozens of deaths.
  assert.doesNotMatch(html,/headerCasualties24|updateHeaderCasualties24|extractStrict24h/);
});

test("the 24h button says where the data ends, and a period it no longer reaches shows a dash",()=>{
  assert.match(extract("updateFacetCounts"),/Rolling 24 hours from now; the data ends/);
  assert.match(extract("updateFacetCounts"),/count === 0 && mapDataOlderThan\(days\)\s*\?\s*"—"/);
});

test("the badge follows the data age on the minute tick and the period on every redraw",()=>{
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
