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
from daily_reliability import recovery_caps, SLOTS
RESUME_PENDING = sys.argv[1:] == ['resume-pending']

THRESHOLD=int(os.getenv("AI_SELECTION_THRESHOLD","60"))
BATCH=max(1,min(40,int(os.getenv("AI_SELECTION_BATCH_SIZE","25"))))
RUN_BUDGET=max(1,int(os.getenv("AI_SELECTION_MAX_CALLS_PER_RUN","30")))
DAY_BUDGET=max(0,int(os.getenv("AI_SELECTION_DAILY_CALL_BUDGET","60")))
RECENT_DAYS=max(1,int(os.getenv("AI_SELECTION_RECENT_PRIORITY_DAYS","3")))
# Recent reporting gets the full envelope first. Historical recovery and schema
# maintenance share this smaller cap; neither may consume the recent reserve.
HISTORICAL_RUN_BUDGET=max(0,int(os.getenv("AI_SELECTION_HISTORICAL_MAX_CALLS_PER_RUN","10")))
MAINTENANCE_RUN_BUDGET=max(0,int(os.getenv("AI_SELECTION_MAINTENANCE_MAX_CALLS_PER_RUN","2")))
# At most 10 Gemini requests a minute from the collection: the free tier allows
# 15 on 3.5 Flash Lite, and the Report Generator, Deep Search and Atlas AI use
# the same model while the collection runs.
MIN_GEMINI_INTERVAL=max(0.0,float(os.getenv("GEMINI_MIN_SECONDS_BETWEEN_CALLS","6")))
# Candidates left once 3.5 Flash Lite's budget is spent (or it answers 429) are
# reviewed on another model with its own free quota, within its own budget,
# instead of falling off the feeds unreviewed. Off when no model is set.
OVERFLOW_MODEL=os.getenv("AI_SELECTION_OVERFLOW_MODEL","").strip()
OVERFLOW_RUN_BUDGET=max(0,int(os.getenv("AI_SELECTION_OVERFLOW_MAX_CALLS_PER_RUN","0") or 0)) if OVERFLOW_MODEL else 0
OVERFLOW_DAY_BUDGET=max(0,int(os.getenv("AI_SELECTION_OVERFLOW_DAILY_CALL_BUDGET","0") or 0)) if OVERFLOW_MODEL else 0
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
PROCESS_BATCH=collector.process_ai_selection_batch
calls=0; hit429=False; budget_hit=False; auto_count=0; partial=False; recent_count=0; backlog_count=0; last_gemini_call=None
overflow_calls=0; overflow429=False; primary_spent=False
# Candidates the overflow model reviewed this run, so their decisions say so.
OVERFLOW_IDS=set(); RUN_STARTED=datetime.now(timezone.utc).isoformat()
EVENT_ID_RE=re.compile(r'"event_id":\s*"((?:[^"\\]|\\.)*)"')
LANES=("recent","backlog","maintenance")
ACTIVE_LANE="recent"
LANE_CALLS={lane:{"primary":0,"overflow":0} for lane in LANES}
LANE_RECORDS={lane:{} for lane in LANES}
EVENT_FINGERPRINTS={}
SELECTION_ERRORS={lane:[] for lane in LANES}
CURRENT_FAILURE=None
RECOGNIZED_ERRORS=(collector.AISelectionQuotaError,collector.AISelectionTransientError,collector.AISelectionIncompleteError)

def pacific_day(): return datetime.now(PACIFIC).date().isoformat()
def starting_calls(key="calls"):
    try:
        # Quota usage survives editorial cache versions; a schema migration
        # never replenishes the actual provider's daily request allowance.
        path=Path(collector.AI_SELECTION_CACHE_FILE)
        cache=json.loads(path.read_text(encoding="utf-8")) if path.exists() else collector.load_selection_cache()
        u=cache.get("selection_quota_usage",{})
        return max(0,int(u.get(key,0) or 0)) if u.get("pacific_day")==pacific_day() else 0
    except Exception: return 0
