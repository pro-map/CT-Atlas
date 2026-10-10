"""Conservative, aggregate-only scoring of fictional public benchmark cases.

Do not confuse agreement with deliberately authored synthetic fixture labels
with independent real-news evaluation or a production release gate.
No external I/O, credentials, source texts or article identifiers in output.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict


def _fraction(numerator, denominator):
    return round(numerator / denominator, 4) if denominator else None


def _safe_f1(tp, fp, fn):
    denominator = 2 * tp + fp + fn
    return round(2 * tp / denominator, 4) if denominator else None


def classification_metrics(pairs, categories):
    """Pairs are already schema-validated (fixture, model result) records."""
    per_category = {name: {"true_positive": 0, "false_positive": 0,
                           "false_negative": 0} for name in categories}
    per_language = defaultdict(lambda: {
        "cases": 0, "exact_category_matches": 0, "event_decision_matches": 0,
        "status_matches": 0, "country_matches": 0,
    })
    counters = Counter()
    for case, output in pairs:
        expected = set(case["expected_labels"])
        predicted = set(output["category_labels"])
        language = case["language"]
        counters["cases"] += 1
        counters["true_positive_labels"] += len(expected & predicted)
        counters["false_positive_labels"] += len(predicted - expected)
        counters["false_negative_labels"] += len(expected - predicted)
        counters["exact_category_matches"] += (expected == predicted)
        counters["event_decision_matches"] += (bool(expected) == output["qualifying_event"])
        counters["status_matches"] += (case["expected_status"] == output["reported_status"])
        expected_country = case["expected_country"].strip().casefold()
        predicted_country = output["event_country"].strip().casefold()
        counters["country_matches"] += (expected_country == predicted_country)
        counters["unsupported_country_guesses"] += (not expected_country and bool(predicted_country))
        if expected_country and predicted_country != expected_country:
            counters["country_mismatches_when_provided"] += 1
        for label in categories:
            per_category[label]["true_positive"] += (label in expected and label in predicted)
            per_category[label]["false_positive"] += (label not in expected and label in predicted)
            per_category[label]["false_negative"] += (label in expected and label not in predicted)
        row = per_language[language]
        row["cases"] += 1
        row["exact_category_matches"] += (expected == predicted)
        row["event_decision_matches"] += (bool(expected) == output["qualifying_event"])
        row["status_matches"] += (case["expected_status"] == output["reported_status"])
        row["country_matches"] += (expected_country == predicted_country)
    for label, row in per_category.items():
        row["precision"] = _fraction(row["true_positive"], row["true_positive"] + row["false_positive"])
        row["recall"] = _fraction(row["true_positive"], row["true_positive"] + row["false_negative"])
        row["f1"] = _safe_f1(row["true_positive"], row["false_positive"], row["false_negative"])
    n = counters["cases"]
    return {
        "cases": n,
        "label_micro_precision": _fraction(counters["true_positive_labels"],
                                           counters["true_positive_labels"] + counters["false_positive_labels"]),
        "label_micro_recall": _fraction(counters["true_positive_labels"],
                                        counters["true_positive_labels"] + counters["false_negative_labels"]),
        "label_micro_f1": _safe_f1(counters["true_positive_labels"],
                                    counters["false_positive_labels"], counters["false_negative_labels"]),
        "exact_category_agreement": _fraction(counters["exact_category_matches"], n),
        "qualifying_event_agreement": _fraction(counters["event_decision_matches"], n),
        "reported_status_agreement": _fraction(counters["status_matches"], n),
        "event_country_agreement": _fraction(counters["country_matches"], n),
        "unsupported_country_guesses": counters["unsupported_country_guesses"],
        "country_mismatches_when_provided": counters["country_mismatches_when_provided"],
        "per_category": per_category,
        "per_language": dict(sorted(per_language.items())),
        "warning": "Synthetic fixture agreement, NOT independent real-article precision.",
        "production_validated": False,
    }


def translation_metrics(pairs):
    """Exact reference matching is an auxiliary check, never semantic accuracy."""
    per_language = defaultdict(lambda: {"cases": 0, "exact_title_matches": 0})
    n = exact = invented_numerals = 0
    for case, output in pairs:
        n += 1
        reference = " ".join(case["expected_title_en"].casefold().split())
        actual = " ".join(output["title_en"].casefold().split())
        is_exact = reference == actual
        exact += is_exact
        per_language[case["language"]]["cases"] += 1
        per_language[case["language"]]["exact_title_matches"] += is_exact
        # Additional fail-closed metric: no numbers may be invented in the
        # English headline. Existing translation validator checks omissions.
        original_numbers = Counter(re.findall(r"[0-9]+", case["title"]))
        actual_numbers = Counter(re.findall(r"[0-9]+", output["title_en"]))
        if not all(actual_numbers[k] <= original_numbers[k] for k in actual_numbers):
            invented_numerals += 1
    return {
        "cases": n,
        "exact_reference_title_matches": exact,
        "exact_reference_title_agreement": _fraction(exact, n),
        "headlines_with_invented_numerals": invented_numerals,
        "per_language": dict(sorted(per_language.items())),
        "warning": "Translation correctness cannot be inferred from string equality or preserved numerals; independent bilingual review required.",
        "production_validated": False,
    }
