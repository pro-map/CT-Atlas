const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf('// Update completeness is collection metadata');
const end=html.indexOf('loadMapDatabase()\r\n\r\n.then(',start);
assert.ok(start>=0&&end>start,'collection status helpers are present');
const source=html.slice(start,end);
function context(document={getElementById:()=>null}) {
    const context=vm.createContext({document,Date,Number,Array,Set});
    vm.runInContext(source,context);
    return context;
}
function plain(value){return JSON.parse(JSON.stringify(value));}
function status(overrides={}) {
    return {
        status:'complete',last_attempt_at:'2026-10-14T08:21:00Z',published_at:'2026-10-14T08:22:00Z',
        recent:{candidates:50,reviewed:50,pending:0,window_start:'2026-10-11T00:00:00Z',window_end:'2026-10-14T08:21:00Z'},
        backlog:{pending:0},reasons:[],...overrides
    };
}

test('a partial run separates recent candidates from the older backlog',()=>{
    const c=context();
    const view=plain(c.collectionStatusView({collection_status:status({status:'partial',recent:{candidates:80,reviewed:30,pending:50},backlog:{pending:459},reasons:['selection_budget','recent_pending','backlog_pending']})}));
    assert.equal(view.state,'partial');
    assert.equal(view.title,'Latest update partial');
    assert.match(view.counts,/Recent candidates: 30 \/ 80 reviewed/);
    assert.match(view.counts,/50 recent pending/);
    assert.match(view.counts,/Earlier backlog: 459 pending/);
    assert.match(view.reasons,/Review allowance reached/);
});

test('recent completion does not hide a remaining earlier backlog',()=>{
    const c=context();
    const view=c.collectionStatusView({collection_status:status({status:'partial',backlog:{pending:459},reasons:['backlog_pending']})});
    assert.equal(view.state,'partial');
    assert.equal(view.recentPending,'0');
    assert.match(view.counts,/50 \/ 50 reviewed/);
    assert.match(view.counts,/Earlier backlog: 459 pending/);
});

test('complete requires explicit consistent counters and no incomplete sources or lanes',()=>{
    const c=context();
    assert.equal(c.collectionStatusView({collection_status:status()}).state,'complete');
    assert.equal(c.collectionStatusView({collection_status:status({backlog:{pending:8}})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({recent:{candidates:50,reviewed:30,pending:20}})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({source:{errors:[{source:'GDELT',status:429}]}})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({categories:[{category:'Radiological/Nuclear',status:'partial',candidates:500,reviewed:41,pending:459}]})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({recent:{candidates:50,reviewed:20,pending:0}})}).state,'unknown');
    assert.equal(c.collectionStatusView({collection_status:status({recent:{}})}).state,'unknown');
    assert.equal(c.collectionStatusView({collection_status:status({backlog:{}})}).state,'unknown');
});

test('old snapshots and invalid metadata never imply a completed update',()=>{
    const c=context();
    const view=c.collectionStatusView({last_updated:'2026-10-14T08:20:00Z'});
    assert.equal(view.state,'unknown');
    assert.equal(view.title,'Update completeness not reported');
    assert.equal(view.reviewed,'Not reported');
    assert.match(view.published,/14 Oct 2026/);
    assert.equal(view.attempt,'Not reported');
    for(const value of [null,undefined,-1,NaN,Infinity,'0']) assert.equal(c.collectionStatusCount(value),null);
    assert.equal(c.collectionStatusDate('invalid'),'Not reported');
    assert.equal(c.collectionStatusView({collection_status:{status:'complete',recent:{candidates:0,reviewed:0,pending:0},backlog:{pending:null}}}).state,'unknown');
});

test('attempt and publication dates are separate and explicitly shown in Paris time',()=>{
    const c=context();
    const view=c.collectionStatusView({collection_status:status()});
    assert.match(view.attempt,/10:21 Paris$/);
    assert.match(view.published,/10:22 Paris$/);
    assert.match(view.window,/Recent window:.*11 Oct 2026.*14 Oct 2026/);
    assert.match(html,/"Published "/);
});

test('failed runs and source issues remain visible even without pending articles',()=>{
    const c=context();
    const failed=c.collectionStatusView({collection_status:status({status:'failed',reasons:['provider_rate_limit']})});
    assert.equal(failed.title,'Latest update failed');
    assert.match(failed.reasons,/AI service rate limit/);
    const partial=c.collectionStatusView({collection_status:status({status:'partial',reasons:['source_errors']})});
    assert.equal(partial.title,'Latest update partial');
    assert.match(partial.reasons,/Some news searches were incomplete/);
});

