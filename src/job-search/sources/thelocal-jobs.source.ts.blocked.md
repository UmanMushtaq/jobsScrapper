# The Local Jobs source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `thelocal-jobs.source.ts` does not exist yet.

## What was asked

Add coverage for `jobs.thelocal.de`, targeting the Software Engineering / IT &
Telecoms category, PLUS (bonus) the same board's other-country editions
(`jobs.thelocal.com` with Austria/Denmark/France/Italy/Norway/Spain/Sweden/Switzerland
editions) filtered down to Uman's target countries (Denmark, France, Italy, Spain,
Sweden), capped at ~15 requests/run total. The Local is described as a white-label
"content supplied by external partners" board, which the task flagged as likely running
a hosted job-board product with either a clean JSON search endpoint or clean
server-rendered HTML.

## What was attempted

- `curl` against `https://jobs.thelocal.de/` — connection never completed, `HTTP 000` /
  exit 56, confirmed as a 403 policy-denial CONNECT rejection via
  `$HTTPS_PROXY/__agentproxy/status`.

Same universal proxy-level block affecting every domain targeted in this pass — not
informative about whether the site itself would block Render.

## Why this stops here

The task's own framing — "likely a hosted job-board product; discovery will reveal the
real backend" — is exactly the kind of claim that needs a live look before writing
code. Which hosted job-board platform this is (and therefore its URL/API conventions)
was not confirmed, and guessing wrong burns effort building against the wrong shape
entirely.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
curl -sI https://jobs.thelocal.de/robots.txt
curl -sI https://jobs.thelocal.de/sitemap.xml
curl -s "https://jobs.thelocal.de/jobs?category=software-engineering" | head -c 3000
```

Report back:
- Whether the underlying platform is identifiable (many white-label boards run on a
  shared vendor platform — if so, note the vendor, since its API conventions are often
  documented/reusable).
- The real category-filter URL/param for Software Engineering / IT & Telecoms.
- The real edition URL pattern for `jobs.thelocal.com` (e.g. does it use a subdomain,
  path prefix, or query param to select country edition) so the bonus country-loop can
  target Denmark/France/Italy/Spain/Sweden correctly.
- Whether search/listing responses are JSON (preferred) or server-rendered HTML.

Delete this file once `thelocal-jobs.source.ts` is actually implemented and verified.
