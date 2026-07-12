# WeAreDevelopers source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `wearedevelopers.source.ts` does not exist yet.

## What was asked

Add coverage for `wearedevelopers.com`, entry point
`https://www.wearedevelopers.com/en/jobs/ln/english` (pre-filtered English-language
jobs) plus search-parameterized URLs for `node.js`/`typescript`/`backend`. As a modern
JS platform it likely calls an internal JSON API behind the job search — the task's own
discovery methodology (robots.txt/sitemap → feed paths → live XHR capture via
Playwright, dev-time only → cheerio on server-rendered HTML → Playwright rotation as
last resort) requires actually loading the page to find that endpoint.

## What was attempted

- `curl` (via this sandbox's egress proxy) against `https://www.wearedevelopers.com/`
  and the jobs listing URL above. **Result: connection never completed**, `HTTP 000` /
  exit 56, confirmed as a 403 policy-denial CONNECT rejection via
  `$HTTPS_PROXY/__agentproxy/status`.
- `WebFetch` against the same listing URL — returned a bare `HTTP 403 Forbidden`.

Both failures are indistinguishable from this sandbox's general outbound restriction
(every domain targeted in this pass hit the identical failure mode) — they say nothing
about whether wearedevelopers.com itself would block a request from Render.

## Why this stops here

No part of the discovery methodology (checking for a feed, capturing XHR requests,
inspecting server-rendered HTML) can be performed without loading the actual page.
Shipping a guessed field-mapping against an unseen internal API risks a source that
silently returns zero jobs forever.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
curl -sI https://www.wearedevelopers.com/robots.txt
curl -sI https://www.wearedevelopers.com/sitemap.xml
curl -s https://www.wearedevelopers.com/en/jobs/ln/english | head -c 3000
```

Better: load `https://www.wearedevelopers.com/en/jobs/ln/english` in a real/headless
browser with devtools Network tab open (filter XHR/Fetch), and also try adding
`?q=node.js`, `?q=typescript`, `?q=backend` style query params to see if search is
server-side or client-side. Report:

- Any internal JSON API endpoint called (URL + a sample response) — build as a
  plain-fetch FAST-scheduler source.
- If no JSON API and job cards are present in the initial server-rendered HTML — build
  as a cheerio scraper.
- If jobs only render after client-side JS with no discoverable API — that's the
  Playwright-rotation case (register in `PLAYWRIGHT_SOURCES` in `run.ts`, SLOW
  scheduler).

Also note for the final report regardless of implementation path: WeAreDevelopers is
partly a matching platform where companies can approach candidates directly — recommend
Uman create a profile there manually (one-time action, not something a scraper covers).

Delete this file once `wearedevelopers.source.ts` is actually implemented and verified.
