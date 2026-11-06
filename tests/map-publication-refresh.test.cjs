const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
function extract(name){
    const start=html.indexOf(`function ${name}(`);
    assert.ok(start>=0,name);
    let depth=0,i=html.indexOf('{',start);
    for(;i<html.length;i++){
        if(html[i]==='{')depth++;
        else if(html[i]==='}'&&--depth===0)break;
    }
    return html.slice(start,i+1);
}
const before='2026-11-01T22:04:19Z',after='2026-11-02T08:00:00Z';
const snapshot=(version,hash=version===before?'a':'b')=>({_publicationBytesHash:hash.repeat(64),last_updated:version,collection_status:{finalized_at:version},events:[{id:version}],recent_events:[]});
const target=(version,hash='a')=>({last_updated:version,collection_status_finalized_at:version,
    record_count:1,sha256_canonical_json:hash.repeat(64),sha256_bytes:hash.repeat(64)});
function harness(){
    let clock=1_000_000,publication=target(before),data=snapshot(after),loads=0,checks=0,applied=0,failure=false;
    const c=vm.createContext({Promise,Date:{now:()=>clock},console:{warn(){}},
        document:{visibilityState:'visible'},window:{eventsDataSource:'events-map.json'},
        mapLoadFailed:false,mapRefreshFailures:0,mapRefreshRetryAt:0,mapRefreshFailedSignature:'',MAP_REFRESH_BACKOFF_MS:[300000,900000,3600000],
        mapDatabaseVersion:before,mapSnapshotStatusFinalizedAt:before,mapSnapshotBytesHash:'a'.repeat(64),mapInitialLoadComplete:true,
        allEvents:snapshot(before).events,recentContextEvents:[],mapPublicationSignature:'',
        mapPublicationCheckedAt:0,mapPublicationPromise:null,MAP_PUBLICATION_POLL_MS:60000,chronologySelectedKeys:new Set(),
        fetch:async(url,options)=>{checks++;assert.equal(url,'publication-manifest.json');assert.equal(options.cache,'no-store');
            if(failure)throw new Error('network unavailable');
            return {ok:true,json:async()=>({files:{'events-map.json':publication}})};},
        loadMapDatabase:async()=>{loads++;return data;},renderCollectionStatus(){},
        applyMapDatabase:next=>{applied++;c.mapDatabaseVersion=next.last_updated;c.mapSnapshotStatusFinalizedAt=next.collection_status.finalized_at;c.mapSnapshotBytesHash=next._publicationBytesHash;c.allEvents=next.events;}
    });
    vm.runInContext(extract('mapPublicationMatches')+extract('deferMapRefresh')+extract('clearMapRefreshBackoff')+extract('refreshMapPublication'),c);
    return {c,advance(minutes=1){clock+=minutes*60000;},publish(value){publication=value;},dataset(value){data=value;},fail(value){failure=value;},
        counts:()=>({loads,checks,applied})};
}
test('unchanged publication polls a tiny manifest without downloading the map again',async()=>{
    const h=harness();await h.c.refreshMapPublication();
    assert.deepEqual(h.counts(),{loads:0,checks:1,applied:0});
    await h.c.refreshMapPublication();assert.equal(h.counts().checks,1);
    h.advance();await h.c.refreshMapPublication();assert.deepEqual(h.counts(),{loads:0,checks:2,applied:0});
});
test('a new publication refreshes the loaded map exactly once',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.advance();
    await Promise.all([h.c.refreshMapPublication(),h.c.refreshMapPublication()]);
    assert.deepEqual(h.counts(),{loads:1,checks:2,applied:1});assert.equal(h.c.mapDatabaseVersion,after);
    h.advance();await h.c.refreshMapPublication();assert.equal(h.counts().loads,1);
});
test('out-of-sync and failed publications preserve the previous data and retry later',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.dataset(snapshot(before));h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().applied,0);assert.equal(h.c.mapDatabaseVersion,before);
    h.fail(true);h.advance();await h.c.refreshMapPublication();assert.equal(h.counts().applied,0);
    h.fail(false);h.dataset(snapshot(after));h.advance(5);await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
});
test('status-only updates refresh, and hidden pages do not poll',async()=>{
    const h=harness();await h.c.refreshMapPublication();const next=snapshot(before,'b');next.collection_status.finalized_at=after;
    h.publish({...target(before,'b'),collection_status_finalized_at:after});h.dataset(next);h.advance();
    h.c.document.visibilityState='hidden';await h.c.refreshMapPublication();assert.equal(h.counts().checks,1);
    h.c.document.visibilityState='visible';await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
});
test('an export selection keeps its snapshot until the analyst finishes',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.advance();
    h.c.chronologySelectedKeys.add('selected-record');await h.c.refreshMapPublication();
    assert.equal(h.counts().checks,1);assert.equal(h.c.mapDatabaseVersion,before);
    h.c.chronologySelectedKeys.clear();await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
});
test('a selection made during a download prevents replacing its snapshot',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.advance();
    h.c.loadMapDatabase=async()=>{h.c.chronologySelectedKeys.add('selected-during-download');return snapshot(after);};
    await h.c.refreshMapPublication();assert.equal(h.counts().applied,0);assert.equal(h.c.mapDatabaseVersion,before);
    h.c.loadMapDatabase=async()=>snapshot(after);h.c.chronologySelectedKeys.clear();h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
});
test('a metadata correction with the same timestamp and record count cannot accept stale bytes',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(before,'b'));h.dataset(snapshot(before));h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().applied,0);
    h.dataset(snapshot(before,'b'));h.advance(5);await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
});
test('a mismatch downloads after 5, then 15, then 60 minutes instead of every minute',async()=>{
    // Verified live: 3 polls gave 3 downloads of 12.4 MB, 44 MB more once the fallbacks joined in.
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.dataset(snapshot(before));h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().loads,1);
    for(const [waited,loads] of [[4,1],[1,2],[14,2],[1,3],[59,3],[1,4],[59,4],[1,5]]){
        h.advance(waited);await h.c.refreshMapPublication();
        assert.equal(h.counts().loads,loads,'after '+waited+' more minutes');
    }
    assert.equal(h.counts().applied,0);
    assert.ok(h.counts().checks>=10,'the small manifest keeps its one-minute poll');
});
test('a new publication during a backoff is fetched at once, and success ends the backoff',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.dataset(snapshot(before));h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().loads,1);
    const later='2026-11-02T18:00:00Z';
    h.publish(target(later,'c'));h.dataset(snapshot(later,'c'));h.advance();
    await h.c.refreshMapPublication();assert.equal(h.counts().loads,2);assert.equal(h.counts().applied,1);
    assert.equal(h.c.mapRefreshFailures,0);assert.equal(h.c.mapRefreshRetryAt,0);
});
test('a page on a fallback file settles on the publication instead of downloading every minute',async()=>{
    const h=harness();h.c.mapSnapshotBytesHash='';h.c.window.eventsDataSource='events-lite.json';
    const lite={...snapshot(before),_publicationBytesHash:undefined};h.dataset(lite);
    await h.c.refreshMapPublication();assert.equal(h.counts().loads,1,'the map file is tried once');
    assert.equal(h.counts().applied,0,'the same publication is not redrawn');
    assert.equal(h.c.mapPublicationSignature,'a'.repeat(64));
    for(let minute=0;minute<3;minute++){h.advance();await h.c.refreshMapPublication();}
    assert.equal(h.counts().loads,1);
});
test('a fallback file carrying a newer publication is shown, one lagging behind it is not',async()=>{
    const h=harness();await h.c.refreshMapPublication();h.publish(target(after,'b'));h.advance();
    h.c.loadMapDatabase=async()=>{h.c.window.eventsDataSource='events-lite.json';return {...snapshot(before),_publicationBytesHash:undefined};};
    await h.c.refreshMapPublication();assert.equal(h.counts().applied,0);
    assert.equal(h.c.window.eventsDataSource,'events-map.json','the failed attempt leaves the source as it was');
    h.c.loadMapDatabase=async()=>{h.c.window.eventsDataSource='events-lite.json';return {...snapshot(after),_publicationBytesHash:undefined};};
    h.advance(5);await h.c.refreshMapPublication();assert.equal(h.counts().applied,1);
    assert.equal(h.c.mapDatabaseVersion,after);
});
test('a failed first load is retried by the minute poll, then with the backoff',async()=>{
    const h=harness();let starts=0;h.c.mapLoadFailed=true;h.c.startMapLoad=async()=>{starts++;};
    await h.c.refreshMapPublication();assert.equal(starts,1);
    h.advance();await h.c.refreshMapPublication();assert.equal(starts,1);
    h.advance(4);await h.c.refreshMapPublication();assert.equal(starts,2);
    assert.equal(h.counts().checks,0,'nothing on screen: the manifest cannot help');
});
test('the loader hashes the original UTF-8 bytes without changing returned JSON fields',async()=>{
    const crypto=require('node:crypto');const text=JSON.stringify(snapshot(before));
    const c=vm.createContext({crypto:crypto.webcrypto,TextDecoder,Uint8Array});
    vm.runInContext(extract('readMapSnapshotResponse'),c);
    const data=await c.readMapSnapshotResponse(new Response(text));
    assert.equal(data._publicationBytesHash,crypto.createHash('sha256').update(text).digest('hex'));
    const expected=JSON.parse(text);delete expected._publicationBytesHash;
    assert.deepEqual(JSON.parse(JSON.stringify(data)),expected);
});
test('the existing visible-page refresh checks publications without navigation or filter resets',()=>{
    assert.match(html,/refreshDatabaseArchiveTotal\(\);\s*refreshMapPublication\(\);\s*refreshVisibleDatabaseBackground\(\);/);
    assert.doesNotMatch(extract('applyMapDatabase'),/selectedDays\s*=|mapCategoryScope\s*=|location\.reload|fitBounds|setView/);
    assert.match(extract('loadEventsDatabase'),/"events\.json", \{ cache: "no-cache", signal \}/);
});
