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
        if isinstance(value, tuple):
            body, mime = value
        else:
            body, mime = value, 'text/html; charset=utf-8'
        return Response(body.encode(), headers={'Content-Type': mime}, url=url)


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
    assert calls == [[BASE, BASE+'dead'], [BASE+'dead'], [BASE+'dead']]
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


def test_watch_pass_refetches_the_start_page_ahead_of_older_frontier_entries(tmp_path):
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
    assert calls[1] == [BASE, BASE+'posts/news/2/', BASE+'posts/news/3/']
    uploaded = [item['url'] for batch in more_sent[0] for item in batch['items']]
    assert BASE+'posts/news/12/' in uploaded
    # Unchanged cards from the re-checked start page are not sent again within the run.
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
