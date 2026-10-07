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
    def __init__(self, body=b'', status=200, headers=None, url=BASE, encoding='utf-8'):
        self.body, self.status_code, self.headers, self.url = body, status, headers or {}, url
        self.closed = False
        self.encoding = encoding
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


def test_source_timeout_applies_to_each_same_host_redirect():
    session = Session([Response(status=302, headers={'Location':'/next'}), Response()])
    session.source_connect_timeout = 120
    c.source_get(session, BASE, 'a'*56+'.onion')
    assert len(session.calls) == 2
    assert all(call[1]['timeout'] == (120,90) and not call[1]['allow_redirects'] for call in session.calls)


def test_slow_tor_connection_keeps_queue_and_recovers_with_longer_budget(tmp_path, caplog):
    class SlowTor(Site):
        def get(self, url, **kwargs):
            if kwargs['timeout'][0] < 60:
                raise c.requests.exceptions.ConnectTimeout('private source and token should not be logged')
            return super().get(url, **kwargs)
    tor = SlowTor({BASE:structured_listing(1, False)})
    tor.source_connect_timeout = 30
    db = c.open_database(tmp_path/'state.sqlite')
    failed = c.crawl_outlet(tor, db, OUTLET, 1, 100, 0)
    assert failed['failed_pages'] == 1 and not failed['complete']
    assert 'ConnectTimeout' in caplog.text and 'connect timeout=30s' in caplog.text
    assert 'private source' not in caplog.text
    del tor.source_connect_timeout  # Default budget now accepts the simulated slow connection.
    recovered = c.crawl_outlet(tor, db, OUTLET, 1, 100, 0)
    assert recovered['failed_pages'] == 0 and recovered['pages_scanned'] == 1
    assert db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0] == 1
    db.close()


@pytest.mark.parametrize('error,expected', [
    (c.requests.exceptions.ReadTimeout('sensitive'), 'ReadTimeout (request timed out)'),
    (c.requests.exceptions.ConnectionError('private source: timed out'), 'Tor/SOCKS connection timed out'),
    (c.requests.exceptions.ConnectionError('private source: connection refused'), 'Tor/SOCKS connection refused'),
    (c.requests.exceptions.ConnectionError('private source: unreachable'), 'Tor/SOCKS connection failed'),
    (ValueError('Listing exceeds HTML size limit'), 'Listing exceeds HTML size limit'),
    (ValueError('private source\nsecret'), 'ValueError'),
])
def test_source_failure_reason_does_not_expose_exception_text(error, expected):
    assert c.source_failure_reason(error) == expected


def test_http_failure_reports_only_status():
    response = c.requests.Response()
    response.status_code = 503
    error = c.requests.exceptions.HTTPError('private source', response=response)
    assert c.source_failure_reason(error) == 'HTTP 503'


def test_acquisition_cap_removes_partial_files_and_content_hash_is_exact(tmp_path):
    response = Response(b'12345')
    with pytest.raises(ValueError):
        c.acquire(Session([response]), {'url': BASE + 'a.pdf'}, tmp_path, 4)
    assert not list(tmp_path.iterdir()) and response.closed
    meta = c.acquire(Session([Response(b'12345')]), {'url': BASE + 'a.pdf'}, tmp_path, 10)
    assert meta['sha256'] == c.hashlib.sha256(b'12345').hexdigest()
    assert (tmp_path / (meta['sha256'] + '.bin')).read_bytes() == b'12345'


class HTTPStatus(Response):
    def raise_for_status(self):
        if self.status_code >= 400:
            raise c.requests.exceptions.HTTPError('private source', response=self)


class Site:
    def __init__(self, pages):
        self.pages, self.calls = pages, []
    def get(self, url, **kwargs):
        self.calls.append(url)
        value = self.pages[url]
        if isinstance(value, Exception):
            raise value
        if isinstance(value, int):
            return HTTPStatus(status=value, url=url)
        # A page is a str or bytes body, or (body, mime) / (body, mime, extra headers).
        # Bytes are served unchanged, so pages can be in legacy encodings.
        extra = {}
        if isinstance(value, tuple):
            body, mime, *more = value
            extra = dict(more[0]) if more else {}
        else:
            body, mime = value, 'text/html; charset=utf-8'
        # Like requests: ISO-8859-1 is reported for text/* without a charset.
        encoding = 'utf-8' if 'charset=' in mime.lower() else 'ISO-8859-1'
        return Response(body.encode() if isinstance(body, str) else body, headers={**extra, 'Content-Type': mime}, url=url, encoding=encoding)


def run_scan(site, db, tmp_path, budget=100, acquire=False, max_pages=10000):
    sent = []
    def ack(*args, **kwargs):
        sent.append(args[-1])
        return {'ok': True}
    with patch.object(c, 'api_call', side_effect=ack):
        result = c.scan_outlet(None, '', site, db, OUTLET, tmp_path, acquire, 100, budget, max_pages, 0)
    return result, sent


def test_recursive_pages_pagination_media_comments_and_loop_dedup(tmp_path):
    site = Site({
        BASE: '<a href="section">section</a><a href="https://outside.example/x">external</a>',
        BASE+'section': '<a href="/">home</a><a href="post">post</a><a href="section?page=2">next</a>',
        BASE+'post': '<title>Publication</title><p>Visible comment text</p><script>secret script text</script><video src="v.mp4"></video><a href="d.pdf">PDF</a>',
        BASE+'section?page=2': '<a href="/post">same post</a><a href="/attachment?id=1">attachment</a>',
        BASE+'attachment?id=1': ('pdf bytes', 'application/pdf')
    })
    db = c.open_database(tmp_path/'state.sqlite')
    ok, sent = run_scan(site, db, tmp_path)
    assert ok and sent[-1]['scan_complete']
    assert len(site.calls) == 5 and len(set(site.calls)) == 5
    items = {i['url']: i for batch in sent for i in batch['items']}
    assert items[BASE+'v.mp4']['type'] == 'video'
    assert items[BASE+'d.pdf']['source_page'] == BASE+'post'
    assert items[BASE+'attachment?id=1']['type'] == 'pdf'
    text = db.execute('SELECT text FROM pages WHERE url=?', (BASE+'post',)).fetchone()[0]
    assert 'Visible comment text' in text and 'secret script text' not in text
    db.close()


def test_resume_after_restart_preserves_queue_and_delays_baseline(tmp_path):
    site = Site({BASE:'<a href="p1">one</a>', BASE+'p1':'<a href="p2">two</a>', BASE+'p2':'<a href="/">home</a>'})
    path = tmp_path/'state.sqlite'
    db = c.open_database(path)
    ok, sent = run_scan(site, db, tmp_path, budget=1)
    assert ok and not sent[-1]['scan_complete'] and sent[-1]['pending_pages'] == 1
    assert not db.execute('SELECT 1 FROM outlets').fetchone()
    db.close()
    db = c.open_database(path)
    run_scan(site, db, tmp_path, budget=1)
    ok, sent = run_scan(site, db, tmp_path, budget=1)
    assert sent[-1]['scan_complete'] and site.calls == [BASE, BASE+'p1', BASE+'p2']
    assert db.execute('SELECT initialized FROM outlets').fetchone()[0] == 1
    assert all(row[0] == 1 for row in db.execute('SELECT baseline FROM items'))
    # A new cycle revisits the whole reachable outlet and detects newly linked material.
    site.pages[BASE+'p2'] += '<a href="new.pdf">new material</a>'
    ok, sent = run_scan(site, db, tmp_path)
    assert sent[-1]['scan_complete']
    assert db.execute('SELECT baseline FROM items WHERE url=?',(BASE+'new.pdf',)).fetchone()[0] == 0
    db.close()


