from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]

def replace(text, before, after, count=1):
    if text.count(before) != count:
        raise RuntimeError(f'Expected {count} exact occurrences: {before[:90]!r}, found {text.count(before)}')
    return text.replace(before, after)

def read(path, expected):
    raw=(ROOT/path).read_bytes()
    actual=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    if actual != expected:
        raise RuntimeError(f'Unexpected source revision: {path} {actual}')
    return raw.decode('utf-8')

backend=read('cloudflare-worker/deep-search.js','7ec9561e926c1d0c1a3d0f337bd7bc3aa79860b6')
front=read('deep-search.js','9551f4ece54dc858f0ad4c4691421467eb9c6f8e')
recall=read('tests/deep-search-recall.test.cjs','4e2a329b586eb889d891718cb717c34ba025f502')
backend=replace(backend,'const DEEP_SEARCH_MAX_QUERIES = 24;','const DEEP_SEARCH_MAX_QUERIES = 28;')
backend=replace(backend,'deep-search-v15-atlas-ai','deep-search-v16-chinese-scripts')
backend=replace(backend,'fa: "persian", ur: "urdu", he: "hebrew", ps: "pashto"','fa: "persian", ur: "urdu", he: "hebrew", ps: "pashto",\n  zh: "chinese", "zh-Hant": "chinese (traditional)"')
backend=replace(backend,'tr: "tr-TR", ru: "ru-RU", fa: "fa-IR", ur: "ur-PK", he: "he-IL", ps: "ps-AF"','tr: "tr-TR", ru: "ru-RU", fa: "fa-IR", ur: "ur-PK", he: "he-IL", ps: "ps-AF",\n  zh: "zh-CN", "zh-Hant": "zh-TW"')
backend=replace(backend,'  ps: { label: "Pashto", hl: "ps", gl: "AF", ceid: "AF:ps" }','  ps: { label: "Pashto", hl: "ps", gl: "AF", ceid: "AF:ps" },\n  zh: { label: "Chinese (Simplified)", hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" },\n  "zh-Hant": { label: "Chinese (Traditional)", hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant" }')
backend=replace(backend,'const COUNTRY_LANGUAGE_PRIORITY = Object.freeze([','''const COUNTRY_LANGUAGE_PRIORITY = Object.freeze([
  { pattern: /\\b(?:china|chinese|beijing|shanghai|xinjiang)\\b|中国|中國|北京|上海|新疆/i, languages: ["zh", "zh-Hant"] },
  { pattern: /\\b(?:taiwan|taiwanese|hong kong|macau|macao)\\b|台湾|台灣|臺灣|香港|澳门|澳門/i, languages: ["zh-Hant", "zh"] },''')
backend=replace(backend,'const GDELT_LANGUAGE_CAP = 5;','const GDELT_LANGUAGE_CAP = DEEP_SEARCH_LANGUAGE_CODES.length;')
backend=replace(backend,'''// 24 base Google + up to 5 native-locale Google rescues + up to
// GDELT_MAX_CHUNKS GDELT date-range queries + 1 ACLED query + up to
// PRIORITY_LANGUAGE_CAP Bing rescues (only fired when Google came up sparse
// for that language, same trigger as the Google rescue above).
const MAX_SEARCH_SUBREQUESTS = DEEP_SEARCH_MAX_QUERIES + PRIORITY_LANGUAGE_CAP + GDELT_MAX_CHUNKS + 1 + PRIORITY_LANGUAGE_CAP;''','''// Keep the existing 40-request SEARCH ceiling after adding four Chinese queries.
// Reserve GDELT date chunks and ACLED before allocating optional Bing rescues.
// Virtual GDELT language attribution never adds provider requests.
const MAX_SEARCH_SUBREQUESTS = 40;''')
backend=replace(backend,'''Google News search queries in EACH of the 12 CT Atlas search languages (24 planned
queries total). Every Deep Search must search ALL 12 languages.

MANDATORY 12-LANGUAGE COVERAGE:''','''Google News search queries in EACH of the ${DEEP_SEARCH_LANGUAGE_CODES.length} CT Atlas
language/script options (${DEEP_SEARCH_MAX_QUERIES} planned queries total).
Every Deep Search must search ALL required language/script options.

MANDATORY LANGUAGE/SCRIPT COVERAGE:''')
backend=replace(backend,'- ps: Pashto\n\nQUESTION ANALYSIS','''- ps: Pashto
- zh: Chinese (Simplified; use Simplified Chinese queries and anchors)
- zh-Hant: Chinese (Traditional; use Traditional Chinese queries and anchors)

Chinese is one language with two separately searched writing systems. Search
Chinese sources regardless of the incident country. Never infer event location
from the language, search edition or publisher. Keep the final assessment in
English, preserving Chinese source names, titles and citations as evidence.

QUESTION ANALYSIS''')
backend=replace(backend,'all 12 languages','all required languages and scripts')
backend=replace(backend,'which of the 12 languages','which of the supported languages')
backend=replace(backend,'full 12-language search','full multilingual search')
backend=replace(backend,'tr; the Caucasus or Central Asia -> ru. Arabic','tr; the Caucasus or Central Asia -> ru; China -> zh, zh-Hant;\nTaiwan, Hong Kong or Macau -> zh-Hant, zh. Arabic')
backend=replace(backend,'if (anchor.length >= 3) anchors[language] = anchor;','''// Common Chinese names such as 中国 / 中國 and 伊朗 have two characters.
    const minimumAnchorLength = language === "zh" || language === "zh-Hant" ? 2 : 3;
    if (anchor.length >= minimumAnchorLength) anchors[language] = anchor;''')