START_CALLS=starting_calls()
START_OVERFLOW=starting_calls("overflow_calls")
START_DAY=pacific_day()
try:
    START_USAGE=json.loads(Path(collector.AI_SELECTION_CACHE_FILE).read_text(encoding='utf-8')).get('selection_quota_usage',{})
except (OSError, ValueError, AttributeError):
    START_USAGE={}
COMPLETED_SLOTS=set(START_USAGE.get('completed_daily_slots',[])) & set(SLOTS) if START_USAGE.get('pacific_day')==START_DAY else set()
if RESUME_PENDING:
    RUN_BUDGET,OVERFLOW_RUN_BUDGET=recovery_caps(START_USAGE,START_DAY,RUN_BUDGET,DAY_BUDGET,OVERFLOW_RUN_BUDGET,OVERFLOW_DAY_BUDGET)
    HISTORICAL_RUN_BUDGET=min(HISTORICAL_RUN_BUDGET,RUN_BUDGET+OVERFLOW_RUN_BUDGET)
    MAINTENANCE_RUN_BUDGET=0

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

def runtime_telemetry():
    """Per-run decisions, counted once per original candidate fingerprint."""
    lanes={}
    for lane in LANES:
        records=list(LANE_RECORDS[lane].values())
        reviewed=sum(record["reviewed"] for record in records)
        pending=len(records)-reviewed
        cached=sum(record["reviewed"] and record["source"]=="cached" for record in records)
        official=sum(record["reviewed"] and record["source"]=="official_rule" for record in records)
        reasons=list(dict.fromkeys(error["reason"] for error in SELECTION_ERRORS[lane])) if pending else []
        if pending and not reasons:
            reasons=["selection_incomplete"]
        lanes[lane]={"candidates":len(records),"reviewed":reviewed,"cached":cached,
                     "new_reviews":reviewed-cached-official,"official_auto_accepted":official,
                     "retained":sum(record["reviewed"] and record["kept"] for record in records),
                     "rejected":sum(record["reviewed"] and not record["kept"] for record in records),
                     "pending":pending,"status":"partial" if pending else "complete",
                     "calls":sum(LANE_CALLS[lane].values()),
                     "primary_calls":LANE_CALLS[lane]["primary"],
                     "overflow_calls":LANE_CALLS[lane]["overflow"],"reasons":reasons}
    is_partial=any(lane["pending"] for lane in lanes.values())
    reasons=list(dict.fromkeys(reason for lane in lanes.values() for reason in lane["reasons"]))
    return {"schema_version":2,"run_started_at":RUN_STARTED,
            "last_run_at":datetime.now(timezone.utc).isoformat(),
            "status":"partial" if is_partial else "complete","partial":is_partial,
            "threshold":THRESHOLD,"batch_size":BATCH,"recent_priority_days":RECENT_DAYS,
            "max_calls_per_run":RUN_BUDGET,"daily_call_budget":DAY_BUDGET,
            "calls_this_run":calls,"calls_today":today_calls(),
            "overflow_model":OVERFLOW_MODEL or None,"overflow_calls_this_run":overflow_calls,
            "overflow_calls_today":today_overflow(),"official_auto_accepted":auto_count,
            "recent_pending":lanes["recent"]["pending"],
            "backlog_pending":lanes["backlog"]["pending"],
            "maintenance_pending":lanes["maintenance"]["pending"],
            "budget_reached":budget_hit,"gemini_429":hit429,"overflow_429":overflow429,
            "partial_recovery":is_partial,"reasons":reasons,"lanes":lanes,
            "budgets":{"primary":{"per_run":RUN_BUDGET,"per_day":DAY_BUDGET,
                                    "used_this_run":calls,"used_today":today_calls()},
                       "overflow":{"model":OVERFLOW_MODEL or None,"per_run":OVERFLOW_RUN_BUDGET,
                                     "per_day":OVERFLOW_DAY_BUDGET,"used_this_run":overflow_calls,
                                     "used_today":today_overflow()},
                       "historical_calls_per_run":HISTORICAL_RUN_BUDGET,
                       "historical_calls_used":sum(sum(LANE_CALLS[lane].values()) for lane in ("backlog","maintenance")),
                       "maintenance_calls_per_run":MAINTENANCE_RUN_BUDGET}}


