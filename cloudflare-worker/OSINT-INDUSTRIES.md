# OSINT Industries in the Social workspace

The Social interface uses the documented OSINT Industries POST `/v2/request` API and GET `/misc/credits`. It searches one email, international phone number, username, name or wallet at a time. The Worker authenticates the existing CT Atlas session and keeps the provider key on the server.

## Activate the connection

In Cloudflare, open **Workers & Pages → ct-report-generator → Settings → Variables and Secrets → Add**. Select **Secret**, use the name `OSINT_INDUSTRIES_API_KEY`, paste the key supplied by OSINT Industries, and deploy the setting. Never put the key in GitHub source files or client JavaScript. Refresh the Social page: its credit check should show **API connected** and the shared account balance.

The interface is available before activation and shows **Awaiting API key**. A configured key is checked using the provider's credit endpoint; this check does not run an identifier search. The account must have access to the requested query types. A real search has not been verified until the provider credentials are connected.

## Search behavior

- Requests use a 60-second provider window, exact name matching and no premium modules. Slower modules may be omitted by the provider.
- Every search is submitted once without automatic retries. Provider failures distinguish invalid access, insufficient credits, rate limits and unavailable responses.
- The shared connection permits three submitted searches per minute, with at most two per user and one active search per user. Duplicate request IDs are blocked for ten minutes.
- Credits come from the shared OSINT Industries account; CT Atlas does not assume a free allocation or invent a balance.
- Source results and raw JSON are kept in the current browser page, with JSON/PDF downloads. They are not persisted to the CT Atlas event database or sent to Gemini. Reservation metadata stores user names, random request IDs and times, not search identifiers or results.
- The former Social admin counters remain retired.

API references: [POST search](https://docs.osint.industries/reference/search-1), [credits](https://docs.osint.industries/reference/credit-lookup), [spec format](https://docs.osint.industries/reference/spec-format).
