"""CT Atlas phase-test Gemini optimiser. Keeps collector.py as the main engine."""
import hashlib, json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT=Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path: sys.path.insert(0,str(ROOT))
import collector

THRESHOLD=int(os.getenv("AI_SELECTION_THRESHOLD","60"))
BATCH=max(1,min(40,int(os.getenv("AI_SELECTION_BATCH_SIZE","25"))))
RUN_BUDGET=max(1,int(os.getenv("AI_SELECTION_MAX_CALLS_PER_RUN","30")))
DAY_BUDGET=max(RUN_BUDGET,int(os.getenv("AI_SELECTION_DAILY_CALL_BUDGET","60")))
RECENT_DAYS=max(1,int(os.getenv("AI_SELECTION_RECENT_PRIORITY_DAYS","3")))
PACIFIC=ZoneInfo("America/Los_Angeles")
collector.AI_SELECTION_THRESHOLD=THRESHOLD
collector.AI_SELECTION_BATCH_SIZE=BATCH
collector.AI_SELECTION_INSTRUCTIONS=(collector.AI_SELECTION_INSTRUCTIONS
    .replace("score >= 50",f"score >= {THRESHOLD}")
    .replace("at least 50",f"at least {THRESHOLD}")
    .replace("just above 50",f"just above {THRESHOLD}"))

POST=collector.requests.post
AI_SELECT=collector.ai_select_events
SAVE_CACHE=collector.save_selection_cache
TREND=collector.generate_24h_trend_summary
PRUNE=collector.prune_old
WEEKLY=collector.generate_weekly_analysis
calls=0; hit429=False; budget_hit=False; auto_count=0; partial=False; recent_count=0; backlog_count=0

def pacific_day(): return datetime.now(PACIFIC).date().isoformat()
def starting_calls():
    try:
        u=collector.load_selection_cache().get("selection_quota_usage",{})
        return int(u.get("calls",0) or 0) if u.get("pacific_day")==pacific_day() else 0
    except Exception: return 0
START_CALLS=starting_calls()
def today_calls(): return START_CALLS+calls

def inject(cache):
    cache["selection_quota_usage"]={"pacific_day":pacific_day(),"calls":today_calls(),"daily_budget":DAY_BUDGET,"last_updated":datetime.now(timezone.utc).isoformat()}
    cache["selection_runtime_telemetry"]={"last_run_at":datetime.now(timezone.utc).isoformat(),"threshold":THRESHOLD,"batch_size":BATCH,"max_calls_per_run":RUN_BUDGET,"daily_call_budget":DAY_BUDGET,"calls_this_run":calls,"calls_today":today_calls(),"official_auto_accepted":auto_count,"recent_pending":recent_count,"backlog_pending":backlog_count,"budget_reached":budget_hit,"gemini_429":hit429,"partial_recovery":partial}
    return cache
def save_cache(cache): return SAVE_CACHE(inject(cache))
collector.save_selection_cache=save_cache

def is_selection(kwargs):
    b=kwargs.get("json")
    if not isinstance(b,dict): return False
    if "final editorial relevance filter" in str(b.get("system_instruction","")).lower(): return True
    rf=b.get("response_format",{}); schema=rf.get("schema",{}) if isinstance(rf,dict) else {}
    return isinstance(schema,dict) and "results" in schema.get("properties",{})

def post(url,*args,**kwargs):
    global calls,hit429,budget_hit
    sel="generativelanguage.googleapis.com" in str(url) and is_selection(kwargs)
    if sel:
        if calls>=RUN_BUDGET:
            budget_hit=True; raise collector.AISelectionQuotaError(f"CT Atlas self-imposed selection budget reached ({RUN_BUDGET} calls/run).")
        if today_calls()>=DAY_BUDGET:
            budget_hit=True; raise collector.AISelectionQuotaError(f"CT Atlas daily selection budget reached ({DAY_BUDGET} calls/Pacific day).")
        calls+=1
    r=POST(url,*args,**kwargs)
    if sel and getattr(r,"status_code",None)==429:
        hit429=True
        try: detail=" ".join(json.dumps(r.json(),ensure_ascii=False).split())[:1000]
        except Exception: detail=" ".join(str(getattr(r,"text","")).split())[:1000]
        print("   Gemini article-selection 429 detected; stopping immediately.")
        if detail: print(f"   429 detail: {detail}")
        raise collector.AISelectionQuotaError("Gemini article-selection returned 429. Cached progress is preserved.")
    return r
