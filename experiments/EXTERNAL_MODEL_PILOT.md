# External-model pilot — CT ATLAS (NOT production)

**Status:** experimental GitHub branch only. Nothing is wired to the live
collector, events.json, Dark Web Worker, Gemini allocation, background archive,
D1, Cloudflare deployments, SOCMINT agent or financial/billing settings.

## Purpose

Evaluate two candidates **independently of Gemini**:

| Candidate | Test-only purpose | Model ID |
|---|---|---|
| Groq GPT-OSS 120B | Public-news classification into the existing 11 Map labels | openai/gpt-oss-120b |
| Cloudflare Workers AI GLM-4.7-Flash | Faithful headline translation and neutral one-sentence overview | @cf/zai-org/glm-4.7-flash |

This initial suite contains **18 fictional public classification snippets**
and **8 fictional public translation snippets** in multiple languages. Fixture
labels are written separately from providers' responses. Passing the unit
tests only proves plumbing, validation and *refusal safeguards*: it is **not**
an assessment of either model's factual accuracy, multilingual recall or
relative performance against Gemini. Public fictional test cases may be
published in the repository; private, operational or Tor-sourced cases MUST NOT.

## Run the safe offline checks

    python -m unittest discover -s tests -p 'external_llm_pilot_test.py' -v
    python -m unittest discover -s tests -p 'external_llm_metrics_test.py' -v
    python experiments/external_llm_pilot.py --mode plan
    python experiments/external_llm_pilot.py --mode coverage --max-per-provider 26

No API key is needed. The experiment branch's own GitHub Actions workflow runs
exactly these checks **without secrets** and with read-only repository access.
The coverage command reports language balance, all eleven category counts and
negative controls; it does NOT query any provider. New offline metrics separate
true positives, false positives, false negatives, precision/recall/F1 by Map
category, exact-label agreement and evidence-status/country disagreements.
The translation audit counts reference-title exact matches and invented digits,
but requires an independent bilingual review to establish fidelity.

## Correction du test Cloudflare GLM — 10 octobre 2026

Si la console locale affichait **"Provider returned unusable JSON; no retry"**
alors que le serveur a répondu HTTP 200, le problème était dans le
traitement du format de réponse. Le modèle GLM-4.7-Flash peut consacrer
son petit budget de tokens au **raisonnement** et retourner
`choices[0].message.content = null` avec `finish_reason = "length"`,
sans aucune traduction finale. L'ancien pilote demandait seulement 500
tokens et refusait cet objet sans expliquer pourquoi.

Correction sur cette branche : passage de
`chat_template_kwargs: {"enable_thinking": false}` dans la requête
Cloudflare, budget de sortie limité à **900 tokens** pour le test
synthétique, et diagnostic non sensible indiquant le motif
`finish_reason` autorisé (sans afficher la réponse brute, le
raisonnement, les identifiants ni les clés). Une réponse JSON encadrée
entièrement par une seule barrière Markdown est décodée, mais aucun texte
libre n'est accepté. **Aucune relance automatique et aucun second appel
en cas d'erreur**.

L'API OpenAI-compatible Cloudflare et le modèle
`@cf/zai-org/glm-4.7-flash` restent inchangés. Cette correction ne
prouve pas que le modèle traduira fidèlement; seule l'évaluation
ultérieure pourra l'établir.

Sources : https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
et https://github.com/cloudflare/ai/blob/main/packages/tanstack-ai/README.md

## Optional small live test (only after manual account verification)

The script supports **at most two synthetic items per provider per execution**
and has no retry-on-429 logic. All external calls are **disabled by default**.

Before running ANY live test, verify all of the following:

1. The **specific Groq organization** is on its actual Free Plan. Consult
   the Groq console rate-limits and billing pages, not public pricing alone.
   Groq's listed free limits for GPT-OSS 120B include 30 RPM, 1,000 requests
   per day, 8,000 tokens per minute and 200,000 tokens per day; these limits
   are account-level and can change.
