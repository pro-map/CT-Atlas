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


class Site:
    def __init__(self, pages):
        self.pages, self.calls = pages, []
    def get(self, url, **kwargs):
        self.calls.append(url)
        value = self.pages[url]
        if isinstance(value, Exception):
            raise value
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


def test_total_page_limit_is_visible_and_resumable_when_increased(tmp_path):
    db = c.open_database(tmp_path/'state.sqlite')
    site = Site({BASE:'<a href="second">second</a>', BASE+'second':'<p>done</p>'})
    ok, sent = run_scan(site,db,tmp_path,max_pages=1)
    assert not ok and sent[-1]['truncated'] and sent[-1]['pending_pages'] == 1
    ok, sent = run_scan(site,db,tmp_path,max_pages=10)
    assert ok and sent[-1]['scan_complete'] and site.calls.count(BASE) == 1
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
    Image=pytest.importorskip('PIL.Image');fitz=pytest.importorskip('fitz')
    output=c.io.BytesIO();Image.new('RGB',(300,200),'navy').save(output,format='PNG')
    image=c.make_preview(Session([Response(output.getvalue())]),{'url':BASE+'image.png','type':'image'})
    assert image['preview'].startswith('data:image/jpeg;base64,/9j/') and len(image['preview'])<=16000
    with fitz.open() as doc:
        doc.new_page();pdf=doc.tobytes()
    preview=c.make_preview(Session([Response(pdf)]),{'url':BASE+'file.pdf','type':'pdf'})
    assert preview['preview_status']=='First page' and len(preview['preview'])<=16000
    response=Response(headers={'Content-Length':str(9*1048576)})
    assert 'cap' in c.make_preview(Session([response]),{'url':BASE+'image.png','type':'image'})['preview_status']
    assert response.closed and not list(tmp_path.iterdir())
