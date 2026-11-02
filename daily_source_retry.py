"""Bounded GDELT retries; query errors and throttling never become empty results."""
import json

from daily_reliability import retry_delay


RATE_LIMIT_TEXT = "limit requests to one every"
RATE_LIMIT_PAUSE_SECONDS = 30.0


def _deferred(stats, url, label, error, message=""):
    stats['failed'] += 1
    pending = stats.get('deferred_queries')
    if not isinstance(pending, list):
        pending = []
        stats['deferred_queries'] = pending
    item = {'url': url, 'label': label, 'reason': error, 'recovered': False}
    if message:
        # Public provider diagnostics only; never promote response text to code
        # or include entire pages in published progress metadata.
        item['provider_message'] = ' '.join(message.split())[:200]
    pending.append(item)
    print(f'GDELT deferred {label}: {error}; not a successful empty search.')
    return []


def _payload(response):
    """Read JSON titles with provider control characters, without accepting HTML."""
    try:
        return response.json()
    except (ValueError, TypeError):
        raw = str(getattr(response, 'text', '') or '')
        if raw.lstrip().startswith(('{', '[')):
            return json.loads(raw, strict=False)
        raise ValueError('Provider did not return JSON')


def fetch_articles(client, url, stats, *, label, sleep):
    stats['attempted'] += 1  # logical queries, not HTTP attempts
    if stats.get('circuit_open'):
        stats['skipped_http_queries'] += 1
        return _deferred(stats, url, label, 'source_paused_' + str(stats.get('pause_reason', 'unavailable')))
    limited_query = False
    error = 'unknown'
    message = ''
    for attempt in range(2):
        stats['http_attempts'] += 1
        response = None
        try:
            response = client.get(url, headers={'User-Agent':'CT-Atlas-Collector/1.0'}, timeout=20)
        except client.RequestException:
            stats['request_errors'] += 1
            error = 'network_error'
        else:
            if response.status_code == 200:
                try:
                    payload = _payload(response)
                    articles = payload.get('articles') if isinstance(payload, dict) else None
                    if not isinstance(articles, list):
                        raise ValueError('No article list')
                except (ValueError, TypeError):
                    message = str(getattr(response, 'text', '') or '')
                    normalized = message.lower()
                    if RATE_LIMIT_TEXT in normalized:
                        # GDELT also sends a plain-text throttle with HTTP 200.
                        error = 'rate_limit_response'
                    elif any(phrase in normalized for phrase in (
                            'your query', 'keywords were', 'parentheses',
                            'invalid query', 'boolean or blocks')):
                        stats['query_rejected'] += 1
                        error = 'query_rejected'
                        break
                    else:
                        stats['invalid_response'] += 1
                        error = 'invalid_response'
                        break
                else:
                    stats['successful'] += 1
                    stats['consecutive_unavailable_queries'] = 0
                    return articles
            else:
                error = 'http_' + str(response.status_code)
                message = str(getattr(response, 'text', '') or '')
            if response.status_code == 429 or error == 'rate_limit_response':
                stats['rate_limit_http_attempts'] += 1
                if not limited_query:
                    stats['rate_limited'] += 1
                    limited_query = True
            if response.status_code not in (408, 429, 500, 502, 503, 504) and error != 'rate_limit_response':
                break
        if attempt == 0:
            delay = retry_delay(attempt, response)
            if delay is None:
                break
            sleep(max(RATE_LIMIT_PAUSE_SECONDS if limited_query else 6.0, delay))
    if limited_query:
        # A shared runner IP can stay throttled even at the documented pace.
        # Do not repeat that refusal for every category or query fragment.
        stats['circuit_open'] = True
        stats['pause_reason'] = 'rate_limit'
    elif error in ('network_error', 'http_408', 'http_500', 'http_502', 'http_503', 'http_504'):
        stats['consecutive_unavailable_queries'] += 1
        if stats['consecutive_unavailable_queries'] >= 3:
            stats['circuit_open'] = True
            stats['pause_reason'] = 'unavailable'
    return _deferred(stats, url, label, error, message)
