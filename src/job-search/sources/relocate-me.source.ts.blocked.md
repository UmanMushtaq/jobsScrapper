# Relocate.me source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `relocate-me.source.ts` does not exist yet.

## What was asked

Add coverage for `relocate.me` (Tier 2 of the Germany-coverage task), checking first
whether the site's listing pages call a JSON API (common for React/Next.js-driven job
boards — cheap, no Playwright) before falling back to a Playwright scrape — and if
Playwright is genuinely required, it must join the existing one-per-run Playwright
rotation (`playwright-queue.ts`'s `acquirePlaywrightLock`) rather than running
standalone, since Render's free tier (512MB RAM) can't run two Playwright instances in
the same execution.

## What was attempted

Tried both a direct `curl` (through this sandbox's configured egress proxy, with the
proxy's CA bundle) and the `WebFetch` tool against:

- `https://relocate.me/`
- `https://relocate.me/it-jobs` / `/jobs` (guessed common listing paths)

**Result: connection never completed.** `curl` returned exit code 56 / `HTTP 000` — the
CONNECT to `relocate.me:443` was rejected by this environment's own egress proxy with a
403 policy denial, confirmed via `$HTTPS_PROXY/__agentproxy/status`:

```
{ "host": "relocate.me:443", "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)" }
```

This is the same sandbox-specific outbound allowlist restriction that has blocked every
other Germany-coverage target domain in this same pass (see the July 12 2026
Germany-coverage report for the full blocked-domain list). It says nothing about
whether the site itself would accept the request from Render.

## Why this stops here

Without seeing the actual page, there is no way to confirm whether Relocate.me's
listings are served via a discoverable JSON API (e.g. an XHR call visible in browser
devtools) or require full JS rendering. Shipping a guessed implementation against
either path risks a source that silently returns zero jobs forever, which is the exact
outcome this precedent (see `eures.source.ts.blocked.md` history) exists to avoid.

## Next steps (for whoever picks this up next)

Run this from an environment with real, unrestricted internet access (a local machine,
or a shell on Render itself) and report back:

```bash
curl -s https://relocate.me/it-jobs | head -c 3000
```

Better yet, open the site's job-search page in a real browser, open devtools' Network
tab, filter to XHR/Fetch, and check whether a JSON endpoint is called when the listing
loads or when a filter changes. Report:

- The JSON endpoint URL and a sample response (if one exists) — this can then be built
  as a plain-fetch source (FAST scheduler, no ScraperAPI, no Playwright).
- If no JSON endpoint is called and jobs only appear after client-side rendering: say so
  explicitly — that's the trigger for a Playwright-based source, which must register in
  `PLAYWRIGHT_SOURCES` in `run.ts` and go through `acquirePlaywrightLock`.

Delete this file once `relocate-me.source.ts` is actually implemented and verified.
