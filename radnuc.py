"""RADNUC retrieval hints and metadata. Keywords never establish terrorism.

State military/intelligence operations (including Iran/Israel nuclear-site
strikes) are excluded. State investigations AGAINST non-state suspects remain
eligible. Do not exclude entire countries or confuse state-backed groups with
regular state forces. Gemini is the semantic scope/intent judge.
"""
import re

KEYWORDS = [
    "nuclear", "radioactive", "radiological", "red mercury", "uranium smuggling",
    "illegal uranium mining", "radiopharmaceutical", "nuclear power plant",
    "cyberattack on nuclear plant", "AI for nuclear", "nuclear supply chain",
    "nuclear transport", "drones over nuclear sites", "cesium", "thorium", "dirty bomb",
]
ENGLISH_QUERIES = [
    '(nuclear OR radioactive OR radiological OR cesium OR caesium OR thorium OR radiopharmaceutical OR "dirty bomb") (terrorism OR terrorist OR extremist OR "bomb plot")',
    '("uranium smuggling" OR "illegal uranium mining" OR "red mercury" OR radioactive OR radiopharmaceutical OR cesium OR thorium) (smuggling OR trafficking OR stolen OR theft OR seizure OR arrest OR investigation)',
    '("nuclear power plant" OR "nuclear supply chain" OR "nuclear transport" OR "nuclear sites") (cyberattack OR sabotage OR drones OR "terror plot")',
    '("AI for nuclear" OR "cyberattack on nuclear plant" OR "drones over nuclear sites" OR "dirty bomb") (terrorist OR terrorism OR plot OR investigation)',
]
# material, non-state threat, crime/investigation, infrastructure, malicious act.
# Local-script searches complement GDELT's multilingual translated full-text index.
LEXICONS = {
    "en": ('nuclear OR radioactive OR radiological OR uranium OR cesium OR thorium OR "dirty bomb"', 'terrorist OR terrorism OR extremist', 'smuggling OR trafficking OR theft OR seized OR arrested', '"nuclear plant" OR "nuclear transport"', 'sabotage OR cyberattack OR drones OR plot'),
    "fr": ('nucléaire OR radioactif OR radiologique OR uranium OR césium OR thorium OR "bombe sale"', 'terrorisme OR terroriste OR extrémiste', 'trafic OR contrebande OR vol OR saisie OR arrestation', '"centrale nucléaire" OR "transport nucléaire"', 'sabotage OR cyberattaque OR drones OR complot'),
    "ar": ('نووي OR نووية OR إشعاعي OR "مواد مشعة" OR يورانيوم OR سيزيوم OR ثوريوم OR "قنبلة قذرة"', 'إرهاب OR إرهابي OR متطرف', 'تهريب OR سرقة OR ضبط OR اعتقال OR تحقيق', '"محطة نووية" OR "منشأة نووية"', 'تخريب OR "هجوم إلكتروني" OR "طائرات مسيرة" OR مخطط'),
    "de": ('nuklear OR radioaktiv OR radiologisch OR Uran OR Cäsium OR Thorium OR "schmutzige Bombe"', 'Terrorismus OR Terrorist OR Extremist', 'Schmuggel OR Diebstahl OR Beschlagnahme OR Festnahme', 'Atomkraftwerk OR Nukleartransport', 'Sabotage OR Cyberangriff OR Drohnen OR Anschlagsplan'),
    "es": ('nuclear OR radiactivo OR radiológico OR uranio OR cesio OR torio OR "bomba sucia"', 'terrorismo OR terrorista OR extremista', 'contrabando OR tráfico OR robo OR incautación OR detención', '"central nuclear" OR "transporte nuclear"', 'sabotaje OR ciberataque OR drones OR complot'),
    "it": ('nucleare OR radioattivo OR radiologico OR uranio OR cesio OR torio OR "bomba sporca"', 'terrorismo OR terrorista OR estremista', 'contrabbando OR traffico OR furto OR sequestro OR arresto', '"centrale nucleare" OR "trasporto nucleare"', 'sabotaggio OR attacco informatico OR droni OR complotto'),
    "tr": ('nükleer OR radyoaktif OR radyolojik OR uranyum OR sezyum OR toryum OR "kirli bomba"', 'terör OR terörist OR aşırılıkçı', 'kaçakçılık OR hırsızlık OR operasyon OR tutuklama', '"nükleer santral" OR "nükleer taşıma"', 'sabotaj OR "siber saldırı" OR drone OR plan'),
    "ru": ('ядерный OR радиоактивный OR радиологический OR уран OR цезий OR торий OR "грязная бомба"', 'терроризм OR террорист OR экстремист', 'контрабанда OR кража OR изъятие OR задержание', 'АЭС OR "ядерный объект"', 'диверсия OR кибератака OR беспилотники OR заговор'),
    "ur": ('جوہری OR تابکار OR یورینیم OR سیزیم OR تھوریم OR "گندا بم"', 'دہشتگرد OR "دہشت گردی" OR انتہا پسند', 'اسمگلنگ OR چوری OR ضبط OR گرفتار OR تحقیقات', '"جوہری پلانٹ" OR "جوہری تنصیبات"', 'تخریب OR "سائبر حملہ" OR ڈرون OR سازش'),
    "fa": ('هسته‌ای OR رادیواکتیو OR پرتوزا OR اورانیوم OR سزیم OR توریم OR "بمب کثیف"', 'تروریسم OR تروریست OR افراطی', 'قاچاق OR سرقت OR توقیف OR بازداشت OR تحقیقات', '"نیروگاه هسته‌ای" OR "تأسیسات هسته‌ای"', 'خرابکاری OR "حمله سایبری" OR پهپاد OR توطئه'),
    "ps": ('اټومي OR راډیواکټیف OR یورانیم OR "ناپاک بم"', 'ترهګر OR ترهګري OR داعش', 'قاچاق OR غلا OR نیول OR ضبط OR پلټنه', '"اټومي بټۍ" OR "اټومي تاسیسات"', 'تخریب OR "سایبري برید" OR ډرون OR پلان'),
    "he": ('גרעיני OR רדיואקטיבי OR רדיולוגי OR אורניום OR צזיום OR תוריום OR "פצצה מלוכלכת"', 'טרור OR טרוריסט OR קיצוני', 'הברחה OR גניבה OR תפיסה OR מעצר OR חקירה', '"תחנת כוח גרעינית" OR "מתקן גרעיני"', 'חבלה OR "מתקפת סייבר" OR רחפנים OR מזימה'),
    "pt": ('nuclear OR radioativo OR radiológico OR urânio OR césio OR tório OR "bomba suja"', 'terrorismo OR terrorista OR extremista', 'contrabando OR tráfico OR roubo OR apreensão OR prisão', '"central nuclear" OR "transporte nuclear"', 'sabotagem OR ciberataque OR drones OR conspiração'),
    "hi": ('परमाणु OR रेडियोधर्मी OR विकिरण OR यूरेनियम OR सीजियम OR थोरियम OR "डर्टी बम"', 'आतंकवाद OR आतंकवादी OR चरमपंथी', 'तस्करी OR चोरी OR जब्त OR गिरफ्तार OR जांच', '"परमाणु संयंत्र" OR "परमाणु परिवहन"', 'तोड़फोड़ OR "साइबर हमला" OR ड्रोन OR साजिश'),
    "bn": ('পারমাণবিক OR তেজস্ক্রিয় OR ইউরেনিয়াম OR সিজিয়াম OR থোরিয়াম OR "ডার্টি বোমা"', 'সন্ত্রাসবাদ OR সন্ত্রাসী OR জঙ্গি', 'পাচার OR চুরি OR জব্দ OR গ্রেপ্তার OR তদন্ত', '"পারমাণবিক বিদ্যুৎকেন্দ্র" OR "পারমাণবিক স্থাপনা"', 'নাশকতা OR "সাইবার হামলা" OR ড্রোন OR ষড়যন্ত্র'),
    "id": ('nuklir OR radioaktif OR radiologi OR uranium OR sesium OR torium OR "bom kotor"', 'terorisme OR teroris OR ekstremis', 'penyelundupan OR pencurian OR penyitaan OR ditangkap OR penyelidikan', '"pembangkit nuklir" OR "transportasi nuklir"', 'sabotase OR "serangan siber" OR drone OR rencana'),
    "so": ('nukliyeer OR shucaac OR yuraaniyam OR "bam wasakh"', 'argagixiso OR argagixisada OR Shabaab', 'tahriib OR xatooyo OR qabtay OR xabsi OR baaritaan', '"warshad nukliyeer" OR "xarun nukliyeer"', 'qarxin OR weerar OR diyaarado OR qorshe'),
    "ha": ('nukiliya OR rediyoaktif OR uranium OR "bam mai datti"', 'ta’addanci OR ta’adda OR "Boko Haram"', 'fasa-kwauri OR sata OR kama OR bincike', '"tashar nukiliya" OR "wurin nukiliya"', 'zagon-kasa OR hari OR jirage OR makirci'),
    "sw": ('nyuklia OR mionzi OR urani OR "bomu chafu"', 'ugaidi OR magaidi OR Shabaab', 'magendo OR wizi OR kukamatwa OR uchunguzi', '"mtambo wa nyuklia" OR "usafirishaji wa nyuklia"', 'hujuma OR "shambulio la mtandao" OR droni OR njama'),
}


