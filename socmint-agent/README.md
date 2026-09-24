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
3. **Independent public search** — optional; enable SearXNG or Brave Search
   later without changing the agent.

If search is unavailable, the investigation continues from known URLs instead
of failing.

## Structure

```
socmint-agent/
  app/
    __init__.py
    agent.py
    tools.py
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

After deployment, CT Atlas needs only the service URL in the Worker environment:

```
SOCMINT_AGENT_URL=https://...
SOCMINT_AGENT_APP=app
```

An optional shared-secret header can be configured later if a proxy is placed
in front of the ADK service.

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

The Worker health endpoint exposes only:

```json
{
  "social_agent_configured": true,
  "social_agent_client_version": "..."
}
```

It never exposes the URL or secret.

When `social_agent_configured` is false, the Social Media Analysis page displays
`GEMINI FALLBACK`. When both settings are present and the new Worker is
deployed, the badge changes to `ADK AGENT`.

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
SOCMINT_AGENT_MODEL=gemini-2.5-flash-lite
SOCMINT_SEARCH_PROVIDER=disabled
```

Because Google Search grounding is unavailable on the current Gemini API
project, leave `SOCMINT_SEARCH_PROVIDER=disabled` initially. The agent will
still iterate through supplied public URLs and relevant links discovered from
those pages.

Later, public-web discovery can be added independently with SearXNG or Brave
without changing the CT Atlas Worker or UI.


## Free social-source collectors

The ADK agent now has dedicated PUBLIC-source collectors:

- **Bluesky**: unauthenticated public AppView search for posts and accounts.
- **Mastodon**: unauthenticated account/hashtag discovery on public instances.
- **YouTube Data API**: enabled when `YOUTUBE_API_KEY` is configured.
- **Reddit Data API**: enabled when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are configured. OAuth is required; unauthenticated
  Reddit API traffic is not used.
- **Telegram public pages**: known `t.me` pages can be fetched directly;
  discovery uses the configured independent public-web provider, avoiding
  private chats and authentication-gated data.
- **Groq Whisper**: enabled when `GROQ_API_KEY` is configured, for
  transcription of suitable public audio/video URLs.
- **Sherlock**: included for same-username discovery across public services.
  Hits are candidate profiles only and never establish identity by themselves.

Bluesky and basic Mastodon discovery require no key. All optional credentials
must be stored as deployment secrets and never committed.

### Optional free-tier secrets

```
BRAVE_SEARCH_API_KEY=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
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