def inject(cache):
    mark_overflow(cache)
    cache["selection_quota_usage"]={"pacific_day":pacific_day(),"calls":today_calls(),"daily_budget":DAY_BUDGET,"overflow_calls":today_overflow(),"overflow_daily_budget":OVERFLOW_DAY_BUDGET,"last_updated":datetime.now(timezone.utc).isoformat()}
    cache['selection_quota_usage']['completed_daily_slots']=sorted(COMPLETED_SLOTS) if pacific_day()==START_DAY else []
    cache["selection_runtime_telemetry"]=runtime_telemetry()
    return cache


def save_cache(cache): return SAVE_CACHE(inject(cache))
collector.save_selection_cache=save_cache
collector.selection_runtime_status=runtime_telemetry


def record_failure(reason,detail):
    global CURRENT_FAILURE
    CURRENT_FAILURE={"reason":reason,"detail":str(detail)[:300]}
    if CURRENT_FAILURE not in SELECTION_ERRORS[ACTIVE_LANE]:
        SELECTION_ERRORS[ACTIVE_LANE].append(CURRENT_FAILURE)


def quota_stop(reason,detail):
    global budget_hit
    budget_hit=True
    record_failure(reason,detail)
    raise collector.AISelectionQuotaError(detail)


def check_lane_budget():
    if collector.BACKFILL_ACTIVE or ACTIVE_LANE not in ("backlog","maintenance"):
        return
    historical_calls=sum(sum(LANE_CALLS[lane].values()) for lane in ("backlog","maintenance"))
    if historical_calls>=HISTORICAL_RUN_BUDGET:
        quota_stop("historical_budget",f"CT Atlas historical selection budget reached ({HISTORICAL_RUN_BUDGET} calls/run); recent reporting is reserved.")
    if ACTIVE_LANE=="maintenance" and sum(LANE_CALLS["maintenance"].values())>=MAINTENANCE_RUN_BUDGET:
        quota_stop("maintenance_budget",f"CT Atlas incident-maintenance budget reached ({MAINTENANCE_RUN_BUDGET} calls/run).")


def tracked_process_batch(batch):
    try:
        return PROCESS_BATCH(batch)
    except RECOGNIZED_ERRORS as error:
        if CURRENT_FAILURE is None:
            if isinstance(error,collector.AISelectionTransientError):
                reason="transient_error"
            elif isinstance(error,collector.AISelectionIncompleteError):
                reason="incomplete_response"
            else:
                reason="quota_429" if hit429 or overflow429 else "selection_quota"
            record_failure(reason,error)
        raise
collector.process_ai_selection_batch=tracked_process_batch

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
    """The same selection request on the overflow model, without mutating the
    collector's retry body or exceeding either lane or free-tier envelope."""
    global overflow_calls,overflow429,budget_hit
    check_lane_budget()
    overflow_calls+=1
    LANE_CALLS[ACTIVE_LANE]["overflow"]+=1
    kwargs=dict(kwargs,json=dict(kwargs["json"],model=OVERFLOW_MODEL))
    OVERFLOW_IDS.update(EVENT_ID_RE.findall(str(kwargs["json"].get("input") or "")))
    pace()
    r=POST(url,*args,**kwargs)
    if getattr(r,"status_code",None)==429:
        overflow429=True
        print(f"   Overflow model {OVERFLOW_MODEL} returned 429; stopping the selection.")
        quota_stop("overflow_quota_429",f"Gemini overflow model {OVERFLOW_MODEL} returned 429. Cached progress is preserved.")
    return r