backend=replace(backend,'An article in a language outside our 12 is dropped','An article in an unsupported language is dropped')
backend=replace(backend,'    const language = GDELT_LANGUAGE_NAME_TO_CODE[cleanText(article?.language, 40).toLowerCase()];','''    const providerLanguage = cleanText(article?.language, 40).toLowerCase();
    const language = GDELT_LANGUAGE_NAME_TO_CODE[providerLanguage];''')
backend=replace(backend,'      published: parseGdeltDate(article?.seendate),\n      language,','''      published: parseGdeltDate(article?.seendate),
      language,
      // GDELT's generic Chinese tag does NOT prove Simplified writing.
      ...(providerLanguage === "chinese" ? { language_script: "unspecified" } : {}),''')
backend=replace(backend,'''  // 24 Google News + max 5 priority Google rescues + up to GDELT_MAX_CHUNKS(5)
  // GDELT calls (see fetchGdeltChunked) + 1 ACLED call (see fetchAcledWave) +
  // max 5 Bing rescues (see fetchBingWave) = max 38 total, kept under ~40 so
  // the whole invocation (search + the ~9 calls above) stays safely under
  // 50.''','''  // 28 Google News + up to 5 priority Google rescues + up to 5 GDELT
  // date chunks + 1 ACLED call, then only the Bing rescues that fit in 40.
  // The four new Chinese queries must not raise the existing search ceiling.
  // This leaves the same nominal headroom for the non-search calls above.''')
backend=replace(backend,'  const bingRescueItems = [];','''  const reservedGdeltCalls = broadGdeltQuery(plan)
    ? gdeltChunkRanges(window.startDt, window.endDt).length : 0;
  const reservedAcledCalls = plan.queries.some(item => item.language === "en") ? 1 : 0;
  const bingBudget = Math.max(0, Math.min(PRIORITY_LANGUAGE_CAP,
    MAX_SEARCH_SUBREQUESTS - googleAll.length - reservedGdeltCalls - reservedAcledCalls));
  const bingRescueItems = [];''')
backend=replace(backend,'    if (candidate) bingRescueItems.push(candidate);','    if (candidate && bingRescueItems.length < bingBudget) bingRescueItems.push(candidate);')
backend=replace(backend,'    published: row.published, language: row.language,','''    published: row.published, language: row.language,
    ...(row.language_script ? { language_script: row.language_script } : {}),''')
front=replace(front,'two native-language Google News searches in each of the 12 supported languages, plus ACLED and GDELT','two native-language Google News searches in each of the 14 supported language/script options, including <strong>Chinese (Simplified)</strong> and <strong>Chinese (Traditional)</strong>, plus ACLED and GDELT')
front=replace(front,'before deduplication, CT Atlas comparison and source-cited analysis.','before deduplication, CT Atlas comparison and source-cited analysis. Reports remain in English. GDELT Chinese results may not specify the writing system; they are counted once under Chinese, not as verified Simplified or Traditional coverage.')
recall=replace(recall,'within 33 search calls (24 google','within 37 search calls (28 google')
recall=replace(recall,'assert.equal(calls.length,33);assert.equal(result.subrequest_budget.search_requests,33);','assert.equal(calls.length,37);assert.equal(result.subrequest_budget.search_requests,37);')
recall=replace(recall,'within the 36-call search budget','within the 40-call search budget')
recall=replace(recall,'assert.equal(calls.length,36);assert.equal(result.subrequest_budget.search_requests,36);','assert.equal(calls.length,40);assert.equal(result.subrequest_budget.search_requests,40);')
for path, text in [('cloudflare-worker/deep-search.js',backend),('deep-search.js',front),('tests/deep-search-recall.test.cjs',recall)]:
    (ROOT/path).write_bytes(text.encode('utf-8'))
    print('Updated',path)
