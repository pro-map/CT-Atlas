"""CT Atlas phase-test Gemini optimiser. Keeps collector.py as the main engine."""
import hashlib, json, os, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT=Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path: sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import collector
import archive_review

THRESHOLD=int(os.getenv("AI_SELECTION_THRESHOLD","60"))
BATCH=max(1,min(40,int(os.getenv("AI_SELECTION_BATCH_SIZE","25"))))
RUN_BUDGET=max(1,int(os.getenv("AI_SELECTION_MAX_CALLS_PER_RUN","30")))
DAY_BUDGET=max(RUN_BUDGET,int(os.getenv("AI_SELECTION_DAILY_CALL_BUDGET","60")))
RECENT_DAYS=max(1,int(os.getenv("AI_SELECTION_RECENT_PRIORITY_DAYS","3")))
# At most 10 Gemini requests a minute from the collection: the free tier allows
# 15 on 3.5 Flash Lite, and the Report Generator, Deep Search and Atlas AI use
# the same model while the collection runs.
MIN_GEMINI_INTERVAL=max(0.0,float(os.getenv("GEMINI_MIN_SECONDS_BETWEEN_CALLS","6")))
# Candidates left once 3.5 Flash Lite's budget is spent (or it answers 429) are
# reviewed on another model with its own free quota, within its own budget,
# instead of falling off the feeds unreviewed. Off when no model is set.
OVERFLOW_MODEL=os.getenv("AI_SELECTION_OVERFLOW_MODEL","").strip()
OVERFLOW_RUN_BUDGET=max(0,int(os.getenv("AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN","0") or 0)) if OVERFLOW_MODEL else 0
OVERFLOW_DAY_BUDGET=max(OVERFLOW_RUN_BUDGET,int(os.getenv("AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET","0") or 0)) if OVERFLOW_MODEL else 0
# No overflow request this late in a run: the geolocation and the commit
# steps still need their time.
OVERFLOW_DEADLINE_MINUTES=float(os.getenv("AI_SELECTION_OVERFLOW_DEADLINE_MINUTES","200") or 200)
PROCESS_START=time.monotonic()
PACIFIC=ZoneInfo("America/Los_Angeles")
collector.AI_SELECTION_BATCH_SIZE=BATCH
# The prompt and the keep bar at the map's threshold, exactly as the archive
# reviews use them (tools/archive_review.py).
archive_review.apply_threshold(collector,THRESHOLD)

POST=collector.requests.post
AI_SELECT=collector.ai_select_events
SAVE_CACHE=collector.save_selection_cache
TREND=collector.generate_24h_trend_summary
PRUNE=collector.prune_old
WEEKLY=collector.generate_weekly_analysis
calls=0; hit429=False; budget_hit=False; auto_count=0; partial=False; recent_count=0; backlog_count=0; last_gemini_call=None
overflow_calls=0; overflow429=False; primary_spent=False
# Candidates the overflow model reviewed this run, so their decisions say so.
OVERFLOW_IDS=set(); RUN_STARTED=datetime.now(timezone.utc).isoformat()
EVENT_ID_RE=re.compile(r'"event_id":\s*"((?:[^"\\]|\\.)*)"')

def pacific_day(): return datetime.now(PACIFIC).date().isoformat()
def starting_calls(key="calls"):
    try:
        u=collector.load_selection_cache().get("selection_quota_usage",{})
        return int(u.get(key,0) or 0) if u.get("pacific_day")==pacific_day() else 0
    except Exception: return 0
START_CALLS=starting_calls()
START_OVERFLOW=starting_calls("overflow_calls")
def today_calls(): return START_CALLS+calls
def today_overflow(): return START_OVERFLOW+overflow_calls
def overflow_left():
    if not OVERFLOW_MODEL or overflow429: return False
    if (time.monotonic()-PROCESS_START)/60>=OVERFLOW_DEADLINE_MINUTES: return False
    return overflow_calls<OVERFLOW_RUN_BUDGET and today_overflow()<OVERFLOW_DAY_BUDGET

def mark_overflow(cache):
    """Reviews made this run by the overflow model record it."""
    if not OVERFLOW_IDS: return
    for item in (cache.get("items") or {}).values():
        if isinstance(item,dict) and str((item.get("result") or {}).get("event_id")) in OVERFLOW_IDS \
                and str(item.get("reviewed_at") or "")>=RUN_STARTED:
            item["model"]=OVERFLOW_MODEL

def inject(cache):
    mark_overflow(cache)
    cache["selection_quota_usage"]={"pacific_day":pacific_day(),"calls":today_calls(),"daily_budget":DAY_BUDGET,"overflow_calls":today_overflow(),"overflow_daily_budget":OVERFLOW_DAY_BUDGET,"last_updated":datetime.now(timezone.utc).isoformat()}
    cache["selection_runtime_telemetry"]={"last_run_at":datetime.now(timezone.utc).isoformat(),"threshold":THRESHOLD,"batch_size":BATCH,"max_calls_per_run":RUN_BUDGET,"daily_call_budget":DAY_BUDGET,"calls_this_run":calls,"calls_today":today_calls(),"overflow_model":OVERFLOW_MODEL or None,"overflow_calls_this_run":overflow_calls,"overflow_calls_today":today_overflow(),"official_auto_accepted":auto_count,"recent_pending":recent_count,"backlog_pending":backlog_count,"budget_reached":budget_hit,"gemini_429":hit429,"overflow_429":overflow429,"partial_recovery":partial}
    return cache
