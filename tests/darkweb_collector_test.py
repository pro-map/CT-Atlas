import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import pytest

spec = importlib.util.spec_from_file_location('darkweb_collector', Path('darkweb-collector/collector.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
BASE = 'http://' + 'a' * 56 + '.onion/'
OUTLET = {'id': 'test-outlet', 'url': BASE}

class Response:
    def __init__(self, body=b'', status=200, headers=None, url=BASE):
        self.body, self.status_code, self.headers, self.url = body, status, headers or {}, url
        self.closed = False
        self.encoding = 'utf-8'
    def iter_content(self, size):
        yield self.body
    def close(self):
        self.closed = True
    def raise_for_status(self):
        if self.status_code >= 400:
            raise ValueError('HTTP failed')

class Session:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []
    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return next(self.responses)


def test_parser_normalizes_relative_links_and_rejects_off_host():
    p = c.ListingParser(BASE)
    p.feed('<a href="/news.pdf#page=2">Niger <b>report</b></a><a href="/news.pdf">Niger report</a><a href="https://example.com/file.mp4">external</a><a href="javascript:alert(1)">x</a>')
    assert list(p.rows) == [BASE + 'news.pdf']
    assert p.rows[BASE + 'news.pdf']['type'] == 'pdf'
    assert p.rows[BASE + 'news.pdf']['title'] == 'Niger report'


def test_proxy_has_remote_dns_and_loopback_only():
    assert c.safe_proxy('socks5h://127.0.0.1:9150')
    for proxy in ['socks5://127.0.0.1:9050', 'http://127.0.0.1:9050', 'socks5h://public.example:9050']:
        with pytest.raises(ValueError):
            c.safe_proxy(proxy)


def test_source_redirect_is_rejected_before_any_clearnet_request():
    response = Response(status=302, headers={'Location': 'https://example.com/file.pdf'})
    session = Session([response])
    with pytest.raises(ValueError):
        c.source_get(session, BASE + 'a.pdf', 'a' * 56 + '.onion')
    assert len(session.calls) == 1
    assert response.closed
    assert session.calls[0][1]['allow_redirects'] is False


def test_acquisition_cap_removes_partial_files_and_content_hash_is_exact(tmp_path):
    response = Response(b'12345')
    with pytest.raises(ValueError):
        c.acquire(Session([response]), {'url': BASE + 'a.pdf'}, tmp_path, 4)
    assert not list(tmp_path.iterdir()) and response.closed
    meta = c.acquire(Session([Response(b'12345')]), {'url': BASE + 'a.pdf'}, tmp_path, 10)
    assert meta['sha256'] == c.hashlib.sha256(b'12345').hexdigest()
    assert (tmp_path / (meta['sha256'] + '.bin')).read_bytes() == b'12345'


def test_baseline_is_not_acquired_new_material_is_acquired_and_upload_failure_is_retried(tmp_path):
    db = c.open_database(tmp_path / 'state.sqlite')
    inventory = [{'url': BASE + 'old.pdf', 'title': 'old', 'type': 'pdf'}]
    sent, acquired = [], []
    def api(*args, **kwargs):
        sent.append(args[-1])
        return {'ok': True}
    def acquire(*args):
        acquired.append(args[1]['url'])
        return {'acquired': True, 'sha256': 'b' * 64, 'bytes': 3}
    with patch.object(c, 'read_listing', return_value=(inventory, False)), patch.object(c, 'api_call', side_effect=api), patch.object(c, 'acquire', side_effect=acquire):
        c.scan_outlet(None, '', None, db, OUTLET, tmp_path, True, 10)
    assert acquired == []
    inventory += [{'url': BASE + 'new.pdf', 'title': 'new', 'type': 'pdf'}]
    with patch.object(c, 'read_listing', return_value=(inventory, False)), patch.object(c, 'api_call', side_effect=ValueError('not acknowledged')), patch.object(c, 'acquire', side_effect=acquire):
        with pytest.raises(ValueError):
            c.scan_outlet(None, '', None, db, OUTLET, tmp_path, True, 10)
    assert not db.execute('SELECT 1 FROM items WHERE url=?', (BASE + 'new.pdf',)).fetchone()
    with patch.object(c, 'read_listing', return_value=(inventory, False)), patch.object(c, 'api_call', side_effect=api), patch.object(c, 'acquire', side_effect=acquire):
        c.scan_outlet(None, '', None, db, OUTLET, tmp_path, True, 10)
        c.scan_outlet(None, '', None, db, OUTLET, tmp_path, True, 10)
    assert acquired == [BASE + 'new.pdf', BASE + 'new.pdf']
    assert json.loads(db.execute('SELECT metadata FROM items WHERE url=?', (BASE + 'new.pdf',)).fetchone()[0])['acquired']
    db.close()


def test_failed_listing_reports_failure_with_no_sensitive_exception(tmp_path):
    db = c.open_database(tmp_path / 'state.sqlite')
    with patch.object(c, 'read_listing', side_effect=ValueError('sensitive URL')), patch.object(c, 'api_call', return_value={'ok': True}) as api:
        c.scan_outlet(None, '', None, db, OUTLET, tmp_path, False, 10)
    payload = api.call_args.args[-1]
    assert payload['scan_ok'] is False and payload['items'] == []
    assert 'sensitive' not in json.dumps(payload)
    assert not db.execute('SELECT 1 FROM outlets').fetchone()
    db.close()
