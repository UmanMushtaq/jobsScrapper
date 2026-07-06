# EURES source — blocked pending live verification

**Date:** 2026-07-06
**Status:** NOT implemented. `eures.source.ts` does not exist yet.

## What was asked

Add a new `eures.source.ts` HTTP/JSON source hitting EURES's (the European Commission's
job mobility portal) internal search API:

```
POST https://europa.eu/eures/eures-searchengine/page/jobSearch?lang=en
Content-Type: application/json
```

with a documented-but-unverified request body shape (`resultsPerPage`, `keywords`,
`locationCodes`, etc.) and response shape (`jobsCount`, `jobs[]` with `title`,
`employer.name`, `locations`, `creationDate`/`lastModificationDate`, `jvProfileId`).

The task instructions were explicit: **curl-verify the real response shape first, and
adjust the field mapping to match. If the endpoint rejects programmatic access entirely,
stop and document instead of shipping speculative code.**

## What was attempted

1. `curl -X POST https://europa.eu/eures/eures-searchengine/page/jobSearch?lang=en` with
   the documented request body and browser-like headers (`User-Agent`, `Origin`,
   `Referer`, `Content-Type: application/json`) from this environment's Bash tool.
   **Result: connection never completed.** `curl` returned exit code 56 / `HTTP 000` —
   the CONNECT to `europa.eu:443` was rejected by this environment's own egress proxy
   with a 403 policy denial, confirmed via the proxy status endpoint
   (`$HTTPS_PROXY/__agentproxy/status`), which showed:
   ```
   { "host": "europa.eu:443", "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)" }
   ```
   This is a restriction specific to this sandbox's outbound allowlist — the same
   pattern that blocked `glassdoor.com`, `justjoin.it`, `duunitori.fi`, and
   `tyomarkkinatori.fi` in earlier sessions. **It says nothing about whether EURES
   itself would accept the request from Render or any other environment with real
   internet access.**

2. As a fallback, tried the `WebFetch` tool (which sometimes routes through a different
   network path than this sandbox's Bash `curl`) against both:
   - The exact API endpoint (as a GET, since WebFetch can't do a custom POST body/headers).
   - The actual EURES search portal page a browser would load
     (`https://europa.eu/eures/portal/jv-se/search?...`).

   **Both returned a bare `HTTP 403 Forbidden` with no response body available to
   inspect.** This is genuinely ambiguous: it could mean europa.eu has bot-detection /
   WAF protection that blocks non-browser clients generically (which would also block a
   plain axios/fetch call from Render, i.e. a real "can't be done with plain headers"
   block matching the task's own stop condition) — or it could just be WebFetch's
   fetch client being flagged for unrelated reasons. There is no way to tell which from
   the tool's output (no headers, no body were returned).

## Why this stops here

The request/response shapes given in the task were explicitly flagged as
"documented community-known shape... verify live and adjust" — i.e. not confirmed
correct even by the person who wrote the task. Combined with two independent
inconclusive-or-blocked attempts to reach the endpoint at all, shipping ~150 lines of
field-mapping code against an unverified interface risks landing a source that silently
returns zero jobs forever, or breaks on a response shape that doesn't match the guess.
That's exactly the outcome the task asked to avoid.

## Next steps (for whoever picks this up next)

Run this from an environment with real, unrestricted internet access (a local machine,
or a shell on Render itself) and report the actual output:

```bash
curl -s -X POST "https://europa.eu/eures/eures-searchengine/page/jobSearch?lang=en" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Origin: https://europa.eu" \
  -H "Referer: https://europa.eu/eures/portal/jv-se/search" \
  -d '{
    "resultsPerPage": 5,
    "page": 1,
    "sortSearch": "MOST_RECENT",
    "keywords": [{ "keyword": "nodejs", "specificSearchCode": "EVERYWHERE" }],
    "publicationPeriod": null,
    "occupationUris": [],
    "skillUris": [],
    "requiredExperienceCodes": [],
    "positionScheduleCodes": [],
    "sectorCodes": [],
    "educationAndQualificationLevelCodes": [],
    "positionOfferingCodes": [],
    "locationCodes": ["lu", "it", "se", "be", "nl"],
    "euresFlagCodes": [],
    "otherBenefitsCodes": [],
    "requiredLanguages": [],
    "minNumberPost": null
  }'
```

- If it returns a clean JSON body with `jobs[]`: paste the real field names back into a
  follow-up task so `eures.source.ts` can be written against the actual shape instead of
  a guess.
- If it returns a WAF/challenge page (HTML, a Cloudflare/Akamai-style block, or a cookie
  requirement): this source is a dead end via plain HTTP and should not be attempted
  without a headless-browser approach (which would need its own memory-budget
  discussion, same as the other Playwright sources).
- If it returns a clean 403/401 JSON error unrelated to bot detection (e.g. requires an
  API key/registration): note that requirement and treat like the Platsbanken key
  situation — a separate registration question, not a code bug.

Delete this file once `eures.source.ts` is actually implemented and verified.