collector.requests.post=post

def official_result(e):
    if collector.out_of_scope_reason(e): return None
    if collector.source_rank(collector.clean_text(e.get("source","")))<122: return None
    title=collector.clean_text(e.get("title","")); summary=collector.clean_text(e.get("summary",""))
    combined=collector.normalize_relevance_text(title+" "+summary); tt=collector.normalize_relevance_text(title)
    if collector.has_non_event_pattern(combined): return None
    cats=collector.normalize_categories(e.get("categories") or ([e.get("category")] if e.get("category") else [])); good=[]
    for c in cats:
        if c not in collector.CATEGORIES: continue
        acts=collector.ACTION_TERMS.get(c,set()); terms=collector.CATEGORY_RELEVANCE.get(c,set())
        if c=="Maritime Piracy":
            pa=any(collector.contains_term(tt,x) for x in ("maritime piracy","piracy","pirate","pirates","armed robbery at sea")); ta=any(collector.contains_term(tt,x) for x in acts)
            if pa and ta: good.append(c)
            continue
        anchor=any(collector.contains_term(tt,x) for x in collector.CT_ANCHORS)
        cat=any(collector.contains_term(tt,x) for x in terms); act=any(collector.contains_term(tt,x) for x in acts)
        if anchor and cat and act: good.append(c)
    if not good: return None
    lang=collector.clean_text(e.get("original_language") or e.get("collection_language") or "en").lower()
    return {"event_id":str(e.get("id") or ""),"relevance_score":88,"is_current_ct_event":True,"categories":good,"original_language":lang or "en","english_title":title,"english_summary":summary,"canonical_event":title,"reason":"Auto-accepted: authoritative official source with strong CT category/action evidence in the headline."}

def cache_hit(cache,e):
    x=cache.get("items",{}).get(collector.selection_fingerprint(e))
    return isinstance(x,dict) and x.get("version")==collector.AI_SELECTION_VERSION and isinstance(x.get("result"),dict)
def dtkey(e): return collector.event_datetime(e) or datetime.min.replace(tzinfo=timezone.utc)
def recover(events):
    cache=collector.load_selection_cache(); selected=[]; reviewed=0
    for e in events:
        x=cache.get("items",{}).get(collector.selection_fingerprint(e))
        if not (isinstance(x,dict) and x.get("version")==collector.AI_SELECTION_VERSION and isinstance(x.get("result"),dict)): continue
        reviewed+=1
        if collector.apply_ai_selection(e,x["result"]): selected.append(e)
    print(f"Budget-safe partial publication: {reviewed}/{len(events)} reviewed; {len(selected)} retained at {THRESHOLD}/100.")
    return selected

