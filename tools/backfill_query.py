"""Provider-specific query syntax, without dropping a keyword or context anchor.

GDELT documents exact phrases and non-nested OR groups. Use unquoted single
words and a conservative 200-byte query ceiling. Split oversized conjunctions
into an equivalent UNION of shorter queries, never silently truncate them.
"""
from __future__ import annotations
import re

GDELT_QUERY_BYTES = 200
_PART = re.compile(r'\([^()]*\)|"[^"\n]*"|[^\s()]+')
_OR = re.compile(r'\s+OR\s+(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)')


def groups(query):
    """Parse the flat AND-of-OR grammar used by the configured news searches."""
    result, end = [], 0
    for match in _PART.finditer(query):
        if query[end:match.start()].strip():
            raise ValueError('Unsupported nested query expression')
        item = match.group()
        if item.startswith('('):
            alternatives = _OR.split(item[1:-1].strip())
        else:
            alternatives = [item]
        if not all(alternatives):
            raise ValueError('Empty query alternative')
        result.append(alternatives)
        end = match.end()
    if not result or query[end:].strip():
        raise ValueError('Empty or malformed query')
    return result


def render(parts):
    return ' '.join('(' + ' OR '.join(items) + ')' if len(items) > 1 else items[0]
                    for items in parts)


def divide(parts):
    """Split one OR group. The two child result sets UNION to the parent."""
    for index, items in enumerate(parts):
        if len(items) > 1:
            middle = (len(items) + 1) // 2
            return [parts[:index] + [half] + parts[index+1:]
                    for half in (items[:middle], items[middle:])]
    return []


def gdelt_queries(query, max_bytes=GDELT_QUERY_BYTES):
    parsed = groups(query)
    normalized = [[term[1:-1] if term.startswith('"') and term.endswith('"')
                   and not re.search(r'\s', term[1:-1]) else term
                   for term in items] for items in parsed]
    pending, output = [normalized], []
    while pending:
        item = pending.pop(0)
        text = render(item)
        if len(text.encode('utf-8')) <= max_bytes:
            output.append(text)
            continue
        children = divide(item)
        if not children:
            raise ValueError('A single query term plus its context exceeds the provider query ceiling')
        pending[:0] = children
    return list(dict.fromkeys(output))


def narrower_queries(query):
    """Refine a saturated one-day search by query, not by silently losing hits."""
    return [render(parts) for parts in divide(groups(query))]


def provider_tasks(task, key_function):
    if task['source'] != 'gdelt':
        return [task]
    result = []
    for query in gdelt_queries(task['query']):
        child = {**task, 'query': query}
        child['key'] = key_function(child)
        if child['key'] != task['key']:
            child['legacy_query_key'] = task['key']
        result.append(child)
    return result


def split_saturated(task, key_function):
    result = []
    try:
        queries = narrower_queries(task['query'])
    except ValueError:
        return []  # Unsupported expressions stay explicitly coverage-limited.
    for query in queries:
        child = {**task, 'query': query, 'query_split_parent': task['key']}
        child['key'] = key_function(child)
        result.append(child)
    return result
