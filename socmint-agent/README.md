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
