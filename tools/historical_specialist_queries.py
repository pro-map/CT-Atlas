"""Historical-only native discovery seeds for otherwise unsearched languages.

These are context-qualified news queries, not a full translation of every
English keyword or evidence of terrorism. Keep the existing five-language
vocabulary, all RN tasks and the Daily Update unchanged. The caller uses these
seeds ONLY when the shared vocabulary has no native queries for a language.
The usual source, relevance, state-actor and publication filters still apply.
"""
from __future__ import annotations

import threat_categories as topics

VERSION = "historical-specialist-native-seeds-v1-20261011"
# chemical phrases; explosive phrases; biological phrases; terrorism context.
# International substance names are kept alongside the translated concepts.
SEEDS = {
    "bn": (
        ("রাসায়নিক অস্ত্র", "রাসায়নিক হামলা", "বিষাক্ত গ্যাস", "সারিন"),
        ("বিস্ফোরক", "বোমা", "বোমা তৈরির সরঞ্জাম", "আইইডি"),
        ("জৈব সন্ত্রাসবাদ", "জৈব অস্ত্র", "অ্যানথ্রাক্স", "রিসিন"),
        ("সন্ত্রাসবাদ", "সন্ত্রাসী", "জঙ্গি"),
    ),
    "de": (
        ("Chemiewaffen", "Chemiewaffenanschlag", "Giftgas", "Sarin"),
        ("Sprengstoff", "Rohrbombe", "Autobombe", "Sprengsatz"),
        ("Bioterrorismus", "biologische Waffen", "Milzbrand", "Rizin"),
        ("Terrorismus", "Terroristen", "Terroranschlag"),
    ),
    "es": (
        ("armas químicas", "ataque químico", "gas tóxico", "sarín"),
        ("explosivos", "bomba casera", "coche bomba", "artefacto explosivo"),
        ("bioterrorismo", "armas biológicas", "ántrax", "ricina"),
        ("terrorismo", "terroristas", "atentado terrorista"),
    ),
    "fa": (
        ("سلاح شیمیایی", "حمله شیمیایی", "گاز سمی", "سارین"),
        ("مواد منفجره", "بمب دست ساز", "خودروی بمب گذاری شده", "بمب"),
        ("بیوتروریسم", "سلاح بیولوژیک", "سیاه زخم", "ریسین"),
        ("تروریسم", "تروریست", "حمله تروریستی"),
    ),
    "ha": (
        ("makaman sinadarai", "makamai masu guba", "gas mai guba", "sarin"),
        ("bama-bamai", "bam", "abubuwan fashewa", "IED"),
        ("makaman halittu", "makaman kwayoyin cuta", "anthrax", "ricin"),
        ("ta'addanci", "'yan ta'adda", "Boko Haram", "ISWAP"),
    ),
    "he": (
        ("נשק כימי", "מתקפה כימית", "גז רעיל", "סארין"),
        ("חומרי נפץ", "מטען חבלה", "מכונית תופת", "פצצת צינור"),
        ("טרור ביולוגי", "נשק ביולוגי", "אנתרקס", "ריצין"),
        ("טרור", "מחבלים", "פיגוע"),
    ),
    "hi": (
        ("रासायनिक हथियार", "रासायनिक हमला", "जहरीली गैस", "सरीन"),
        ("विस्फोटक", "पाइप बम", "कार बम", "आईईडी"),
        ("जैव आतंकवाद", "जैविक हथियार", "एंथ्रेक्स", "रिसिन"),
        ("आतंकवाद", "आतंकवादी", "आतंकी"),
    ),
    "id": (
        ("senjata kimia", "serangan kimia", "gas beracun", "sarin"),
        ("bahan peledak", "bom rakitan", "bom mobil", "bom pipa"),
        ("bioterorisme", "senjata biologis", "antraks", "risin"),
        ("terorisme", "teroris", "serangan teror"),
    ),
    "it": (
        ("armi chimiche", "attacco chimico", "gas tossico", "sarin"),
        ("esplosivi", "ordigno artigianale", "autobomba", "bomba a tubo"),
        ("bioterrorismo", "armi biologiche", "antrace", "ricina"),
        ("terrorismo", "terroristi", "attentato terroristico"),
    ),
    "ps": (
        ("کیمیاوي وسلې", "کیمیاوي برید", "زهرجن ګاز", "سارین"),
        ("چاودېدونکي توکي", "لاس جوړ بم", "موټر بم", "ماین"),
        ("بیولوژیکي وسلې", "بیولوژیکي برید", "انتراکس", "ریسین"),
        ("ترهګري", "ترهګر", "ترهګریز برید"),
    ),
    "pt": (
        ("armas químicas", "ataque químico", "gás tóxico", "sarin"),
        ("explosivos", "bomba caseira", "carro-bomba", "engenho explosivo"),
        ("bioterrorismo", "armas biológicas", "antraz", "ricina"),
        ("terrorismo", "terroristas", "atentado terrorista"),
    ),
    "ru": (
        ("химическое оружие", "химическая атака", "отравляющий газ", "зарин"),
        ("взрывчатка", "самодельное взрывное устройство", "заминированный автомобиль", "бомба"),
        ("биотерроризм", "биологическое оружие", "сибирская язва", "рицин"),
        ("терроризм", "террорист", "теракт"),
    ),
    "so": (
        ("hubka kiimikada", "weerar kiimiko", "gaas sun ah", "sarin"),
        ("walxaha qarxa", "bambo", "gaari qarax", "miino"),
        ("hubka noolaha", "hubka jeermiska", "anthrax", "ricin"),
        ("argagixiso", "argagixisada", "Al-Shabaab", "Daacish"),
    ),
    "sw": (
        ("silaha za kemikali", "shambulio la kemikali", "gesi yenye sumu", "sarin"),
        ("vilipuzi", "bomu la kutengenezwa", "gari la bomu", "bomu"),
        ("silaha za kibaolojia", "shambulio la kibaolojia", "kimeta", "risini"),
        ("ugaidi", "magaidi", "shambulio la kigaidi"),
    ),
    "tr": (
        ("kimyasal silah", "kimyasal saldırı", "zehirli gaz", "sarin"),
        ("patlayıcı", "el yapımı patlayıcı", "bombalı araç", "boru bomba"),
        ("biyoterörizm", "biyolojik silah", "şarbon", "risin"),
        ("terör", "terörist", "terör saldırısı"),
    ),
    "ur": (
        ("کیمیائی ہتھیار", "کیمیائی حملہ", "زہریلی گیس", "سارین"),
        ("دھماکہ خیز مواد", "دیسی ساختہ بم", "کار بم", "پائپ بم"),
        ("حیاتیاتی دہشت گردی", "حیاتیاتی ہتھیار", "اینتھراکس", "رائسن"),
        ("دہشت گردی", "دہشت گرد", "دہشتگرد"),
    ),
}


def _group(terms):
    if not terms or any(not isinstance(t, str) or not t.strip()
                        or any(ch in t for ch in ('"', '\n', '\r')) for t in terms):
        raise ValueError("Invalid historical native discovery term")
    if len(set(terms)) != len(terms):
        raise ValueError("Repeated historical native discovery term")
    return "(" + " OR ".join('"' + term + '"' for term in terms) + ")"


def queries(category, code):
    """Return fresh lists; never alter the shared daily vocabulary or profiles."""
    if category not in (topics.CE, topics.BIO) or code not in SEEDS:
        return []
    chemical, explosive, biological, context = SEEDS[code]
    material_groups = (chemical, explosive) if category == topics.CE else (biological,)
    return [_group(terms) + " " + _group(context) for terms in material_groups]