test('status uses already loaded data and renders supplied text without HTML injection',()=>{
    const nodes=new Map();
    for(const id of ['collectionStatus','collectionStatusTitle','collectionStatusCounts','collectionStatusAttempt','collectionStatusPublished','collectionStatusWindow','collectionStatusReasons','healthUpdateStatus','healthRecentReviewed','healthRecentPending','healthBacklogPending','healthUpdateAttempt','healthUpdatePublished','healthUpdateReasons','collectionStatusCategories']) {
        nodes.set(id,{textContent:'',dataset:{},children:[],replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}});
    }
    const document={getElementById:id=>nodes.get(id),createElement:tag=>({tag,textContent:''})};
    const c=context(document);
    c.renderCollectionStatus({collection_status:status({status:'partial',categories:[{category:'<img src=x onerror=alert(1)>',status:'partial',candidates:3,reviewed:1,pending:2}]})});
    assert.equal(nodes.get('collectionStatus').dataset.state,'partial');
    assert.equal(nodes.get('healthRecentReviewed').textContent,'50 / 50');
    assert.equal(nodes.get('collectionStatusCategories').hidden,false);
    assert.equal(nodes.get('collectionStatusCategories').children[0].textContent,'<img src=x onerror=alert(1)>: Partial · 1 / 3 reviewed · 2 pending');
    assert.doesNotMatch(source,/\bfetch\s*\(|setInterval|innerHTML/);
    assert.match(html,/data => \{\s*renderCollectionStatus\(data\);/);
    assert.match(html,/<div class="analytics-card" id="collectionStatus"/);
    assert.ok(html.indexOf('id="collectionStatusCounts"')<html.indexOf('<details>',html.indexOf('id="collectionStatus"')),'counts remain visible when update details are collapsed');
});


test('internal limits and partial location work are described in plain language',()=>{
    const c=context();
    const reasons=['historical_budget','maintenance_budget','run_budget','daily_budget','primary_quota_429','overflow_quota_429','transient_error','incomplete_response','selection_incomplete','selection_deadline','geolocation_pending'];
    const view=c.collectionStatusView({collection_status:status({status:'partial',reasons,geolocation:{status:'partial',pending:3,unlocated:10,completed_unlocated:7}})});
    assert.match(view.reasons,/Earlier backlog review allowance reached/);
    assert.match(view.reasons,/Daily review allowance reached/);
    assert.match(view.reasons,/Review time limit reached/);
    for(const reason of reasons) assert.ok(!view.reasons.includes(reason),reason+' should not appear as an internal code');
    assert.equal((view.reasons.match(/AI service rate limit/g)||[]).length,1);
    assert.equal(view.locationPending,'3');
    assert.equal(view.locationUnlocated,'7');
    assert.match(view.locations,/pending: 3.*without a location: 7/);
    assert.equal(c.collectionStatusView({collection_status:status({geolocation:{status:'failed',pending:0,unlocated:7}})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({geolocation:{status:'complete',pending:0,unlocated:7}})}).state,'complete');
});

test('independent category attempts and split pending counts are preserved',()=>{
    const c=context();
    const view=c.collectionStatusView({collection_status:status({status:'partial',categories:[{category:'Radiological/Nuclear',status:'partial',candidates:500,reviewed:41,pending:459,recent_pending:9,backlog_pending:450,last_attempt_at:'2026-10-14T09:00:00Z',stop_code:'daily_budget'}]})});
    const category=view.categories[0];
    assert.equal(category.recentPending,9);
    assert.equal(category.backlogPending,450);
    assert.match(category.attempt,/11:00 Paris$/);
    assert.equal(category.note,'Daily review allowance reached');
});


test('unresolved locations are distinct from reviews completed without a location',()=>{
    const c=context();
    const view=c.collectionStatusView({collection_status:status({status:'partial',geolocation:{status:'partial',pending:3,unlocated:10},maintenance:{pending:8}})});
    assert.equal(view.locationPending,'3');
    assert.equal(view.locationUnlocated,'Not reported');
    assert.equal(view.maintenancePending,'8');
    assert.match(view.maintenance,/re-review: 8/);
    assert.equal(c.collectionStatusView({collection_status:status({maintenance:{pending:8}})}).state,'partial');
    assert.equal(c.collectionStatusView({collection_status:status({source:{status:'partial',errors:[]}})}).state,'partial');
});
