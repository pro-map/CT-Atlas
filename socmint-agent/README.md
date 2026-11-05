# CT Atlas SOCMINT ADK Agent

This directory contains the real ADK-based SOCMINT investigation agent used by
CT Atlas.

## Why this agent does not use Gemini Google Search grounding

The current Gemini API project used by CT Atlas does not have Google Search
grounding available. The agent therefore treats public-web discovery as an
independent optional tool, not as a Gemini capability.

It works in three modes:

1. **Known public URLs** — works immediately.
2. **Link expansion** — follows relevant public links found on those pages.
3. **Independent public search** — production uses Brave Search; SearXNG also
   works, and search can be disabled.

If search is unavailable, the investigation continues from known URLs instead
of failing.

## Structure

```
socmint-agent/
  app/
    __init__.py
    agent.py
    tools.py
    evidence_ledger.py
    run_budget.py
    telegram_evidence.py
  server.py
  tests/
  pyproject.toml
  agents-cli-manifest.yaml
  .env.example
```

The agent is a genuine ADK agent: Gemini decides which registered tools to call,
can make multiple tool calls in one investigation, keeps the investigation
context in the ADK session, and only produces the final report after the
collection/verification loop.

## Local development

Google's current Agents CLI requires Python 3.11+ and is not officially
supported on native Windows. On a Windows workstation, use WSL2/Ubuntu for the
CLI workflow.

From WSL/Linux/macOS:

```bash
cd socmint-agent
cp .env.example .env
# Add your existing AI Studio key to GEMINI_API_KEY in .env.

uvx google-agents-cli setup
agents-cli install
agents-cli playground
```

You can also run one investigation from the terminal:

```bash
agents-cli run '{"target":"example","urls":["https://example.org"],"objective":"Assess public associations"}'
```

AI Studio API-key authentication is sufficient for local `dev/run/eval`.
Deployment to Google Cloud requires Google Cloud authentication and billing.

## Optional independent search

Default:

```
SOCMINT_SEARCH_PROVIDER=disabled
```

### SearXNG

```
SOCMINT_SEARCH_PROVIDER=searxng
SOCMINT_SEARCH_BASE_URL=https://your-searxng.example
```

### Brave Search

```
SOCMINT_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=...
```

Search-provider credentials belong only in runtime secrets/environment
variables. Never commit them.

## Cloud Run

When ready to deploy, authenticate to a Google Cloud project with billing
enabled, then use the Agents CLI Cloud Run workflow or the official ADK Cloud
Run deployment flow.

Production deploys through `.github/workflows/deploy-socmint-agent.yml`, which
sets `--concurrency 1`, `--timeout 130` and `--memory 1Gi`, then connects the
Worker (see below). Each deploy generates a new shared secret, so the agent
refuses the Worker until the Worker's secret step has finished.

Until `SOCMINT_AGENT_URL` exists, CT Atlas continues using its existing
single-call SOCMINT backend as a fallback.

## Evidence model

The agent must distinguish:
- observed public-source facts;
- analytical assessments;
- confidence in linkages;
- unresolved gaps.

A similar username, profile image, narrative, wallet mention or shared channel
is never treated as proof of common identity, ownership or terrorist
affiliation.

### Evidence ledger

`server.py` records every URL a collector actually returned and sends the list
in `meta.evidence_ledger`. The Worker keeps a report's sources and citations only
if they are in the ledger or were supplied by the analyst, and takes each
source's kind from the ledger, never from the model:

- `direct_public_page` — `fetch_public_url` retrieved it;
- `search_result` — a search collector listed it, nobody read the page;
- `telegram_collected_post`, `telegram_public_preview`, `transcribed_media`;
- `discovered_link` — seen on a page or in a post, not read;
- `analyst_supplied` — given by the analyst, not read by the agent.

Any other URL is removed and listed in `unverified_sources`. A finding that
loses all its citations this way drops to LOW confidence.

### Run limits

A run has 12 LLM calls and a deadline of 100 seconds, sent by the Worker, whose
own limit is 115 seconds. The last call, or the first one in the final 25 seconds,
is made with tools switched off so that the model writes its report. If a run
still ends without a usable report, the agent returns the ledger as a partial
report (`meta.partial`, `meta.stop_reason`) instead of discarding the evidence.

The Worker allows 3 runs per account and 10 overall per Paris day, one at a time
per account (`SOCMINT_*` in `cloudflare-worker/shared.js`).

### Platforms CT Atlas never fetches

