"""Regression tests for the Somalia/Djibouti/Yemen maritime-piracy coverage expansion,
the new Latin America multilingual profiles, and the stricter opinion/analysis filter
added to collector.py. No network access; collector.py is imported directly (it only
runs collection logic under `if __name__ == "__main__"`)."""
import importlib.util
import unittest

spec = importlib.util.spec_from_file_location("collector", "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class MaritimePiracyHornOfAfricaTests(unittest.TestCase):
    def test_houthi_attack_on_tanker_is_accepted_without_the_word_pirate(self):
        # This is the exact gap found live: a Red Sea/Gulf of Aden Houthi strike on
        # shipping never uses "pirate"/"piracy", so it used to fail piracy_anchor and
        # get rejected outright regardless of how clearly it's a maritime CT event.
        self.assertTrue(collector.is_relevant_article(
            "Maritime Piracy",
            "Houthi missile strike hits tanker in Gulf of Aden",
            "The vessel was targeted while transiting the Red Sea corridor off Yemen.",
        ))

    def test_classic_piracy_wording_still_accepted(self):
        self.assertTrue(collector.is_relevant_article(
            "Maritime Piracy",
            "Pirates hijacked cargo vessel off Somalia",
            "The crew was taken hostage before being rescued by naval forces.",
        ))

    def test_houthi_mention_alone_without_maritime_action_context_is_rejected(self):
        # The Houthi alternate path must still require maritime_anchor + action_hits,
        # not just the word "Houthi" anywhere in the text.
        self.assertFalse(collector.is_relevant_article(
            "Maritime Piracy",
            "Houthi spokesperson gives press conference on regional politics",
            "No vessel or maritime incident was mentioned.",
        ))

    def test_ct_anchors_recognise_houthi_and_the_single_a_shabaab_spelling(self):
        self.assertIn("houthi", collector.CT_ANCHORS)
        self.assertIn("houthis", collector.CT_ANCHORS)
        self.assertIn("al-shabab", collector.CT_ANCHORS)

    def test_category_relevance_and_action_terms_cover_the_region_and_ransom_vocabulary(self):
        relevance = collector.CATEGORY_RELEVANCE["Maritime Piracy"]
        for term in ("somalia", "djibouti", "yemen", "gulf of aden", "houthi", "ransom"):
            self.assertIn(term, relevance, term)
        actions = collector.ACTION_TERMS["Maritime Piracy"]
        for term in ("ransom", "missile strike", "drone strike"):
            self.assertIn(term, actions, term)

    def test_east_africa_profile_gained_somali_sites_and_a_maritime_query(self):
        profile = next(p for p in collector.MULTILINGUAL_PROFILES if p["name"] == "English / East Africa")
        self.assertTrue(profile["sites"], "East Africa profile must no longer have an empty sites list")
        self.assertIn("hiiraan.com", profile["sites"])
        self.assertTrue(
            any(q["category"] == "Maritime Piracy" for q in profile["queries"]),
            "East Africa profile must carry its own Maritime Piracy query",
        )

    def test_djibouti_is_a_recognised_country(self):
        self.assertIn("djibouti", collector.COUNTRY_CANONICAL)

    def test_horn_of_africa_maritime_sources_feed_targeted_source_sites(self):
        sites = {item["site"] for item in collector.TARGETED_SOURCE_SITES if item.get("category_hint") == "Maritime Piracy"}
        self.assertIn("hiiraan.com", sites)
        self.assertIn("icc-ccs.org", sites, "the original global maritime sources must still be present")

    def test_ai_selection_instructions_mention_the_region_and_houthi(self):
        text = collector.AI_SELECTION_INSTRUCTIONS.lower()
        for term in ("somalia", "djibouti", "yemen", "gulf of aden", "houthi"):
            self.assertIn(term, text, term)


class LatinAmericaCoverageTests(unittest.TestCase):
    def test_new_profiles_exist_and_are_distinct_from_the_spain_profile(self):
        names = {p["name"] for p in collector.MULTILINGUAL_PROFILES}
        self.assertIn("Spanish / Latin America", names)
        self.assertIn("Portuguese / Brazil", names)
        latam = next(p for p in collector.MULTILINGUAL_PROFILES if p["name"] == "Spanish / Latin America")
        spain = next(p for p in collector.MULTILINGUAL_PROFILES if p["name"] == "Spanish")
        self.assertNotEqual(latam["gl"], spain["gl"])
        self.assertNotEqual(latam["sites"], spain["sites"])

    def test_latin_america_profiles_are_included_in_backfill_new_sources(self):
        self.assertIn("Spanish / Latin America", collector.REGIONAL_BACKFILL_PROFILE_NAMES)
        self.assertIn("Portuguese / Brazil", collector.REGIONAL_BACKFILL_PROFILE_NAMES)
        profiles = collector.regional_backfill_profiles()
        names = {p["name"] for p in profiles}
        self.assertIn("Spanish / Latin America", names)
        self.assertIn("Portuguese / Brazil", names)

    def test_latin_american_armed_groups_are_recognised_as_non_state_actors(self):
        # out_of_scope_reason() returning "" means the article is treated as in-scope;
        # without this, these groups' own headlines could fall through to the
        # interstate-war/diplomacy rejection heuristics.
        for title in (
            "ELN ataca base militar en Colombia",
            "Tren de Aragua members arrested in Peru",
            "CJNG gunmen clash with security forces",
            "Sendero Luminoso ambush kills soldiers",
        ):
            self.assertEqual(collector.out_of_scope_reason({"title": title, "summary": ""}), "", title)

    def test_country_canonical_covers_the_named_latin_american_countries(self):
        for country in ("mexico", "colombia", "brazil", "peru", "venezuela", "ecuador"):
            self.assertIn(country, collector.COUNTRY_CANONICAL, country)

    def test_actor_aliases_cover_the_new_groups(self):
        for key in ("eln", "farc_dissidents", "sendero_luminoso", "tren_de_aragua", "sinaloa_cartel", "cjng", "ms_13"):
            self.assertIn(key, collector.ACTOR_ALIASES, key)

    def test_ai_selection_instructions_canonicalize_the_new_actors(self):
        text = collector.AI_SELECTION_INSTRUCTIONS
        for name in ("ELN", "Sendero Luminoso", "Tren de Aragua", "Sinaloa Cartel", "CJNG", "MS-13"):
            self.assertIn(name, text, name)


class OpinionAndAnalysisFilterTests(unittest.TestCase):
    def test_non_event_patterns_now_flag_analysis_and_editorial_language(self):
        for phrase in ("in-depth analysis", "an op-ed", "editorial board", "the crisis explained", "a personal perspective"):
            self.assertTrue(collector.has_non_event_pattern(phrase), phrase)

    def test_operational_event_requirement_is_present_and_precedes_the_scoring_policy(self):
        text = collector.AI_SELECTION_INSTRUCTIONS
        req_index = text.find("OPERATIONAL EVENT REQUIREMENT")
        policy_index = text.find("KEEPING POLICY")
        self.assertNotEqual(req_index, -1)
        self.assertNotEqual(policy_index, -1)
        self.assertLess(req_index, policy_index, "the operational-event rule should be stated before the keeping policy softens strictness")
        self.assertIn("concrete, dated operational", text)

    def test_a_pure_analysis_headline_with_only_background_actors_is_still_rejected_for_attacks(self):
        # Deterministic pre-filter sanity check (separate from the AI step): an
        # analysis piece merely naming a group in the title, no action term, no
        # anchor-heavy body evidence, must not pass as an "Attacks" event.
        self.assertFalse(collector.is_relevant_article(
            "Attacks",
            "Analysis: what ISIS's resurgence means for the region",
            "A broad discussion of geopolitical trends and historical context.",
        ))


if __name__ == "__main__":
    unittest.main()
