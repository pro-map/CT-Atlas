# Temporary branch editor. No stored data, quota, secrets or schedules are edited.
from pathlib import Path
import ast, hashlib, json, subprocess, sys
R=Path.cwd()
BASE={'.github/workflows/python-tests.yml':'f29b7def0d3f186b279acc8ef35a65bc4776261b','collector.py':'0b680293cc5b32244664bf9723b78ebb47173667','ct-atlas-runtime.json':'946686728768a0e2d33c608bae151823af495fae','index.html':'b9e0d48fe776fbbb756f02370bdd6d0c1f1201fb','tests/enrich_archive_test.py':'e5be9ea7c66b3d900911730c48b882c3440e0374','tests/historical_specialist_languages_test.py':'a6c2c5231f65eabd6dead8ebfeb6a2d8262fd182','tests/runtime-config.test.cjs':'aea64b83e34e0f1dd00317e706e1367887bee94d','threat-category-keywords.json':'373c7121edd5afb7eebf5c9fb8ba158a0989441c','threat_categories.py':'9675254af67f45e4378b72bc9818f7ee5e3aacd1','tools/enrich_archive.py':'4566804163759a51904ad943ce21b2627245f054','tools/enrich_chinese_map.py':'cdcc0bdfe84f1c7b183f098cb659e4739cf23174','tools/enrich_radnuc.py':'234c81801d448ae8fbb41cb73d1c1b8c902d9eaa','tools/enrich_threat_categories.py':'2f2169fdd205939438e33f76a275769d5ed4a843','tools/historical_specialist_queries.py':'e196ed5e087f039e8b3ed460d2d432c6807341e4'}
EXPECTED={'.github/workflows/python-tests.yml':'88529fbf506dafc4af0e1dcd82bc030d61b41651','collector.py':'7e33c001cce1cf2fea18de9b98583a0fdaa8e4d2','ct-atlas-runtime.json':'d3cc0ee636ebe3e5e46d7cdf6f6eebb46f2f9bf1','index.html':'284b1425c7f4b772349a9063e54e817e88b56c36','tests/enrich_archive_test.py':'b9143d177809ce4f292cd24cfb8a3db7ce0f2c39','tests/historical_specialist_languages_test.py':'054977680a179a2cb69cc920f3f6c995eae12227','tests/runtime-config.test.cjs':'55d272f895e84267480f388217dc619b38426843','threat-category-keywords.json':'79b5332a6d50e82be304e6544339359ad4207f82','threat_categories.py':'0c2fd58c1473b3e614ff1fb57153eebf59af8689','tools/enrich_archive.py':'15e2a7afbb28ed31d5ed3bfdd781cb583df02fd2','tools/enrich_chinese_map.py':'afbefca407975b4a2d67d6fd294cb22b9c3c59b8','tools/enrich_radnuc.py':'74e54c6881ff81529dbce83b17083a28b3854cba','tools/enrich_threat_categories.py':'875a6675233c5107938d5a58ad5d239c3effed3d','tools/historical_specialist_queries.py':'aa7af6e898268c2e782b75b04af79f3b4dd58c66','collection_config.py':'4dff4b40dbaf6f8257d3e99044c7b5c819c0fc0d','tools/describe_collection.py':'68695668f9f1353d733091616af2486794759830'}
def blob_hash(name):
    data=(R/name).read_bytes()
    return hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
for name,sha in BASE.items():
    assert blob_hash(name)==sha, ('Unexpected input',name)
def read(name):return (R/name).read_bytes().decode()
def write(name,text):
    p=R/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(text.encode())
def replace(name,old,new,count=1):
    text=read(name)
    assert text.count(old)==count,(name,text.count(old),old[:120])
    write(name,text.replace(old,new))

