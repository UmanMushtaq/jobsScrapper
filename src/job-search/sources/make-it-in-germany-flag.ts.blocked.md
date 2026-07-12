# Make it in Germany — "welcomesForeignApplicants" flag — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. No `welcomesForeignApplicants` field added to `bundesagentur.source.ts`.

## What was asked

Make it in Germany's listings are the Bundesagentur für Arbeit database filtered to
employers who consented to publication there (i.e. employers who explicitly welcome
applications from skilled professionals abroad). Rather than building a duplicate
scraper, the task asked to find the distinguishing signal — either a request
parameter/facet on `www.make-it-in-germany.com`'s job-listings page, or a field already
present in our existing `rest.arbeitsagentur.de` v6/v4 responses (publication-channel,
consent, or partner flag) — and surface it as a boolean tag on jobs we already ingest
from the BA API, rather than ingesting a second copy of the same postings.

## What was attempted

1. `curl` (through this sandbox's egress proxy, with its CA bundle) against
   `https://www.make-it-in-germany.com/en/working-in-germany/job-listings` and against
   `https://rest.arbeitsagentur.de/`. **Result: connection never completed** — `curl`
   returned exit code 56 / `HTTP 000`, confirmed via `$HTTPS_PROXY/__agentproxy/status`
   as a 403 policy-denial CONNECT rejection for both hosts.
2. `WebFetch` against the same Make it in Germany URL — returned a bare `HTTP 403
   Forbidden` with no body.
3. Searched this repo for any saved/fixture BA API response that might already reveal
   the field (`grep -rn "arbeitgeber\|externeUrl\|angebotsart\|refnr"` across
   `bundesagentur.source.ts`) — the current source only declares the fields it actively
   consumes (`refnr`, `titel`, `beruf`, `arbeitgeber`, `arbeitsort`, date fields,
   `arbeitszeitmodelle`, `befristung`, `externeUrl`); there is no saved raw response
   anywhere in the repo to inspect for undeclared fields the API might also return.

## Why this stops here

The task's own instructions were explicit: use a live Playwright XHR capture on the
Make it in Germany listings page to see what backend/parameters it actually calls, and
cross-check the BA API's real response body for an undeclared flag. Both require live
network access this sandbox does not have. Guessing a field name (e.g. `oeffentlich`,
`partnerKanal`, `mig`) and wiring it in without ever seeing a real response risks
shipping a tag that's either always false or crashes on a shape mismatch — worse than
not shipping it.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
# 1. Load the listings page in a real/headless browser with devtools open, filter
#    Network to XHR/Fetch, and note every request made when the page loads or a filter
#    changes. Report the request URL(s) and full response body of one request.

# 2. Independently, hit our own already-working BA search endpoint and inspect the FULL
#    raw JSON (not just the fields bundesagentur.source.ts currently maps) for any
#    extra field:
curl -s "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=Node.js&angebotsart=1&maxErgebnisse=5" \
  -H "X-API-Key: jobboerse-jobsuche" -H "Accept: application/json" | python3 -m json.tool
```

- If Make it in Germany calls `rest.arbeitsagentur.de` (or a thin proxy in front of it)
  with an extra parameter — report the parameter name/value.
- If the BA API's own raw response (not our currently-mapped subset) already contains a
  publication-channel/consent/partner field — report the field name and its value for a
  few known Make-it-in-Germany-listed jobs vs. a few known non-listed jobs, so the
  distinguishing value can be confirmed.
- If NEITHER exists: fall back to the task's own fallback plan — a lightweight
  Playwright scraper of the Make it in Germany listing pages (SLOW scheduler, joins the
  existing Playwright rotation) that fetches only refnrs and cross-references them
  against jobs already ingested from the BA API (match on `refnr`), tagging existing
  records rather than duplicating them.

Delete this file once the flag (or the Playwright cross-reference fallback) is
implemented and verified.
