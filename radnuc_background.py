"""Validated RadNuc background articles: archive context, never map incidents."""
import hashlib
from urllib.parse import urlsplit

KIND = 'radnuc_background'
CATEGORY = 'Radiological/Nuclear'
ARTICLES_FILE = 'archive/radnuc-background-articles.json'
STATE_FILE = 'archive/radnuc-background-state.json'
STATUS_FILE = 'archive/radnuc-background-status.json'


def valid_article(row):
    import radnuc_background_topics as topics
    return (isinstance(row, dict) and row.get('kind') == KIND
            and row.get('archive_only') is True and row.get('background_reviewed') is True
            and row.get('ai_selected') is False and row.get('ai_current_ct_event') is False
            and row.get('category') == CATEGORY and row.get('categories') == [CATEGORY]
            and row.get('primary_event_type') == 'BACKGROUND_INFO'
            and row.get('ai_relevance_score') is None
            and not row.get('parent_event_id') and not row.get('parent_incident_id')
            and urlsplit(str(row.get('url') or '')).scheme in ('http', 'https')
            and bool(urlsplit(str(row.get('url') or '')).netloc)
            and bool(row.get('title')) and bool(row.get('summary'))
            and bool(row.get('background_topics'))
            and set(row['background_topics']) <= set(topics.topic_ids()))


def article(candidate, result, now):
    """Build a background row independently of CT scores and map selection."""
    if (not result['keep_background'] or result.get('is_operational_event') is not False
            or result.get('is_anti_war') is not False):
        return None
    row = {
        'id':'radnuc-background-'+hashlib.sha1(candidate['url'].encode()).hexdigest()[:16],
        'kind':KIND, 'archive_only':True, 'background_reviewed':True,
        'ai_selected':False, 'ai_current_ct_event':False,
        'category':CATEGORY, 'categories':[CATEGORY], 'primary_event_type':'BACKGROUND_INFO',
        'actor_group':None, 'parent_event_id':None, 'parent_incident_id':None,
        'country':None, 'region':None, 'url':candidate['url'],
        'title':result['english_title'], 'summary':result['english_summary'],
        'original_title':candidate.get('original_title') or candidate.get('title'),
        'original_language':result['original_language'], 'source':candidate.get('source'),
        'published':candidate.get('published'), 'collected_at':now.isoformat(),
        'background_topics':result['topic_ids'], 'ai_relevance_score':None,
        'ai_relevance_reason':'RadNuc background only: '+result['reason'],
    }
    if not valid_article(row):
        raise ValueError('Invalid RadNuc background article')
    return row
