# Get in IT source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `get-in-it.source.ts` does not exist yet.

## What was asked

Add coverage for `get-in-it.de`, a German IT niche board aimed at early-career-to-mid
profiles (0-5 years — aligned with Uman's 4-year positioning), searching `Node.js`,
`Backend Entwickler`, `Software Engineer`. The board skews German-language and includes
many Werkstudent/graduate roles, which the existing title-exclusion list and German
language filter are expected to reject heavily (an intentionally low pass rate is
acceptable per the task). If job details require login to view, the task specified
extracting what the public listing shows and marking `descriptionPartial: true` rather
than building auth.

## What was attempted

- `curl` against `https://www.get-in-it.de/` — connection never completed, `HTTP 000` /
  exit 56, confirmed as a 403 policy-denial CONNECT rejection via
  `$HTTPS_PROXY/__agentproxy/status`.

Same universal proxy-level block affecting every domain targeted in this pass.

## Why this stops here

As a "modern JS site" (per the task's own description) it's expected to expose an
internal API, but which one — and whether job details are actually login-gated as
suspected — can only be confirmed by loading the real page.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
curl -sI https://www.get-in-it.de/robots.txt
curl -sI https://www.get-in-it.de/sitemap.xml
curl -s "https://www.get-in-it.de/jobs?q=Node.js" | head -c 3000
```

Better: load the search page in a real/headless browser with devtools Network tab open
(filter XHR/Fetch) while searching `Node.js`, `Backend Entwickler`, and `Software
Engineer`, and open one job detail page to confirm whether the full description is
public or actually requires login. Report:

- Any internal JSON API endpoint (URL + sample response).
- Whether job detail pages are genuinely gated — if so, confirm exactly what the public
  listing card shows (title, company, city, short blurb) so a scraper can be built
  against listing data only, with `descriptionPartial: true` set on every job from this
  source.

Delete this file once `get-in-it.source.ts` is actually implemented and verified.
