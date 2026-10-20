"""Bounded source retries, unrelated to model quotas. Keeps terminal query errors visible."""
from daily_reliability import retry_delay


def fetch_articles(client, url, stats, *, label, sleep):
    stats['attempted'] += 1  # logical queries, not HTTP attempts
    limited_query = False
    error = 'unknown'
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
                    payload = response.json()
                    articles = payload.get('articles') if isinstance(payload, dict) else None
                    if not isinstance(articles, list):
                        raise ValueError('No article list')
                except (ValueError, TypeError):
                    stats['invalid_response'] += 1
                    error = 'invalid_response'
                    break
                stats['successful'] += 1
                return articles
            error = 'http_' + str(response.status_code)
            if response.status_code == 429:
                stats['rate_limit_http_attempts'] += 1
                if not limited_query:
                    stats['rate_limited'] += 1
                    limited_query = True
            if response.status_code not in (408, 429, 500, 502, 503, 504):
                break
        if attempt == 0:
            delay = retry_delay(attempt, response)
            if delay is None:
                break
            sleep(max(6.0, delay))
    stats['failed'] += 1
    pending = stats.get('deferred_queries')
    if not isinstance(pending, list):
        pending = []
        stats['deferred_queries'] = pending
    pending.append({'url':url, 'label':label, 'reason':error, 'recovered':False})
    print(f'GDELT deferred {label}: {error}; not a successful empty search.')
    return []