def post(url,*args,**kwargs):
    global calls,hit429,budget_hit,primary_spent
    gemini="generativelanguage.googleapis.com" in str(url)
    sel=gemini and is_selection(kwargs)
    if RESUME_PENDING and gemini and pacific_day()!=START_DAY:
        quota_stop('recovery_day_boundary','Recovery stopped at the Pacific day boundary; restart with a freshly read ledger.')
    if RESUME_PENDING and gemini and not sel:
        raise collector.AISelectionQuotaError('Queue-only recovery does not request trend or incident-maintenance AI.')
    if sel:
        check_lane_budget()
        if primary_spent or calls>=RUN_BUDGET or today_calls()>=DAY_BUDGET:
            if overflow_left():
                if not primary_spent: budget_hit=True
                return overflow_post(url,args,kwargs)
            if overflow429:
                quota_stop("overflow_quota_429","Gemini overflow model returned 429 and no selection budget is left.")
            if primary_spent:
                quota_stop("primary_quota_429","Gemini article-selection returned 429 and no overflow budget is left.")
            if OVERFLOW_MODEL and (time.monotonic()-PROCESS_START)/60>=OVERFLOW_DEADLINE_MINUTES:
                quota_stop("selection_deadline","CT Atlas overflow deadline reached; time is reserved for publication and geolocation.")
            if calls>=RUN_BUDGET:
                quota_stop("run_budget",f"CT Atlas self-imposed selection budget reached ({RUN_BUDGET} calls/run).")
            quota_stop("daily_budget",f"CT Atlas daily selection budget reached ({DAY_BUDGET} calls/Pacific day).")
        calls+=1
        LANE_CALLS[ACTIVE_LANE]["primary"]+=1
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
        quota_stop("primary_quota_429","Gemini article-selection returned 429. Cached progress is preserved.")
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
    x=cache.get("items",{}).get(original_fingerprint(e))
    return isinstance(x,dict) and x.get("version")==collector.AI_SELECTION_VERSION and isinstance(x.get("result"),dict)
def dtkey(e): return collector.event_datetime(e) or datetime.min.replace(tzinfo=timezone.utc)
def original_fingerprint(event):
    identity=EVENT_FINGERPRINTS.get(id(event))
    if identity is not None and identity[0] is event:
        return identity[1]
    return collector.selection_fingerprint(event)


def selection_review_complete(event):
    # Applying a review translates the title/summary, which changes its
    # fingerprint. Queue persistence must use the original candidate identity.
    fp=original_fingerprint(event)
    return any(records.get(fp,{}).get("reviewed",False) for records in LANE_RECORDS.values())
collector.selection_review_complete=selection_review_complete


def mark_models(events):
    """Name the model on retained decisions, including translated cache hits."""
    try: items=collector.load_selection_cache().get("items",{})
    except Exception: return
    for e in events:
        x=items.get(original_fingerprint(e))
        if (isinstance(x,dict) and x.get("model")) or str(e.get("id")) in OVERFLOW_IDS:
            e["ai_selection_model"]=(x or {}).get("model") or OVERFLOW_MODEL
        elif isinstance(x,dict) and x.get("decision_source")=="official_rule":
            e["ai_selection_model"]="official-rule-v1"


def recover(events):
    cache=collector.load_selection_cache(); selected=[]; rejected=[]; reviewed=0
    for e in events:
        x=cache.get("items",{}).get(original_fingerprint(e))
        if not (isinstance(x,dict) and x.get("version")==collector.AI_SELECTION_VERSION and isinstance(x.get("result"),dict)):
            continue
        reviewed+=1
        if collector.apply_ai_selection(e,x["result"]): selected.append(e)
        else: rejected.append(e)
    # Keep reviewed background articles too; candidates without a decision stay
    # untouched in the separate durable queue written by collector.main().
    if rejected:
        collector.persist_background_articles(rejected)
    print(f"Budget-safe partial publication: {reviewed}/{len(events)} reviewed; {len(selected)} retained at {THRESHOLD}/100.")
    return selected