def queries(code):
    if code == "en":
        return list(ENGLISH_QUERIES)
    material, terror, crime, site, malicious = LEXICONS[code]
    return [f'({material}) ({terror})', f'({material}) ({crime})', f'({site}) ({malicious})']


_RADNUC = re.compile(r'\b(?:nuclear|radioactiv\w*|radiolog\w*|uranium|plutonium|cesium|caesium|cobalt[- ]?60|thorium|radiopharmaceutical\w*|dirty bomb|red mercury|fissile)\b', re.I)
_STATE_ACTION = re.compile(r'\b(?:iran(?:ian)?|israel(?:i)?|russia(?:n)?|ukrain(?:ian)?|united states|us military|u\.s\.|idf|irgc|mossad|army|military|air force|intelligence service)\b.{0,100}\b(?:strik\w*|bomb\w*|attack\w*|sabotag\w*|cyberattack\w*|raid\w*)\b', re.I)
_NONSTATE_ACTION = re.compile(r'\b(?:terrorists?|extremists?|militants?|insurgents?|isis|isil|daesh|al.qaeda|lone.actor|suspects?|cell)\b.{0,100}\b(?:plot\w*|attack\w*|arrest\w*|detain\w*|charg\w*|seiz\w*|smuggl\w*|steal\w*|stole\w*|traffic\w*)\b|\b(?:arrest\w*|detain\w*|charg\w*|seiz\w*)\b.{0,100}\b(?:terrorists?|extremists?|militants?|isis|suspects?|cell)\b', re.I)


