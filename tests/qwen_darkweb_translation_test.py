"""Read-only Dark Web Qwen translation tests: no Tor, Cloudflare or remote data."""
from __future__ import annotations
import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "experiments" / "qwen_darkweb_translation_probe.py"
spec = importlib.util.spec_from_file_location("qwen_darkweb_translation_probe", PATH)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def source(s="أعلنت السلطات فتح تحقيق في تهديد أمني مزعوم"):
    return {"id": "a"*64, "title": s, "content_hash": hashlib.sha256(s.encode()).hexdigest(),
            "source_language": "ar", "excerpt": "أعلنت السلطات فتح تحقيق رسمي."}


def mock_response(payload):
    item = payload["messages"][-1]["content"]
    assert source()["id"] in item
    return {"titles":[{"id": source()["id"],
                        "title": "Authorities announced an investigation into an alleged security threat",
                        "overview_en": "Authorities reported that they opened an investigation."}]}


class QwenDarkwebTranslatorTests(unittest.TestCase):
    def test_structured_translation_retains_hash_and_original_title(self):
        original=source()
        answer=module.translate_one(original, ask=mock_response)
        self.assertEqual(answer["id"],original["id"])
        self.assertEqual(answer["content_hash"],original["content_hash"])
        self.assertEqual(answer["original"],original["title"])
        self.assertEqual(answer["title_en_kind"],"translation")
        self.assertIn("alleged",answer["title"])

    def test_existing_final_original_or_outlet_translation_is_not_rewritten(self):
        for status in [{"title_en_kind":"translation"},{"title_en_kind":"original"},{"source_translation":"outlet"}]:
            with self.subTest(status=status):
                a=source();a.update(status)
                with patch.object(module,"urlopen",side_effect=AssertionError("Should skip completed title")):
                    self.assertIsNone(module.translate_one(a))

    def test_non_loopback_ollama_refused(self):
        for url in ("https://api.remote.ai/api/chat","http://192.0.2.1:11434/api/chat",
                    "http://127.0.0.1:11434/api/generate"):
            with self.subTest(url=url):
                with patch.object(module,"OLLAMA_URL",url):
                    with self.assertRaises(ValueError):module.translate_one(source(),ask=mock_response)

    def test_corrupted_content_hash_or_id_refused(self):
        for key,value in (("id","oops"),("content_hash","notsha256"),("title","")):
            invalid=source();invalid[key]=value
            with self.subTest(key=key):
                with self.assertRaises(ValueError):module.translate_one(invalid,ask=mock_response)

    def test_model_must_return_matching_id_unchanged(self):
        bad=lambda payload: {"titles":[{"id":"b"*64,"title":"Translation","overview_en":"Overview"}]}
        with self.assertRaises(ValueError):module.translate_one(source(),ask=bad)
        no_text=lambda payload: {"titles":[{"id":"a"*64,"title":"","overview_en":""}]}
        with self.assertRaises(ValueError):module.translate_one(source(),ask=no_text)

    def test_duplicate_item_and_batch_maximum_enforced(self):
        a=source();b=source("Une enquête officielle a été ouverte")
        with self.assertRaises(ValueError):module.process([a,a],ask=mock_response)
        with self.assertRaises(ValueError):module.process([a]*6,ask=mock_response)
        self.assertEqual(module.process([],ask=mock_response)["titles"],[])

if __name__=="__main__":unittest.main()
