import importlib.util
import sys
import types
import unittest
import tempfile
import json
from pathlib import Path
from unittest.mock import patch

# No network or API key is needed for these regression tests.
sys.modules.setdefault('requests', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('quiz', 'tools/generate_daily_quiz.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

class QuizSourceTests(unittest.TestCase):
    def candidate(self, **changes):
        return dict(dict(category='Financing', question='Which body adopted this instrument?', options=['A','B','C'], correct_index=1, explanation='A short verified explanation.', source_url='https://www.fatf-gafi.org/en/example.html'), **changes)

    def test_retry_includes_limits_rejected_source_and_reason_then_publishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            quiz_path=Path(tmp)/'quiz.json'; history_path=Path(tmp)/'history.json'
            old=self.candidate(date='2026-09-01'); quiz_path.write_text(json.dumps(old))
            bad=self.candidate(question='x'*241)
            good=self.candidate(question='Which institution maintains the second instrument?',source_url='https://www.interpol.int/example')
            with patch.object(q,'QUIZ_PATH',quiz_path), patch.object(q,'HISTORY_PATH',history_path), patch.dict(q.os.environ,{'GEMINI_API_KEY':'fixture'}), patch.object(q,'ai_json',side_effect=[bad,good]) as ai, patch.object(q,'verify_source') as verify:
                q.main()
            self.assertIn('question at most 240',ai.call_args_list[0].args[1])
            retry=ai.call_args_list[1].args[1]
            self.assertIn(bad['source_url'],retry)
            self.assertIn('question must be a string of at most 240 characters',retry)
            self.assertEqual(json.loads(quiz_path.read_text())['question'],good['question'])
            self.assertEqual(len(json.loads(history_path.read_text())),2)
            verify.assert_called_once()

    def test_all_rejections_preserve_published_quiz_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            quiz_path=Path(tmp)/'quiz.json'; history_path=Path(tmp)/'history.json'
            before=json.dumps(self.candidate(date='2026-09-01')); quiz_path.write_text(before);history_path.write_text('[]')
            with patch.object(q,'QUIZ_PATH',quiz_path), patch.object(q,'HISTORY_PATH',history_path), patch.dict(q.os.environ,{'GEMINI_API_KEY':'fixture'}), patch.object(q,'ai_json',return_value=self.candidate(question='What distinguishes these sanctions regimes?')), patch.object(q,'verify_source',side_effect=ValueError('Source is inaccessible')) as verify:
                with self.assertRaises(RuntimeError):q.main()
            self.assertEqual(quiz_path.read_text(),before)
            self.assertEqual(history_path.read_text(),'[]')
            self.assertEqual(verify.call_count,1)

    def test_same_day_retry_does_not_replace_question_or_call_ai(self):
        with tempfile.TemporaryDirectory() as tmp:
            quiz_path=Path(tmp)/'quiz.json'; history_path=Path(tmp)/'history.json'
            today=q.datetime.now(q.ZoneInfo('Europe/Paris')).date().isoformat()
            before=json.dumps(self.candidate(date=today));quiz_path.write_text(before)
            with patch.object(q,'QUIZ_PATH',quiz_path), patch.object(q,'HISTORY_PATH',history_path), patch.object(q,'ai_json') as ai:
                q.main();q.main()
            ai.assert_not_called();self.assertEqual(quiz_path.read_text(),before)
            self.assertEqual(len(json.loads(history_path.read_text())),1)

    def test_allowlist(self):
        self.assertTrue(q.trusted_url('https://main.un.org/example'))
        for url in ['https://un.org.evil.test/', 'http://un.org/', 'https://127.0.0.1/', 'https://user@un.org/']:
            self.assertFalse(q.trusted_url(url))

    def test_empty_or_duplicate_choices_rejected(self):
        data=dict(category='C',question='Q',options=['A','a','B'],correct_index=1,explanation='E',source_url='https://un.org/')
        with self.assertRaises(ValueError):q.validate(data)

    def test_source_requires_real_supporting_passage(self):
        text='This is verified supporting evidence. ' * 20
        response=types.SimpleNamespace(status_code=200,url='https://un.org/',headers={'Content-Type':'text/html'},text='<p>'+text+'</p>')
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
        response=types.SimpleNamespace(status_code=202,url='https://un.org/',headers={},text='')
        with patch.object(q.requests,'get',return_value=response,create=True):
            with self.assertRaises(ValueError):q.verify_source('test',{'source_url':'https://un.org/'})

if __name__=='__main__':unittest.main()


