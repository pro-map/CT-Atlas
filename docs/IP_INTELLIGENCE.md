# IP Intelligence

IP Intelligence is an investigator-oriented workspace for the existing authenticated CT Atlas users. It has the same session access as the other workspaces; there is no separate police-account grant. The main page orders the six equal desktop cards as Map, Crypto, Dark Web, Facial, IP Intelligence, Social (Beta).

## What works after deployment

Enter one public IPv4 or IPv6 address. The API authenticates the session, validates the address, and consults IANA's RDAP bootstrap, the responsible regional registry, and RIPEstat. Results include registration, published organisation/contact postal addresses, technical/abuse contacts, routing ASN/prefix, and approximate MaxMind GeoLite2 location through RIPEstat. Source outages are shown explicitly, with partial results retained. No Tor installation or collector is used for this workspace.

Only public unicast literals are accepted. URLs, domains, ports, subnets, local/private, shared carrier-NAT, documentation, multicast, mapped and special-use/tunnel ranges are excluded conservatively. The tool does not connect to the investigated IP, perform traceroute, scan ports, bypass a VPN, identify a subscriber, or send a provider request.

## Enable VPN detection and enhanced geolocation

1. Obtain an IPinfo API token with **Plus or equivalent lookup access** that returns `anonymous.is_vpn` and `anonymous.name`. A Lite token alone is not sufficient for VPN detection. Check the subscription and quota in your IPinfo account; purchasing a plan is an administrator action.
2. In Cloudflare, open the **ct-report-generator** Worker → Settings → Variables and Secrets. Add **IPINFO_TOKEN** as a **Secret** and save/deploy.
3. Run a new lookup. The page reports unknown if enrichment is unavailable, the token lacks access, the quota is exhausted, or a field is omitted. It never converts a missing field into “not detected”. The Worker health endpoint reports only whether a token is configured, not whether the subscription works.

The server requests `https://api.ipinfo.io/lookup/{ip}` with a Bearer credential. The secret never reaches the page, exported files, source URLs or application logs. IPinfo's `anonymous.name` identifies the privacy service where available; the ASN organisation can instead be its hosting supplier. “Hosting” does not imply “VPN”, and “not detected” is not proof of absence. There is no promise of comprehensive VPN attribution.

## Contact routes and interpretation

RIR contact cards supply published organisation names, postal addresses, email addresses and phone numbers. RIPEstat supplies additional abuse emails. These are explicitly labelled registry/technical contacts, not legal-request channels or subscriber addresses. Registration country, estimated server location and corporate legal jurisdiction are kept separate.

The initial small contact directory matches exact IPinfo service aliases for Proton VPN, NordVPN, Mullvad and ExpressVPN. Proton's law-enforcement page/email is labelled as such. NordVPN and Mullvad expose general contact routes, and ExpressVPN links to its provider policy: none is presented as a verified law-enforcement inbox. A Cloudflare AS13335 routing match links to its official law-enforcement guidance, subject to confirming the relevant service/entity. Unknown providers have an explicit “no verified route” result; no AI invents contacts, addresses or jurisdictions. The directory's verification date is printed in the screen and report. Recheck official pages before an operational request; extend the directory with reviewed official sources as required.

## Reports and incident context

PDF and JSON exports include the lookup time, IP, operator, registration, geolocation and radius when supplied, VPN indicators, provider and registry contacts, source links/status/timestamps, and limitations. An optional case reference, observation time (explicitly UTC), source port, protocol and analyst notes are held in the current page and added locally to the exported report. They are not transmitted to metadata APIs or stored on the Worker. Reloading the page clears the investigation. Exports are local files, not saved case records.

Lookup time is separate from analyst-supplied incident time. Current records cannot establish who held a historical address. Preserve the original log and exact timestamp/timezone, source port and protocol where available, and route the enquiry through the agency's current procedures. No disclosure or retained-log availability is implied.

## Operation and bounds

- Authenticated POST `/ip-intelligence/lookup`, JSON `{ "ip": "8.8.8.8" }`; response `Cache-Control: no-store, private`.
- Six lookups per user per minute via a transactional Durable Object counter. No target IP or case text is persisted in that counter; tab usage records aggregate openings only.
- Registry requests and redirects restricted to five official HTTPS RIR hosts. Up to three missing top-level contact cards expanded. Maximum 1 MB per source response, 8-second timeout per outbound request, maximum three redirect follows, 2 KB input cap. Provider responses are data, never executable HTML.
- IPv4/IPv6 bootstrap cached for 24 hours within the Worker isolate. No cross-user result cache. Query IPs necessarily go to the consulted metadata providers; an optional external map link sends coordinates only after a click.
- RIPEstat asks regular users above 1,000 daily queries to register their usage. This integration uses `sourceapp=ct-atlas` and at most three concurrent RIPEstat requests per lookup. Review source terms and permitted use if expanding usage or redistribution, including MaxMind GeoLite2 attribution/licensing.

## Official references

- IANA bootstrap: https://data.iana.org/rdap/ipv4.json and https://data.iana.org/rdap/ipv6.json
- RIPEstat API/usage: https://stat.ripe.net/docs/data-api/ripestat-data-api
- Network: https://stat.ripe.net/docs/data-api/api-endpoints/network-info
- Abuse: https://stat.ripe.net/docs/data-api/api-endpoints/abuse-contact-finder
- GeoLite2: https://stat.ripe.net/docs/data-api/api-endpoints/maxmind-geo-lite
- IPinfo Plus: https://ipinfo.io/developers/plus-api
- Proton authorities: https://proton.me/legal/law-enforcement
- NordVPN contact: https://nordvpn.com/contact-us/
- Mullvad contact/policy: https://mullvad.net/en/help/privacy-policy
- ExpressVPN policy: https://www.expressvpn.com/trust
- Cloudflare authorities: https://www.cloudflare.com/trust-hub/law-enforcement/

All directory entries reviewed 2026-10-03. Automated tests use synthetic/provider-shaped fixtures and verify authentication, IP validation, provider failure, redirect restrictions, contact attribution, export content and hub/deployment wiring. Live registry checks use public resolver addresses, not user investigation targets.