def _select_lane(events,lane):
    global auto_count,partial,recent_count,backlog_count,ACTIVE_LANE,CURRENT_FAILURE
    previous_lane=ACTIVE_LANE; ACTIVE_LANE=lane; CURRENT_FAILURE=None
    cache=collector.load_selection_cache(); auto=[]; cached_selected=[]; cached_rejected=[]; remaining=[]
    if lane=="maintenance":
        # An earlier relevance-only verdict does not establish the incident
        # type or anchor. Invalidate only those supplied maintenance entries;
        # all other cached editorial decisions and daily quota usage survive.
        invalid=[]
        for event in events:
            fp=original_fingerprint(event)
            item=cache.get("items",{}).get(fp)
            result=item.get("result") if isinstance(item,dict) else None
            if (isinstance(item,dict) and item.get("version")==collector.AI_SELECTION_VERSION
                    and isinstance(result,dict)
                    and not (result.get("primary_event_type") and result.get("incident_anchor"))):
                invalid.append(fp)
        for fp in invalid:
            cache["items"].pop(fp,None)
        if invalid:
            collector.save_selection_cache(cache)
            print(f"Incident maintenance: refreshing {len(set(invalid))} unstructured cached verdict(s).")
    records=LANE_RECORDS[lane]
    for e in events:
        fp=original_fingerprint(e)
        EVENT_FINGERPRINTS[id(e)]=(e,fp)
        records.setdefault(fp,{"reviewed":False,"kept":False,"source":"cached" if cache_hit(cache,e) else "ai"})
        if cache_hit(cache,e):
            keep=collector.apply_ai_selection(e,cache["items"][fp]["result"])
            records[fp].update(reviewed=True,kept=bool(keep))
            (cached_selected if keep else cached_rejected).append(e)
            continue
        # Official-source auto-accept establishes relevance, not an incident
        # type. It cannot finish an existing record's incident migration.
        r=official_result(e) if lane!="maintenance" else None
        if r is None: remaining.append(e); continue
        cache.setdefault("items",{})[fp]={"version":collector.AI_SELECTION_VERSION,"reviewed_at":datetime.now(timezone.utc).isoformat(),"result":r,"decision_source":"official_rule"}
        keep=collector.apply_ai_selection(e,r); e["ai_selection_model"]="official-rule-v1"
        records[fp].update(reviewed=True,kept=bool(keep),source="official_rule")
        if keep: auto.append(e)
        auto_count+=1
    if auto:
        collector.save_selection_cache(cache)
        print(f"Official-source conservative auto-accept: {len(auto)} {lane} candidate(s) resolved without Gemini.")
    if cached_rejected:
        collector.persist_background_articles(cached_rejected)
    mark_models(cached_selected)
    remaining.sort(key=dtkey,reverse=True)
    hits=len(cached_selected)+len(cached_rejected)
    print("\n"+"="*70+"\nCT ATLAS GEMINI BUDGET / "+lane.upper()+"\n"+"="*70)
    print(f"Threshold: {THRESHOLD}/100 | Batch: {BATCH} | Cache: {hits}/{len(events)} | Need new AI review: {len(remaining)} | Auto-accept: {len(auto)}")
    print(f"Selection budget: {RUN_BUDGET}/run, {DAY_BUDGET}/Pacific day | Used before run: {START_CALLS}")
    if lane in ("backlog","maintenance"):
        print(f"Historical envelope: {HISTORICAL_RUN_BUDGET} calls/run total | Maintenance cap: {MAINTENANCE_RUN_BUDGET}")
    if OVERFLOW_MODEL: print(f"Overflow: {OVERFLOW_MODEL}, {OVERFLOW_RUN_BUDGET}/run, {OVERFLOW_DAY_BUDGET}/Pacific day | Used before run: {START_OVERFLOW}")
    try:
        try:
            out=AI_SELECT(remaining,lane=lane) if remaining else []
        except RECOGNIZED_ERRORS as error:
            if CURRENT_FAILURE is None:
                reason="transient_error" if isinstance(error,collector.AISelectionTransientError) else "incomplete_response" if isinstance(error,collector.AISelectionIncompleteError) else "selection_quota"
                record_failure(reason,error)
            out=None
        if out is None:
            if CURRENT_FAILURE is None: record_failure("selection_incomplete","AI selection returned without every candidate decision.")
            out=recover(remaining)
        mark_models(out)
        cache=collector.load_selection_cache()
        kept_ids={id(event) for event in auto+cached_selected+out}
        for e in events:
            fp=original_fingerprint(e)
            x=cache.get("items",{}).get(fp)
            if isinstance(x,dict) and x.get("version")==collector.AI_SELECTION_VERSION and isinstance(x.get("result"),dict):
                records[fp].update(reviewed=True,kept=id(e) in kept_ids)
        telemetry=runtime_telemetry(); partial=telemetry["partial"]
        recent_count=telemetry["recent_pending"]; backlog_count=telemetry["backlog_pending"]
        pending=telemetry["lanes"][lane]["pending"]
        if pending and collector.BACKFILL_ACTIVE:
            collector.BACKFILL_PENDING_QUERIES.clear()
            collector.BACKFILL_STATS["ai_deferred_backfill"]+=pending
        collector.save_selection_cache(cache)
        print(f"Selection telemetry ({lane}): reviewed={telemetry['lanes'][lane]['reviewed']}, pending={pending}, calls={calls}, overflow={overflow_calls}, partial={partial}.")
        return auto+cached_selected+out
    finally:
        ACTIVE_LANE=previous_lane


