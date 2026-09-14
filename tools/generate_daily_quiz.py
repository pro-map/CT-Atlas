#!/usr/bin/env python3
"""Generate one sourced CT knowledge question for the first daily update."""
import json
import os
import re
from datetime import date
from pathlib import Path

import requests

QUIZ_PATH = Path("daily-quiz.json")
HISTORY_PATH = Path("daily-quiz-history.json")
MODEL = os.getenv("DAILY_QUIZ_MODEL", "gemini-3.5-flash-lite")


def load_history():
    try:
        data = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def extract_json(text):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Gemini did not return a JSON object")
    return json.loads(text[start:end + 1])


def validate(quiz):
    required = ("category", "question", "options", "correct_index", "explanation", "source_url")
    if any(not quiz.get(key) and quiz.get(key) != 0 for key in required):
        raise ValueError("Quiz is missing a required field")
    if not isinstance(quiz["options"], list) or len(quiz["options"]) != 3:
        raise ValueError("Quiz must contain exactly three options")
    if quiz["correct_index"] not in (0, 1, 2):
        raise ValueError("correct_index must be 0, 1 or 2")
    if not str(quiz["source_url"]).startswith("https://"):
        raise ValueError("Quiz must cite an HTTPS source")
    if len(str(quiz["question"])) > 240 or len(str(quiz["explanation"])) > 500:
        raise ValueError("Quiz text is too long")


def main():
    api_key = os.environ["GEMINI_API_KEY"]
    history = load_history()
    recent = [str(item.get("question", "")) for item in history[-120:] if isinstance(item, dict)]
    prompt = f"""You create the daily professional knowledge quiz for CT Atlas, an OSINT counter-terrorism analytical platform.
Return ONLY valid JSON with these keys: category, question, options, correct_index, explanation, source_url.

Rules:
- Write in clear professional English.
- Ask exactly one timeless factual question and provide exactly 3 plausible, mutually exclusive answers.
- Cover varied counter-terrorism knowledge: terrorist organisations and areas of operation; aliases and leaders; nationality or biography of historically significant terrorists; dates and locations of major attacks; ideology; financing; recruitment; propaganda; travel and foreign terrorist fighters; weapons; CBRN; maritime terrorism; online activity and emerging technology; international CT instruments and institutions.
- Do not ask about graphic details, tactics that facilitate harm, classified information, political opinion, disputed attribution, or facts likely to change.
- The correct answer must be unambiguous and supported by one authoritative public source: UN, EU, INTERPOL, Europol, NATO, FATF, national government, court, official inquiry, or established academic reference. source_url must be the direct HTTPS page supporting it.
- Keep the explanation to 1-2 concise sentences.
- Randomise the correct answer position.
- Do not repeat or substantially paraphrase any of these recent questions: {json.dumps(recent, ensure_ascii=False)}
"""
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    response = requests.post(endpoint, params={"key": api_key}, json={
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.8, "responseMimeType": "application/json"},
    }, timeout=90)
    response.raise_for_status()
    payload = response.json()
    text = payload["candidates"][0]["content"]["parts"][0]["text"]
    quiz = extract_json(text)
    quiz["correct_index"] = int(quiz["correct_index"])
    quiz["date"] = date.today().isoformat()
    validate(quiz)

    # Reject a dead or clearly inaccessible citation before publication.
    source = requests.get(quiz["source_url"], timeout=25, allow_redirects=True,
                          headers={"User-Agent": "CT-Atlas-Daily-Quiz/1.0"})
    if source.status_code >= 400:
        raise RuntimeError(f"Citation returned HTTP {source.status_code}")

    QUIZ_PATH.write_text(json.dumps(quiz, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    history.append({"date": quiz["date"], "question": quiz["question"], "category": quiz["category"]})
    HISTORY_PATH.write_text(json.dumps(history[-365:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Daily quiz generated: {quiz['question']}")


if __name__ == "__main__":
    main()
