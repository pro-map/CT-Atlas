#!/usr/bin/env python3
"""Read-only connectivity check for both native Chinese Google News editions.

Tests Google News RSS availability and reports empty targeted historical searches
as coverage limitations, not successful retrievals. No AI or CT ATLAS writes.
"""
import json
import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlencode

import feedparser
import requests

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/"tools"))
import enrich_radnuc

SAMPLES={
    "zh": {"broad":"新闻","historical":"(核材料 OR 放射性) (恐怖主义 OR 查获 OR 走私)"},
    "zh-Hant": {"broad":"新聞","historical":"(核材料 OR 放射性) (恐怖主義 OR 查獲 OR 走私)"},
}
BASE="https://news.google.com/rss/search"

def request(session, profile, q):
    options={"q":q,"hl":profile["hl"],"gl":profile["gl"],"ceid":profile["ceid"]}
    url=BASE+"?"+urlencode(options)
    res=session.get(url,timeout=18,headers={"User-Agent":"CT-Atlas-Language-Connectivity-Test/1.0"})
    if res.status_code != 200:
        print(f"SOURCE_LIMIT code={profile['code']} status={res.status_code}",flush=True)
        return None
    parsed=feedparser.parse(res.content)
    if not parsed.feed:
        print(f"INVALID_RSS code={profile['code']} bozo={parsed.get('bozo',None)}",flush=True)
        return None
    count=len(parsed.entries)
    print(f"CHINESE_RSS code={profile['code']} "
          f"edition={profile['ceid']} entries={count} "
          f"cjk_titles={sum(any(0x4E00<=ord(char)<=0x9FFF for char in str(entry.get('title',''))) for entry in parsed.entries)}",flush=True)
    return count

def main():
    reachable=0
    with requests.Session() as session:
        for profile in enrich_radnuc.CHINESE_BACKFILL_PROFILES:
            native=SAMPLES[profile["code"]]
            broad=request(session,profile,native["broad"])
            if broad is not None and broad>0:
                reachable+=1
            time.sleep(2)
            historic=native["historical"] + " after:2026-04-11 before:2026-10-10"
            targeted=request(session,profile,historic)
            if targeted == 0:
                print(f"WARNING code={profile['code']} targeted source returned no items; "
                      "this is not evidence of complete source coverage",flush=True)
            time.sleep(2)
    print(f"CHINESE_EDITION_PROBE reachable_broad={reachable}/2; "
          "no historical collection, no AI calls, no checkpoint writes.",flush=True)
    if reachable != 2:
        raise SystemExit("Chinese news editions not both confirmed reachable; "
                         "manual validation required")

if __name__=="__main__":main()