old_native=read('tools/historical_specialist_queries.py')
node=next(n for n in ast.parse(old_native).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SEEDS' for t in n.targets))
seeds=ast.literal_eval(node.value)
vocab=json.loads(read('threat-category-keywords.json'))
for key,indices in [('chemical_explosives',(0,1)),('biological',(2,))]:
    vocab[key]['native_query_groups']={code:[list(parts[i]) for i in indices] for code,parts in seeds.items()}
    vocab[key]['native_query_context']={code:list(parts[3]) for code,parts in seeds.items()}
    vocab[key]['native_query_note']='Shared daily and historical discovery seeds for 16 additional codes. Existing query text is preserved; not a full translation of every English keyword or proof of successful source coverage.'
write('threat-category-keywords.json',json.dumps(vocab,ensure_ascii=False,indent=2)+'\n')
write('tools/historical_specialist_queries.py','''"""Compatibility API for the former historical-only native specialist seeds.

The authoritative terms now live in threat-category-keywords.json and serve
both daily intake and the historical planner. Existing query text is unchanged.
"""
import threat_categories as topics

VERSION = "historical-specialist-native-seeds-v1-20261011"
_chemical = topics.vocabulary()['chemical_explosives']
_biological = topics.vocabulary()['biological']
SEEDS = {
    code: (tuple(groups[0]), tuple(groups[1]),
           tuple(_biological['native_query_groups'][code][0]),
           tuple(_chemical['native_query_context'][code]))
    for code, groups in _chemical['native_query_groups'].items()
}
_group = topics.query_group


def queries(category, code):
    return topics.seed_queries(category, code)
''')
insert='''def query_group(terms):
    if not terms or any(not isinstance(t, str) or not t.strip()
                        or any(ch in t for ch in ('"', '\\n', '\\r')) for t in terms):
        raise ValueError('Invalid native discovery term')
    if len(set(terms)) != len(terms):
        raise ValueError('Repeated native discovery term')
    return '(' + ' OR '.join('"' + term + '"' for term in terms) + ')'


def seed_queries(category, code):
    """Shared native seeds; the old historical query strings remain identical."""
    key = {CE: 'chemical_explosives', BIO: 'biological'}.get(category)
    if key is None:
        return []
    item = vocabulary()[key]
    groups = item.get('native_query_groups', {}).get(code, [])
    context = item.get('native_query_context', {}).get(code, [])
    if not groups and not context:
        return []
    if not groups or not context:
        raise ValueError(f'Incomplete specialist seed vocabulary: {category}/{code}')
    return [query_group(group) + ' ' + query_group(context) for group in groups]


def collection_queries(category, code='en'):
    """Authoritative complete query API shared by daily and historical intake."""
    return queries(category, code) or seed_queries(category, code)


'''
replace('threat_categories.py','def install_collection(namespace):',insert+'def install_collection(namespace):')
replace('threat_categories.py',"    for label, terms in ((RN,['radiological','radioactive','nuclear','uranium','dirty bomb']),",'''    # Freeze the PRE-ALIGNMENT daily replay surface for the older general
    # archive planner. Expanding daily intake must not recreate historical work.
    import copy
    import collection_config
    namespace.setdefault('HISTORICAL_REPLAY_PROFILES', copy.deepcopy(namespace['MULTILINGUAL_PROFILES']))
    collection_config.extend_specialist_profiles(namespace['MULTILINGUAL_PROFILES'])
    for profile in namespace['MULTILINGUAL_PROFILES']:
        for label in LABELS:
            for query in collection_queries(label, profile['code']):
                item = {'term': query, 'category': label}
                if item not in profile['queries']:
                    profile['queries'].append(item)
    for label, terms in ((RN,['radiological','radioactive','nuclear','uranium','dirty bomb']),''')
replace('threat_categories.py','    """Material phrases AND context anchors; no isolated generic search terms."""','    """Curated query groups; collection_queries also includes shared native seeds."""')
name='collector.py';text=read(name);lines=text.splitlines(keepends=True);spans=[]
for node in ast.parse(text).body:
    if not isinstance(node,ast.Assign) or not isinstance(node.value,ast.Dict):continue
    names={t.id for t in node.targets if isinstance(t,ast.Name)}
    if not names & {'CATEGORIES','CORE_SEARCH_QUERIES','OFFICIAL_SOURCE_QUERIES','TARGETED_MEDIA_CATEGORY_TERMS'}:continue
    for key,value in zip(node.value.keys,node.value.values):
        if isinstance(key,ast.Constant) and key.value=='CBRN':spans.append((key.lineno-1,value.end_lineno))
assert len(spans)==4
for start,end in reversed(spans):
    lines[start:end]=['    # Specialist categories are installed from threat_categories.py below.\n']
write(name,''.join(lines))
replace(name,'import threat_categories\n','import threat_categories\nimport collection_config\n')
replace(name,'# OSINT COLLECTOR V13 — INCREMENTAL BACKFILL + RESUMABLE COLLECTION','''# OSINT COLLECTOR V13 — INCREMENTAL BACKFILL + RESUMABLE COLLECTION
#
# EFFECTIVE CONFIGURATION (not the historical defaults in this file):
# - threat_categories.install_collection loads the three specialist categories
#   from threat-category-keywords.json, radnuc.py and radnuc-keywords.json.
# - collection_config aligns daily specialist searches with all 21 codes.
# - tools/run_collector_quota_safe.py supplies the DAILY model/budget/threshold.
# - tools/enrich_threat_categories.py and tools/enrich_chinese_map.py have
#   separate historical checkpoints and choose their backend in the workflow.
# Inspect without collecting: python tools/describe_collection.py --check
# See docs/COLLECTION_CONFIGURATION.md. CBRN source hints/legacy fields are
# deliberate compatibility, not a user-facing parent category.''')
replace(name,'# The same historical Chinese search vocabulary is shared with the separate\n# six-month Qwen experiment, but the daily path deliberately runs ONLY ONE','# Daily and historical Chinese searches use separate bounded query plans.\n# The daily path deliberately runs ONLY ONE')
replace(name,'''        "source_languages":
            [
                "en", "fr", "ar", "de", "es", "it",
                "tr", "ru", "ur", "fa", "he", "ps"
            ],''','''        "source_languages":
            collection_config.language_metadata(MULTILINGUAL_PROFILES)['language_codes'],
        "collection_configuration": collection_config.effective(globals()),''')
replace(name,'    is_backfill, COLLECTION_SCOPE = parse_collection_mode()\n','''    is_backfill, COLLECTION_SCOPE = parse_collection_mode()
    effective_config = collection_config.validate_runtime(globals())
    print('Effective configured collection: ' + json.dumps(effective_config, ensure_ascii=False))
''')
replace('tools/enrich_threat_categories.py','import historical_specialist_queries\n','')
replace('tools/enrich_threat_categories.py','''            # Historical-only discovery for languages absent from the shared
            # five-language CE/BIO vocabulary. Existing queries/keys win intact.
            native = (topics.queries(category,profile['code']) or
                      historical_specialist_queries.queries(category,profile['code']))''','''            # Shared with daily collection; existing queries/keys stay intact.
            native = topics.collection_queries(category, profile['code'])''')
replace('tools/enrich_archive.py','replayed(google_tasks(collector.MULTILINGUAL_PROFILES, "daily_profile"))','replayed(google_tasks(getattr(collector, "HISTORICAL_REPLAY_PROFILES", collector.MULTILINGUAL_PROFILES), "daily_profile"))')
replace('tools/enrich_archive.py','# Languages the daily collection does not search. Somali and Hausa have no','# Legacy general-archive language profiles (identities retained). Daily now\n# also searches specialist topics in these languages. Somali and Hausa have no')
replace('tools/enrich_radnuc.py','''# These are HISTORICAL specialist-backfill editions only: no change to the
# Gemini daily collector, its language mix or its request allocations.''','''# Fixed historical edition identities, also present in daily collection.
# They are not a model, quota or scheduling configuration.''')
replace('tools/enrich_radnuc.py',"'languages': sorted(radnuc.LEXICONS) if self.category == threat_categories.RN else sorted(threat_categories.vocabulary()['biological' if self.category == threat_categories.BIO else 'chemical_explosives']['terms'])","'languages': sorted({p['code'] for p in profiles(self.collector) if threat_categories.collection_queries(self.category, p['code'])})")
replace('tools/enrich_radnuc.py',"'pipeline': 'existing Gemini selection, English translation and incremental event deduplication'","'pipeline': 'Shared selection schema, English translation and incremental event deduplication',\n                'model': self.collector.AI_SELECTION_MODEL")
replace('tools/enrich_chinese_map.py','''"""Gemini-only, resumable six-month history for eight Map topics in two Chinese scripts.

Search editions are discovery hints, NEVER event locations or proof of relevance.
Runs off the ordinary GEMINI enrichment ledger (no extra daily allowance), in
bounded batches. Checkpoints and publication metadata are separate from CBRNE.
No Qwen / Ollama dependency, no automatic background bulk processing.
"""''','''"""Resumable six-month history for eight Map topics in two Chinese scripts.

The active workflow selects Groq with CT_ATLAS_BACKFILL_PROVIDER=groq;
manual Gemini fallback uses its existing separate ledger. Historical Gemini
filenames are retained so that source/review checkpoints do not restart.
Search editions are hints, NEVER event locations or proof of relevance.
No Qwen/Ollama dependency. This runner is not the ordinary daily collector.
"""''')
write('tools/describe_collection.py','''#!/usr/bin/env python3
"""Print effective loaded collection settings without network calls or writes."""
import argparse
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import collector
import collection_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if runtime metadata disagrees with loaded collection')
    args = parser.parse_args()
    report = (collection_config.validate_runtime(vars(collector)) if args.check
              else collection_config.effective(vars(collector)))
    report['scheduled_selection_threshold'] = json.loads((ROOT / 'ct-atlas-runtime.json').read_text())['ai_selection_threshold']
    report['planned_daily_requests'] = collector.planned_collection_query_count()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
''')
meta=json.loads(subprocess.check_output([sys.executable,'-c','import json,collector,collection_config; print(json.dumps(collection_config.language_metadata(collector.MULTILINGUAL_PROFILES)))'],cwd=R))
assert meta['collection_languages']==20 and meta['language_variants']==21
runtime=json.loads(read('ct-atlas-runtime.json'));runtime.update(meta)
runtime['collection_config_version']='shared-collection-v1-20261012'
runtime['language_scope_note']='Configured discovery: all three specialist topics in 21 codes (20 languages). Added editions may cover specialist topics only; counts do not prove completed retrieval or translation.'
write('ct-atlas-runtime.json',json.dumps(runtime,ensure_ascii=False,indent=2)+'\n')
name='index.html'
replace(name,'  collection_languages: 12,\r\n  translated_languages: 11,','  collection_languages: 20,\r\n  translated_languages: 19,\r\n  language_variants: 21,\r\n  translated_language_variants: 20,')
replace(name,'Number(ctAtlasRuntimeConfig.collection_languages || 12) + " total"','Number(ctAtlasRuntimeConfig.collection_languages || 20) + " languages / " + Number(ctAtlasRuntimeConfig.language_variants || 21) + " codes"')
replace(name,'Number(ctAtlasRuntimeConfig.translated_languages || 11) + " → English"','Number(ctAtlasRuntimeConfig.translated_languages || 19) + " languages → English"')
replace(name,'<span>Collection languages</span><strong id="healthCollectionLanguages">12 total</strong>','<span>Configured source coverage</span><strong id="healthCollectionLanguages">20 languages / 21 codes</strong>')
replace(name,'<span>Translated languages</span><strong id="healthTranslatedLanguages">11 → English</strong>','<span>Translation configured</span><strong id="healthTranslatedLanguages">19 languages → English</strong>')
replace(name,'<div class="mini-metric" title="11 non-English source languages translated into English; 12 collection languages in total including English.">\r\n                <div class="value">10</div>\r\n                <div class="label">Translated languages</div>','<div class="mini-metric" title="Configured source coverage: 20 languages / 21 codes, including two Chinese writing systems. Some editions search specialist topics only. This is not a completed-translation count.">\r\n                <div class="value" id="railTranslationLanguages">19</div>\r\n                <div class="label">Translation languages</div>')
replace(name,'  set("healthRetention", Number(ctAtlasRuntimeConfig.retention_days || 180) + " days");','  set("railTranslationLanguages", Number(ctAtlasRuntimeConfig.translated_languages || 19));\r\n  set("healthRetention", Number(ctAtlasRuntimeConfig.retention_days || 180) + " days");')
replace(name,'Status reflects the current application configuration and the database loaded by this page. Schedule timezone: ','Language counts describe configured searches, not completed coverage; some editions search specialist topics only. Status also reflects the database loaded by this page. Schedule timezone: ')
name='tests/runtime-config.test.cjs'
replace(name,'assert.equal(config.collection_languages,12);','assert.equal(config.collection_languages,20);')
replace(name,'assert.equal(config.translated_languages,11);','assert.equal(config.translated_languages,19);')
replace(name,'assert.equal(config.language_codes.length,12);','''assert.equal(config.language_codes.length,21);
  assert.equal(config.language_variants,21);
  assert.equal(config.translated_language_variants,20);
  assert.equal(new Set(config.language_codes.map(code=>code.split('-')[0])).size,config.collection_languages);
  assert.ok(config.language_codes.includes('zh') && config.language_codes.includes('zh-Hant'));''')
replace('tests/historical_specialist_languages_test.py','with patch.object(native, "queries", return_value=[]):','with patch.object(topics, "collection_queries", side_effect=topics.queries):')
replace('tests/historical_specialist_languages_test.py','"""Offline regression tests for additive, historical-only language coverage."""','"""Offline regression tests for retained historical language coverage and keys."""')
replace('.github/workflows/python-tests.yml','      - "collector.py"','''      - "collector.py"
      - "collection_config.py"
      - "ct-atlas-runtime.json"
      - "radnuc-keywords.json"
      - "radnuc_vocabulary.py"
      - "chinese-map-backfill-queries.json"
      - "chinese-gemini-backfill-queries.json"''',count=2)
replace('tests/enrich_archive_test.py','''    def test_the_daily_collection_profiles_are_not_changed(self):
        codes = {profile["code"] for profile in collector.MULTILINGUAL_PROFILES}
        self.assertFalse({"hi", "bn", "id", "so", "ha"} & codes)''','''    def test_general_archive_replay_stays_frozen_after_daily_specialist_expansion(self):
        codes = {profile["code"] for profile in collector.HISTORICAL_REPLAY_PROFILES}
        self.assertFalse({"hi", "bn", "id", "so", "ha"} & codes)
        daily = {profile["code"] for profile in collector.MULTILINGUAL_PROFILES}
        self.assertTrue({"hi", "bn", "id", "so", "ha", "sw"} <= daily)''')
replace('tools/enrich_archive.py',"daily collection never reviewed: languages it does not search (Hindi, Bengali,\nIndonesian, Mozambique Portuguese, Somali, Hausa), GDELT's Persian, Urdu,\nPashto, Hausa, Somali and Swahili sources, and week-by-week searches of the\nlanguages it does.","daily collection never reviewed: the original extra-language discovery plan,\nGDELT's Persian, Urdu, Pashto, Hausa, Somali and Swahili sources, and fixed\nreplay searches of the pre-alignment daily profiles. Daily now also uses\nspecialist queries in those extra languages; that expansion does not reset or\nexpand this older archive plan.")
write('tests/runtime-config.test.cjs',read('tests/runtime-config.test.cjs')+'''

test('status and summary describe configured languages and both Chinese scripts, not completed translations',()=>{
  const vm=require('node:vm');
  const elements={};
  const context={document:{getElementById(id){return elements[id] ||= {textContent:''};}}};
  vm.createContext(context);
  const start=html.indexOf('let ctAtlasRuntimeConfig =');
  const end=html.indexOf('async function loadCtAtlasRuntimeConfig',start);
  assert.ok(start>=0 && end>start);
  vm.runInContext(html.slice(start,end),context);
  context.applyCtAtlasRuntimeConfig(config);
  assert.equal(elements.healthCollectionLanguages.textContent,'20 languages / 21 codes');
  assert.equal(elements.healthTranslatedLanguages.textContent,'19 languages → English');
  assert.equal(elements.railTranslationLanguages.textContent,19);
  assert.match(elements.healthStatusNote.textContent,/configured searches, not completed coverage/);
  assert.match(html,/id="railTranslationLanguages"/);
});
''')
for name,sha in EXPECTED.items():
    assert blob_hash(name)==sha,('Unexpected output',name,blob_hash(name),sha)
print('Validated exact tested output for',len(EXPECTED),'files')