def test_upload_failure_replays_outbox_without_restarting_crawl(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    site = Site({BASE:'<a href="old.pdf">old</a>'})
    run_scan(site, db, tmp_path)
    site.pages[BASE] += '<a href="new.pdf">new</a>'
    acquired = []
    def acquire(*args):
        acquired.append(args[1]['url'])
        return {'acquired': True, 'sha256': 'b'*64, 'bytes': 3}
    with patch.object(c, 'api_call', side_effect=ValueError('upload failed')), patch.object(c, 'acquire', side_effect=acquire):
        with pytest.raises(ValueError):
            c.scan_outlet(None,'',site,db,OUTLET,tmp_path,True,100,100,10000,0)
    assert db.execute('SELECT 1 FROM outbox').fetchone()
    calls = len(site.calls)
    with patch.object(c, 'acquire', side_effect=acquire):
        ok, sent = run_scan(site, db, tmp_path, acquire=True)
    assert ok and len(site.calls) == calls
    assert acquired == [BASE+'new.pdf'], 'Acquired metadata survives a failed upload'
    assert not db.execute('SELECT 1 FROM outbox').fetchone()
    db.close()


def test_failed_page_prevents_complete_inventory_and_recovers(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    site = Site({BASE:'<a href="broken">broken</a>', BASE+'broken':ValueError('sensitive URL')})
    ok, sent = run_scan(site,db,tmp_path)
    assert not ok and sent[-1]['failed_pages'] == 1 and not sent[-1]['scan_complete']
    assert 'sensitive' not in json.dumps(sent)
    assert not db.execute('SELECT 1 FROM outlets').fetchone()
    site.pages[BASE+'broken'] = '<p>Recovered page</p>'
    ok, sent = run_scan(site,db,tmp_path)
    assert ok and sent[-1]['scan_complete']
    assert site.calls.count(BASE) == 1
    db.close()


def test_page_cap_finishes_the_run_reports_abandoned_pages_and_restarts_at_start_page(tmp_path):
    # A capped run used to stop making requests for good; it now ends and is reported.
    db = c.open_database(tmp_path/'state.sqlite')
    site = Site({BASE:'<a href="second">second</a><a href="2025-09-01-old.pdf">old</a>', BASE+'second':'<p>done</p>'})
    ok, sent = run_scan(site,db,tmp_path,max_pages=1)
    assert ok and sent[-1]['scan_complete'] and not sent[-1]['truncated']
    assert sent[-1]['abandoned_pages'] == 1 and sent[-1]['pending_pages'] == 0 and sent[-1]['failed_pages'] == 0
    site.pages[BASE] += '<a href="2025-10-02-new.pdf">new</a>'
    run_scan(site,db,tmp_path,max_pages=1)
    assert site.calls == [BASE, BASE]
    baseline = dict(db.execute('SELECT url,baseline FROM items'))
    assert baseline == {BASE+'2025-09-01-old.pdf':1, BASE+'2025-10-02-new.pdf':0}
    db.close()


def test_parser_ignores_action_links_and_follows_rel_next():
    p = c.ListingParser(BASE)
    p.feed('<a href="/logout">logout</a><a href="/?action=delete">delete</a><form action="/submit"></form><link rel="next" href="?page=2"><source src="/stream?id=4" type="video/mp4">')
    assert set(p.rows) == {BASE+'?page=2',BASE+'stream?id=4'}
    assert p.rows[BASE+'stream?id=4']['type'] == 'video'


def test_unicode_batches_fit_actual_requests_json_encoding(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    html = ''.join('<a href="file%d.pdf">%s</a>' % (i, 'ع'*300) for i in range(100))
    ok, sent = run_scan(Site({BASE: html}), db, tmp_path)
    assert ok and sent
    assert all(len(json.dumps(payload, ensure_ascii=False).encode('utf-8')) < 128000 for payload in sent)
    assert sum(len(payload['items']) for payload in sent) == 100
    assert sent[-1]['scan_complete'] and not any(payload['scan_complete'] for payload in sent[:-1])
    db.close()


def structured_listing(count=12, next_page=True):
    cards = ''.join('<div class="post-card"><a class="post-card-link" href="/posts/%s/%s/"><h5 class="post-summary">%s</h5></a><div class="card-footer"><span>السبت، ٣ أكتوبر ٢٠٢٦</span><a href="/posts/news/%s/">قراءة</a></div></div>' % ('naba' if i == 6 else 'news', i, 'صحيفة العدد 567' if i == 6 else 'عنوان الخبر العربي '+str(i), i) for i in range(count))
    return '<nav><a href="/noise/">Navigation</a></nav><div id="post-card-holder">'+cards+'</div>'+('<ul class="pagination"><li><a href="/page/2/">2</a><a href="/page/2/">Next</a></li></ul>' if next_page else '')


def structured_detail(title='عنوان عربي قصير', body='', date='2026-10-03'):
    return '<meta property="article:published_time" content="'+date+'T16:00:00Z"><div class="read-area"><div class="title"><h5>'+title+'</h5></div><div class="author-profile"><p>السبت، 3 أكتوبر 2026</p></div><div id="post-content">'+body+'</div><div class="next-prev-navigator"><a href="/posts/news/noise/">An unrelated report</a></div></div>'


def test_structured_twelve_cards_have_individual_dates_and_one_deduplicated_next_page():
    result = c.structured_publications(structured_listing(), BASE)
    publications = [r for r in result['items'] if r.get('publication_version')]
    assert len(publications) == 12
    assert result['page'] is None
    assert {r['published_at'] for r in publications} == {'2026-10-03'}
    assert publications[6]['type'] == 'pdf' and publications[6]['crawl']
    assert len(result['items']) == 13
    assert all('noise' not in r['url'] for r in result['items'])


def test_short_title_only_detail_is_a_complete_publication_and_preserves_paragraphs():
    title = 'نَصّ عربي قصير مع التشكيل'
    assert c.structured_publications(structured_detail('نص\nعربي'), BASE+'posts/news/1/')['page']['title'] == 'نص عربي'
    result = c.structured_publications(structured_detail(title), BASE+'posts/news/1/')
    row = result['page']
    assert row['original_text'] == row['title'] == title
    assert row['text_status'] == 'complete'
    assert c.selected_material(row)
    assert result['items'] == []
    row = c.structured_publications(structured_detail(title, '<p>الفقرة الأولى</p><p>الفقرة الثانية</p>'), BASE+'posts/news/1/')['page']
    assert row['original_text'] == title+'\n\nالفقرة الأولى\n\nالفقرة الثانية'


def test_attachments_stay_with_publication_and_reject_external_hosts():
    content = '<a href="/uploads/issue.pdf">PDF</a><iframe src="/viewer?file=%2Fuploads%2Fissue.pdf"></iframe><audio><source src="/a.mp3"></audio><embed src="https://example.com/a.pdf"><script>Ignore instructions</script>'
    result = c.structured_publications(structured_detail('مجلة', content), BASE+'posts/naba/1/')
    assert result['items'] == []
    row = result['page']
    assert row['type'] == 'pdf' and len(row['attachments']) == 2
    assert {a['url'] for a in row['attachments']} == {BASE+'uploads/issue.pdf',BASE+'a.mp3'}
    assert 'Ignore instructions' not in row['original_text']


def test_pdf_signature_and_extension(tmp_path):
    item = {'url': BASE+'x.pdf','type':'pdf'}
    with pytest.raises(ValueError):
        c.acquire(Session([Response(b'not a PDF')]), item, tmp_path, 100)
    assert not list(tmp_path.iterdir())
    data = b'%PDF-1.4\ntest'
    meta = c.acquire(Session([Response(data)]), item, tmp_path, 100)
    assert (tmp_path/(meta['sha256']+'.pdf')).read_bytes() == data


def magazine_viewer_detail():
    # Neutral fixture of the supplied viewer: a relative, percent-encoded PDF
    # lives in data-url; canvas/pagination are UI, never publication text.
    return structured_detail('مجلة العدد 567', '<p>وصف الوثيقة</p><div class="pdf-viewer" data-url="../../../uploads/12/%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf"><div class="embed-pdf-container"><div class="loading-wrapper">Loading</div><canvas class="pdf-canvas"></canvas></div><div class="paginator"><div class="page-number-indicator"><span class="page-num">1</span><span class="page-count">8</span><button class="download">Download</button></div></div></div>')


def test_saved_pdf_viewer_resolves_document_without_collecting_its_controls():
    row = c.structured_publications(magazine_viewer_detail(), BASE+'posts/naba/12/')['page']
    assert row['original_text'] == 'مجلة العدد 567\n\nوصف الوثيقة'
    assert row['attachments'] == [{'url':BASE+'uploads/12/%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf','type':'pdf','title':'تقرير.pdf'}]
    assert c.preview_source(row) == ('pdf', row['attachments'][0]['url'])


def test_listing_preview_failure_is_retried_after_magazine_detail_is_fetched(tmp_path):
    # First pass discovers a magazine card with no poster/PDF URL. The next pass
    # must retry its preview using the newly resolved PDF, not cache "unavailable".
    listing = structured_listing(7,False)
    site = Site({BASE:listing,**{BASE+'posts/news/'+str(i)+'/':structured_detail('خبر '+str(i)) for i in range(6)},
                 BASE+'posts/naba/6/':magazine_viewer_detail(),
                 BASE+'uploads/12/%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf':('%PDF-1.4\nexample','application/pdf')})
    db = c.open_database(tmp_path/'state.sqlite')
    # Put the magazine first so it consumes one of the first pass's preview slots.
    start=listing.index('<div class="post-card"><a class="post-card-link" href="/posts/naba/')
    site.pages[BASE]=listing[:listing.index('<div id="post-card-holder">')]+'<div id="post-card-holder">'+listing[start:]
    policy={'epoch':2,'from':'2025-01-01','through':'2026-12-31','pages_per_scan':10,'previews':True}
    observed=[]
    def preview(tor,row):
        observed.append(c.preview_source(row))
        return {'preview_status':'First page' if c.preview_source(row) else 'No visual preview supplied'}
    with patch.object(c,'api_call',return_value={'ok':True}), patch.object(c,'make_preview',side_effect=preview):
        c.scan_outlet(None,'',site,db,{**OUTLET,'policy':policy},tmp_path,False,1000,1,100,0)
        c.scan_outlet(None,'',site,db,{**OUTLET,'policy':policy},tmp_path,False,1000,1,100,0)
    stored=json.loads(db.execute('SELECT metadata FROM items WHERE url=?',(BASE+'posts/naba/6/',)).fetchone()[0])
    assert stored['preview_status']=='First page'
    assert stored['attachments'][0]['acquired']
    assert observed == [None,('pdf',BASE+'uploads/12/%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf')]
    db.close()


def test_structured_crawl_resumes_and_downloads_historical_pdf_without_duplicate_records(tmp_path):
    site = Site({BASE:structured_listing(7),BASE+'page/2/':structured_listing(1,False),
                 **{BASE+'posts/news/'+str(i)+'/':structured_detail('خبر '+str(i)) for i in range(6)},
                 BASE+'posts/naba/6/':structured_detail('مجلة', '<a href="/issue.pdf">PDF</a>'),
                 BASE+'issue.pdf':('%PDF-1.4\nexample','application/pdf')})
    db = c.open_database(tmp_path/'state.sqlite')
    sent=[]
    with patch.object(c,'api_call',side_effect=lambda *a,**k: sent.append(a[-1]) or {'ok':True}):
        for _ in range(5):
            c.scan_outlet(None,'',site,db,OUTLET,tmp_path,False,1000,3,100,0)
    stored=[json.loads(r[0]) for r in db.execute('SELECT metadata FROM items')]
    assert len(stored) == 7
    assert all(r['text_status'] == 'complete' for r in stored)
    magazine=next(r for r in stored if r['category']=='naba')
    assert magazine['attachments'][0]['acquired']
    assert len(list(tmp_path.glob('*.pdf'))) == 1
    assert not any('/noise' in url for url in site.calls)
    db.close()


def test_selection_discards_navigation_but_still_reaches_publications(tmp_path):
    body = 'This is substantive analytical body text with details. ' * 30
    site = Site({
        BASE: '<nav><a href="category">Section title</a></nav><a href="logo.png">Logo</a>',
        BASE+'category': '<h1>Publications</h1><a href="article">Read article</a><a href="discussion">Discussion</a>',
        BASE+'article': '<title>Detailed text</title><nav>Navigation noise</nav><article><p>'+body+'</p></article><a href="report.pdf">Report</a>',
        BASE+'discussion': '<div class="comment-body">'+('An identifiable user comment with enough context. '*3)+'</div>'
    })
    db = c.open_database(tmp_path/'state.sqlite')
    ok, sent = run_scan(site, db, tmp_path)
    items = {i['url']: i for batch in sent for i in batch['items']}
    assert ok and sent[-1]['scan_complete']
    assert set(items) == {BASE+'article', BASE+'discussion', BASE+'report.pdf'}
    assert 'Navigation noise' not in items[BASE+'article']['excerpt']
    assert items[BASE+'discussion']['selection_version'] == 1
    assert set(site.calls) == {BASE, BASE+'category', BASE+'article', BASE+'discussion'}


def test_selection_rejects_large_menus_headings_and_html_comments():
    html = '<nav><div>'+('menu text '*500)+'</div></nav>'
    html += '<div class="pagination">'+('next page '*500)+'</div>'
    html += '<div><h2>'+('section title '*200)+'</h2></div>'
    html += '<!-- '+('comment in source '*100)+' -->'
    html += '<div>'+(' <a href="/x">link label</a> '*300)+'</div>'
    parser = c.PublicationParser(); parser.feed(html)
    assert parser.selected_text() == ''


def test_selection_accepts_arabic_body_and_rejects_keyword_only():
    parser = c.PublicationParser()
    parser.feed('<article><p>'+('هذا نص طويل يتضمن تفاصيل ومعلومات للتحليل. '*40)+'</p></article>')
    assert parser.selected_text().startswith('هذا نص')
    parser = c.PublicationParser(); parser.feed('<h2>إصدار فيديو PDF</h2><p>publication officielle</p>')
    assert parser.selected_text() == ''


def test_legacy_outbox_noise_is_not_uploaded(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    row = {'url': BASE+'menu', 'type': 'page', 'title': 'Menu'}
    db.execute('INSERT INTO outbox VALUES (?,?,?,?)', (OUTLET['id'],row['url'],json.dumps(row),1)); db.commit()
    _, sent = run_scan(Site({BASE:''}), db, tmp_path)
    assert not any(batch['items'] for batch in sent)
    assert not db.execute('SELECT 1 FROM outbox').fetchone()

POLICY = {'epoch':2, 'from':'2025-01-01', 'through':'2026-12-31', 'pages_per_scan':10, 'previews':False}

def test_arabic_filename_decodes_without_altering_fetch_url():
    path = BASE+'uploads/292/%d9%82%d8%a7%d8%aa%d9%84%d9%88%d9%87%d9%85_%d8%a7%d9%84%d9%84%d9%87.mp3'
    assert c.display_title(path) == 'قاتلوهم الله.mp3'
    parser=c.ListingParser(BASE); parser.feed('<a href="'+path+'"></a>')
    assert parser.rows[path]['url'] == path
    assert parser.rows[path]['title'] == 'قاتلوهم الله.mp3'

def test_date_scope_excludes_undated_old_and_future_and_preserves_navigation(tmp_path):
    site=Site({BASE:'<a href="post">Publication</a><a href="2024-01-01.pdf">Old</a><a href="unknown.pdf">Unknown</a>',BASE+'post':'<meta property="article:published_time" content="2025-03-09T10:00:00Z"><a href="report.pdf">Report</a>'})
    outlet={**OUTLET,'policy':POLICY}
    db=c.open_database(tmp_path/'state.sqlite');c.apply_epoch(db,POLICY)
    sent=[]
    with patch.object(c,'api_call',side_effect=lambda *args:sent.append(args[-1]) or {'ok':True}):
        c.scan_outlet(None,'',site,db,outlet,tmp_path,False,100,100,10000,0)
    rows=[r for batch in sent for r in batch['items']]
    assert [r['url'] for r in rows] == [BASE+'report.pdf']
    assert rows[0]['published_at']=='2025-03-09' and rows[0]['date_basis']=='source_page'
    assert db.execute('SELECT COUNT(*) FROM undated').fetchone()[0]==1
    assert not c.within_period({'published_at':'2099-01-01'},POLICY)
    assert not c.publication_date('2025-02-30')
    assert c.publication_date('٢٠٢٥-٠٣-٠٩')=='2025-03-09'

def test_epoch_reset_is_idempotent_and_does_not_delete_evidence(tmp_path):
    db=c.open_database(tmp_path/'state.sqlite');c.apply_epoch(db,POLICY)
    evidence=tmp_path/'evidence.bin';evidence.write_bytes(b'preserved')
    db.execute('INSERT INTO items VALUES (?,?,?,?)',('x',BASE,'{}',1));db.commit()
    c.apply_epoch(db,POLICY);assert db.execute('SELECT COUNT(*) FROM items').fetchone()[0]==1
    c.apply_epoch(db,{**POLICY,'epoch':3});assert db.execute('SELECT COUNT(*) FROM items').fetchone()[0]==0
    assert evidence.read_bytes()==b'preserved'

def test_watch_is_shallow_but_initial_inventory_reaches_deeper_pages(tmp_path):
    site=Site({BASE:'<a href="a">a</a>',BASE+'a':'<a href="b">b</a>',BASE+'b':'<a href="c">c</a>',BASE+'c':'<a href="2025-04-01.pdf">pdf</a>'})
    db=c.open_database(tmp_path/'state.sqlite')
    c.crawl_outlet(site,db,{**OUTLET,'policy':POLICY,'collection_phase':'watch'},100,10000,0)
    assert site.calls==[BASE,BASE+'a',BASE+'b']
    c.apply_epoch(db,POLICY);site.calls=[]
    c.crawl_outlet(site,db,{**OUTLET,'policy':POLICY,'collection_phase':'backfill'},100,10000,0)
    assert BASE+'c' in site.calls

def test_previews_are_small_jpegs_and_pdf_first_pages_with_no_original_on_disk(tmp_path):
    # Previews belong to structured records only: their own cover image or their PDF's first page.
    Image=pytest.importorskip('PIL.Image');fitz=pytest.importorskip('fitz')
    output=c.io.BytesIO();Image.new('RGB',(300,200),'navy').save(output,format='PNG')
    cover={'publication_version':1,'url':BASE+'posts/news/1/','preview_url':BASE+'image.png','attachments':[]}
    image=c.make_preview(Session([Response(output.getvalue())]),cover)
    assert image['preview'].startswith('data:image/jpeg;base64,/9j/') and len(image['preview'])<=16000
    assert image['preview_status']=='Source thumbnail'
    with fitz.open() as doc:
        doc.new_page();pdf=doc.tobytes()
    magazine={'publication_version':1,'url':BASE+'posts/naba/1/','attachments':[{'type':'pdf','url':BASE+'file.pdf'}]}
    preview=c.make_preview(Session([Response(pdf)]),magazine)
    assert preview['preview_status']=='First page' and len(preview['preview'])<=16000
    response=Response(headers={'Content-Length':str(9*1048576)})
    assert 'cap' in c.make_preview(Session([response]),cover)['preview_status']
    assert response.closed and not list(tmp_path.iterdir())

class UploadReply:
    def __init__(self, payload, status=200):
        self.payload, self.status_code, self.closed = payload, status, False
    def json(self):
        return self.payload
    def raise_for_status(self):
        if self.status_code >= 400:
            raise c.requests.exceptions.HTTPError('private API details', response=self)
    def close(self):
        self.closed = True

class UploadAPI:
    def __init__(self, fail_upload=False):
        self.calls, self.files, self.fail_upload = [], {}, fail_upload
    def request(self, method, url, **kwargs):
        assert url.startswith('https://atlas.example/darkweb/')
        assert kwargs['allow_redirects'] is False
        fingerprint = kwargs['params']['sha256']
        self.calls.append((method, url, kwargs['params']))
        if method == 'GET':
            return UploadReply({'stored':fingerprint in self.files})
        data = kwargs['data'].read()
        assert data.startswith(b'%PDF-')
        assert c.hashlib.sha256(data).hexdigest() == fingerprint
        assert kwargs['headers']['Content-Length'] == str(len(data))
        self.files[fingerprint] = data
        if self.fail_upload:
            self.fail_upload = False
            raise c.requests.exceptions.ConnectionError('lost acknowledgement')
        return UploadReply({'stored':True})


def saved_pdf(db, folder, number=1):
    data = ('%PDF-1.4\nNeutral document '+str(number)).encode()
    fingerprint = c.hashlib.sha256(data).hexdigest()
    (folder/(fingerprint+'.pdf')).write_bytes(data)
    row = {'url':BASE+'posts/naba/'+str(number)+'/', 'publication_version':1, 'published_at':'2025-06-01',
           'attachments':[{'url':BASE+str(number)+'.pdf','title':'تقرير.pdf','type':'pdf','acquired':True,'sha256':fingerprint,'bytes':len(data)}]}
    db.execute('INSERT INTO items VALUES (?,?,?,?)',(OUTLET['id'],row['url'],json.dumps(row),1));db.commit()
    return row, fingerprint, data


def test_existing_pdfs_upload_without_recrawling_or_resetting_collection(tmp_path):
    db=c.open_database(tmp_path/'state.sqlite');row,fingerprint,data=saved_pdf(db,tmp_path)
    db.execute('INSERT INTO frontier(outlet_id,url) VALUES (?,?)',(OUTLET['id'],BASE+'pending/'));db.commit()
    before=db.execute('SELECT * FROM items').fetchall()
    policy={'epoch':2,'from':'2025-01-01','through':'2026-12-31','paused':False}
    api=UploadAPI();storage={'configured':True,'max_file_bytes':50*1048576}
    assert not c.sync_pdf_files(api,'https://atlas.example',db,{**OUTLET,'policy':policy},tmp_path,storage)
    assert api.files[fingerprint]==data and len(api.calls)==2
    assert api.calls[0][2]['id']==c.hashlib.sha256((OUTLET['id']+'\n'+row['url']).encode()).hexdigest()
    assert db.execute('SELECT * FROM items').fetchall()==before
    assert db.execute('SELECT COUNT(*) FROM frontier').fetchone()[0]==1
    assert (tmp_path/(fingerprint+'.pdf')).read_bytes()==data
    c.sync_pdf_files(api,'https://atlas.example',db,{**OUTLET,'policy':policy},tmp_path,storage)
    assert len(api.calls)==2
    db.close()


def test_pdf_upload_lost_ack_retries_status_without_sending_bytes_twice(tmp_path):
    db=c.open_database(tmp_path/'state.sqlite');row,fingerprint,data=saved_pdf(db,tmp_path)
    api=UploadAPI(fail_upload=True);outlet={**OUTLET,'policy':{'epoch':2,'from':'2025-01-01','through':'2026-12-31'}}
    c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    assert db.execute('SELECT status FROM pdf_uploads').fetchone()[0]=='retry'
    db.execute('UPDATE pdf_uploads SET next_try=0');db.commit()
    c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    assert [x[0] for x in api.calls]==['GET','POST','GET']
    assert db.execute('SELECT status FROM pdf_uploads').fetchone()[0]=='stored'
    db.close()


def test_pdf_upload_budget_and_pause_preserve_remaining_files(tmp_path):
    db=c.open_database(tmp_path/'state.sqlite')
    for i in range(3):saved_pdf(db,tmp_path,i)
    api=UploadAPI();outlet={**OUTLET,'policy':{'epoch':2,'from':'2025-01-01','through':'2026-12-31'}}
    assert not c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':False})
    assert not c.sync_pdf_files(api,'https://atlas.example',db,{**outlet,'policy':{**outlet['policy'],'paused':True}},tmp_path,{'configured':True})
    assert not api.calls
    assert c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    assert len(api.files)==2
    assert not c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    assert len(api.files)==3 and len(list(tmp_path.glob('*.pdf')))==3
    db.close()


def test_corrupt_local_pdf_is_not_uploaded_and_storage_limit_backs_off(tmp_path,caplog):
    db=c.open_database(tmp_path/'state.sqlite');row,fingerprint,data=saved_pdf(db,tmp_path)
    path=tmp_path/(fingerprint+'.pdf');path.write_bytes(data[:-1]+b'x')
    api=UploadAPI();outlet={**OUTLET,'policy':{'epoch':2,'from':'2025-01-01','through':'2026-12-31'}}
    c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    assert not api.files and len(api.calls)==1 and path.exists()
    path.write_bytes(data);db.execute('UPDATE pdf_uploads SET next_try=0');db.commit()
    original=api.request
    api.request=lambda method,url,**kwargs: UploadReply({'error':'storage limit reached'},507) if method=='POST' else original(method,url,**kwargs)
    c.sync_pdf_files(api,'https://atlas.example',db,outlet,tmp_path,{'configured':True})
    status,next_try=db.execute('SELECT status,next_try FROM pdf_uploads').fetchone()
    assert status=='storage_limit' and next_try>c.time.time()+800
    assert 'storage limit reached' in caplog.text and path.read_bytes()==data
    db.close()


def test_pdf_cover_is_used_when_first_page_preview_is_unavailable():
    row={'publication_version':1,'url':BASE+'posts/naba/1/','preview_url':BASE+'hero.jpg',
         'attachments':[{'type':'pdf','url':BASE+'large.pdf'}]}
    with patch.object(c,'_make_preview',side_effect=[{'preview_status':'Preview source exceeds 8 MB cap'}, {'preview':'data:image/jpeg;base64,test','preview_status':'Source thumbnail'}]) as make:
        result=c.make_preview(None,row)
    assert result['preview_version']==2 and result['preview_status']=='Source thumbnail'
    assert make.call_args_list[1].args[1]['attachments']==[]
    assert make.call_args_list[1].args[1]['preview_url']==BASE+'hero.jpg'


def test_old_missing_preview_is_retried_once_without_resetting_items(tmp_path):
    db=c.open_database(tmp_path/'state.sqlite')
    row,fingerprint,data=saved_pdf(db,tmp_path)
    row.update(type='pdf',title='مجلة',text_status='complete',preview_status='Old failure')
    db.execute('UPDATE items SET metadata=?',(json.dumps(row),));db.commit()
    outlet={**OUTLET,'policy':{'epoch':2,'from':'2025-01-01','through':'2026-12-31','pages_per_scan':1,'previews':True}}
    site=Site({BASE:'<html></html>'})
    with patch.object(c,'api_call',return_value={'ok':True}),patch.object(c,'make_preview',return_value={'preview_status':'No image available','preview_version':2}) as make:
        c.scan_outlet(None,'',site,db,outlet,tmp_path,False,1000,1,100,0)
        c.scan_outlet(None,'',site,db,outlet,tmp_path,False,1000,1,100,0)
        assert make.call_count==1
    assert db.execute('SELECT COUNT(*) FROM items').fetchone()[0]==1
    db.close()


# Regression tests for the audit of 2026-10-04. All source traffic is stubbed.
LOOP_POLICY = {'epoch':2, 'from':'2025-01-01', 'through':'2026-12-31', 'pages_per_scan':10, 'previews':False}


def policy_scan(site, db, tmp_path, outlet, budget=10, acquire=False, max_pages=10000):
    sent = []
    with patch.object(c, 'api_call', side_effect=lambda *args, **kwargs: sent.append(args[-1]) or {'ok': True}):
        ok = c.scan_outlet(None, '', site, db, outlet, tmp_path, acquire, 100, budget, max_pages, 0)
    return ok, sent


def passes(site, db, tmp_path, outlet, count, **kwargs):
    calls, sent = [], []
    for _ in range(count):
        before = len(site.calls)
        sent.append(policy_scan(site, db, tmp_path, outlet, **kwargs)[1])
        calls.append(site.calls[before:])
    return calls, sent


def frontier(db):
    return {url: (status, attempts) for url, status, attempts in db.execute('SELECT url,status,attempts FROM frontier')}


def card(i, date='السبت، 3 أكتوبر 2025'):
    return '<div class="post-card"><a class="post-card-link" href="/posts/news/%s/"><h5 class="post-summary">خبر رقم %s</h5></a><div class="card-footer"><span>%s</span></div></div>' % (i, i, date)


def cards(ids, next_page=False):
    return '<div id="post-card-holder">' + ''.join(card(i) for i in ids) + '</div>' + ('<ul class="pagination"><li><a href="/page/2/">2</a></li></ul>' if next_page else '')


def mark_watching(db):
    db.execute("INSERT OR REPLACE INTO settings VALUES (?, 'complete')", ('publication-inventory-v1:'+OUTLET['id'],))
    db.execute('INSERT OR REPLACE INTO outlets VALUES (?,1)', (OUTLET['id'],))
    db.commit()


def test_dead_link_is_abandoned_after_three_passes_and_the_start_page_is_fetched_again(tmp_path):
    site = Site({BASE: '<a href="dead">dead</a><a href="2025-09-01-old.pdf">old</a>', BASE+'dead': 404})
    db = c.open_database(tmp_path/'state.sqlite')
    outlet = {**OUTLET, 'policy': LOOP_POLICY, 'collection_phase': 'watch'}
    calls, sent = passes(site, db, tmp_path, outlet, 3)
    # One attempt per pass, so a brief source problem cannot use up all three at once.
    assert calls == [[BASE, BASE+'dead']] * 3
    assert not any(batch['scan_complete'] for batch in sent[0] + sent[1])
    assert sent[2][-1]['scan_complete'] and sent[2][-1]['abandoned_pages'] == 1
    assert sent[2][-1]['failed_pages'] == 0 and not sent[2][-1]['truncated']
    assert db.execute("SELECT value FROM settings WHERE key=?", ('publication-inventory-v1:'+OUTLET['id'],)).fetchone()[0] == 'complete'
    site.pages[BASE] += '<a href="2025-10-02-new.pdf">new</a>'
    calls, sent = passes(site, db, tmp_path, outlet, 1)
    assert calls[0][0] == BASE
    baseline = dict(db.execute('SELECT url,baseline FROM items'))
    assert baseline == {BASE+'2025-09-01-old.pdf': 1, BASE+'2025-10-02-new.pdf': 0}
    db.close()


def test_title_less_detail_page_is_abandoned_and_new_cards_are_not_baseline(tmp_path):
    site = Site({BASE: cards([0, 1]), BASE+'posts/news/0/': structured_detail('<img src="/logo.png">', '', '2025-10-03'),
                 BASE+'posts/news/1/': structured_detail('خبر', '', '2025-10-03'), BASE+'posts/news/2/': structured_detail('خبر جديد', '', '2025-10-03')})
    db = c.open_database(tmp_path/'state.sqlite')
    outlet = {**OUTLET, 'policy': LOOP_POLICY, 'collection_phase': 'watch'}
    calls, sent = passes(site, db, tmp_path, outlet, 1)
    assert frontier(db)[BASE+'posts/news/0/'][0] == 'partial'
    assert sent[0][-1]['scan_complete'] and sent[0][-1]['abandoned_pages'] == 1 and not sent[0][-1]['truncated']
    site.pages[BASE] = cards([0, 1, 2])
    calls, sent = passes(site, db, tmp_path, outlet, 1)
    assert calls[0][0] == BASE
    baseline = dict(db.execute('SELECT url,baseline FROM items'))
    assert baseline[BASE+'posts/news/2/'] == 0 and baseline[BASE+'posts/news/1/'] == 1
    db.close()


def test_limited_start_page_closes_the_run_and_still_counts_as_scanned(tmp_path):
    # Over 500 links truncate the page; its items must still reach Atlas with scan_ok.
    site = Site({BASE: ''.join('<a href="2025-05-01-file%d.pdf">file</a>' % i for i in range(501))})
    db = c.open_database(tmp_path/'state.sqlite')
    calls, sent = passes(site, db, tmp_path, {**OUTLET, 'policy': LOOP_POLICY}, 1)
    assert calls == [[BASE]]
    assert all(batch['scan_ok'] and batch['pages_scanned'] == 1 for batch in sent[0])
    assert sent[0][-1]['scan_complete'] and sent[0][-1]['abandoned_pages'] == 1 and not sent[0][-1]['truncated']
    assert sum(len(batch['items']) for batch in sent[0]) == c.MAX_ITEMS
    assert frontier(db)[BASE][0] == 'partial'
    db.close()


def test_start_page_failure_is_retried_and_never_completes_an_empty_inventory(tmp_path):
    site = Site({BASE: 404})
    db = c.open_database(tmp_path/'state.sqlite')
    calls, sent = passes(site, db, tmp_path, {**OUTLET, 'policy': LOOP_POLICY}, 4)
    assert calls == [[BASE]] * 4
    assert not any(batch['scan_complete'] for batch_list in sent for batch in batch_list)
    assert not db.execute('SELECT 1 FROM outlets').fetchone()
    assert db.execute("SELECT value FROM settings WHERE key=?", ('publication-inventory-v1:'+OUTLET['id'],)).fetchone()[0] == 'running'
    db.close()


def test_tor_outage_does_not_use_up_page_attempts(tmp_path):
    pages = {BASE: '<a href="a">a</a><a href="b">b</a>', BASE+'a': '<p>a</p>', BASE+'b': '<p>b</p>'}
    site = Site(dict(pages))
    db = c.open_database(tmp_path/'state.sqlite')
    outlet = {**OUTLET, 'policy': LOOP_POLICY}
    passes(site, db, tmp_path, outlet, 1, budget=1)
    site.pages = {url: c.requests.exceptions.ConnectTimeout('down') for url in pages}
    calls, sent = passes(site, db, tmp_path, outlet, 5)
    # The start page is probed once only failing pages remain; it is down as well.
    assert calls == [[BASE+'a', BASE+'b', BASE]] * 5
    assert frontier(db) == {BASE: ('done', 1), BASE+'a': ('failed', 0), BASE+'b': ('failed', 0)}
    site.pages = dict(pages)
    calls, sent = passes(site, db, tmp_path, outlet, 1)
    assert sent[0][-1]['scan_complete'] and sent[0][-1]['abandoned_pages'] == 0
    db.close()


def test_page_that_keeps_timing_out_is_abandoned_once_the_start_page_answers(tmp_path):
    site = Site({BASE: '<a href="slow">slow</a>', BASE+'slow': c.requests.exceptions.ReadTimeout('slow')})
    db = c.open_database(tmp_path/'state.sqlite')
    calls, sent = passes(site, db, tmp_path, {**OUTLET, 'policy': LOOP_POLICY}, 3)
    assert calls == [[BASE, BASE+'slow'], [BASE+'slow', BASE], [BASE+'slow', BASE]]
    assert sent[2][-1]['scan_complete'] and sent[2][-1]['abandoned_pages'] == 1
    db.close()


def test_watch_pass_reads_only_current_listing_and_new_publications(tmp_path):
    site = Site({BASE: cards(range(12), True), BASE+'page/2/': cards([20]),
                 **{BASE+'posts/news/%s/' % i: structured_detail('خبر %s' % i, '', '2025-10-03') for i in list(range(13)) + [20]}})
    db = c.open_database(tmp_path/'state.sqlite')
    mark_watching(db)
    outlet = {**OUTLET, 'policy': {**LOOP_POLICY, 'pages_per_scan': 3}, 'collection_phase': 'watch'}
    calls, sent = passes(site, db, tmp_path, outlet, 1)
    site.pages[BASE] = cards(range(13), True)
    more_calls, more_sent = passes(site, db, tmp_path, outlet, 3)
    calls += more_calls
    assert [pass_calls[0] for pass_calls in calls] == [BASE] * 4
    assert calls[1] == [BASE, BASE+'posts/news/12/']
    assert all(BASE+'page/2/' not in pass_calls for pass_calls in calls)
    uploaded = [item['url'] for batch in more_sent[0] for item in batch['items']]
    assert BASE+'posts/news/12/' in uploaded
    # Unchanged cards are not reopened, and historical pagination is never followed.
    assert BASE+'posts/news/11/' not in uploaded
    assert db.execute('SELECT baseline FROM items WHERE url=?', (BASE+'posts/news/12/',)).fetchone()[0] == 0
    db.close()


def test_generic_pages_never_fetch_preview_or_acquire_images(tmp_path):
    comment = 'A forum reply with enough words to be selected as a comment. ' * 3
    site = Site({BASE: '<meta property="article:published_time" content="2025-05-01"><meta property="og:image" content="/hero.jpg"><title>Thread</title>'
                       '<div class="comment-body">'+comment+'</div><a href="/attach/123.jpg">image</a><video poster="/poster.jpg" src="/clip.mp4"></video>'})
    db = c.open_database(tmp_path/'state.sqlite')
    mark_watching(db)
    acquired = []
    def acquire(tor, item, *args):
        acquired.append(item['url'])
        return {'acquired': True, 'sha256': 'b'*64, 'bytes': 3}
    with patch.object(c, 'acquire', side_effect=acquire):
        ok, sent = policy_scan(site, db, tmp_path, {**OUTLET, 'policy': {**LOOP_POLICY, 'previews': True}}, acquire=True)
    assert site.calls == [BASE]
    assert BASE+'attach/123.jpg' not in acquired
    items = {item['url']: item for batch in sent for item in batch['items']}
    assert items[BASE+'attach/123.jpg']['type'] == 'image'
    assert not any('preview' in item or 'preview_status' in item for item in items.values())
    for row in items.values():
        assert c.preview_source(row) is None
    session = Session([])
    assert c.make_preview(session, {'url': BASE+'a.jpg', 'type': 'image', 'preview_url': BASE+'hero.jpg'})['preview_status'] == 'No visual preview supplied'
    assert c.make_preview(session, {'url': BASE+'a.pdf', 'type': 'pdf'})['preview_status'] == 'No visual preview supplied'
    assert session.calls == []
    db.close()


LONG_PATH = 'uploads/2025-05-01-' + 'ع' * 330 + '.pdf'


def test_url_length_is_measured_after_the_workers_percent_encoding():
    assert len(BASE + LONG_PATH) < 500 and c.onion_url(BASE + LONG_PATH) == ''
    short = BASE + 'uploads/2025-05-01-' + 'ع' * 300 + '.pdf'
    assert c.onion_url(short) == short
    parser = c.ListingParser(BASE); parser.feed('<a href="/'+LONG_PATH+'">long</a><a href="/ok.pdf">ok</a>')
    assert list(parser.rows) == [BASE+'ok.pdf']
    row = c.structured_publications(structured_detail('مجلة', '<a href="/'+LONG_PATH+'">PDF</a><a href="/ok.pdf">PDF</a>'), BASE+'posts/naba/1/')['page']
    assert [a['url'] for a in row['attachments']] == [BASE+'ok.pdf']


def test_url_length_bound_is_never_below_new_url_in_node():
    import shutil, subprocess
    if not shutil.which('node'):
        pytest.skip('node is not installed')
    urls = [BASE + LONG_PATH, BASE + 'a b/"q"/{x}/<y>/`z`/|^[]~?k=\'v\' "w"&x=ع', BASE + "it's/%41%zz?q=1;2,3"]
    script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(u=>new URL(u).href.length))))"
    result = subprocess.run(['node', '-e', script], input=json.dumps(urls), capture_output=True, text=True, encoding='utf-8', timeout=60)
    measured = json.loads(result.stdout)
    assert measured[0] > 2000
    assert all(len(c.quote(url, safe=c.URL_SAFE)) >= length for url, length in zip(urls, measured))


def test_queued_row_with_overlong_url_is_kept_locally_and_does_not_freeze_the_outlet(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    rows = [{'url': BASE+LONG_PATH, 'type': 'pdf', 'title': 'long', 'published_at': '2025-05-01'},
            {'url': BASE+'posts/naba/9/', 'publication_version': 1, 'published_at': '2025-05-03', 'title': 'مجلة', 'original_text': 'مجلة',
             'text_status': 'complete', 'attachments': [{'url': BASE+LONG_PATH, 'type': 'pdf', 'title': 'long'}]},
            {'url': BASE+'2025-05-02-ok.pdf', 'type': 'pdf', 'title': 'ok', 'published_at': '2025-05-02'}]
    for row in rows:
        db.execute('INSERT INTO outbox VALUES (?,?,?,?)', (OUTLET['id'], row['url'], json.dumps(row), 1))
    db.commit()
    site = Site({BASE: '<p>home</p>'})
    outlet = {**OUTLET, 'policy': LOOP_POLICY}
    ok, sent = policy_scan(site, db, tmp_path, outlet)
    assert [item['url'] for batch in sent for item in batch['items']] == [BASE+'2025-05-02-ok.pdf']
    kept = {url: json.loads(metadata) for url, metadata in db.execute('SELECT url,metadata FROM rejected')}
    assert kept == {rows[0]['url']: rows[0], rows[1]['url']: rows[1]}
    assert not db.execute('SELECT 1 FROM outbox').fetchone() and site.calls == []
    policy_scan(site, db, tmp_path, outlet)
    assert site.calls == [BASE]
    db.close()


class LegacyPublicationParser(c.HTMLParser):
    """The selection parser before the linear rewrite, kept to prove identical output."""
    VOID, OMIT = c.PublicationParser.VOID, c.PublicationParser.OMIT
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.blocks = [], []
    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        marker = " ".join(values.get(k, "") for k in ("id", "class", "itemprop"))
        tokens = set(c.re.split(r"[^\w]+", marker.lower()))
        excluded = bool(tokens & {"menu", "navigation", "breadcrumb", "breadcrumbs", "pagination", "sidebar"})
        omitted = tag in self.OMIT or excluded or values.get("role") == "navigation" or "hidden" in values or values.get("aria-hidden") == "true"
        comment = bool(tokens & {"comment", "comments", "reply", "replies", "commentbody", "usercomment"})
        frame = {"tag": tag, "omit": omitted or any(x["omit"] for x in self.stack),
                 "comment": comment or any(x["comment"] for x in self.stack), "parts": [], "linked": 0}
        if tag not in self.VOID:
            self.stack.append(frame)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)
    def handle_data(self, data):
        if not self.stack or self.stack[-1]["omit"]:
            return
        linked = any(x["tag"] == "a" for x in self.stack)
        for frame in self.stack:
            if frame["tag"] in {"p", "article", "main", "blockquote", "div", "td", "section"}:
                frame["parts"].append(data)
                frame["linked"] += len(data) if linked else 0
    def handle_endtag(self, tag):
        index = next((i for i in range(len(self.stack)-1, -1, -1) if self.stack[i]["tag"] == tag), None)
        if index is None:
            return
        for frame in self.stack[index:]:
            raw = " ".join(frame["parts"])
            text = " ".join(raw.split())
            if not frame["omit"] and text and frame["linked"] / max(len(raw), 1) < 0.25:
                self.blocks.append((text, frame["comment"], frame["tag"]))
        del self.stack[index:]
    def selected_text(self):
        candidates = [(text, comment) for text, comment, tag in self.blocks
                      if (comment and len(text) >= 80) or (len(text) >= 1200 and tag in {"p", "article", "blockquote", "div", "td"})]
        paragraphs = list(dict.fromkeys(text for text, _, tag in self.blocks if tag == "p" and len(text) >= 120))
        if sum(map(len, paragraphs)) >= 1200:
            candidates.append(("\n\n".join(paragraphs), False))
        if not candidates:
            return ""
        return max(candidates, key=lambda row: len(row[0]))[0][:100000]


def selection(parser_class, html):
    parser = parser_class()
    parser.feed(html)
    parser.handle_endtag('html')
    return parser.selected_text()


def random_page(rng):
    tags = ['p', 'div', 'article', 'section', 'main', 'blockquote', 'span', 'a', 'b', 'nav', 'h2', 'ul', 'li', 'table', 'tr', 'td',
            'aside', 'header', 'footer', 'form', 'script', 'style', 'em', 'br', 'img']
    attributes = ['', '', '', ' class="comment-body"', ' class="sidebar"', ' aria-hidden="true"', ' id="main"', ' role="navigation"', ' class="post reply"', ' hidden']
    words = ['تحليل', 'report', 'نص', 'details', 'العدد', 'context', 'statement', 'claims', 'الولاية', 'analysis', '&amp;', 'x']
    def text():
        return ' '.join(rng.choice(words) for _ in range(rng.randint(1, 160)))
    def node(depth, ancestors):
        if depth > 5 or rng.random() < 0.3:
            return text()
        tag = rng.choice(tags)
        if tag in c.PublicationParser.IMPLIED and tag in ancestors:
            tag = 'div'
        if tag in c.PublicationParser.VOID:
            return '<%s>' % tag
        if tag in ('script', 'style'):
            return '<%s>%s</%s>' % (tag, text(), tag)
        inner = ''.join(node(depth + 1, ancestors | {tag}) for _ in range(rng.randint(1, 4)))
        return '<%s%s>%s</%s>' % (tag, rng.choice(attributes), inner, tag)
    return '<html><body>' + ''.join(node(0, frozenset()) for _ in range(rng.randint(1, 6))) + '</body></html>'


def test_linear_parser_output_is_identical_for_well_formed_pages():
    import random
    rng = random.Random(20261004)
    fixtures = [structured_detail('عنوان', '<p>'+'فقرة طويلة من النص العربي للتحليل. '*20+'</p>'), magazine_viewer_detail(),
                '<article><p>'+('هذا نص طويل يتضمن تفاصيل ومعلومات للتحليل. '*40)+'</p></article>',
                '<div class="comment-body">'+('An identifiable user comment with enough context. '*3)+'</div>',
                '<nav><div>'+('menu text '*500)+'</div></nav><div>'+(' <a href="/x">link label</a> '*300)+'</div>']
    pages = fixtures + [random_page(rng) for _ in range(400)]
    selected = 0
    for html in pages:
        expected = selection(LegacyPublicationParser, html)
        assert selection(c.PublicationParser, html) == expected
        selected += bool(expected)
    assert selected > 50, 'the random pages exercise non-empty selections'


def test_unclosed_paragraphs_list_items_and_cells_parse_in_linear_time():
    import time
    paragraph = 'Paragraph %d carries enough analytical text to count as a body paragraph of the publication. '
    body = ''.join('<p>' + (paragraph % i) * 2 for i in range(4000))
    started = time.monotonic()
    unclosed = selection(c.PublicationParser, '<html><body>' + body + '</body></html>')
    assert time.monotonic() - started < 5
    closed = ''.join('<p>' + (paragraph % i) * 2 + '</p>' for i in range(4000))
    assert unclosed == selection(c.PublicationParser, '<html><body>' + closed + '</body></html>') and unclosed
    cell = 'Cell text that is long enough to be selected as a table body block. ' * 30
    assert selection(c.PublicationParser, '<html><table><tr><td>'+cell+'<td>'+cell+'<tr><td>'+cell+'</table></html>') == \
        selection(c.PublicationParser, '<html><table><tr><td>'+cell+'</td><td>'+cell+'</td></tr><tr><td>'+cell+'</td></tr></table></html>')
    items = ''.join('<li>' + paragraph % i for i in range(4000))
    started = time.monotonic()
    selection(c.PublicationParser, '<html><ul>' + items + '</ul></html>')
    assert time.monotonic() - started < 5


def test_deep_nesting_is_capped_and_deep_navigation_stays_excluded():
    import time
    started = time.monotonic()
    text = 'Deeply nested body text that should still be readable. ' * 40
    deep = '<html>' + '<div>' * 20000 + text + '<nav>' + 'menu label ' * 300 + '</nav>' + '</div>' * 20000 + '</html>'
    result = selection(c.PublicationParser, deep)
    assert time.monotonic() - started < 5
    assert result.startswith('Deeply nested') and 'menu label' not in result
    parser = c.PublicationParser(); parser.feed('<div>' * 1000)
    assert len(parser.stack) == c.PublicationParser.MAX_DEPTH


def test_transient_preview_errors_are_classified_and_carry_no_status():
    pytest.importorskip('PIL.Image')
    row = {'publication_version': 1, 'url': BASE+'posts/news/1/', 'preview_url': BASE+'cover.jpg', 'attachments': []}
    class Down:
        def __init__(self, error):
            self.error = error
        def get(self, url, **kwargs):
            raise self.error
    for error in (c.requests.exceptions.ReadTimeout('slow'), c.requests.exceptions.ConnectionError('refused')):
        assert c.make_preview(Down(error), row) == {'transient': True}
    assert c.make_preview(Site({BASE+'cover.jpg': 503}), row) == {'transient': True}
    permanent = c.make_preview(Site({BASE+'cover.jpg': 404}), row)
    assert permanent == {'preview_status': 'Preview unavailable within collection limits', 'preview_version': 2}
    magazine = {**row, 'attachments': [{'type': 'pdf', 'url': BASE+'large.pdf'}]}
    with patch.object(c, '_make_preview', side_effect=[{'preview_status': 'Preview source exceeds 8 MB cap'}, {'transient': True}]):
        assert c.make_preview(None, magazine) == {'transient': True}


def preview_site():
    return Site({BASE: '<meta property="og:image" content="/cover.jpg">' + structured_detail('مقال', '<p>نص المقال</p>', '2025-10-03')})


def test_transient_preview_failures_are_retried_for_three_passes_without_reuploading(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    site = preview_site()
    outlet = {**OUTLET, 'policy': {**LOOP_POLICY, 'previews': True}}
    with patch.object(c, '_make_preview', return_value={'transient': True}) as make:
        calls, sent = passes(site, db, tmp_path, outlet, 3)
    assert make.call_count == 3
    uploads = [[item for batch in batches for item in batch['items']] for batches in sent]
    assert len(uploads[0]) == 1 and 'preview_status' not in uploads[0][0]
    assert uploads[1] == [], 'only the local retry counter changed'
    assert uploads[2][0]['preview_status'] == 'Preview source unreachable after 3 attempts'
    stored = json.loads(db.execute('SELECT metadata FROM items').fetchone()[0])
    assert stored['preview_status'] == 'Preview source unreachable after 3 attempts' and stored['preview_version'] == 2
    assert not db.execute('SELECT 1 FROM preview_retries').fetchone()
    db.close()


def test_preview_succeeds_on_a_later_pass_after_a_timeout(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    outlet = {**OUTLET, 'policy': {**LOOP_POLICY, 'previews': True}}
    picture = {'preview': 'data:image/jpeg;base64,/9j/AAAA', 'preview_status': 'Source thumbnail'}
    with patch.object(c, '_make_preview', side_effect=[{'transient': True}, picture]):
        calls, sent = passes(preview_site(), db, tmp_path, outlet, 3)
    stored = json.loads(db.execute('SELECT metadata FROM items').fetchone()[0])
    assert stored['preview'] == picture['preview'] and stored['preview_version'] == 2
    assert not db.execute('SELECT 1 FROM preview_retries').fetchone()
    db.close()


PREVIOUS_SCHEMA = [
    "CREATE TABLE outlets (id TEXT PRIMARY KEY, initialized INTEGER NOT NULL)",
    "CREATE TABLE items (outlet_id TEXT, url TEXT, metadata TEXT, baseline INTEGER, PRIMARY KEY(outlet_id,url))",
    "CREATE TABLE crawl_runs (outlet_id TEXT PRIMARY KEY, finished INTEGER DEFAULT 0)",
    "CREATE TABLE frontier (outlet_id TEXT, url TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, PRIMARY KEY(outlet_id,url))",
    "CREATE TABLE pages (outlet_id TEXT, url TEXT, title TEXT, text TEXT, checked_at TEXT, PRIMARY KEY(outlet_id,url))",
    "CREATE TABLE outbox (outlet_id TEXT, url TEXT, metadata TEXT, baseline INTEGER, PRIMARY KEY(outlet_id,url))",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
    "CREATE TABLE pdf_uploads (outlet_id TEXT, item_url TEXT, sha256 TEXT, epoch INTEGER, status TEXT, attempts INTEGER, next_try REAL, PRIMARY KEY(outlet_id,item_url,sha256,epoch))",
    "CREATE TABLE undated (outlet_id TEXT, url TEXT, metadata TEXT, PRIMARY KEY(outlet_id,url))",
    "ALTER TABLE frontier ADD COLUMN depth INTEGER DEFAULT 0"]


def test_existing_archive_database_is_preserved_and_its_stuck_run_finishes(tmp_path):
    import sqlite3
    path, oid = tmp_path/'state.sqlite', OUTLET['id']
    old = sqlite3.connect(path)
    for statement in PREVIOUS_SCHEMA:
        old.execute(statement)
    archive = [(oid, BASE+'posts/naba/%d/' % i, json.dumps({'url': BASE+'posts/naba/%d/' % i, 'publication_version': 1, 'published_at': '2025-06-01',
               'title': 'مجلة', 'text_status': 'complete', 'preview_status': 'First page', 'preview_version': 2,
               'attachments': [{'url': BASE+'%d.pdf' % i, 'type': 'pdf', 'acquired': True, 'sha256': 'a'*64, 'bytes': 9}]}, ensure_ascii=False), 1) for i in range(3)]
    old.executemany('INSERT INTO items VALUES (?,?,?,?)', archive)
    old.execute('INSERT INTO crawl_runs VALUES (?,0)', (oid,))
    old.executemany('INSERT INTO frontier(outlet_id,url,status,attempts,depth) VALUES (?,?,?,?,?)',
                    [(oid, BASE, 'done', 1, 0), (oid, BASE+'dead', 'failed', 0, 1), (oid, BASE+'huge', 'limited', 1, 1)])
    old.execute("INSERT INTO settings VALUES (?, 'running')", ('publication-inventory-v1:'+oid,))
    old.commit(); old.close()
    db = c.open_database(path)
    site = Site({BASE+'dead': 404})
    calls, sent = passes(site, db, tmp_path, {**OUTLET, 'policy': {**LOOP_POLICY, 'previews': True}}, 3)
    assert calls == [[BASE+'dead']] * 3
    assert sent[2][-1]['scan_complete'] and sent[2][-1]['abandoned_pages'] == 2
    assert not any(batch['items'] for batches in sent for batch in batches), 'nothing already uploaded is sent again'
    assert db.execute('SELECT * FROM items ORDER BY rowid').fetchall() == archive
    assert {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= {'rejected', 'preview_retries'}
    db.close()


# Latin-script outlets (2026-10-07). Besira's HTML is unknown, so these fixtures
# imitate common WordPress, Blogger and generic article markup. All traffic is stubbed.
BASE2 = 'http://' + 'b' * 56 + '.onion/'
OUTLET2 = {'id': 'latin-outlet', 'url': BASE2}
LONG_BODY = '<div>' + 'Body text with enough analytical detail to be selected as a publication. ' * 20 + '</div>'


def read_page(html, url=BASE, mime='text/html; charset=utf-8', headers=None):
    return c.read_listing(Site({url: (html, mime, headers or {})}), {**OUTLET, 'url': url})


@pytest.mark.parametrize('text,lang,expected', [
    ('12 Ekim 2026', '', '2026-10-12'), ('Pazartesi, 12 Ekim 2026', 'tr', '2026-10-12'), ('12 EKİM 2026', 'tr', '2026-10-12'),
    ('12 MAYIS 2026', 'tr', '2026-05-12'), ('12 Ağustos 2026', 'tr', '2026-08-12'), ('12 Kasım 2026', '', '2026-11-12'),
    ('Ekim 7, 2026', 'tr', '2026-10-07'), ('12. oktobar 2026.', 'bs', '2026-10-12'), ('ponedjeljak, 12. oktobra 2026.', 'bs', '2026-10-12'),
    ('12. marta 2026.', 'sr', '2026-03-12'), ('12. listopada 2026.', 'hr', '2026-10-12'), ('12. siječnja 2026.', 'hr', '2026-01-12'),
    ('12 tetor 2026', 'sq', '2026-10-12'), ('12 tetorit 2026', '', '2026-10-12'), ('12 Oktober 2026', 'de', '2026-10-12'),
    ('7. Oktober 2026', 'de', '2026-10-07'), ('12. März 2026', 'de', '2026-03-12'), ('12 octobre 2026', 'fr', '2026-10-12'),
    ('1er octobre 2026', 'fr', '2026-10-01'), ('12 Cotmeh 2026', 'ku', '2026-10-12'), ("12'ê Cotmehê 2026an", 'ku', '2026-10-12'),
    ('5ê Kanûna Pêşîn 2026', 'ku', '2026-12-05'), ('Senin, 12 Oktober 2026', 'id', '2026-10-12'), ('12 Ogos 2026', 'ms', '2026-08-12'),
    ('12 Mac 2026', 'ms', '2026-03-12'), ('12 de octubre de 2026', 'es', '2026-10-12'), ('12 ottobre 2026', 'it', '2026-10-12'),
    ('12 de outubro de 2026', 'pt', '2026-10-12'), ('October 12, 2026', 'en', '2026-10-12'), ('Oct 12, 2026', '', '2026-10-12'),
    ('Oct. 12th, 2026', 'en', '2026-10-12'), ('12th October 2026', 'en', '2026-10-12'), ('Mon, 12 Oct 2026 10:00:00 +0000', '', '2026-10-12'),
    ('12-Oct-2026', '', '2026-10-12'), ('12.10.2026', '', '2026-10-12'), ('12.10.2026.', 'hr', '2026-10-12'), ('12. 10. 2026.', 'hr', '2026-10-12'),
    ('2026.10.12', '', '2026-10-12'), ('12/10/2026', 'tr', '2026-10-12'), ('12-10-2026', 'bs', '2026-10-12'), ('13/10/2026', 'en', '2026-10-13'),
    ('10/13/2026', 'en', '2026-10-13'), ('05/06/2026', '', '2026-06-05'), ('05/06/2026', 'fr', '2026-06-05'), ('05/06/2026', 'en', ''),
    ('05/06/2026', 'en-US', ''),
    # Arabic month table and Arabic-Indic digits are unchanged.
    ('السبت، ٣ أكتوبر ٢٠٢٦', '', '2026-10-03'), ('3 أبريل 2026', 'ar', '2026-04-03'), ('٢٠٢٥-٠٣-٠٩', '', '2025-03-09'),
    ('2026-10-12T10:00:00+03:00', '', '2026-10-12'), ('2026/10/12', '', '2026-10-12'),
])
def test_publication_date_reads_latin_month_names_and_numeric_orders(text, lang, expected):
    assert c.publication_date(text, lang) == expected


@pytest.mark.parametrize('text,lang', [
    ('31.02.2026', ''), ('30 Şubat 2026', 'tr'), ('31 April 2026', 'en'), ('2025-02-30', ''), ('29.02.2025', 'de'),
    ('2 gün önce', 'tr'), ('prije 2 dana', 'bs'), ('il y a 2 jours', 'fr'), ('vor 2 Tagen', 'de'), ('2 days ago', 'en'), ('3 orë më parë', 'sq'),
    # Polish and Czech "listopad" is November: never read it as the Croatian October.
    ('12. listopada 2026.', 'pl'), ('12 listopad 2026', 'cs'),
    # Abbreviations that are ordinary words in the page language are not months.
    ('12 des 2026', 'fr'), ('12 set 2026', 'en'), ('3 ago 2026', 'en'),
])
def test_relative_invalid_ambiguous_and_foreign_dates_stay_undated(text, lang):
    assert c.publication_date(text, lang) == ''


def test_earliest_valid_date_wins_and_folding_handles_turkish_i():
    assert c.publication_date('Yayın: 12 Ekim 2026, güncelleme 14.10.2026', 'tr') == '2026-10-12'
    assert c.publication_date('Güncellendi 14.10.2026 · Yayın 12 Ekim 2026', 'tr') == '2026-10-14'
    assert c.publication_date('31.02.2026 ve 12 Ekim 2026', 'tr') == '2026-10-12'
    assert c.publication_date('12 Des 2026', 'id') == '2026-12-12' and c.publication_date('12 des 2026') == '2026-12-12'
    assert [c.fold_text(w) for w in ('EKİM', 'MAYIS', 'Ağustos', 'Déclaration', 'ÇIKIŞ')] == ['ekim', 'mayis', 'agustos', 'declaration', 'cikis']
    assert c.machine_date('20251012') == c.machine_date('2025-10-12 10:00:00') == '2025-10-12'


def test_month_lexicon_is_folded_and_never_maps_one_word_to_two_months():
    seen = {}
    for code, months in c.MONTH_NAMES.items():
        assert len(months) == 12, code
        for number, names in enumerate(months, 1):
            for name in names.split(','):
                assert name == c.fold_text(name), (code, name)
                assert seen.setdefault(name, number) == number, (code, name)
    assert c.date_patterns('hr')[1]['listopad'] == 10 and 'listopad' not in c.date_patterns('pl')[1]


@pytest.mark.parametrize('path,expected', [
    ('wp-content/uploads/2026/10/1.pdf', ''), ('uploads/2026/10/12-scaled.jpg', ''), ('uploads/2025/03/7-1.pdf', ''),
    ('images/2026/1/5.mp4', ''), ('wp-content/uploads/2025-10-01-report.pdf', ''), ('2026/10/slug.html', ''), ('x/2026-02-30-y', ''),
    ('2026/10/12/post/', '2026-10-12'), ('2025-09-01-old.pdf', '2025-09-01'), ('news/2026_10_12_report', '2026-10-12'),
])
def test_url_dates_only_strict_permalinks_and_never_upload_folders(path, expected):
    assert c.url_publication_date(BASE + path) == expected


def test_published_time_wins_over_updated_sidebar_and_comment_times():
    sidebar = '<aside class="widget-area">' + ''.join('<time datetime="2025-09-%02d">x</time>' % d for d in range(1, 5)) + '</aside>'
    comments = '<div id="comments" class="comments-area"><time datetime="2025-10-13T10:00:00+03:00">13 Ekim 2025</time></div>'
    times = ('<time class="entry-date published" datetime="2025-10-12T09:00:00+03:00">12 Ekim 2025</time>'
             '<time class="updated" datetime="2025-10-14T09:00:00+03:00">14 Ekim 2025</time>')
    html = '<html lang="tr"><body><main><article><h1>Başlık</h1>' + times + LONG_BODY + '</article>' + comments + '</main>' + sidebar + '</body></html>'
    page = read_page(html)['page']
    assert page['published_at'] == '2025-10-12' and page['date_basis'] == 'html' and page['selection_version'] == 1
    # Without the class, the first time inside the single article still wins.
    assert read_page(html.replace(' class="entry-date published"', ''))['page']['published_at'] == '2025-10-12'
    # Only an updated time and chrome times: undated, never the sidebar or a comment.
    assert read_page(html.replace(times, times[times.index('<time class="updated"'):]))['page']['published_at'] == ''


@pytest.mark.parametrize('markup', [
    '<meta itemprop="datePublished" content="2025-10-12T10:00:00+03:00">',
    '<abbr class="published" itemprop="datePublished" title="2025-10-12T10:00:00+02:00">12. oktobra 2025.</abbr>',
    '<abbr class="published" title="2025-10-12T10:00:00+02:00">10:00</abbr>',
    '<span itemprop="datePublished" content="2025-10-12">12 Ekim 2025</span>',
    '<time pubdate datetime="2025-10-12">x</time><time datetime="2025-10-20">y</time>',
    '<meta name="pubdate" content="20251012">', '<meta name="publishdate" content="2025-10-12">',
    '<meta name="publish-date" content="12.10.2025">', '<meta name="publish_date" content="2025-10-12">',
    '<meta name="DC.date.issued" content="2025-10-12">', '<meta name="dc.date" content="2025-10-12">',
    '<meta name="dcterms.created" content="2025-10-12">', '<meta name="DCTERMS.date" content="2025-10-12">',
    '<meta name="parsely-pub-date" content="2025-10-12T10:00:00Z">', '<meta name="sailthru.date" content="2025-10-12 10:00:00">',
    '<meta property="article:published_time" content="2025-10-12T10:00:00+03:00">', '<meta name="date" content="2025-10-12">',
    '<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"BlogPosting","datePublished":"2025-10-12T10:00:00Z","dateModified":"2025-10-20"}]}</script>',
])
def test_microdata_blogger_abbr_and_extended_meta_names_date_the_page(markup):
    page = read_page('<html><head>' + markup + '</head><body>' + LONG_BODY + '</body></html>')['page']
    assert page['published_at'] == '2025-10-12'


def test_modified_only_metadata_leaves_a_page_undated():
    modified = ('<meta property="article:modified_time" content="2025-10-12"><meta property="og:updated_time" content="2025-10-12">'
                '<meta itemprop="dateModified" content="2025-10-12"><meta name="last-modified" content="2025-10-12">'
                '<span class="updated" itemprop="dateModified" content="2025-10-12">12 Ekim 2025</span>')
    assert read_page('<html><head>' + modified + '</head><body>' + LONG_BODY + '</body></html>')['page']['published_at'] == ''


def marked_article(label, lang='tr', sidebar='<aside><span class="post-date">1 Ekim 2025</span></aside>', url_path=''):
    return ('<html lang="%s"><head><meta property="og:type" content="article"></head><body><main><article class="post">'
            '<h1 class="entry-title">Kısa açıklama</h1>%s<div class="entry-content"><p>Kısa bir metin.</p></div></article></main>%s</body></html>') % (lang, label, sidebar)


@pytest.mark.parametrize('label,lang,expected', [
    ('<span class="posted-on">12 Ekim 2025</span>', 'tr', '2025-10-12'),
    ('<div class="date">12. oktobra 2025.</div>', 'bs', '2025-10-12'),
    ('<p class="byline">Publié le 1er octobre 2025 par la rédaction</p>', 'fr', '2025-10-01'),
    ('<time>12 October 2025</time>', 'en', '2025-10-12'),
    ('<span class="meta-date">12 tetor 2025</span><span class="byline">Redaksia</span>', 'sq', '2025-10-12'),
    # Two different visible dates inside the article: no guess.
    ('<span class="posted-on">12 Ekim 2025</span><span class="date">13 Ekim 2025</span>', 'tr', ''),
    # The only visible date is in the sidebar: undated.
    ('', 'tr', ''),
])
def test_visible_date_text_dates_the_article_but_never_the_sidebar(label, lang, expected):
    page = read_page(marked_article(label, lang), BASE + 'duyuru-7/')['page']
    assert page['publication_version'] == 1 and page['published_at'] == expected
    assert page['date_basis'] == 'html' and page['source_language'] == lang
    if expected:
        assert c.publication_date(page['source_date'], lang) == expected


def test_category_page_with_several_article_times_is_neither_dated_nor_a_record():
    cards = ''.join('<article class="post hentry"><h2 class="entry-title"><a href="/2025/10/%02d/yazi-%d/">Yazı %d</a></h2>'
                    '<time class="entry-date published" datetime="2025-10-%02dT10:00:00+03:00">%d Ekim 2025</time>'
                    '<div class="entry-content"><p>%s</p></div></article>' % (d, d, d, d, d, 'Uzun özet paragrafı, ayrıntılı bilgi içerir. ' * 10)
                    for d in (10, 11, 12))
    html = ('<html lang="tr"><head><meta property="og:type" content="article"></head><body class="archive category">'
            '<main>' + cards + '<nav class="pagination"><a href="/category/haber/page/2/">2</a></nav></main></body></html>')
    result = read_page(html, BASE + 'category/haber/')
    assert result['page']['published_at'] == '' and result['page']['selection_version'] == 0
    assert not result['page'].get('publication_version') and not c.selected_material(result['page'])
    assert {BASE + '2025/10/10/yazi-10/', BASE + 'category/haber/page/2/'} <= set(r['url'] for r in result['items'])
    # The same cards without a listing body class are still recognised as a listing.
    result = read_page(html.replace(' class="archive category"', ''), BASE + 'category/haber/')
    assert result['page']['selection_version'] == 0 and not result['page'].get('publication_version')


def test_permalink_url_dates_its_own_record_only_in_strict_form():
    html = marked_article('', sidebar='')
    page = read_page(html, BASE + '2025/10/12/ornek-yazi/')['page']
    assert page['published_at'] == '2025-10-12' and page['date_basis'] == 'url'
    assert read_page(html, BASE + '2025/10/ornek-yazi.html')['page']['published_at'] == ''
    legacy = read_page('<html><body>' + LONG_BODY + '</body></html>', BASE + 'haber/2025-10-12-rapor/')['page']
    assert legacy['published_at'] == '2025-10-12' and legacy['date_basis'] == 'url' and legacy['selection_version'] == 1
    assert read_page('<html><body><p>short</p></body></html>', BASE + 'haber/2025-10-12-rapor/')['page']['published_at'] == ''


def test_files_on_a_dated_page_take_its_date_not_the_upload_folder():
    links = ''.join('<a href="/%s">file</a>' % p for p in ('wp-content/uploads/2026/10/1.pdf', 'uploads/2025/03/7-1.pdf', 'images/2026/1/5.mp4'))
    dated = read_page('<html><head><meta property="article:published_time" content="2025-10-12T10:00:00Z"></head><body>' + links + '</body></html>')
    assert {(r['published_at'], r['date_basis']) for r in dated['items']} == {('2025-10-12', 'source_page')}
    undated = read_page('<html><body>' + links + '<a href="/files/2025-09-01-old.pdf">old</a></body></html>')
    assert {r['url']: r['published_at'] for r in undated['items']} == {
        BASE + 'wp-content/uploads/2026/10/1.pdf': '', BASE + 'uploads/2025/03/7-1.pdf': '', BASE + 'images/2026/1/5.mp4': '',
        BASE + 'files/2025-09-01-old.pdf': '2025-09-01'}


TR_HEADER = ('<header id="masthead" class="site-header"><p class="site-date">7 Ekim 2026, Çarşamba</p><nav class="main-navigation">'
             '<a href="/">Ana sayfa</a><a href="/category/haberler/">Haberler</a><a href="/wp-login.php">Giriş</a>'
             '<a href="/%C3%A7%C4%B1k%C4%B1%C5%9F/">Çıkış</a></nav></header>')
TR_SIDEBAR = ('<aside id="secondary" class="widget-area"><section class="widget widget_recent_entries"><h2 class="widget-title">Son yazılar</h2><ul>'
              '<li><a href="/2025/10/12/sinir-bolgesinde-catisma/">Sınır bölgesinde çatışma</a><span class="post-date">11 Ekim 2025</span></li>'
              '<li><a href="/duyuru-7/">Kamuoyuna duyuru</a><span class="post-date">4 Ekim 2025</span></li>'
              '<li><a href="/haber/rapor-3/">Rapor</a><time datetime="2025-09-01">1 Eylül 2025</time></li></ul></section></aside>')
TR_FOOTER = ('<footer id="colophon" class="site-footer"><a href="/feed/">RSS</a><a href="/comments/feed/">Yorum RSS</a>'
             '<a href="/?amp=1">AMP</a><a href="/xmlrpc.php">XML-RPC</a></footer>')
TR_ARTICLE_URL = BASE + '2025/10/12/sinir-bolgesinde-catisma/'
TR_PDF = BASE + 'wp-content/uploads/2025/09/1.pdf'


def tr_article():
    """WordPress single post: published and updated times, sharing block, comments and a sidebar."""
    return ('<!DOCTYPE html><html lang="tr-TR"><head><meta charset="UTF-8"><title>Sınır bölgesinde çatışma – Besira</title>'
            '<meta property="og:type" content="article"><meta property="og:site_name" content="Besira">'
            '<meta property="og:title" content="Sınır bölgesinde çatışma - Besira"><meta property="og:image" content="/wp-content/uploads/2025/10/kapak.jpg">'
            '<meta property="article:modified_time" content="2025-10-14T08:00:00+00:00"></head>'
            '<body class="post-template-default single single-post postid-812 has-sidebar"><div id="page" class="site">' + TR_HEADER +
            '<div id="content" class="site-content right-sidebar"><main id="main" class="site-main">'
            '<article id="post-812" class="post-812 post type-post status-publish hentry category-haberler">'
            '<header class="entry-header"><h1 class="entry-title">Sınır bölgesinde çatışma</h1><div class="entry-meta">'
            '<span class="posted-on">Yayınlandı: <a href="/2025/10/12/sinir-bolgesinde-catisma/" rel="bookmark">'
            '<time class="entry-date published" datetime="2025-10-12T09:30:00+03:00">12 Ekim 2025</time>'
            '<time class="updated" datetime="2025-10-14T11:00:00+03:00">14 Ekim 2025</time></a></span>'
            '<span class="byline"> Yazar: Besira</span></div></header>'
            '<div class="entry-content"><p>İlk paragraf: sınır bölgesinde gece saatlerinde çatışma çıktı.</p>'
            '<p>İkinci paragraf: bölgede güvenlik önlemleri artırıldı.</p>'
            '<p><a href="/wp-content/uploads/2025/09/1.pdf">Raporu indir (PDF)</a></p>'
            '<div class="sharedaddy sd-sharing-enabled"><h3 class="sd-title">Paylaş:</h3>'
            '<a href="/2025/10/12/sinir-bolgesinde-catisma/?share=twitter">Twitter</a></div></div>'
            '<footer class="entry-footer"><span class="cat-links"><a href="/category/haberler/" rel="category tag">Haberler</a></span></footer></article>'
            '<nav class="navigation post-navigation"><a href="/duyuru-7/" rel="prev">Kamuoyuna duyuru</a></nav>'
            '<div id="comments" class="comments-area"><h2 class="comments-title">1 yorum</h2><ol class="comment-list"><li id="comment-5" class="comment">'
            '<article id="div-comment-5" class="comment-body"><footer class="comment-meta"><time datetime="2025-10-13T10:00:00+03:00">13 Ekim 2025</time></footer>'
            '<div class="comment-content"><p>Okuyucu yorumu: bu haberin kaynağı belirtilmeli, ayrıntılar eksik görünüyor.</p></div>'
            '<a rel="nofollow" class="comment-reply-link" href="/2025/10/12/sinir-bolgesinde-catisma/?replytocom=5">Yanıtla</a></article></li></ol></div>'
            '</main>' + TR_SIDEBAR + '</div>' + TR_FOOTER + '</div></body></html>')


def tr_communique():
    """A title-only communiqué dated only by its visible label, with a long reader comment."""
    return ('<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Kamuoyuna duyuru | Besira</title>'
            '<meta property="og:type" content="article"></head><body class="single single-post">' + TR_HEADER +
            '<main id="main"><article class="post hentry"><header class="entry-header"><h1 class="entry-title">Kamuoyuna duyuru</h1>'
            '<div class="entry-meta"><span class="posted-on">5 Ekim 2025</span><span class="byline">Besira</span></div></header>'
            '<div class="entry-content"></div></article><div id="comments" class="comments-area"><div class="comment-content"><p>'
            + 'Bir okuyucunun uzun yorumu duyurunun ayrıntılarını soruyor. ' * 3 + '</p></div></div></main>' + TR_SIDEBAR + TR_FOOTER + '</body></html>')


def tr_report():
    """A custom-CMS news page in Windows-1254 declared only in <meta>, dated by JSON-LD."""
    title = 'Şırnak\'ta güvenlik operasyonu'
    return ('<html lang="tr"><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1254"><title>' + title + ' | Besira</title>'
            '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","datePublished":"2025-09-20T08:00:00+03:00"},'
            '{"@type":"NewsArticle","headline":"' + title + '","datePublished":"2025-09-20T08:00:00+03:00","dateModified":"2025-09-25T08:00:00+03:00"}]}</script>'
            '</head><body><div class="container"><h1>' + title + '</h1><div class="article-content" itemprop="articleBody">'
            '<p>Operasyonda ağır silahlar ele geçirildi; İçişleri Bakanlığı açıklama yaptı.</p></div>'
            '<div class="sidebar"><span class="date">1 Eylül 2025</span></div></div></body></html>').encode('cp1254')


def tr_card(path, title, iso, label):
    return ('<article class="post hentry"><header class="entry-header"><h2 class="entry-title"><a href="%s" rel="bookmark">%s</a></h2>'
            '<div class="entry-meta"><span class="posted-on"><a href="%s"><time class="entry-date published" datetime="%s">%s</time></a></span></div></header>'
            '<div class="entry-summary"><p>Özet: %s hakkında kısa bilgi.</p></div></article>') % (path, title, path, iso, label, title)


def tr_listing(cards, next_page='', body_class='home blog'):
    return ('<!DOCTYPE html><html lang="tr-TR"><head><meta charset="utf-8"><title>Besira – Haberler</title><meta property="og:type" content="website">'
            + ('<link rel="next" href="%s">' % next_page if next_page else '') + '</head><body class="%s">' % body_class + TR_HEADER
            + '<main id="main" class="site-main">' + ''.join(cards)
            + ('<nav class="navigation pagination"><a class="next page-numbers" href="%s">Sonraki</a><a href="/?paged=2">2</a></nav>' % next_page if next_page else '')
            + '</main>' + TR_SIDEBAR + TR_FOOTER + '</body></html>')


def turkish_site():
    first = tr_card('/2025/10/12/sinir-bolgesinde-catisma/', 'Sınır bölgesinde çatışma', '2025-10-12T09:30:00+03:00', '12 Ekim 2025')
    second = tr_card('/duyuru-7/', 'Kamuoyuna duyuru', '2025-10-05T12:00:00+03:00', '5 Ekim 2025')
    third = tr_card('/haber/rapor-3/', 'Şırnak\'ta güvenlik operasyonu', '2025-09-20T08:00:00+03:00', '20 Eylül 2025')
    return Site({BASE: tr_listing([first, second], '/page/2/'), BASE + 'page/2/': tr_listing([third]),
                 BASE + '?paged=2': tr_listing([third]), BASE + 'category/haberler/': tr_listing([first], body_class='archive category'),
                 TR_ARTICLE_URL: tr_article(), BASE + 'duyuru-7/': tr_communique(), BASE + 'haber/rapor-3/': (tr_report(), 'text/html'),
                 TR_PDF: ('%PDF-1.4\nrapor', 'application/pdf')})


BS_ITEM_URL = BASE2 + '2025/10/napad-na-kontrolni-punkt.html'
BS_PDF = BASE2 + 'fajlovi/izvjestaj-oktobar.pdf'
BS_OLDER = BASE2 + 'search?updated-max=2025-10-08T09:00:00%2B02:00&max-results=2'
BS_SIDEBAR = ('<div class="sidebar section" id="sidebar"><div class="widget PopularPosts" id="PopularPosts1"><h2>Popularne objave</h2>'
              '<div class="item-title"><a href="/2025/10/saopcenje.html">Saopćenje za javnost</a></div><div class="item-date">1. oktobra 2025.</div></div>'
              '<div class="widget BlogArchive" id="BlogArchive1"><a class="post-count-link" href="/2025/10/">oktobar 2025</a></div></div>'
              '<div class="blog-feeds"><a class="feed-link" href="/feeds/posts/default" type="application/atom+xml">Objave (Atom)</a></div>')
BS_COMMENTS = ('<div class="comments" id="comments"><h4>1 komentar:</h4><div id="comment-holder"><dl id="comments-block">'
               '<dt class="comment-author">Anonimni</dt><dd class="comment-body"><p>Komentar čitaoca: ovo treba provjeriti iz više izvora prije objave.</p></dd>'
               '<dd class="comment-footer"><span class="comment-timestamp"><a href="/2025/10/napad-na-kontrolni-punkt.html?showComment=1760000000000#c1">'
               '13. oktobra 2025. u 10:15</a></span></dd></dl></div></div>')


def bs_post(number, path, title, body, iso, item=False):
    heading = title if item else '<a href="%s">%s</a>' % (path, title)
    return ('<div class="post-outer"><div class="post hentry uncustomized-post-template" itemprop="blogPost" itemscope itemtype="http://schema.org/BlogPosting">'
            + ('<meta itemprop="dateModified" content="2025-10-15T12:00:00+02:00">' if item else '')
            + '<h3 class="post-title entry-title" itemprop="name">%s</h3><div class="post-header"><div class="post-header-line-1"></div></div>' % heading
            + '<div class="post-body entry-content" id="post-body-%d" itemprop="description articleBody">%s</div>' % (number, body)
            + '<div class="post-footer"><div class="post-footer-line post-footer-line-1"><span class="post-author vcard">Objavio <span class="fn">Besira</span></span> '
            + '<span class="post-timestamp">u <a class="timestamp-link" href="%s" rel="bookmark" title="permanent link">' % path
            + '<abbr class="published" itemprop="datePublished" title="%s">10:00</abbr></a></span></div>' % iso
            + '<div class="post-footer-line post-footer-line-2"><span class="post-labels">Oznake: <a href="/search/label/Vijesti" rel="tag">Vijesti</a></span></div></div></div>'
            + (BS_COMMENTS if item else '') + '</div>')


def bs_page(posts, date_header, view='feed-view', head='', older=''):
    return ('<!DOCTYPE html><html dir="ltr" lang="bs"><head><meta content="text/html; charset=UTF-8" http-equiv="Content-Type">' + head + '</head>'
            '<body class="version-1-3-3 %s"><div class="main-outer"><div class="main section" id="main"><div class="widget Blog" data-version="1" id="Blog1">'
            '<div class="blog-posts hfeed"><div class="date-outer"><h2 class="date-header"><span>%s</span></h2><div class="date-posts">%s</div></div></div>'
            '%s</div></div></div>%s</body></html>') % (view, date_header, ''.join(posts), older, BS_SIDEBAR)


def bosnian_site():
    napad_body = ('<p>Napad na kontrolni punkt dogodio se u ranim jutarnjim satima.</p><p>Vlasti su pojačale mjere sigurnosti u regiji.</p>'
                  '<p><a href="/fajlovi/izvjestaj-oktobar.pdf">Izvještaj (PDF)</a></p>')
    saopcenje_body = '<p>Kratko saopćenje: sastanak je odgođen.</p>'
    cards = [bs_post(1, '/2025/10/napad-na-kontrolni-punkt.html', 'Napad na kontrolni punkt', 'Napad na kontrolni punkt dogodio se...', '2025-10-12T10:00:00+02:00'),
             bs_post(2, '/2025/10/saopcenje.html', 'Saopćenje za javnost', saopcenje_body, '2025-10-08T09:00:00+02:00')]
    older = ('<div class="blog-pager" id="blog-pager"><a class="blog-pager-older-link" href="/search?updated-max=2025-10-08T09:00:00%2B02:00&amp;max-results=2"'
             ' title="Starije objave">Starije objave</a></div>')
    listing = bs_page(cards, 'ponedjeljak, 12. oktobra 2025.', older=older)
    item_head = '<title>Besira: %s</title><meta content="%s" property="og:title"><meta content="Besira" property="og:site_name">'
    return Site({BASE2: listing, BASE2 + 'search/label/Vijesti': listing, BASE2 + '2025/10/': listing,
                 BS_OLDER: bs_page([], 'Nema starijih objava'),
                 BS_ITEM_URL: bs_page([bs_post(1, '/2025/10/napad-na-kontrolni-punkt.html', 'Napad na kontrolni punkt', napad_body, '2025-10-12T10:00:00+02:00', True)],
                                      'ponedjeljak, 12. oktobra 2025.', 'item-view', item_head % (('Napad na kontrolni punkt',) * 2)),
                 BASE2 + '2025/10/saopcenje.html': bs_page([bs_post(2, '/2025/10/saopcenje.html', 'Saopćenje za javnost', saopcenje_body, '2025-10-08T09:00:00+02:00', True)],
                                                         'srijeda, 8. oktobra 2025.', 'item-view', item_head % (('Saopćenje za javnost',) * 2)),
                 BS_PDF: ('%PDF-1.4\nizvjestaj', 'application/pdf')})


def test_wordpress_and_blogger_articles_become_one_publication_record_each():
    result = c.read_listing(turkish_site(), {**OUTLET, 'url': TR_ARTICLE_URL})
    row = result['page']
    assert row['publication_version'] == 1 and row['text_status'] == 'complete' and row['type'] == 'page'
    assert row['title'] == 'Sınır bölgesinde çatışma' and row['category'] == 'haberler' and row['source_language'] == 'tr'
    assert row['original_text'] == ('Sınır bölgesinde çatışma\n\nİlk paragraf: sınır bölgesinde gece saatlerinde çatışma çıktı.\n\n'
                                   'İkinci paragraf: bölgede güvenlik önlemleri artırıldı.\n\nRaporu indir (PDF)')
    assert row['published_at'] == '2025-10-12' and row['date_basis'] == 'html' and row['source_date'] == '12 Ekim 2025'
    assert row['attachments'] == [{'url': TR_PDF, 'type': 'pdf', 'title': 'Raporu indir (PDF)'}]
    assert row['preview_url'] == BASE + 'wp-content/uploads/2025/10/kapak.jpg' and c.preview_source(row) == ('pdf', TR_PDF)
    assert row['url'] == row['source_page'] == TR_ARTICLE_URL and c.selected_material(row)
    urls = {r['url'] for r in result['items']}
    assert TR_PDF not in urls and BASE + 'category/haberler/' in urls and BASE + 'duyuru-7/' in urls
    assert not any('share=' in u or 'replytocom' in u or 'feed' in u or 'wp-login' in u for u in urls)
    result = c.read_listing(bosnian_site(), {**OUTLET2, 'url': BS_ITEM_URL})
    row = result['page']
    assert row['publication_version'] == 1 and row['title'] == 'Napad na kontrolni punkt' and row['category'] == 'vijesti'
    assert row['published_at'] == '2025-10-12' and row['source_language'] == 'bs'
    assert row['original_text'] == ('Napad na kontrolni punkt\n\nNapad na kontrolni punkt dogodio se u ranim jutarnjim satima.\n\n'
                                   'Vlasti su pojačale mjere sigurnosti u regiji.\n\nIzvještaj (PDF)')
    assert [a['url'] for a in row['attachments']] == [BS_PDF] and BS_PDF not in {r['url'] for r in result['items']}
    assert not any('showComment' in r['url'] or 'feeds' in r['url'] for r in result['items'])


def test_generic_article_titles_fall_back_from_og_title_to_headline_heading_and_page_title():
    body = '<article><div class="entry-content"><p>Metin.</p></div></article>'
    def title(head, extra=''):
        return read_page('<html><head>' + head + '</head><body>' + extra + body + '</body></html>', BASE + 'haber/1/')['page']['title']
    assert title('<meta property="og:title" content="Başlık | Site"><meta property="og:site_name" content="Site"><title>Diğer</title>') == 'Başlık'
    # Without og:site_name an og:title is kept whole: " - " may belong to the headline.
    assert title('<meta property="og:title" content="Saldırı - 3 ölü"><title>Diğer – Site</title>') == 'Saldırı - 3 ölü'
    assert title('<script type="application/ld+json">{"@type":"Report","headline":"Rapor başlığı"}</script><title>Diğer – Site</title>') == 'Rapor başlığı'
    assert title('<title>Diğer – Site</title>', '<h1 class="entry-title">Ana başlık</h1>') == 'Ana başlık'
    assert title('<title>Sayfa başlığı – Site</title>') == 'Sayfa başlığı'
    assert title('<title>Sayfa başlığı | Site</title>') == 'Sayfa başlığı'


def test_short_article_is_kept_but_short_navigation_and_unmarked_pages_are_not():
    statement = 'Kısa açıklama: bölgedeki gelişmeler hakkında kamuoyunu bilgilendiriyoruz ve ayrıntılar yakında paylaşılacak. ' * 3
    marked = ('<html lang="tr"><head><meta property="og:type" content="article"><meta property="article:published_time" content="2025-10-12T10:00:00Z">'
              '</head><body><article><h1>Açıklama</h1><div class="entry-content"><p>' + statement + '</p></div></article></body></html>')
    row = read_page(marked, BASE + 'aciklama/')['page']
    assert row['publication_version'] == 1 and row['original_text'] == 'Açıklama\n\n' + statement.strip() and row['published_at'] == '2025-10-12'
    nav = '<html><head><meta property="article:published_time" content="2025-10-12"></head><body><nav>' + '<a href="/x">Bağlantı</a> ' * 30 + '</nav></body></html>'
    page = read_page(nav, BASE + 'menu/')['page']
    assert not page.get('publication_version') and page['selection_version'] == 0 and not c.selected_material(page)
    unmarked = '<html><head><meta property="article:published_time" content="2025-10-12"></head><body><article><p>' + statement + '</p></article></body></html>'
    page = read_page(unmarked, BASE + 'aciklama/')['page']
    assert not page.get('publication_version') and page['selection_version'] == 0
    # og:type=article on its own, with neither a container nor an <article>: still the 1,200-character rule.
    assert read_page(unmarked.replace('<article>', '<div>').replace('</article>', '</div>').replace('<head>', '<head><meta property="og:type" content="article">'),
                     BASE + 'aciklama/')['page']['selection_version'] == 0


def test_comments_never_replace_a_short_article_but_forum_comments_are_still_selected():
    row = c.read_listing(turkish_site(), {**OUTLET, 'url': BASE + 'duyuru-7/'})['page']
    assert row['publication_version'] == 1 and row['original_text'] == 'Kamuoyuna duyuru' and row['title'] == 'Kamuoyuna duyuru'
    assert row['published_at'] == '2025-10-05' and row['source_date'] == '5 Ekim 2025' and 'yorum' not in row['excerpt']
    forum = '<div class="comment-body">' + 'An identifiable user comment with enough context. ' * 3 + '</div>'
    assert read_page(forum, BASE + 'discussion')['page']['selection_version'] == 1


def test_inline_related_links_and_date_containers_do_not_hide_the_article():
    # News sites put "related news" headings with links inside the body, and Blogger
    # wraps posts in date-outer/date-posts: neither turns the article into a listing card.
    html = ('<html lang="tr"><head><meta property="og:type" content="article"></head><body><main><article class="post">'
            '<h1 class="entry-title">Olay yerinden</h1><div class="date-outer"><span class="posted-on">12 Ekim 2025</span></div>'
            '<div class="entry-content"><p>Gelişme yaşandı.</p><h3><a href="/haber/baska/">İLGİLİ HABER: Başka gelişme</a></h3></div>'
            '<div class="read-also"><h4><a href="/haber/diger/">Diğer</a></h4></div></article></main></body></html>')
    row = read_page(html, BASE + 'haber/olay/')['page']
    assert row['publication_version'] == 1 and row['published_at'] == '2025-10-12' and row['source_date'] == '12 Ekim 2025'
    row = c.read_listing(bosnian_site(), {**OUTLET2, 'url': BASE2 + '2025/10/saopcenje.html'})['page']
    assert row['publication_version'] == 1 and row['published_at'] == '2025-10-08'


def test_malformed_and_large_generic_pages_are_read_in_linear_time():
    import time
    started = time.monotonic()
    unclosed = '<html><body>' + ''.join('<h2><a href="/p%d/">Başlık %d</a><time datetime="2025-10-12">x</time><span class="date">12 Ekim 2025' % (i, i) for i in range(3000)) + '</body></html>'
    read_page(unclosed)
    assert time.monotonic() - started < 10
    started = time.monotonic()
    wide = '<html lang="tr"><body><main>' + ''.join(tr_card('/y/%d/' % i, 'Yazı %d' % i, '2025-10-12T10:00:00+03:00', '12 Ekim 2025') for i in range(2500)) + '</main></body></html>'
    assert len(wide) < c.MAX_HTML_BYTES
    assert read_page(wide)['page']['selection_version'] == 0
    assert time.monotonic() - started < 10


def test_json_ld_article_in_a_legacy_charset_is_decoded_and_dated():
    row = c.read_listing(turkish_site(), {**OUTLET, 'url': BASE + 'haber/rapor-3/'})['page']
    assert row['publication_version'] == 1 and row['title'] == 'Şırnak\'ta güvenlik operasyonu' and row['category'] == 'haber'
    assert row['published_at'] == '2025-09-20' and 'İçişleri' in row['original_text'] and '�' not in row['original_text']


@pytest.mark.parametrize('head,headers,expected', [
    ('<html lang="tr-TR"><head>', {}, 'tr'), ('<html><head><meta property="og:locale" content="bs_BA">', {}, 'bs'),
    ('<html lang=""><head>', {'Content-Language': 'sq, en'}, 'sq'), ('<html lang="x-default"><head>', {'Content-Language': 'ku'}, 'ku'),
    ('<html lang="FR-ca"><head><meta property="og:locale" content="de_DE">', {'Content-Language': 'id'}, 'fr'), ('<html><head>', {}, None),
])
def test_source_language_comes_from_html_lang_then_og_locale_then_header(head, headers, expected):
    result = read_page(head + '</head><body>' + LONG_BODY + '<a href="/r.pdf">r</a></body></html>', headers=headers)
    assert result['page'].get('source_language') == expected and result['items'][0].get('source_language') == expected
    file = c.read_listing(Site({BASE + 'f.pdf': ('%PDF-1.4', 'application/pdf', headers)}), {**OUTLET, 'url': BASE + 'f.pdf'})['page']
    assert file.get('source_language') == (c.language_tag(headers.get('Content-Language')) or None)


def test_structured_records_carry_source_language_only_when_the_page_declares_it():
    assert 'source_language' not in c.structured_publications(structured_detail('عنوان'), BASE + 'posts/news/1/')['page']
    row = c.structured_publications('<html lang="ar">' + structured_detail('عنوان'), BASE + 'posts/news/1/')['page']
    assert row['source_language'] == 'ar' and row['published_at'] == '2026-10-03'
    cards = c.structured_publications('<html lang="ar-SA">' + structured_listing(2, False), BASE)['items']
    assert {r.get('source_language') for r in cards if r.get('publication_version')} == {'ar'}


TURKISH = 'Şehirde çağrı: Iğdır ve Güçlü İşçi'
FRENCH = 'Société générale: déclaration à Paris'


def charset_page(text, meta='', lang=''):
    return '<html%s><head>%s<title>%s</title></head><body><p>%s</p></body></html>' % (lang, meta, text, text)


@pytest.mark.parametrize('body,mime,expected', [
    (charset_page(TURKISH, '<meta charset="windows-1254">').encode('cp1254'), 'text/html', TURKISH),
    (charset_page(TURKISH, '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-9">').encode('iso-8859-9'), 'text/html', TURKISH),
    (charset_page(FRENCH).encode('latin-1'), 'text/html; charset=ISO-8859-1', FRENCH),
    (charset_page(FRENCH).encode('cp1252'), 'text/html', FRENCH),
    (charset_page(FRENCH, '<meta charset="utf-8">').encode('utf-8'), 'text/html', FRENCH),
    (charset_page(TURKISH).encode('utf-8'), 'text/html', TURKISH),
    (b'\xef\xbb\xbf' + charset_page(TURKISH).encode('utf-8'), 'text/html; charset=windows-1252', TURKISH),
    (charset_page(TURKISH, '<meta charset="windows-1252">').encode('utf-8'), 'text/html; charset=utf-8', TURKISH),
    # Undeclared and not UTF-8: the legacy code page of the declared language.
    (charset_page(TURKISH, lang=' lang="tr"').encode('cp1254'), 'text/html', TURKISH),
    (charset_page('Napad u Čapljini, izvještaj šefa', lang=' lang="bs"').encode('cp1250'), 'text/html', 'Napad u Čapljini, izvještaj šefa'),
    # The Arabic outlet: UTF-8 with no charset in the header, and with one damaged byte.
    (charset_page('عنوان الخبر العربي').encode('utf-8'), 'text/html', 'عنوان الخبر العربي'),
    (charset_page('عنوان الخبر العربي الطويل').encode('utf-8').replace(b'</p>', b'\xff</p>'), 'text/html', 'عنوان الخبر العربي الطويل'),
])
def test_charset_detection_never_trusts_requests_latin1_default(body, mime, expected):
    result = c.read_listing(Site({BASE: (body, mime)}), OUTLET)
    assert result['page']['title'] == expected and expected in result['text']
    assert '�' not in result['page']['title']


def test_charset_helpers_map_labels_like_browsers():
    assert [c.charset_codec(x) for x in ('ISO-8859-1', 'latin1', 'us-ascii', 'iso-8859-9', 'windows-1254', 'utf-8', 'utf-7', 'base64', 'nonsense')] == \
        ['cp1252', 'cp1252', 'cp1252', 'cp1254', 'cp1254', 'utf-8', '', '', '']
    assert c.decode_html('déjà'.encode('utf-8'), 'text/html; charset="unknown-label"') == 'déjà'


def test_traversal_skips_localized_logout_delete_and_cms_plumbing_but_follows_pagination():
    skipped = ['/cikis/', '/%C3%87IKI%C5%9E', '/oturumu-kapat', '/sil?id=4', '/odjava/', '/obrisi', '/izbri%C5%A1i/', '/abmelden', '/l%C3%B6schen',
               '/loeschen', '/d%C3%A9connexion', '/supprimer', '/fshij', '/keluar', '/hapus', '/padam', '/derketin', '/logout.php',
               '/?do=%C3%A7%C4%B1k%C4%B1%C5%9F', '/wp-login.php?action=logout', '/wp-admin/', '/xmlrpc.php', '/wp-json/wp/v2/posts', '/feed/',
               '/comments/feed/', '/2025/10/12/post/feed/', '/2025/10/12/post/trackback/', '/feeds/posts/default', '/post/?replytocom=5',
               '/post/?share=twitter', '/post/?like_comment=3', '/post/?amp', '/post/?amp=1', '/post/amp/', '/post/?print=1',
               '/post.html?showComment=1#c1']
    kept = ['/page/2/', '/?paged=2', '/dil/tr/', '/silahlar/', '/haber/sil-bastan/', '/wp-content/uploads/2025/10/rapor.pdf', '/category/haber/']
    p = c.ListingParser(BASE)
    p.feed(''.join('<a href="%s">x</a>' % href for href in skipped + kept) + '<link rel="next" href="/page/3/">')
    assert set(p.rows) == {c.onion_url(c.urljoin(BASE, href)) for href in kept + ['/page/3/']}


def test_display_title_decodes_windows_1252_percent_escapes():
    assert c.display_title(BASE + 'uploads/d%E9claration.pdf') == c.display_title(BASE + 'uploads/d%C3%A9claration.pdf') == 'déclaration.pdf'
    assert c.display_title('%C5%9Eehir_raporu.pdf') == 'Şehir raporu.pdf'


def test_latin_outlets_end_to_end_ingest_dated_articles_with_nothing_held_undated(tmp_path):
    expectations = {
        'tr': (turkish_site(), OUTLET, {TR_ARTICLE_URL: '2025-10-12', BASE + 'duyuru-7/': '2025-10-05', BASE + 'haber/rapor-3/': '2025-09-20'}),
        'bs': (bosnian_site(), OUTLET2, {BS_ITEM_URL: '2025-10-12', BASE2 + '2025/10/saopcenje.html': '2025-10-08'}),
    }
    for language, (site, outlet, dates) in expectations.items():
        db = c.open_database(tmp_path / (language + '.sqlite'))
        calls, sent = passes(site, db, tmp_path, {**outlet, 'policy': LOOP_POLICY}, 2)
        batches = [batch for pass_batches in sent for batch in pass_batches]
        assert batches[-1]['scan_complete'] and batches[-1]['abandoned_pages'] == 0 and batches[-1]['failed_pages'] == 0
        # Every request was a page of the fixture: no logout, feed, reply, share or AMP URL was fetched.
        assert set(site.calls) <= set(site.pages) and len(calls[0]) == len(set(calls[0]))
        assert all(batch['undated_count'] == 0 for batch in batches)
        assert not db.execute('SELECT 1 FROM undated').fetchone()
        stored = {url: json.loads(metadata) for url, metadata in db.execute('SELECT url,metadata FROM items')}
        assert {url: row['published_at'] for url, row in stored.items()} == dates, 'only the articles; no listing page and no separate file'
        for row in stored.values():
            assert row['publication_version'] == 1 and row['text_status'] == 'complete' and row['source_language'] == language
            assert row['date_basis'] == 'html' and row['original_text'].startswith(row['title'])
            assert not any(word in row['original_text'] for word in ('Okuyucu', 'okuyucu', 'Komentar', 'Paylaş', 'Son yazılar', 'Popularne'))
        article = stored[TR_ARTICLE_URL if language == 'tr' else BS_ITEM_URL]
        assert len(article['attachments']) == 1 and article['attachments'][0]['type'] == 'pdf'
        assert article['attachments'][0]['acquired'] and article['attachments'][0]['status'] == 'downloaded_on_collector'
        assert len(list(tmp_path.glob('*.pdf'))) == (1 if language == 'tr' else 2)
        db.close()
    assert stored[BASE2 + '2025/10/saopcenje.html']['original_text'] == 'Saopćenje za javnost\n\nKratko saopćenje: sastanak je odgođen.'


# --- News-portal template (second outlet). Neutral synthetic markup that mirrors the
# observed structure; no real address or source text is stored in the repository.

PORTAL_MENU = ('<li><div class="language-option " data-lang="ar">AR</div></li>'
               '<li><div class="language-option active" data-lang="en">EN</div></li>'
               '<li><div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="autoTranslateCheckbox" checked>'
               '<label class="form-check-label" for="autoTranslateCheckbox">Auto</label></div></li>'
               '<script>const url = new URL("/language/change", window.location.origin);</script>')
PORTAL_SWITCH = BASE + 'language/change?locale=en&auto_translate=true&force_translate=false'
PORTAL_SWITCH_FORCE = BASE + 'language/change?locale=en&auto_translate=true&force_translate=true'
# The article's pdf.js viewer: a canvas and controls, with the file named only in an inline script.
PORTAL_VIEWER = ('<div class="pdf-viewer-container mb-5"><div class="pdf-controls d-flex">'
                 '<button id="pdf-prev" class="btn btn-sm">Previous</button><span><span id="pdf-current-page">1</span> / '
                 '<span id="pdf-total-pages">1</span></span><button id="pdf-next" class="btn btn-sm">Next</button>'
                 '<button id="pdf-zoom-out" class="btn btn-sm">-</button><span id="pdf-zoom">100%</span>'
                 '<button id="pdf-zoom-in" class="btn btn-sm">+</button></div>'
                 '<div class="pdf-viewer-wrapper"><canvas id="pdf-viewer"></canvas></div></div>')


def portal_pdf_script(value, keyword='const', quote='"'):
    return (f'<script src="{BASE}js/vendor/pdf-js/pdf.min.js"></script><script>\n'
            f"pdfjsLib.GlobalWorkerOptions.workerSrc = '{BASE}js/vendor/pdf-js/pdf.worker.min.js';\n"
            "document.addEventListener('DOMContentLoaded', function() {\n"
            f'    {keyword} pdfUrl = {quote}{value}{quote};\n'
            "    const pdfViewer = document.getElementById('pdf-viewer');\n"
            "    if (!pdfViewer || !pdfUrl) {\n        return;\n    }\n});\n</script>")


def portal_card(slug, title, label, badge='Region'):
    return (f'<a class="list-group-item list-group-item-action" href="{BASE}posts/{slug}">'
            f'<img src="media.php?file=posts%2Fthumbnails%2F1.jpg" alt="x"><div class="d-flex"><h5 class="mb-1">{title}</h5>'
            f'<small>{label}</small></div><span class="badge bg-secondary">{badge}</span>'
            f'<div><i class="fa fa-eye"></i><small class="text-muted">39</small></div></a>')


def portal_priority(slug, title, label):
    return (f'<li class="mb-2"><a href="{BASE}posts/{slug}"><img src="x.jpg" alt="x"></a>'
            f'<a href="{BASE}posts/{slug}" class="text-decoration-none">{title}</a><small class="badge bg-secondary">Weekly</small>'
            f'<div><small class="text-muted">453</small><small class="text-muted"> {label} </small></div></li>')


def portal_pager(pager_id, key, pages, current=1):
    # Numbered links (with the last page) and a final "next" arrow, as the observed pager has.
    links = ''.join(f'<li class="page-item"><a class="page-link" href="{BASE[:-1]}?{key}={n}">{n}</a></li>' for n in pages)
    arrow = (f'<li class="page-item"><a class="page-link" href="{BASE}?{key}={current + 1}" rel="next">&rsaquo;</a></li>'
             if current + 1 in pages else '')
    return f'<div id="{pager_id}"><!-- <a href="{BASE}?{key}=999">hidden</a> --><nav><ul class="pagination">{links}{arrow}</ul></nav></div>'


def portal_home(cards, priority=(), pages=(2, 3, 40), lang='en', priority_pages=(2,), current=1, priority_current=1):
    return (f'<html lang="{lang}" dir="ltr"><body><nav>{PORTAL_MENU}<a href="{BASE}video">Videos</a><a href="{BASE}audio">Audio</a>'
            f'<a href="{BASE}login">Login</a></nav><div id="videoCarousel"><a href="{BASE}video/clip-one">clip</a></div>'
            f'<div id="news-content"><div class="list-group mt-3">{"".join(cards)}</div></div>'
            f'{portal_pager("news-pagination", "news_page", pages, current)}'
            f'<div id="priority-news-content"><ul class="list-unstyled">{"".join(priority)}</ul></div>'
            f'{portal_pager("priority-news-pagination", "priority_news_page", priority_pages, priority_current)}'
            f'<div id="videos-content"><a href="{BASE}video/clip-two">clip</a></div>'
            f'{portal_pager("videos-pagination", "videos_page", (2, 3))}'
            f'<div id="magazines-content"><a href="{BASE}posts/magazine-one">magazine</a></div></body></html>')


def portal_article(title='Example statement about a road project', label='06 October 2026', body=None, lang='en', files='', script=''):
    """body=False renders the article without its .post-content block (a PDF-only issue)."""
    body = body if body is not None else 'Example Province\n    First paragraph of the statement.\n\n    Second paragraph, with a number 12.'
    date = f'<span class="me-3"><i class="fa fa-calendar"></i> {label}</span>' if label else ''
    content = '' if body is False else f'<div class="post-content mb-5"><div style="white-space: pre-line; line-height: 1.6;">{body}</div></div>'
    return (f'<html lang="{lang}" dir="ltr"><body><nav>{PORTAL_MENU}</nav><div class="container mt-4"><article class="blog-post">'
            f'<nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="{BASE}news">News</a></li></ol></nav>'
            f'<header class="mb-4"><a href="{BASE}news"><span class="badge bg-primary">News</span></a>'
            f'<a href="{BASE}news?category=region"><span class="badge bg-secondary">Region</span></a>'
            f'<h1 class="display-5 fw-bold"> {title} </h1><div class="d-flex text-muted"><span class="me-3">By site</span>{date}</div></header>'
            f'<div class="thumbnail-wrapper mb-4"><img src="{BASE}media.php?file=posts%2Fthumbnails%2F17_a.jpg" class="img-fluid">'
            f'<a href="{BASE}media.php?file=posts%2Fthumbnails%2F17_a.jpg" download="a.jpg">Download</a></div>'
            f'{content}{files}'
            f'<div class="related-posts"><h3>See Also</h3><div class="card h-100 clickable-card" onclick="window.location=\'{BASE}posts/region-25-03-2026\'">'
            f'<h6 class="card-title">Related item text</h6></div></div></div></article>'
            f'<div id="comments-section"><div id="comment-1">A reader comment that must stay out.</div>'
            f'<a href="{BASE}posts/region-06-10-2026?sort=votes&page=1#comments-section">sort</a></div>{script}</body></html>')


def test_news_portal_home_lists_only_news_cards_and_their_next_pages():
    html = portal_home([portal_card('region-06-10-2026', 'First item', '06 October 2026'),
                        portal_card('other-05-10-2026-2', 'Second item', '05 October 2026')],
                       [portal_priority('an-naba-01-10-2026', 'Weekly issue No. 1', '01 October 2026')],
                       pages=(2, 3, 4, 5, 292), priority_pages=(2, 3, 4, 5, 34))
    result = c.structured_publications(html, BASE)
    rows = {row['url'].replace(BASE, '/'): row for row in result['items']}
    assert result['structured'] is True and result['page'] is None
    # Only the next page of each section: never the other numbered pages or the last (oldest) one.
    assert set(rows) == {'/posts/region-06-10-2026', '/posts/other-05-10-2026-2', '/posts/an-naba-01-10-2026',
                         '/?news_page=2', '/?priority_news_page=2'}
    first = rows['/posts/region-06-10-2026']
    assert (first['publication_version'], first['text_status'], first['title']) == (1, 'listing', 'First item')
    assert (first['published_at'], first['category'], first['type'], first['source_language'], first['crawl']) == ('2026-10-06', 'news', 'page', 'en', True)
    issue = rows['/posts/an-naba-01-10-2026']
    assert (issue['title'], issue['category'], issue['type'], issue['published_at']) == ('Weekly issue No. 1', 'naba', 'pdf', '2026-10-01')
    assert all(row.get('crawl') for row in rows.values())
    # English records are the outlet's own (possibly automatic) translation.
    assert all(row['source_translation'] == 'outlet' for row in rows.values() if row.get('publication_version') == 1)
    assert 'english_available' in result and result['english_available'] is False
    # A later page follows its own next page (the page's query number plus one); the other
    # section, at its default first page, follows its page 2. The last page has no next page.
    middle = portal_home([portal_card('region-01-10-2026', 'Older item', '01 October 2026')],
                         [portal_priority('an-naba-01-10-2026', 'Weekly issue No. 1', '01 October 2026')],
                         pages=(1, 2, 4, 5, 292), priority_pages=(2, 3, 34), current=3)
    links = {row['url'].replace(BASE, '/') for row in c.structured_publications(middle, BASE + '?news_page=3')['items'] if row['type'] == 'page' and not row.get('publication_version')}
    assert links == {'/?news_page=4', '/?priority_news_page=2'}
    last = portal_home([portal_card('region-01-10-2025', 'Oldest item', '08 October 2025')], pages=(1, 2, 291), priority_pages=(), current=292)
    assert [row['url'] for row in c.structured_publications(last, BASE + '?news_page=292')['items']] == [BASE + 'posts/region-01-10-2025']


def test_news_portal_stops_at_the_period_start_and_never_opens_older_items():
    old = portal_home([portal_card('region-06-10-2024', 'Old item', '06 October 2024')], pages=(41, 42))
    result = c.structured_publications(old, BASE + '?news_page=40', since='2025-10-07')
    assert result['items'] == [], 'an older card is not stored or opened, and a page entirely older than the period ends that pagination'
    mixed = portal_home([portal_card('region-08-10-2025', 'Inside', '08 October 2025'),
                         portal_card('region-06-10-2025', 'Outside', '06 October 2025')], pages=(41,))
    rows = {row['url'].replace(BASE, '/'): row for row in c.structured_publications(mixed, BASE + '?news_page=40', since='2025-10-07')['items']}
    assert set(rows) == {'/posts/region-08-10-2025', '/?news_page=41'}


def test_news_portal_article_keeps_date_paragraphs_and_files_but_no_comments_or_links():
    # The observed pdf.js viewer: #pdf-viewer and its controls carry no URL; the inline
    # script's pdfUrl constant names the file.
    files = PORTAL_VIEWER + f'<a href="{BASE}media.php?file=posts%2Faudio%2Fspeech.mp3">audio</a>'
    html = portal_article(files=files, script=portal_pdf_script(BASE + 'media.php?file=posts/files/issue-1.pdf'))
    result = c.structured_publications(html, BASE + 'posts/region-06-10-2026')
    row = result['page']
    assert result['items'] == [] and result['structured'] is True
    assert (row['title'], row['published_at'], row['date_basis'], row['source_date']) == ('Example statement about a road project', '2026-10-06', 'html', '06 October 2026')
    assert (row['category'], row['text_status'], row['crawl'], row['source_language'], row['source_translation']) == ('news', 'complete', False, 'en', 'outlet')
    assert row['original_text'] == ('Example statement about a road project\n\nExample Province\n\nFirst paragraph of the statement.\n\n'
                                    'Second paragraph, with a number 12.')
    assert sorted((a['type'], a['url'].replace(BASE, '/')) for a in row['attachments']) == [
        ('audio', '/media.php?file=posts%2Faudio%2Fspeech.mp3'), ('pdf', '/media.php?file=posts/files/issue-1.pdf')]
    assert row['attachments'][0] == {'url': BASE + 'media.php?file=posts/files/issue-1.pdf', 'type': 'pdf', 'title': 'issue-1.pdf'}
    # The viewer's PDF is previewed (its first page) ahead of the cover image, as for other PDFs.
    assert c.preview_source(row) == ('pdf', BASE + 'media.php?file=posts/files/issue-1.pdf')
    assert row['preview_url'] == BASE + 'media.php?file=posts%2Fthumbnails%2F17_a.jpg'
    for absent in ('reader comment', 'Related item', 'See Also', 'Previous', '100%', 'pdfUrl'):
        assert absent not in row['original_text']


@pytest.mark.parametrize('script,expected', [
    (portal_pdf_script(''), None),
    (portal_pdf_script('   '), None),
    (portal_pdf_script('/media.php?file=posts/files/a.pdf', 'let', "'"), BASE + 'media.php?file=posts/files/a.pdf'),
    (portal_pdf_script('/media.php?file=posts%2Ffiles%2Fa.pdf', 'var'), BASE + 'media.php?file=posts%2Ffiles%2Fa.pdf'),
    # JSON-escaped slashes, and a same-host https link served by the page's own scheme.
    (portal_pdf_script('https:\\/\\/' + 'a' * 56 + '.onion\\/media.php?file=posts\\/files\\/a.pdf'), BASE + 'media.php?file=posts/files/a.pdf'),
    (portal_pdf_script('http://' + 'c' * 56 + '.onion/media.php?file=a.pdf'), None),
    (portal_pdf_script('https://example.com/a.pdf'), None),
], ids=['empty', 'blank', 'let-single-quotes', 'var-encoded', 'json-escaped-https', 'other-onion', 'clearnet'])
def test_news_portal_viewer_pdf_comes_from_the_inline_script(script, expected):
    row = c.structured_publications(portal_article(files=PORTAL_VIEWER, script=script), BASE + 'posts/an-naba-01-10-2026')['page']
    assert [(a['type'], a['url']) for a in row['attachments']] == ([('pdf', expected)] if expected else [])
    assert (row['type'], row['category']) == ('pdf', 'naba')


def test_news_portal_viewer_script_is_not_needed_when_the_article_links_its_pdf():
    files = PORTAL_VIEWER + f'<a href="{BASE}media.php?file=posts%2Ffiles%2Fissue-2.pdf" download>Download PDF</a>'
    script = portal_pdf_script(BASE + 'media.php?file=posts/files/other.pdf')
    row = c.structured_publications(portal_article(files=files, script=script), BASE + 'posts/an-naba-01-10-2026')['page']
    assert [(a['type'], a['url']) for a in row['attachments']] == [('pdf', BASE + 'media.php?file=posts%2Ffiles%2Fissue-2.pdf')]


def test_news_portal_article_falls_back_to_the_permalink_date():
    row = c.structured_publications(portal_article(label=''), BASE + 'posts/region-24-09-2026-4')['page']
    assert (row['published_at'], row['date_basis']) == ('2026-09-24', 'url')
    row = c.structured_publications(portal_article(label=''), BASE + 'posts/an-naba-31-02-2026')['page']
    assert row['published_at'] == '' and row['category'] == 'naba', 'an impossible permalink date is not invented'


def test_other_pages_are_not_mistaken_for_the_news_portal():
    plain_article = '<html lang="en"><body><article class="blog-post"><h1>T</h1><div class="post-content">text</div></article></body></html>'
    assert c.structured_publications(plain_article, BASE + 'posts/x-01-01-2026') is None
    assert c.structured_publications('<div id="news-content"><a href="/about">About</a></div>', BASE) is None
    # Without the outlet's language menu, a news section needs dated permalinks, as before.
    undated = f'<div id="news-content"><a class="list-group-item" href="{BASE}posts/some-slug"><h5>T</h5><small>06 October 2026</small></a></div>'
    assert c.structured_publications(undated, BASE) is None
    # A language menu alone (another multilingual site) is not the template.
    menu_only = f'<html lang="en"><body><nav>{PORTAL_MENU.replace("autoTranslateCheckbox", "otherSwitch")}</nav><p>About us</p></body></html>'
    assert c.structured_publications(menu_only, BASE + 'about') is None
    # The existing Arabic template keeps priority.
    assert c.structured_publications(structured_listing(2), BASE)['items'][0]['url'].startswith(BASE + 'posts/news/')


NOTHING = {'items': [], 'page': None, 'text': '', 'truncated': False, 'structured': True}


def portal_page(body, lang='en'):
    """Any other page of the news-portal site: its menu (language options and auto-translate switch) and body."""
    return (f'<html lang="{lang}" dir="ltr"><body><nav>{PORTAL_MENU}<a href="{BASE}video">Videos</a><a href="{BASE}login">Login</a>'
            f'<a href="{BASE}discussions">Discussions</a></nav><main class="main-content-container">{body}</main></body></html>')


def test_news_portal_template_never_falls_back_to_the_generic_reader():
    # An article rendered without its .post-content block (a PDF-only issue): a title-only record, no link.
    url = BASE + 'posts/an-naba-02-10-2026'
    bodyless = portal_article('Weekly issue No. 2', '02 October 2026', body=False, files=PORTAL_VIEWER,
                              script=portal_pdf_script('/media.php?file=posts/files/issue-2.pdf'))
    site = Site({url: bodyless})
    result = c.read_listing(site, {**OUTLET, 'url': url})
    row = result['page']
    assert result['items'] == [] and result['structured'] is True and site.calls == [url]
    assert (row['title'], row['original_text'], row['text_status'], row['published_at'], row['type'], row['category']) == (
        'Weekly issue No. 2', 'Weekly issue No. 2', 'complete', '2026-10-02', 'pdf', 'naba')
    assert [a['url'] for a in row['attachments']] == [BASE + 'media.php?file=posts/files/issue-2.pdf']
    # An article without its h1 has no title: nothing is recorded and no link is followed.
    headless = portal_article()
    headless = headless.split('<h1')[0] + headless.split('</h1>', 1)[1]
    assert read_page(headless, BASE + 'posts/region-06-10-2026') == NOTHING
    # Any other page of the site: empty news sections, a soft "not found", a video or a profile page.
    others = {
        '': portal_home([], [], pages=(2, 3, 292), priority_pages=(2, 34)),
        'posts/missing-item': portal_page(f'<h1>Page not found</h1><a href="{BASE}">Home</a><a href="{BASE}profile/reader">reader</a>'),
        'video/clip-one': portal_page(f'<h1>Clip</h1><video controls><source src="{BASE}media.php?file=videos%2Fclip.mp4" type="video/mp4"></video>'
                                      f'<div id="comments-section"><a href="{BASE}profile/reader">reader</a><a href="{BASE}video/clip-two">next</a></div>'),
        'profile/reader': portal_page(f'<h2>reader</h2><a href="{BASE}statuses/1">status</a><a href="{BASE}posts/region-06-10-2026">a post</a>'),
    }
    for path, html in others.items():
        site = Site({BASE + path: html})
        assert c.read_listing(site, {**OUTLET, 'url': BASE + path}) == NOTHING, path
        assert site.calls == [BASE + path]
    # The same holds when the outlet served such a page in Arabic and English cannot be chosen.
    site = Site({BASE + 'profile/reader': portal_page('<h2>قارئ</h2>', lang='ar'), PORTAL_SWITCH: 404})
    assert c.read_listing(site, {**OUTLET, 'url': BASE + 'profile/reader'}) == NOTHING


def test_news_portal_accepts_any_single_segment_permalink_in_its_sections():
    encoded = '%D8%AE%D8%A8%D8%B1-%D8%B9%D8%A7%D8%AC%D9%84'
    html = portal_home([portal_card(encoded, 'Breaking item', '06 October 2026'),
                        portal_card('statement-without-date', 'Undated item', 'Region update')],
                       [portal_priority('agency-statement', 'Agency item', '05 October 2026')], pages=(), priority_pages=())
    rows = {row['url'].replace(BASE, '/'): row for row in c.structured_publications(html, BASE)['items']}
    assert set(rows) == {'/posts/' + encoded, '/posts/statement-without-date', '/posts/agency-statement'}
    first = rows['/posts/' + encoded]
    assert (first['title'], first['published_at'], first['date_basis'], first['category'], first['type'], first['crawl']) == (
        'Breaking item', '2026-10-06', 'html', 'news', 'page', True)
    assert rows['/posts/statement-without-date']['published_at'] == '', 'no date is invented'
    assert (rows['/posts/agency-statement']['title'], rows['/posts/agency-statement']['published_at']) == ('Agency item', '2026-10-05')
    # Article pages are recognised whatever their permalink; the slug date is only a fallback.
    row = c.structured_publications(portal_article(), BASE + 'posts/' + encoded)['page']
    assert (row['published_at'], row['date_basis'], row['category'], row['text_status']) == ('2026-10-06', 'html', 'news', 'complete')
    row = c.structured_publications(portal_article(label=''), BASE + 'posts/' + encoded)['page']
    assert (row['published_at'], row['category']) == ('', 'news')


class LanguageSite(Site):
    """The outlet serves Arabic until its language menu link sets the English session."""
    def __init__(self, pages_ar, pages_en):
        super().__init__(pages_ar)
        self.pages_ar, self.pages_en, self.english = pages_ar, pages_en, False
    def get(self, url, **kwargs):
        if url == BASE + 'language/change?locale=en&auto_translate=true&force_translate=false':
            self.calls.append(url)
            self.english = True
            return Response(status=302, headers={'Location': '/'}, url=url)
        self.pages = self.pages_en if self.english else self.pages_ar
        return super().get(url, **kwargs)


def test_news_portal_asks_its_language_menu_for_english_once():
    arabic = portal_home([portal_card('region-06-10-2026', 'عنوان', '06 أكتوبر 2026')], pages=(), lang='ar')
    english = portal_home([portal_card('region-06-10-2026', 'English title', '06 October 2026')], pages=())
    site = LanguageSite({BASE: arabic}, {BASE: english})
    result = c.read_listing(site, {**OUTLET, 'policy': {'from': '2025-10-07'}})
    assert result['items'][0]['title'] == 'English title' and result['items'][0]['source_language'] == 'en'
    assert site.calls == [BASE, BASE + 'language/change?locale=en&auto_translate=true&force_translate=false', BASE, BASE]
    # Within ten minutes a page still in Arabic is kept as it is (no request loop).
    site.english = False
    site.pages_en = site.pages_ar
    result = c.read_listing(site, OUTLET)
    assert result['items'][0]['source_language'] == 'ar' and site.calls.count(site.calls[1]) == 1
    assert 'source_translation' not in result['items'][0], 'only English records are the outlet translation'


class ForceTranslationSite(Site):
    """The normal English tab changes locale but only force_translate yields English text."""
    def __init__(self, pages_ar, pages_en):
        super().__init__(pages_ar)
        self.pages_ar, self.pages_en, self.force = pages_ar, pages_en, False
    def get(self, url, **kwargs):
        if url == PORTAL_SWITCH:
            self.calls.append(url)
            return Response(status=302, headers={'Location': '/'}, url=url)
        if url == PORTAL_SWITCH_FORCE:
            self.calls.append(url)
            self.force = True
            return Response(status=302, headers={'Location': '/'}, url=url)
        self.pages = self.pages_en if self.force else self.pages_ar
        return super().get(url, **kwargs)


def test_news_portal_forces_translation_when_english_tab_still_serves_arabic():
    arabic = portal_home([portal_card('region-06-10-2026', 'عنوان', '06 أكتوبر 2026')], pages=(), lang='ar')
    english = portal_home([portal_card('region-06-10-2026', 'English title', '06 October 2026')], pages=())
    site = ForceTranslationSite({BASE: arabic}, {BASE: english})
    result = c.read_listing(site, {**OUTLET, 'policy': {'from': '2025-10-07'}})
    assert result['items'][0]['title'] == 'English title'
    assert result['items'][0]['source_language'] == 'en'
    assert PORTAL_SWITCH in site.calls and PORTAL_SWITCH_FORCE in site.calls


class FailingSwitch(Site):
    """The outlet serves Arabic and its English menu link fails."""
    def __init__(self, pages, failure):
        super().__init__(pages)
        self.failure = failure
    def get(self, url, **kwargs):
        if url != PORTAL_SWITCH:
            return super().get(url, **kwargs)
        self.calls.append(url)
        if isinstance(self.failure, Exception):
            raise self.failure
        if isinstance(self.failure, int):
            return HTTPStatus(status=self.failure, url=url)
        return Response(status=302, headers={'Location': self.failure}, url=url)


@pytest.mark.parametrize('failure', [404, 500, 'http://' + 'c' * 56 + '.onion/', c.requests.exceptions.ReadTimeout('private source')],
                         ids=['404', '500', 'off-host-redirect', 'timeout'])
def test_failed_english_switch_keeps_the_page_already_read(failure, caplog):
    arabic = portal_home([portal_card('region-06-10-2026', 'عنوان', '06 أكتوبر 2026')], pages=(2,), lang='ar')
    site = FailingSwitch({BASE: arabic}, failure)
    result = c.read_listing(site, {**OUTLET, 'policy': {'from': '2025-10-07'}})
    assert site.calls == [BASE, PORTAL_SWITCH, PORTAL_SWITCH_FORCE], 'both safe English switch modes are attempted once'
    expected = c.structured_publications(arabic, BASE, since='2025-10-07')
    assert expected.pop('english_available') is True and result == expected, 'the structured result already read'
    row = result['items'][0]
    assert (row['title'], row['source_language'], row['published_at']) == ('عنوان', 'ar', '2026-10-06')
    assert [r['url'] for r in result['items'][1:]] == [BASE + '?news_page=2']
    assert caplog.text.count('English tab did not yield English publication text') == 1
    assert '.onion' not in caplog.text and 'private source' not in caplog.text


PORTAL_POLICY = {'epoch': 2, 'from': '2025-10-07', 'through': '2026-12-31', 'pages_per_scan': 50, 'previews': False}


def portal_scan(site, db, tmp_path, passes=1):
    sent = []
    def ack(*args, **kwargs):
        sent.append(args[-1])
        return {'ok': True}
    with patch.object(c, 'api_call', side_effect=ack):
        for _ in range(passes):
            c.scan_outlet(None, '', site, db, {**OUTLET, 'policy': PORTAL_POLICY}, tmp_path, False, 100, 100, 10000, 0)
    return [item for batch in sent for item in batch.get('items', [])]


def test_news_portal_crawl_collects_news_only_with_dates(tmp_path):
    news1 = [portal_card('region-06-10-2026', 'First item', '06 October 2026')]
    issue1 = [portal_priority('an-naba-01-10-2026', 'Weekly issue No. 1', '01 October 2026')]
    # Every pager links the next pages and the last (oldest) page, as on the site.
    home = portal_home(news1, issue1, pages=(2, 3, 4, 5, 292), priority_pages=(2, 3, 4, 5, 34))
    page2 = portal_home([portal_card('region-01-10-2026', 'Older item', '01 October 2026')], issue1,
                        pages=(1, 3, 4, 5, 292), priority_pages=(2, 3, 4, 5, 34), current=2)
    page3 = portal_home([portal_card('region-06-10-2024', 'Out of period', '06 October 2024')], issue1,
                        pages=(1, 2, 4, 5, 292), priority_pages=(2, 3, 4, 5, 34), current=3)
    priority2 = portal_home(news1, [portal_priority('an-naba-24-09-2026', 'Weekly issue No. 0', '24 September 2026')],
                            pages=(2, 3, 4, 5, 292), priority_pages=(1, 3, 4, 5, 34), priority_current=2)
    priority3 = portal_home(news1, [portal_priority('an-naba-01-10-2024', 'Old issue', '01 October 2024')],
                            pages=(2, 3, 4, 5, 292), priority_pages=(1, 2, 4, 5, 34), priority_current=3)
    site = Site({BASE: home, BASE + '?news_page=2': page2, BASE + '?news_page=3': page3,
                 BASE + '?priority_news_page=2': priority2, BASE + '?priority_news_page=3': priority3,
                 BASE + 'posts/region-06-10-2026': portal_article('First item'),
                 BASE + 'posts/region-01-10-2026': portal_article('Older item', '01 October 2026'),
                 BASE + 'posts/an-naba-01-10-2026': portal_article('Weekly issue No. 1', '01 October 2026'),
                 BASE + 'posts/an-naba-24-09-2026': portal_article('Weekly issue No. 0', '24 September 2026')})
    db = c.open_database(tmp_path / 'state.sqlite')
    items = {item['url'].replace(BASE, '/'): item for item in portal_scan(site, db, tmp_path, 3)}
    requested = [url.replace(BASE, '/') for url in site.calls]
    assert set(requested) == {'/', '/?news_page=2', '/?news_page=3', '/?priority_news_page=2', '/?priority_news_page=3',
                              '/posts/region-06-10-2026', '/posts/region-01-10-2026', '/posts/an-naba-01-10-2026',
                              '/posts/an-naba-24-09-2026'}, 'no video, audio, login, magazine, comment, last or out-of-period page'
    # Sequential paging: each page is found on the previous one, and paging ends at the first
    # page entirely older than the period.
    assert requested.index('/?news_page=2') < requested.index('/?news_page=3')
    assert requested.index('/?priority_news_page=2') < requested.index('/?priority_news_page=3')
    first = items['/posts/region-06-10-2026']
    assert (first['text_status'], first['published_at'], first['source_language'], first['source_translation']) == ('complete', '2026-10-06', 'en', 'outlet')
    assert items['/posts/region-01-10-2026']['published_at'] == '2026-10-01'
    assert (items['/posts/an-naba-24-09-2026']['type'], items['/posts/an-naba-24-09-2026']['published_at']) == ('pdf', '2026-09-24')
    assert '/posts/region-06-10-2024' not in items and '/posts/an-naba-01-10-2024' not in items
    assert db.execute('SELECT COUNT(*) FROM undated').fetchone()[0] == 0
    db.close()


def test_outlet_translation_flag_is_dropped_when_the_page_is_read_in_arabic(tmp_path):
    url = BASE + 'posts/region-06-10-2026'
    site = Site({BASE: portal_home([portal_card('region-06-10-2026', 'English title', '06 October 2026')], pages=()),
                 url: portal_article('English title')})
    db = c.open_database(tmp_path / 'state.sqlite')
    first = {item['url']: item for item in portal_scan(site, db, tmp_path)}[url]
    assert (first['source_language'], first['source_translation'], first['text_status']) == ('en', 'outlet', 'complete')
    # Later the session serves Arabic and English cannot be chosen: the reread article is
    # no longer the outlet's translation, so the flag is not carried over from the earlier record.
    site.pages = {BASE: portal_home([portal_card('region-06-10-2026', 'عنوان', '06 أكتوبر 2026')], pages=(), lang='ar'),
                  url: portal_article('عنوان', '06 أكتوبر 2026', lang='ar'), PORTAL_SWITCH: 404}
    later = [item for item in portal_scan(site, db, tmp_path, 2) if item['url'] == url]
    assert later and all((item['source_language'], item['title']) == ('ar', 'عنوان') and 'source_translation' not in item for item in later)
    stored = json.loads(db.execute('SELECT metadata FROM items WHERE url=?', (url,)).fetchone()[0])
    assert stored['source_language'] == 'ar' and 'source_translation' not in stored
    db.close()


# --- The Arabic outlet keeps its previous dates and generic reading. Expected values below are
# the previous collector's (HEAD before the multilingual change) results for the same markup.

def legacy_detail(profile, meta=''):
    head = f'<meta property="article:published_time" content="{meta}">' if meta else ''
    return (head + '<div class="read-area"><div class="title"><h5>خبر قصير</h5></div>'
            f'<div class="author-profile"><p>{profile}</p></div><div id="post-content"></div></div>')


@pytest.mark.parametrize('profile,meta,expected', [
    # Two dates in one label: the ISO date, as before (the multilingual rule takes 2025-09-20).
    ('نشر في 20 سبتمبر 2025 - تحديث 2025-09-22', '', '2025-09-22'),
    # A non-ISO meta date is not read (the multilingual rule reads 2025-10-09).
    ('10 سبتمبر 2025', '09/10/2025', '2025-09-10'),
    # Nor an RFC 2822 one (the multilingual rule reads 2025-09-19).
    ('20 سبتمبر 2025', 'Fri, 19 Sep 2025 22:30:00 +0000', '2025-09-20'),
    ('السبت، 3 أكتوبر 2026', '2026-10-03T16:00:00Z', '2026-10-03'),
], ids=['two-dates-in-label', 'non-iso-meta', 'rfc2822-meta', 'iso-meta'])
def test_arabic_template_detail_keeps_its_previous_date_rule(profile, meta, expected):
    row = c.structured_publications(legacy_detail(profile, meta), BASE + 'posts/news/1')['page']
    assert (row['published_at'], row['source_date'], row['date_basis']) == (expected, profile, 'html')


def test_arabic_template_cards_keep_their_previous_date_label_and_file_titles():
    footers = ['<span>03/10/2026</span><span>3 أكتوبر 2026</span>', '<span>نشر 20 سبتمبر 2025 - تحديث 2025-09-22</span>',
               '<span>1 October 2025</span><span>3 أكتوبر 2025</span>', '<span>السبت، ٣ أكتوبر ٢٠٢٦</span>']
    holder = '<div id="post-card-holder">' + ''.join(
        f'<div class="post-card"><a class="post-card-link" href="/posts/news/{i}/"><h5 class="post-summary">خبر رقم {i}</h5></a>'
        f'<div class="card-footer">{footer}</div></div>' for i, footer in enumerate(footers)) + '</div>'
    items = c.structured_publications(holder, BASE)['items']
    assert [(row['source_date'], row['published_at']) for row in items] == [
        ('3 أكتوبر 2026', '2026-10-03'), ('نشر 20 سبتمبر 2025 - تحديث 2025-09-22', '2025-09-22'),
        ('3 أكتوبر 2025', '2025-10-03'), ('السبت، ٣ أكتوبر ٢٠٢٦', '2026-10-03')]
    # A file named with a non-UTF-8 escape keeps its previous title.
    detail = legacy_detail('20 سبتمبر 2025').replace('<div id="post-content">', '<div id="post-content"><a href="/uploads/d%E9claration.pdf"></a>')
    attachment = c.structured_publications(detail, BASE + 'posts/naba/1')['page']['attachments'][0]
    assert attachment == {'url': BASE + 'uploads/d%E9claration.pdf', 'type': 'pdf', 'title': 'd\ufffdclaration.pdf'}


LEGACY_SLUG = '%D8%A7%D9%84%D8%AE%D8%A8%D8%B1-%D8%A7%D9%84%D8%A3%D9%88%D9%84'
LEGACY_FILE = '%D8%A7%D9%84%D9%86%D8%A8%D8%A3%2020%20%D8%B3%D8%A8%D8%AA%D9%85%D8%A8%D8%B1%202025.pdf'


def arabic_video_page():
    """A page of the Arabic template outside its card lists and permalinks: read-area without #post-content."""
    return ('<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>الموقع - إصدار مرئي</title>'
            '<meta property="og:type" content="article"><meta property="article:published_time" content="2025-09-20T10:00:00+03:00">'
            '<meta property="og:title" content="إصدار مرئي جديد"><meta property="og:image" content="/assets/logo.png"></head><body>'
            '<nav class="navbar"><a href="/">الرئيسية</a><a href="/posts/news">الأخبار</a><a href="/feed">RSS</a></nav>'
            '<main><div class="read-area"><div class="title"><h1>إصدار مرئي جديد</h1></div>'
            '<div class="author-profile"><p>20 سبتمبر 2025</p></div>'
            '<video controls poster="/uploads/p.jpg"><source src="/uploads/videos/clip.mp4" type="video/mp4"></video>'
            '<div class="post-content"><p>وصف الإصدار</p></div>'
            '<a href="/uploads/2025/09/20/issue.pdf">العدد</a>'
            '<a href="/uploads/2025-09-21-%D8%A7%D9%84%D9%86%D8%A8%D8%A3.pdf">النبأ</a>'
            f'<a href="/files/{LEGACY_FILE}">ملف</a>'
            f'<a href="/posts/videos/{LEGACY_SLUG}?print=1">طباعة</a></div></main></body></html>')


def test_arabic_template_page_without_post_content_keeps_the_previous_generic_reading():
    url = BASE + 'posts/videos/' + LEGACY_SLUG
    result = read_page(arabic_video_page(), url)
    # No generic article record (no publication_version), the page dated as before, and only source_language added.
    assert result['page'] == {'url': url, 'title': 'الموقع - إصدار مرئي', 'type': 'page', 'published_at': '2025-09-20',
                              'date_basis': 'html', 'preview_url': BASE + 'assets/logo.png', 'excerpt': '',
                              'selection_version': 0, 'source_language': 'ar'}
    # Every link is followed as before (no feed or print-view skipping); files take the page date
    # or a date in their URL, upload folders included.
    rows = [(row['url'].replace(BASE, '/'), row['type'], row['published_at'], row['date_basis'], row['title']) for row in result['items']]
    assert rows == [('/', 'page', '', '', 'الرئيسية'), ('/posts/news', 'page', '', '', 'الأخبار'), ('/feed', 'page', '', '', 'RSS'),
                    ('/uploads/videos/clip.mp4', 'video', '2025-09-20', 'source_page', 'clip.mp4'),
                    ('/uploads/2025/09/20/issue.pdf', 'pdf', '2025-09-20', 'url', 'العدد'),
                    ('/uploads/2025-09-21-%D8%A7%D9%84%D9%86%D8%A8%D8%A3.pdf', 'pdf', '2025-09-21', 'url', 'النبأ'),
                    ('/files/' + LEGACY_FILE, 'pdf', '2025-09-20', 'url', 'ملف'),
                    ('/posts/videos/' + LEGACY_SLUG + '?print=1', 'page', '', '', 'طباعة')]
    assert all(row['source_page'] == url and row['source_language'] == 'ar' and 'publication_version' not in row for row in result['items'])
    assert [row.get('preview_url', '').replace(BASE, '/') for row in result['items']][3:5] == ['/uploads/p.jpg', '/assets/logo.png']
    assert result['truncated'] is False
    # The same page with its #post-content block is the template's structured permalink record.
    structured = read_page(arabic_video_page().replace('<div class="post-content">', '<div id="post-content">'), url)
    assert structured['structured'] is True and structured['page']['publication_version'] == 1


# --- Launcher (Windows): it asks for the secret inside its loop and again after a configuration error.

def test_launcher_asks_for_the_secret_in_its_loop_and_again_after_a_configuration_error():
    raw = Path('darkweb-collector/start-collector.cmd').read_bytes()
    assert raw.isascii() and raw.count(b'\r\n') == raw.count(b'\n') and raw.endswith(b'\r\n')
    lines = raw.decode('ascii').splitlines()
    assert 'cd /d "%~dp0"' in lines and lines.index('cd /d "%~dp0"') < lines.index(':run')
    run = lines.index(':run')
    prompt = next(i for i, line in enumerate(lines) if 'set /p "DARKWEB_INGEST_TOKEN=' in line)
    collector = lines.index('py collector.py --proxy socks5h://127.0.0.1:9150 --interval 300 --connect-timeout 120')
    clear = next(i for i, line in enumerate(lines) if 'set "DARKWEB_INGEST_TOKEN="' in line)
    assert run < prompt < collector < clear < lines.index('timeout /t 60 /nobreak >nul') < len(lines) - 1
    assert lines[prompt].startswith('if not defined DARKWEB_INGEST_TOKEN ')
    assert lines[clear].startswith('if errorlevel 2 if not errorlevel 3 '), 'only exit code 2 (configuration error) clears the secret'
    assert lines[-1] == 'goto run'


def test_short_secret_is_a_configuration_error_with_exit_code_2():
    import sys
    with patch.dict(c.os.environ, {'DARKWEB_INGEST_TOKEN': 'too-short'}), \
            patch.object(sys, 'argv', ['collector.py', '--proxy', 'socks5h://127.0.0.1:9150', '--interval', '300', '--connect-timeout', '120']):
        with pytest.raises(SystemExit) as stopped:
            c.main()
    assert stopped.value.code == 2


def test_start_collector_is_one_shot_and_has_no_restart_loop():
    script = Path("darkweb-collector/start-collector.cmd").read_text(encoding="utf-8")
    assert "--once" in script
    assert "--interval" not in script
    assert "goto run" not in script.lower()
    assert "Bessira daily update completed" in script