def optimized_select(events):
    global auto_count,partial,recent_count,backlog_count
    if not collector.AI_SELECTION_ENABLED: return events
    cache=collector.load_selection_cache(); auto=[]; remaining=[]
    for e in events:
        if cache_hit(cache,e): remaining.append(e); continue
        r=official_result(e)
        if r is None: remaining.append(e); continue
        fp=collector.selection_fingerprint(e); cache.setdefault("items",{})[fp]={"version":collector.AI_SELECTION_VERSION,"reviewed_at":datetime.now(timezone.utc).isoformat(),"result":r,"decision_source":"official_rule"}
        keep=collector.apply_ai_selection(e,r); e["ai_selection_model"]="official-rule-v1"
        if keep: auto.append(e)
        auto_count+=1
    if auto_count:
        collector.save_selection_cache(cache); print(f"Official-source conservative auto-accept: {auto_count} candidate(s) resolved without Gemini.")
    remaining.sort(key=dtkey,reverse=True)
    cutoff=datetime.now(timezone.utc)-timedelta(days=RECENT_DAYS)
    recent_count=sum(1 for e in remaining if dtkey(e)>=cutoff); backlog_count=len(remaining)-recent_count
    hits=sum(1 for e in remaining if cache_hit(cache,e))
    print("\n"+"="*70+"\nCT ATLAS GEMINI BUDGET / PRIORITY\n"+"="*70)
    print(f"Threshold: {THRESHOLD}/100 | Batch: {BATCH} | Cache: {hits}/{len(remaining)} | Auto-accept: {auto_count}")
    print(f"Recent priority (<= {RECENT_DAYS}d): {recent_count} | Older backlog: {backlog_count}")
    print(f"Selection budget: {RUN_BUDGET}/run, {DAY_BUDGET}/Pacific day | Used before run: {START_CALLS}")
    out=AI_SELECT(remaining)
    if out is not None:
        print(f"Selection telemetry: calls={calls}, partial=no, 429={hit429}."); return auto+out
    if budget_hit and not hit429:
        partial=True; out=recover(remaining)
        if collector.BACKFILL_ACTIVE:
            collector.BACKFILL_PENDING_QUERIES.clear()
            collector.BACKFILL_STATS["ai_deferred_backfill"]+=max(0,len(remaining)-sum(1 for e in remaining if cache_hit(collector.load_selection_cache(),e)))
        collector.save_selection_cache(collector.load_selection_cache())
        print(f"Selection telemetry: calls={calls}, partial=yes, 429=no."); return auto+out
    return None
collector.ai_select_events=optimized_select

def prune(events,aged_out=None):
    # Same signature as collector.prune_old: aged-out events still reach the
    # background archive through it.
    kept=PRUNE(events,aged_out); out=[]; removed=0
    for e in kept:
        if e.get("ai_selection_complete") is True and e.get("ai_relevance_score") is not None:
            try: score=int(e.get("ai_relevance_score",0) or 0)
            except Exception: score=0
            if score<THRESHOLD: removed+=1; continue
        out.append(e)
    if removed: print(f"Threshold cleanup: removed {removed} previously reviewed event(s) below {THRESHOLD}/100.")
    return out
collector.prune_old=prune

def trend_hash(events):
    cutoff=datetime.now(timezone.utc)-timedelta(hours=24); recent=[]
    for e in events:
        d=collector._trend_recency(e)
        if d is not None and d>=cutoff: recent.append(e)
    recent.sort(key=collector._trend_priority,reverse=True); recent=recent[:10]
    mat=[{"id":str(e.get("id") or e.get("_mapKey") or ""),"score":int(e.get("ai_relevance_score",0) or 0),"source_count":int(e.get("source_count",1) or 1),"last":str(e.get("last_reported") or e.get("published") or ""),"canonical":collector.clean_text(e.get("ai_canonical_event") or e.get("title") or "")} for e in recent]
    return hashlib.sha256(json.dumps(mat,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),len(recent)
def guarded_trend(events):
    h,n=trend_hash(events)
    try: prev=collector.load_database_strict().get("trend_summary",{})
    except Exception: prev={}
    if isinstance(prev,dict) and prev.get("top_hash")==h and prev.get("overview") is not None:
        r=dict(prev); r.update({"reused":True,"last_checked_at":datetime.now(timezone.utc).isoformat(),"top_hash":h,"top_event_count":n})
        print("\n"+"="*70+"\n24H TREND SUMMARY\n"+"="*70+"\nSignificant top-event set unchanged — reusing previous Gemini synthesis."); return r
    r=TREND(events)
    if isinstance(r,dict): r=dict(r); r.update({"top_hash":h,"top_event_count":n,"reused":False})
    return r
collector.generate_24h_trend_summary=guarded_trend

def weekly(events,existing_weekly=None):
    if hit429:
        print("Weekly AI analysis skipped because article selection returned Gemini 429.")
        return existing_weekly if isinstance(existing_weekly,dict) else {}
    return WEEKLY(events,existing_weekly=existing_weekly)
collector.generate_weekly_analysis=weekly

if __name__=="__main__": collector.main()