def save_cache(cache): return SAVE_CACHE(inject(cache))
collector.save_selection_cache=save_cache

def is_selection(kwargs):
    b=kwargs.get("json")
    if not isinstance(b,dict): return False
    if "final editorial relevance filter" in str(b.get("system_instruction","")).lower(): return True
    rf=b.get("response_format",{}); schema=rf.get("schema",{}) if isinstance(rf,dict) else {}
    return isinstance(schema,dict) and "results" in schema.get("properties",{})

def pace():
    global last_gemini_call
    if last_gemini_call is not None:
        wait=last_gemini_call+MIN_GEMINI_INTERVAL-time.monotonic()
        if wait>0: time.sleep(wait)
    last_gemini_call=time.monotonic()

def overflow_post(url,args,kwargs):
    """The same selection request on the overflow model (a copy of the body:
    the collector reuses its own for retries)."""
    global overflow_calls,overflow429,budget_hit
    overflow_calls+=1
    kwargs=dict(kwargs,json=dict(kwargs["json"],model=OVERFLOW_MODEL))
    OVERFLOW_IDS.update(EVENT_ID_RE.findall(str(kwargs["json"].get("input") or "")))
    pace()
    r=POST(url,*args,**kwargs)
    if getattr(r,"status_code",None)==429:
        overflow429=True; budget_hit=True
        print(f"   Overflow model {OVERFLOW_MODEL} returned 429; stopping the selection.")
        raise collector.AISelectionQuotaError(f"Gemini overflow model {OVERFLOW_MODEL} returned 429. Cached progress is preserved.")
    return r

def post(url,*args,**kwargs):
    global calls,hit429,budget_hit,primary_spent
    gemini="generativelanguage.googleapis.com" in str(url)
    sel=gemini and is_selection(kwargs)
    if sel:
        if primary_spent or calls>=RUN_BUDGET or today_calls()>=DAY_BUDGET:
            if overflow_left():
                # 3.5 Flash Lite's budget is spent: if the overflow model fails
                # too, the run still publishes what was reviewed (partial recovery).
                if not primary_spent: budget_hit=True
                return overflow_post(url,args,kwargs)
            budget_hit=True
            if primary_spent: raise collector.AISelectionQuotaError("Gemini article-selection returned 429 and no overflow budget is left.")
            if calls>=RUN_BUDGET: raise collector.AISelectionQuotaError(f"CT Atlas self-imposed selection budget reached ({RUN_BUDGET} calls/run).")
            raise collector.AISelectionQuotaError(f"CT Atlas daily selection budget reached ({DAY_BUDGET} calls/Pacific day).")
        calls+=1
    if gemini: pace()
    r=POST(url,*args,**kwargs)
    if sel and getattr(r,"status_code",None)==429:
        hit429=True; primary_spent=True
        try: detail=" ".join(json.dumps(r.json(),ensure_ascii=False).split())[:1000]
        except Exception: detail=" ".join(str(getattr(r,"text","")).split())[:1000]
        if detail: print(f"   429 detail: {detail}")
        if overflow_left():
            print(f"   Gemini article-selection 429 detected; continuing on {OVERFLOW_MODEL}.")
            return overflow_post(url,args,kwargs)
        print("   Gemini article-selection 429 detected; stopping immediately.")
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
def mark_models(events):
    """Events selected by the overflow model, in this run or an earlier one
    (its decisions are cache hits afterwards), name that model."""
    try: items=collector.load_selection_cache().get("items",{})
    except Exception: return
    for e in events:
        x=items.get(collector.selection_fingerprint(e))
        if (isinstance(x,dict) and x.get("model")) or str(e.get("id")) in OVERFLOW_IDS:
            e["ai_selection_model"]=(x or {}).get("model") or OVERFLOW_MODEL

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
    if OVERFLOW_MODEL: print(f"Overflow: {OVERFLOW_MODEL}, {OVERFLOW_RUN_BUDGET}/run, {OVERFLOW_DAY_BUDGET}/Pacific day | Used before run: {START_OVERFLOW}")
    out=AI_SELECT(remaining)
    if out is not None:
        mark_models(out)
        print(f"Selection telemetry: calls={calls}, overflow={overflow_calls}, partial=no, 429={hit429}."); return auto+out
    if budget_hit and not hit429:
        partial=True; out=recover(remaining); mark_models(out)
        if collector.BACKFILL_ACTIVE:
            collector.BACKFILL_PENDING_QUERIES.clear()
            collector.BACKFILL_STATS["ai_deferred_backfill"]+=max(0,len(remaining)-sum(1 for e in remaining if cache_hit(collector.load_selection_cache(),e)))
        collector.save_selection_cache(collector.load_selection_cache())
        print(f"Selection telemetry: calls={calls}, overflow={overflow_calls}, partial=yes, 429=no."); return auto+out
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
