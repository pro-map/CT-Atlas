import importlib.util
import sys
import types
import unittest
from unittest.mock import patch

# No network or API key is needed for these regression tests.
sys.modules.setdefault('requests', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('quiz', 'tools/generate_daily_quiz.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

class QuizSourceTests(unittest.TestCase):
    def test_allowlist(self):
        self.assertTrue(q.trusted_url('https://main.un.org/example'))
        for url in ['https://un.org.evil.test/', 'http://un.org/', 'https://127.0.0.1/', 'https://user@un.org/']:
            self.assertFalse(q.trusted_url(url))

    def test_empty_or_duplicate_choices_rejected(self):
        data=dict(category='C',question='Q',options=['A','a','B'],correct_index=1,explanation='E',source_url='https://un.org/')
        with self.assertRaises(ValueError):q.validate(data)

    def test_source_requires_real_supporting_passage(self):
        text='This is verified supporting evidence. ' * 20
        response=types.SimpleNamespace(status_code=200,headers={'Content-Type':'text/html'},text='<p>'+text+'</p>')
        data={'source_url':'https://un.org/'}
        with patch.object(q.requests,'get',return_value=response,create=True), patch.object(q,'ai_json',return_value={'supported':True,'unambiguous':True,'evidence':'Invented passage'}):
            with self.assertRaises(ValueError):q.verify_source('test',data)
        with patch.object(q.requests,'get',return_value=response,create=True), patch.object(q,'ai_json',return_value={'supported':True,'unambiguous':True,'evidence':'verified supporting evidence.'}):
            q.verify_source('test',data)
            self.assertIn('source_checked_at',data)

    def test_history_entry_is_idempotent(self):
        quiz={"date":"2026-09-14","question":"Q","category":"C"}
        history=[]
        q.record_in_history(history, quiz)
        q.record_in_history(history, quiz)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["category"], "C")


    def test_challenge_rejected(self):
        response=types.SimpleNamespace(status_code=202,headers={},text='')
        with patch.object(q.requests,'get',return_value=response,create=True):
            with self.assertRaises(ValueError):q.verify_source('test',{'source_url':'https://un.org/'})

if __name__=='__main__':unittest.main()
