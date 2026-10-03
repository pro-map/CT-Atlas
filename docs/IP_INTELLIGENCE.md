# IP Intelligence

IP Intelligence is an investigator-oriented workspace for the existing authenticated CT Atlas users. It has the same session access as the other workspaces; there is no separate police-account grant. The main page orders the six equal desktop cards as Map, Crypto, Dark Web, Facial, IP Intelligence, Social (Beta).

## What works after deployment

Enter one public IPv4 or IPv6 address. The API authenticates the session, validates the address, and consults IANA's RDAP bootstrap, the responsible regional registry, RIPEstat and the configured attribution services. Results include registration, published organisation/contact postal addresses, technical/abuse contacts, routing ASN/prefix, and approximate MaxMind GeoLite2 location through RIPEstat. Source outages are shown explicitly, with partial results retained. No Tor installation or collector is used for this workspace.

Only public unicast literals are accepted. URLs, domains, ports, subnets, local/private, shared carrier-NAT, documentation, multicast, mapped and special-use/tunnel ranges are excluded conservatively. The tool does not connect to the investigated IP, perform traceroute, scan ports, bypass a VPN, identify a subscriber, or send a provider request.

## Source recovery and diagnostics

Worker version **5.37** / `ip-intelligence-v3-resilient-sources` adds an independent **RIPEstat WHOIS** fallback when IANA discovery or RIR RDAP fails. It retrieves allocation names/ranges, available organisation postal addresses and published technical/abuse contacts without a new key. Results retain the original RDAP failure and label the fallback source. Returned resource/range must contain the queried IP; IRR routing objects are not treated as allocation owners. Multiple network records prevent automatic association of unrelated contact cards. Fields absent from the registry remain unknown.

Source errors now include fixed, actionable diagnostics. Proxycheck documents that unauthenticated requests from proxy origins can be denied; a 403 alone cannot establish that this was the cause. Documented account/key/quota messages are classified without returning raw messages, request URLs or secrets. IANA discovery failures and later registry failures are distinguished. No alternative source bypasses authentication or access restrictions, and no denied call is retried through another origin.

## Independent VPN source: ipapi.is

Create a free account at https://ipapi.is/ and add **IPAPI_IS_KEY** as a **Secret** on the **ct-report-generator** Cloudflare Worker, then deploy. Its current documentation offers 1,000 keyed requests/day and permits commercial use on that free tier. There is no purchase or account creation by this integration. Leave the key unset to make no calls to this provider, or set `IPAPI_IS_ENABLED=false` to disable it.

This source supplies separate VPN/proxy/Tor/hosting assessments, a VPN service name where available, ASN/company information, approximate geolocation and WHOIS-derived abuse postal/email/telephone contacts. VPN service names remain distinct from network owners. It uses a fixed HTTPS POST endpoint; only the queried IP and provider key are sent, with the key in the JSON body rather than URL. Case references, timestamps, ports, notes and email headers are not sent. Both top-level IP and any nested VPN IP are checked; abuse contacts are accepted only when the provider's company allocation contains the target. Returned risk/abuser scores are not exposed or interpreted as criminality.

The anonymous/minimal response **does not provide VPN detection**. If such a response arrives despite a configured key, it remains explicitly limited; it is never converted into a negative VPN result. Nonboolean detection values remain unknown. Disagreements across ipapi.is, Proxycheck and IPinfo are preserved and prevent selection of a certain recipient. Health exposes `ip_intelligence_ipapi_is_key_configured` and `ip_intelligence_ipapi_is_enabled`; these reflect configuration, not a successful account check.

## Cisco / IronPort enquiries

AS30238 now has a reviewed Cisco contact route: https://privacyrequest.cisco.com/governmentdatarequest. Cisco's published fallback `governmentdatademands@cisco.com` is for sending the officer's contact details when the portal cannot be used; the tool does not instruct users to email evidence there. The report shows the US entity, flag and company address (170 West Tasman Dr., San Jose, CA 95134), clearly distinguished from an accepted address for legal service. The official guidelines require US-law compliance and may require international assistance for foreign demands.

Cisco IronPort results carry conditional mail-relay guidance: an IP extracted from an email Received header identifies a relay, not the sender's access ISP or home. Suggested enquiry context includes the Message-ID, exact UTC time, customer organisation and available message-trace records. This is an ASN-based orientation, not automatic analysis of email headers. A named VPN or conflicting attribution is not overridden by that guidance.

## VPN detection and IPinfo Lite

Proxycheck.io v3 is enabled by default as a complementary VPN/proxy attribution source. It supplies detection flags and, when known, the intermediary provider name and website independently of the hosting network. An account is not required for initial tests: its documented unregistered allowance is 100 queries/day per egress IP. Shared Cloudflare egress can exhaust this allowance or require authentication. For dependable account-level access, create a Proxycheck account (the documented free registered allowance is 1,000/day), then add **PROXYCHECK_API_KEY** as a **Secret** on the **ct-report-generator** Worker, save and deploy. No purchase is required by this integration. Quota exhaustion, missing names and source errors remain explicit; coverage is not universal.

The Worker calls the fixed HTTPS v3 endpoint with `ver=24-June-2026&tag=0`. The latter disables the provider's optional positive-detection dashboard log; this is not a claim about all provider retention. Only the submitted public IP is sent, never the analyst's case reference, notes or incident details. The optional key stays server-side and is excluded from responses, reports, source links and application logs. It is sent in the API query string as required by the documented API; do not log outbound credential-bearing URLs. Set **PROXYCHECK_ENABLED=false** to disable this source.