def has_material(event):
    return bool(_RADNUC.search(' '.join(str(event.get(k) or '') for k in ('title', 'summary', 'ai_canonical_event'))))


def state_operation_reason(event, actor_scope=None):
    if str(actor_scope or event.get('actor_scope') or '').upper() == 'STATE_ONLY':
        return 'RADNUC excludes operations carried out by states or regular armed forces/intelligence services'
    # A country mention is not an exclusion; an explicit state attack is.
    title = str(event.get('title') or '')
    if has_material(event) and _STATE_ACTION.search(title) and not _NONSTATE_ACTION.search(title):
        return 'RADNUC excludes state military operations, including interstate nuclear-site strikes'
    return ''


def annotate(event, result=None):
    categories = event.get('categories') or [event.get('category')]
    explicit = (result or {}).get('cbrn_subgroups')
    if explicit is not None:
        event['cbrn_subgroups'] = ['RADNUC'] if 'RADNUC' in explicit else []
        if 'RADNUC' in explicit and 'CBRN' not in categories:
            categories = [c for c in categories if c] + ['CBRN']
            event['categories'] = categories
    elif 'CBRN' in categories and 'cbrn_subgroups' not in event and has_material(event):
        # Compatibility for retained, English-normalized legacy records only.
        event['cbrn_subgroups'] = ['RADNUC']
    if (result or {}).get('actor_scope'):
        event['actor_scope'] = result['actor_scope']
    return event


SELECTION_NOTE = '''
RADNUC (subgroup of CBRN): identify concrete non-state radiological/nuclear
terrorism attacks, attempted attacks, plots, material trafficking/theft/seizures
with a credible reported terrorism nexus, investigations and judicial updates.
Return cbrn_subgroups=["RADNUC"] only when radiological/nuclear facts are central;
otherwise []. Return actor_scope=NON_STATE, STATE_ONLY or UNKNOWN according to
who carried out the reported act, not the publisher, victim or investigating agency.
Reject STATE_ONLY even if the report calls a country terrorist or incidentally
mentions ISIS/Hamas/Hezbollah. This explicitly excludes Iran-Israel warfare,
Iranian/Israeli/US or other state nuclear-site strikes, intelligence-service
sabotage, interstate cyber operations, military threats and nuclear programmes.
For RADNUC there is no governing-authority exception. State police operations
AGAINST a non-state suspect, and genuinely non-state actors despite state backing,
remain eligible. Unknown attribution is not proof of state or terrorist involvement.
A stolen radioactive source, illicit uranium mining, radiopharmaceutical shipment,
drone sighting or cyber incident alone does not establish terrorist intent. Reject
routine medicine, energy, mining, supply-chain news, research/AI applications,
accidents, exercises, policy and commentary without a concrete CT event.
Red mercury is often a claimed substance: preserve allegations/uncertainty; never
assert it is a confirmed radiological material or dirty-bomb capability.
Do not lose cases merely because intent/material identity is still investigated:
retain a concrete reported terrorism investigation and clearly label uncertainty.
'''