def optimized_select(events,lane=None):
    """Review recent reporting before old backlog; each uses separate batches.

    Explicit lanes are supplied by collector.main() after it separates discovery
    and replay queues. Direct callers still get the same date-based isolation.
    """
    if lane is not None and lane not in LANES:
        raise ValueError(f"Unknown selection lane: {lane}")
    events=list(events)
    if not collector.AI_SELECTION_ENABLED: return events
    if lane is not None:
        return _select_lane(events,lane)
    cutoff=datetime.now(timezone.utc)-timedelta(days=RECENT_DAYS)
    recent=[e for e in events if dtkey(e)>=cutoff]
    backlog=[e for e in events if dtkey(e)<cutoff]
    return _select_lane(recent,"recent")+_select_lane(backlog,"backlog")
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

def run_main():
    if RESUME_PENDING:
        # No sources are fetched. Only the already durable daily queue is read.
        sys.argv=[sys.argv[0]]
        previous=collector.load_database_strict()
        collector.collect_all=lambda *args,**kwargs: []
        collector.generate_24h_trend_summary=lambda events: previous.get('trend_summary',{})
        collector.generate_weekly_analysis=lambda events,existing_weekly=None: existing_weekly or previous.get('weekly_analysis',{})
        consolidate=collector.consolidate_incidents
        collector.consolidate_incidents=lambda events,state=None,**kwargs: consolidate(events,state,max_calls=0,use_gemini=False)
        print(f'QUEUE-ONLY RECOVERY: at most {RUN_BUDGET} primary and {OVERFLOW_RUN_BUDGET} overflow calls; ordinary slots reserved.')
    collector.main()
    slot=os.getenv('CT_ATLAS_SCHEDULE','')
    if not RESUME_PENDING and slot in SLOTS and pacific_day()==START_DAY:
        COMPLETED_SLOTS.add(slot)
        collector.save_selection_cache(collector.load_selection_cache())

if __name__=="__main__": run_main()