`NO_DIRECT_FETCH_HOSTS` in `app/tools.py` and `cloudflare-worker/social-intel.js`
lists LinkedIn, Facebook, Instagram, Threads, X, TikTok and Reddit, with their
short-link domains. Their terms or robots notices forbid automated access, so
their URLs can only appear as search-index leads. Both lists must stay identical.


## Connect the deployed agent to CT Atlas

The Cloudflare Worker uses the ADK agent only when both values exist:

- `SOCMINT_AGENT_URL` — the HTTPS base URL of the deployed agent service.
- `SOCMINT_AGENT_SHARED_SECRET` — a long random secret shared with the agent
  service as `CT_ATLAS_AGENT_SHARED_SECRET`.

The agent service must receive the same secret:

```
CT_ATLAS_AGENT_SHARED_SECRET=<same-random-secret>
```

CT Atlas then calls:

```
POST <SOCMINT_AGENT_URL>/investigate
X-CT-Atlas-Agent-Key: <shared-secret>
```

The Worker's `/health` says only whether both values exist. `/health/status`
reaches the agent, including `/auth-check` with the shared key, so a stale key
shows as `down`. Neither exposes the URL or secret.

The Social Media Analysis badge follows `components.agent.status` from
`/health/status`: `ADK AGENT` when it answers, `AGENT DOWN` when it fails,
`GEMINI FALLBACK` when it is not configured.

### Cloudflare secret commands

From a machine with Wrangler authenticated to the CT Atlas Cloudflare account:

```bash
cd cloudflare-worker
npx wrangler secret put SOCMINT_AGENT_URL
npx wrangler secret put SOCMINT_AGENT_SHARED_SECRET
```

The URL is not intrinsically sensitive, but storing both through Worker secrets
keeps configuration simple.

### Agent-side environment

For a Cloud Run deployment, configure at least:

```
GEMINI_API_KEY=<AI Studio key>
CT_ATLAS_AGENT_SHARED_SECRET=<same shared secret>
SOCMINT_AGENT_MODEL=gemini-3.5-flash-lite
SOCMINT_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=<Brave key>
```

Google Search grounding is unavailable on the current Gemini API project, so
public-web discovery depends on Brave or SearXNG. With
`SOCMINT_SEARCH_PROVIDER=disabled` the agent still iterates through supplied
public URLs and relevant links discovered from those pages.


## Free social-source collectors

The ADK agent now has dedicated PUBLIC-source collectors:

- **Bluesky**: unauthenticated account search on the public AppView. Post search
  is refused there (403), so it uses `api.bsky.app`, which still answers without
  login but is undocumented: treat it as a stopgap until CT Atlas has a declared
  account with an app password. `bluesky_post_search` shows whether it works.
- **Mastodon**: unauthenticated account/hashtag discovery on public instances.
- **YouTube Data API**: enabled when `YOUTUBE_API_KEY` is configured.
- **X and Reddit**: off. X Developer Agreement XIV.B(a) and XIV.C bar intelligence
  use without written approval, and Reddit's policy is reported to bar helping
  government surveillance. A key alone does nothing: `X_WRITTEN_APPROVAL=1` or
  `REDDIT_WRITTEN_APPROVAL=1` must also be set, and only with the approval on file.
- **Telegram public pages**: known `t.me` pages can be fetched directly;
  discovery uses the configured independent public-web provider, avoiding
  private chats and authentication-gated data.
- **Groq Whisper**: enabled when `GROQ_API_KEY` is configured, for
  transcription of suitable public audio/video URLs.
- **Sherlock**: included for same-username discovery across public services.
  Hits are candidate profiles only and never establish identity by themselves.

Bluesky and basic Mastodon discovery require no key. All optional credentials
must be stored as deployment secrets and never committed.

`social_capabilities` probes the keyless collectors with a small real request,
cached for five minutes, so `/health` shows a refusing provider as false. Keyed
collectors report only that their key is configured.

### Optional free-tier secrets

```
BRAVE_SEARCH_API_KEY=
YOUTUBE_API_KEY=
GROQ_API_KEY=
```

The agent remains operational when any optional source is unavailable and
records coverage limitations in its report.


### Free AI preprocessing fallbacks

For already-public text only, the agent can offload extraction/summarization to:

- **Cloudflare Workers AI** using `CLOUDFLARE_AI_ACCOUNT_ID` and
  `CLOUDFLARE_AI_API_TOKEN`.
- **OpenRouter Free Router** using `OPENROUTER_API_KEY` with
  `OPENROUTER_FREE_MODEL=openrouter/free`.

These model outputs are never treated as source evidence. The final SOCMINT
assessment must remain grounded in the original public URLs/API observations.