2. The **specific Cloudflare account** is on Workers Free (not Workers Paid),
   has an eligible GLM-4.7-Flash model, and retains its unspent free Workers AI
   Neurons allocation. Workers AI's public free allowance is 10,000
   Neurons/day, resetting at 00:00 UTC; overages on Workers Paid accounts can
   be billed. The model's published per-token price is not proof that an
   existing paid Cloudflare account will incur $0.
3. Explicitly authorize sending ONLY the checked-in synthetic examples to
   each provider and understand the provider's data-processing terms.
   **No intercepted, sensitive, law-enforcement, nominal, biometric, classified,
   private, extremist-propaganda, or Dark Web source data** may be sent.
4. Provision scoped API credentials **outside the repository**; never paste
   secrets in GitHub issues, PR comments, files, Actions logs or chat.

Only after verifying account status, set local environment flags to the exact
string YES:

- Both: EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN
- Groq: GROQ_FREE_PLAN_VERIFIED and GROQ_API_KEY
- Cloudflare Workers Free: CLOUDFLARE_WORKERS_AI_FREE_PLAN_VERIFIED,
  CLOUDFLARE_AI_API_TOKEN and CLOUDFLARE_AI_ACCOUNT_ID

The scoped Workers AI token is not the CT ATLAS production D1 token.

The command (with credentials supplied securely through the local environment,
and ONLY after checking the account-specific free plan, regulatory obligations
and privacy authorizations):

    python experiments/external_llm_pilot.py --mode live --provider groq --max-per-provider 2
    python experiments/external_llm_pilot.py --mode live --provider cloudflare --max-per-provider 2

Run with --provider both only when both account statuses and both credentials
have been checked. A failed preflight aborts before any request from either
provider. Only aggregate synthetic outcomes and token counts are printed.
Neither source text nor model completions nor secrets are logged or committed.
No session, credential, usage quota or billing setting is changed.
Never enable live inference by setting flags merely to pass a technical test.
The Cloudflare account's Workers subscription may have changed since a past
invoice/alert: only the current Dashboard can establish its present status.
Likewise Groq API-key existence says nothing about the organization billing
tier. The controlled trial remains blocked until those facts are verified.

## Provider implementation details

- Groq: POST https://api.groq.com/openai/v1/chat/completions; OpenAI-compatible
  JSON Schema strict output for GPT-OSS 120B. Validation checks the existing
  eleven category labels, score, evidence status and actor scope. A schema
  response is not automatically a true-positive terrorism case.
- Workers AI: POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/chat/completions;
  GLM-4.7-Flash. JSON-object response is validated locally.
  The model must echo the synthetic fixture's ID and SHA-256 content hash.
  The original title, summary, source and all attachment data are unchanged.
  Copying of numbers is mechanically checked; **translation fidelity
  still requires a human examiner**.
- Failures, 429s, 403s, redirects, unexpected keys, invalid IDs or missing
  numbers fail closed; **no fallback to Gemini and no automatic retries**.

## How we would assess suitability for production

For a representative **independently human-adjudicated** set of ~150 authorized
real public articles across Arabic, Chinese (both scripts), French, English,
Indonesian, Spanish and other languages, compare each model's:

- Recall and precision by Map category and language, especially CBRNE.
- Alleged vs suspected vs confirmed vs hoax distinctions.
- Unsupported attributions and false event-country guesses.
- Unique incident recall after deduplication, not article count.
- Strict source fidelity for translations (names, numbers, dates, uncertainty).
- Actual account-specific quota use, latency and effective monetary cost.

Only AFTER independent annotation, institutional data-transfer/privacy
authorization, verified $0 billing guarantees, deployment/rollback planning
and a bounded quarantined canary should any workflow ever delegate a final
Map, Dark Web, intelligence or geolocation decision to a second model.

**No scheduled live inference, automatic prod merge, or publication is part
of this experiment.**

Provider docs (accessed October 2026):

- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/model/openai/gpt-oss-120b
- https://console.groq.com/docs/structured-outputs
- https://console.groq.com/docs/your-data
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
- https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
