# GermanTechJobs.de source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `germantechjobs-de.source.ts` does not exist yet.

## What was asked

Add coverage for `germantechjobs.de` (Tier 2 of the Germany-coverage task), checking
first whether the site exposes an XML/RSS feed (cheap, no Playwright) before falling
back to a Playwright scrape — and if Playwright is genuinely required, it must join the
existing one-per-run Playwright rotation (`playwright-queue.ts`'s `acquirePlaywrightLock`)
rather than running standalone, since Render's free tier (512MB RAM) can't run two
Playwright instances in the same execution.

## What was attempted

Tried both a direct `curl` (through this sandbox's configured egress proxy, with the
proxy's CA bundle) and the `WebFetch` tool against:

- `https://germantechjobs.de/`
- `https://germantechjobs.de/feed` / `/rss` / `/feed.xml` (guessed common feed paths)

**Result: connection never completed.** `curl` returned exit code 56 / `HTTP 000` — the
CONNECT to `germantechjobs.de:443` was rejected by this environment's own egress proxy
with a 403 policy denial, confirmed via `$HTTPS_PROXY/__agentproxy/status`:

```
{ "host": "germantechjobs.de:443", "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)" }
```

This is the same sandbox-specific outbound allowlist restriction that has blocked
`europa.eu`, `glassdoor.com`, `justjoin.it`, `duunitori.fi`, and every other
Germany-coverage target domain in this same pass (see the July 12 2026 Germany-coverage
report for the full blocked-domain list). It says nothing about whether the site itself
would accept the request from Render.

## Why this stops here

Without seeing the actual page/feed, there is no way to confirm:
1. Whether an XML/RSS feed exists at all (the task's own instruction was to check this
   *before* reaching for Playwright — guessing feed paths blind isn't a substitute for
   actually looking).
2. The real DOM structure/selectors if a Playwright scrape turns out to be necessary.

Shipping a guessed implementation against either path risks a source that silently
returns zero jobs forever, which is the exact outcome this precedent (see
`eures.source.ts.blocked.md` history) exists to avoid.

## Next steps (for whoever picks this up next)

Run this from an environment with real, unrestricted internet access (a local machine,
or a shell on Render itself) and report back:

```bash
curl -sI https://germantechjobs.de/
curl -sI https://germantechjobs.de/feed
curl -sI https://germantechjobs.de/rss
curl -sI https://germantechjobs.de/feed.xml
curl -s https://germantechjobs.de/ | head -c 2000
```

- If a feed exists and returns clean XML/RSS: report the feed URL and a sample item's
  field names — this can then be built as a plain-fetch FAST-scheduler source (an XML
  feed needs no ScraperAPI, no Playwright).
- If no feed exists: report the actual job-card HTML structure (class names / DOM
  shape) from a real `/jobs`-style listing page so a cheerio scraper can be written
  against it. If the page is JS-hydrated (React/Next.js, no jobs in the initial HTML),
  say so explicitly — that's the trigger for a Playwright-based source, which must
  register in `PLAYWRIGHT_SOURCES` in `run.ts` and go through `acquirePlaywrightLock`.

Delete this file once `germantechjobs-de.source.ts` is actually implemented and verified.
