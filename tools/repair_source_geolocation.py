#!/usr/bin/env python3
"""One-shot source-fidelity repair for historical CT Atlas geolocation errors.

This audit corrects records where publisher geography, translated headlines, or
an unrelated merged article contaminated event geolocation.  Selectors include
source/date/title where IDs are known to collide, so unrelated records sharing
an ID are never modified.

The script is idempotent: after the first successful run, a second run makes no
semantic changes.
"""
from __future__ import annotations

import json
from pathlib import Path

EVENTS_FILE = Path("events.json")
AUDIT_MODEL = "source-fidelity-audit-2026-10-07"
GEO_VERSION = "gemini-ai-first-v5.3-source-faithful"


def load():
    data = json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise RuntimeError("events.json has invalid structure")
    return data


def find_one(events, **selector):
    matches = [
        event
        for event in events
        if all(str(event.get(key) or "") == str(value) for key, value in selector.items())
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Selector {selector!r} matched {len(matches)} records")
    return matches[0]


def geo_signature(event):
    return (
        event.get("country"),
        event.get("country_code"),
        event.get("city"),
        event.get("region"),
        event.get("latitude"),
        event.get("longitude"),
        event.get("location_precision"),
        event.get("location_method"),
        tuple(event.get("location_evidence") or []),
        event.get("excluded_from_map"),
    )


def finish(event, reason):
    event["ai_geo_version"] = GEO_VERSION
    event["ai_geo_complete"] = True
    event["ai_geo_model"] = AUDIT_MODEL
    event["ai_geo_reason"] = reason
    event["ai_geo_inferred"] = False
    event["ai_geo_rescue_complete"] = True
    event["ai_geo_rescue_status"] = "source_verified"
    event["ai_geo_rescue_model"] = AUDIT_MODEL
    event["ai_geo_rescue_reason"] = reason


def city(event, *, country, code, name, lat, lon, evidence, reason, confidence=0.99):
    event.update(
        country=country,
        country_code=code,
        city=name,
        region=None,
        latitude=lat,
        longitude=lon,
        location_precision="city",
        location_confidence="high",
        location_confidence_score=confidence,
        location_method="source_verified_city",
        location_evidence=[evidence],
        excluded_from_map=False,
    )
    finish(event, reason)


def region(event, *, country, code, name, lat, lon, evidence, reason, confidence=0.95):
    event.update(
        country=country,
        country_code=code,
        city=None,
        region=name,
        latitude=lat,
        longitude=lon,
        location_precision="region",
        location_confidence="high" if confidence >= 0.85 else "medium",
        location_confidence_score=confidence,
        location_method="source_verified_region",
        location_evidence=[evidence],
        excluded_from_map=False,
    )
    finish(event, reason)


def country(event, *, name, code, capital, lat, lon, evidence, reason, confidence=0.90):
    event.update(
        country=name,
        country_code=code,
        city=capital,
        region=None,
        latitude=lat,
        longitude=lon,
        location_precision="country_capital",
        location_confidence="high" if confidence >= 0.85 else "medium",
        location_confidence_score=confidence,
        location_method="source_verified_country",
        location_evidence=[evidence],
        excluded_from_map=False,
    )
    finish(event, reason)


def unlocated(event, *, evidence, reason):
    event.update(
        country=None,
        country_code=None,
        city=None,
        region=None,
        latitude=None,
        longitude=None,
        location_precision="unlocated",
        location_confidence="low",
        location_confidence_score=0.0,
        location_method="source_verified_unlocated",
        location_evidence=[evidence],
        excluded_from_map=True,
    )
    finish(event, reason)


def main():
    data = load()
    events = data["events"]
    changed = []

    def apply(event, fn, **kwargs):
        before = geo_signature(event)
        fn(event, **kwargs)
        if geo_signature(event) != before:
            changed.append(
                {
                    "id": event.get("id"),
                    "title": event.get("title"),
                    "source": event.get("source"),
                    "country": event.get("country"),
                    "city": event.get("city"),
                    "region": event.get("region"),
                }
            )

    # 1. GMC Online: Brazilian publisher, Portland/Oregon event.
    event = find_one(
        events,
        id="73d72b30b1cad110",
        source="gmconline.com.br",
        published="2026-10-03T14:47:00+00:00",
    )
    event["title"] = (
        "Teenager accused of terrorism after bringing toxic products to school "
        "in Oregon, United States"
    )
    event["incident_id"] = "inc-70c5136ca5337962"
    event["incident_anchor"] = "US school chemical attack plot 2026"
    canonical = find_one(
        events,
        id="279703abf2682085",
        title=(
            "Teenager charged with attempted murder and domestic terrorism "
            "after mixing toxic chemicals at US school"
        ),
    )
    event["related_articles"] = [
        article
        for article in (canonical.get("related_articles") or [])
        if (
            "escola dos EUA" in str(article.get("title") or "")
            or "escola dos EUA" in str(article.get("original_title") or "")
            or "escola nos Estados Unidos" in str(article.get("title") or "")
            or "escola nos Estados Unidos" in str(article.get("original_title") or "")
            or "school" in str(article.get("title") or "").lower()
            or "school" in str(article.get("original_title") or "").lower()
        )
    ][:4]
    apply(
        event,
        city,
        country="United States",
        code="US",
        name="Portland",
        lat=45.52345,
        lon=-122.67621,
        evidence=(
            "GMC Online states the case occurred at Benson Polytechnic High "
            "School in Oregon; matching reports place it in Portland."
        ),
        reason=(
            "Historical correction: Brazilian publisher geography was mistaken "
            "for event geography."
        ),
    )

    # 2. Brazilian STJ ruling incorrectly pinned to Portugal.
    event = find_one(
        events,
        id="049c9d644064314a",
        source="Diário de Justiça",
        published="2026-10-03T00:30:00+00:00",
    )
    event["incident_id"] = "inc-248cd64620209c00"
    event["incident_anchor"] = "Brazil STJ terrorism preparatory acts ruling 2026"
    apply(
        event,
        city,
        country="Brazil",
        code="BR",
        name="Brasília",
        lat=-15.77972,
        lon=-47.92972,
        evidence=(
            "The report concerns Brazil's Superior Court of Justice (STJ) "
            "Sixth Chamber in Brasília."
        ),
        reason=(
            "Historical correction: Portuguese-language/source context had "
            "incorrectly produced Portugal."
        ),
    )

    # 3. Yakutia school plot incorrectly dragged to Iraq.
    event = find_one(
        events,
        id="1e29b7b40786022f",
        title="Teenager detained in Yakutia for planning school terrorist attack",
        source="Report.az",
        published="2026-09-29T14:41:02+00:00",
    )
    apply(
        event,
        region,
        country="Russia",
        code="RU",
        name="Verkhnevilyuysky District, Sakha Republic (Yakutia)",
        lat=63.44578,
        lon=120.30739,
        evidence=(
            "The original report places the school plot in Verkhnevilyuysky "
            "District, Republic of Sakha (Yakutia)."
        ),
        reason=(
            "Historical correction: Alsumaria publisher geography was not "
            "event-location evidence."
        ),
    )

    # 4. Manchester synagogue plot incorrectly pinned to Moscow.
    event = find_one(
        events,
        id="ff5d5220d4fa5662",
        source="Рамблер",
        published="2026-10-04T14:06:51+00:00",
    )
    apply(
        event,
        city,
        country="United Kingdom",
        code="GB",
        name="Manchester",
        lat=53.48095,
        lon=-2.23743,
        evidence="The report explicitly identifies a synagogue in Manchester as the target.",
        reason=(
            "Historical correction: Russian publisher geography was mistaken "
            "for event geography."
        ),
    )

    # 5. Whitby, Ontario synagogue threat incorrectly pinned to Israel.
    event = find_one(
        events,
        id="16e757fd6b88c699",
        title="Synagogue massacre averted at the last moment",
        source="המחדש",
        published="2026-09-22T07:27:00+00:00",
    )
    apply(
        event,
        city,
        country="Canada",
        code="CA",
        name="Whitby",
        lat=43.87983,
        lon=-78.942261,
        evidence=(
            "Durham Regional Police arrested a 19-year-old from Whitby, "
            "Ontario, over the synagogue threat."
        ),
        reason=(
            "Historical correction: Israeli publisher/language context was "
            "mistaken for the event location."
        ),
    )

    # 6. Bristol IS case incorrectly pinned to Nairobi by a Kenyan mirror.
    event = find_one(
        events,
        id="c8b0f216e5c46cc0",
        source="the-star.co.ke",
        published="2026-08-11T07:00:00+00:00",
    )
    apply(
        event,
        city,
        country="United Kingdom",
        code="GB",
        name="Bristol",
        lat=51.45523,
        lon=-2.59665,
        evidence=(
            "The underlying case concerns a man living in Bristol who attempted "
            "to join Islamic State after online radicalisation."
        ),
        reason=(
            "Historical correction: Kenyan mirror/source geography was mistaken "
            "for the case location."
        ),
    )

    # 7. Kemerovo case incorrectly fell back to Moscow.
    event = find_one(
        events,
        id="b7f25b2299e2d052",
        source="НК-ТВ",
        published="2026-09-07T06:51:21+00:00",
    )
    apply(
        event,
        city,
        country="Russia",
        code="RU",
        name="Kemerovo",
        lat=55.35417,
        lon=86.10435,
        evidence=(
            "The report identifies Kemerovo Central District Court and a "
            "Kemerovo terrorism-preparation case."
        ),
        reason=(
            "Historical correction: article text supplies Kemerovo; Moscow was "
            "only a country-capital fallback."
        ),
    )

    # 8. Edinburgh attacks incorrectly fell back to London.
    event = find_one(
        events,
        id="08446f30c0afda69",
        source="Sky News",
        published="2026-06-22T07:00:00+00:00",
    )
    apply(
        event,
        city,
        country="United Kingdom",
        code="GB",
        name="Edinburgh",
        lat=55.9533,
        lon=-3.1883,
        evidence=(
            "Sky News states the terrorism-linked attempted-murder charges "
            "concern attacks across Edinburgh."
        ),
        reason=(
            "Historical correction: UK capital fallback replaced with explicit "
            "incident city."
        ),
    )

    # 9. Cabo Delgado farmland arson incorrectly fell back to Maputo.
    event = find_one(
        events,
        id="8299040f4a6052c1",
        source="aimnews.org",
        published="2026-09-19T00:04:25+00:00",
    )
    apply(
        event,
        region,
        country="Mozambique",
        code="MZ",
        name="Cabo Delgado",
        lat=-12.9736,
        lon=40.5178,
        evidence=(
            "AIM places the farmland burning in Muidumbe district, "
            "Cabo Delgado province."
        ),
        reason=(
            "Historical correction: Mozambique country was right, but Maputo "
            "was only a publisher/capital fallback."
        ),
    )

    # 10. Borno operation incorrectly fell back to Abuja.
    event = find_one(
        events,
        id="f0ab8b9e7cda5b2e",
        source="Vanguard News",
        published="2026-09-05T15:57:44+00:00",
    )
    apply(
        event,
        city,
        country="Nigeria",
        code="NG",
        name="Monguno",
        lat=12.67059,
        lon=13.61224,
        evidence=(
            "The report states the two teenage militants surrendered to troops "
            "in Monguno, Borno State."
        ),
        reason=(
            "Historical correction: Abuja publisher/capital fallback replaced "
            "with explicit operational location."
        ),
    )

    # 11. Former soldier/ISIS case incorrectly fell back to Jerusalem.
    event = find_one(
        events,
        id="f03d8d9bd2730feb",
        title="Former Soldier on Trial for Espionage Denies ISIS Connection",
        source="i24NEWS",
        published="2026-09-02T18:14:43+00:00",
    )
    apply(
        event,
        region,
        country="Israel",
        code="IL",
        name="Galilee",
        lat=32.819,
        lon=35.298,
        evidence="The case identifies the former IDF soldier as a resident of the Galilee.",
        reason=(
            "Historical correction: Jerusalem was a country-capital fallback; "
            "the source supports Galilee."
        ),
    )

    # 12. PSOE explosives case incorrectly fell back to Madrid.
    event = find_one(
        events,
        id="61666e53a71e1287",
        source="EL PAÍS",
        published="2026-09-24T18:26:22+00:00",
    )
    apply(
        event,
        city,
        country="Spain",
        code="ES",
        name="Santander",
        lat=43.4623,
        lon=-3.80998,
        evidence="The explosive attack concerned the PSOE regional headquarters in Santander.",
        reason=(
            "Historical correction: Spain capital fallback replaced with "
            "explicit event city."
        ),
    )

    # 13. IMO statement incorrectly pinned to IMO headquarters in London.
    event = find_one(
        events,
        id="4ad5392484f2f7a7",
        source="gCaptain",
        published="2026-10-06T15:44:57+00:00",
    )
    apply(
        event,
        region,
        country="Somalia",
        code="SO",
        name="Off the coast of Somalia",
        lat=2.0469,
        lon=45.3182,
        evidence=(
            "The statement concerns five seafarers killed during the HONOUR 25 "
            "rescue in Somali waters."
        ),
        reason="Historical correction: IMO headquarters in London is not the event location.",
    )

    # 14. Vessel releases incorrectly fell back to Mogadishu.
    event = find_one(
        events,
        id="f670cbd8043d17f6",
        source="safety4sea",
        published="2026-10-05T09:12:41+00:00",
    )
    apply(
        event,
        region,
        country="Somalia",
        code="SO",
        name="Western Indian Ocean / Gulf of Aden",
        lat=8.0,
        lon=50.0,
        evidence=(
            "The report places the three releases in the Western Indian Ocean/"
            "Gulf of Aden region; Somalia assisted in securing releases."
        ),
        reason="Historical correction: Mogadishu was only a country-capital fallback.",
        confidence=0.90,
    )

    # 15. Sud Radio Flydubai item incorrectly pinned to France.
    event = find_one(
        events,
        id="388a2ccdeeb9ddce",
        source="sudradio.fr",
        published="2026-09-30T14:02:34+00:00",
    )
    apply(
        event,
        city,
        country="Saudi Arabia",
        code="SA",
        name="Tabuk",
        lat=28.3998,
        lon=36.5715,
        evidence=(
            "The Dubai-Tel Aviv flight diverted and landed at Tabuk, "
            "Saudi Arabia after the cockpit attack."
        ),
        reason="Historical correction: French publisher location was mistaken for event location.",
    )

    # 16. Heute Flydubai investigation incorrectly pinned to Austria.
    event = find_one(
        events,
        id="ebd1230d1d98b6c6",
        source="Heute",
        published="2026-10-06T03:25:08+00:00",
    )
    apply(
        event,
        city,
        country="Israel",
        code="IL",
        name="Tel Aviv",
        lat=32.08088,
        lon=34.78057,
        evidence=(
            "The investigation says the co-pilot repeatedly visited Ben Gurion "
            "and allegedly planned an attack on the Tel Aviv airport."
        ),
        reason="Historical correction: Austrian publisher context was mistaken for plot geography.",
    )

    # 17. Global UN warning incorrectly retained a Vietnam publisher pin.
    event = find_one(
        events,
        id="901dfebe62215e19",
        title=(
            "United Nations warns that artificial intelligence and video games "
            "are being exploited to radicalize youth"
        ),
        source="Vietnam.vn",
        published="2026-09-12T10:41:31+00:00",
    )
    apply(
        event,
        unlocated,
        evidence=(
            "Global United Nations warning on AI/video-game radicalisation; "
            "the item does not establish a single event location."
        ),
        reason="Historical correction: Vietnam.vn publisher geography is not an event location.",
    )

    # 18. CNN Brasil Flydubai follow-up incorrectly pinned to Brazil.
    event = find_one(
        events,
        id="d6b9b68686e27fe8",
        source="CNN Brasil",
        published="2026-10-02T20:25:00+00:00",
    )
    apply(
        event,
        city,
        country="Saudi Arabia",
        code="SA",
        name="Tabuk",
        lat=28.3998,
        lon=36.5715,
        evidence=(
            "The report concerns the Flydubai cockpit attack; the aircraft "
            "diverted to Tabuk and the suspect was questioned in Saudi Arabia."
        ),
        reason="Historical correction: CNN Brasil is the publisher, not the event location.",
    )

    # 19. Ynet Flydubai follow-up contaminated by an unrelated Portuguese related item.
    event = find_one(
        events,
        id="bce47be130e7293b",
        source="YNET",
        published="2026-10-03T13:56:04+00:00",
    )
    apply(
        event,
        city,
        country="Saudi Arabia",
        code="SA",
        name="Tabuk",
        lat=28.3998,
        lon=36.5715,
        evidence=(
            "The report concerns the same Flydubai cockpit attack; the aircraft "
            "landed at Tabuk, Saudi Arabia."
        ),
        reason=(
            "Historical correction: an unrelated Portuguese related headline "
            "had contaminated geolocation."
        ),
    )

    # 20. RTL Flydubai follow-up incorrectly used Oman background context.
    event = find_one(
        events,
        id="c10f6bef49ea0444",
        source="RTL Info",
        published="2026-10-03T01:02:20+00:00",
    )
    apply(
        event,
        city,
        country="Saudi Arabia",
        code="SA",
        name="Tabuk",
        lat=28.3998,
        lon=36.5715,
        evidence=(
            "The Flydubai FZ1073 cockpit attack caused the aircraft to divert "
            "to Tabuk, Saudi Arabia."
        ),
        reason=(
            "Historical correction: Oman is suspect/background context, not "
            "the incident location."
        ),
    )

    # 21. Ghana item retained, with article-supported evidence instead of publisher evidence.
    event = find_one(
        events,
        id="bd8965a8cbe02b72",
        source="Business & Financial Times",
        published="2026-09-09T02:04:04+00:00",
    )
    apply(
        event,
        country,
        name="Ghana",
        code="GH",
        capital="Accra",
        lat=5.55602,
        lon=-0.1969,
        evidence=(
            "The article explicitly says Ghana's fishing industry faces renewed "
            "concern over maritime insecurity."
        ),
        reason=(
            "Source-fidelity audit: Ghana is supported by article text, not "
            "inferred from publisher identity."
        ),
    )

    # 22. Kiyemba case retained in Kampala, now justified by case facts.
    event = find_one(
        events,
        id="b3fd459ffb1ceb4a",
        source="Daily Monitor",
        published="2026-08-11T07:00:00+00:00",
    )
    apply(
        event,
        city,
        country="Uganda",
        code="UG",
        name="Kampala",
        lat=0.31628,
        lon=32.58219,
        evidence=(
            "The conviction concerns solicitation for ADF support at Kampala's "
            "Old Taxi Park and Uganda's International Crimes Division."
        ),
        reason=(
            "Source-fidelity audit: Kampala is supported by the case facts, "
            "not by Daily Monitor's publisher location."
        ),
    )

    # 23. Matsaddash arrests happened in several Egyptian cities, not only Cairo.
    event = find_one(
        events,
        id="1b60b0f2ce49f2bd",
        source="repubblica.it",
        published="2026-10-01T15:18:24+00:00",
    )
    apply(
        event,
        country,
        name="Egypt",
        code="EG",
        capital="Cairo",
        lat=30.04442,
        lon=31.23571,
        evidence=(
            "The six journalists were arrested in separate operations in "
            "multiple Egyptian locations, including Gharbiya, Port Said and Cairo."
        ),
        reason=(
            "Historical correction: the event is Egypt-wide/multi-location; "
            "Cairo is only the country-level marker position."
        ),
    )

    # 24. Switch Off is an online-service/sanctions event without one physical site.
    event = find_one(
        events,
        id="a0bbdab6e8d4b761",
        source="tagesschau.de",
        published="2026-09-19T15:47:00+00:00",
    )
    apply(
        event,
        unlocated,
        evidence=(
            "The report concerns an online blog platform affected by US sanctions; "
            "the service, provider and sanctions involve multiple jurisdictions "
            "and no single physical incident location."
        ),
        reason=(
            "Historical correction: the Berlin-Brandenburg news section and "
            "German publisher context do not establish a physical event location."
        ),
    )

    if changed:
        EVENTS_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(f"Source-fidelity audit changed {len(changed)} event records")
    for item in changed:
        place = item["city"] or item["region"] or item["country"] or "UNLOCATED"
        print(f"- {item['id']} | {place} | {item['title']}")

    # The repair is intentionally idempotent.  Later audit revisions may add
    # a small number of newly verified corrections, so do not require an exact
    # first-pass count here; every target is still guarded by find_one().
    if len(changed) > 24:
        raise RuntimeError(f"Unexpected source-fidelity change count: {len(changed)}")


if __name__ == "__main__":
    main()