**IPINFO_TOKEN** remains an optional Cloudflare Secret. The Worker tries `/lookup/{ip}` with Bearer authorization and falls back to `/lite/{ip}` only on HTTP 401/402/403/404. A valid Lite token enriches the ASN organisation/domain and country; its flatter response is normalized. Lite does not supply VPN detection and never replaces a more detailed RIPEstat location. Plus/equivalent access can supply `anonymous.is_vpn` and `anonymous.name`. Quota, network and mismatched-IP failures are not concealed with retries. Both API integrations verify that the response concerns the requested IP.

Each VPN detection source retains its own assessment in the page and report. Conflicting booleans become unresolved, with a warning; several named services are preserved without selecting a certain recipient. Exact service aliases are deduplicated. Hosting alone does not imply a VPN, a missing assessment is unknown, and a negative assessment does not prove absence. Source confidence concerns positive detection quality, not identity or criminality.

Health fields distinguish IPinfo secret configuration, Proxycheck enablement and Proxycheck key configuration. These configuration flags do not certify credential validity, account entitlement or quota. Run an actual lookup and inspect source statuses for that.

## Contact routes and interpretation

The top **Who to contact** card names the attributed VPN/intermediary first, or the network operator/allocation holder when no service is named. It gives available email, postal address, phone, official policy/portal and the basis for the lead. Unresolved multiple-provider attribution does not choose one mailbox. The same card is included near the beginning of the PDF and in JSON. It identifies a potential records holder and specifies the information an investigator may request: subscriber/account identity, service or installation address, and IP allocation/session records for the incident time and source port. These are request objectives, never public lookup results. A hosting/VPN endpoint does not reveal the access ISP behind it or guarantee that linking records exist.

Network identity can come from IPinfo, RIR RDAP, Proxycheck's network provider or a RIPEstat ASN-holder fallback. A network owner can be an ISP, host or intermediary; it is not automatically the entity holding subscriber records. RIR contact cards and RIPEstat supply published organisation names, postal addresses, emails and phones worldwide. These are IP allocation contacts, not domain registrars. Registry/abuse contacts are clearly labelled as routing leads, not verified legal-request channels. Server location, registration country and a provider's legal jurisdiction remain separate.

The reviewed contact directory currently covers Proton VPN, NordVPN, Mullvad, ExpressVPN, IVPN and Private Internet Access, plus Surfshark. It differentiates legal-request channels from general support or policy contacts. IVPN's jurisdiction/service restrictions are included. Google AS15169 links to LERS, Cloudflare AS13335 to its law-enforcement procedure, and Microsoft AS8075 to its authorities portal. ASN matches are orientation leads requiring confirmation of the relevant service and entity, not proof of a subscriber relationship. Unknown named intermediaries retain their attributed name and HTTPS website when supplied, with an explicit unverified-channel label; network abuse details are not relabelled as that VPN's legal mailbox. External provider websites are not fetched by the Worker.

Directory verification dates, attribution sources and procedure links appear on screen and in exports. Provider cards now include sourced legal-entity jurisdiction entries, country flags and published entity/contact postal addresses. Google and Microsoft expose possible US/Irish entities with scope notes, rather than deriving a jurisdiction from the IP or silently choosing one. Unknown jurisdiction is explicit. A published company address is distinguished from an accepted method of serving legal process. Country SVGs are bundled from the MIT-licensed flag-icons project inside `ip-report.js`; results and PDF flags require no third-party image request or platform emoji support. No AI invents contacts, postal addresses or jurisdictions. Recheck the official procedure before submitting an operational request. The directory is reviewed coverage, not a complete worldwide legal-contact database.

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
- IPinfo Lite: https://ipinfo.io/developers/lite-api
- Proxycheck API, schema, quotas and log flag: https://proxycheck.io/api/
- RIPEstat ASN holder: https://stat.ripe.net/docs/data-api/api-endpoints/as-overview
- RIPEstat WHOIS: https://stat.ripe.net/docs/data-api/api-endpoints/whois
- ipapi.is schema, keyed access and limits: https://ipapi.is/developers.html
- Cisco government requests: https://www.cisco.com/c/en/us/about/trust-center/transparency.html
- Cisco guidelines and fallback email: https://www.cisco.com/c/dam/en_us/about/doing_business/trust-center/docs/law-enforcement-guidelines.pdf
- Cisco published company address: https://www.cisco.com/c/en/us/about/legal/privacy-full.html
- IPinfo Plus: https://ipinfo.io/developers/plus-api
- Proton authorities: https://proton.me/legal/law-enforcement
- NordVPN policy contact: https://my.nordaccount.com/legal/privacy-policy/
- NordVPN general contact: https://nordvpn.com/contact-us/
- Mullvad contact/policy: https://mullvad.net/en/help/privacy-policy
- ExpressVPN policy: https://www.expressvpn.com/trust
- IVPN authorities: https://www.ivpn.net/en/legal-process-guidelines/
- PIA authorities: https://www.privateinternetaccess.com/privacy-policy
- PIA legal email: https://clients.privateinternetaccess.com/contact-us
- Surfshark general contact: https://surfshark.com/terms-of-service
- Google authorities: https://support.google.com/legal/answer/13967303?hl=en and https://lers.google.com/
- Microsoft authorities: https://v2.leportal.microsoft.com/ and https://www.microsoft.com/en-us/corporate-responsibility/reports/government-requests/customer-data
- Cloudflare authorities: https://www.cloudflare.com/trust-hub/law-enforcement/

All directory entries reviewed 2026-10-03. Automated tests use synthetic/provider-shaped fixtures and verify authentication, IP validation, provider failure, redirect restrictions, contact attribution, export content and hub/deployment wiring. Live registry checks use public resolver addresses, not user investigation targets.
