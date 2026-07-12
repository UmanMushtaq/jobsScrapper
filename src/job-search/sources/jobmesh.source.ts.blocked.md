# JobMESH source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `jobmesh.source.ts` does not exist yet.

## What was asked

Add coverage for `jobmesh.de`, a Frankfurt-based aggregator (1M+ listings, offers
English/Russian/Polish/Romanian postings). Flagged as the lowest priority of the six
Wave-2 sources: as an aggregator it will heavily duplicate BA/StepStone inventory, so
the task's own acceptance bar was conditional — if it requires Playwright AND yields
fewer than 10 unique (non-duplicate, post cross-source-dedup) Node/TypeScript jobs in a
live verification run, it should be disabled with a log line rather than consuming a
Playwright-rotation slot for near-zero unique value.

## What was attempted

- `curl` against `https://www.jobmesh.de/` — connection never completed, `HTTP 000` /
  exit 56, confirmed as a 403 policy-denial CONNECT rejection via
  `$HTTPS_PROXY/__agentproxy/status`.

Same universal proxy-level block affecting every domain targeted in this pass.

## Why this stops here

The task's own bar for this source is explicitly a live-verification decision (build it
only if the live run clears the >10-unique-jobs threshold). There is no way to run that
verification, or even to determine which discovery path (feed / JSON API / cheerio /
Playwright) applies, without reaching the site at all.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
curl -sI https://www.jobmesh.de/robots.txt
curl -sI https://www.jobmesh.de/sitemap.xml
curl -s "https://www.jobmesh.de/jobs?q=Node.js" | head -c 3000
```

Report back:
- Discovery path that works (feed / JSON endpoint / server-rendered HTML / requires
  Playwright).
- Whether the site supports a language filter/param (task wants an English-postings
  filter applied at the query level where possible, not just post-hoc).
- Most importantly: run a live search for `Node.js` and `TypeScript Backend`, count how
  many results are genuinely new after running them through the existing cross-source
  dedup key (`normalizeCompanyName(company) + normalizedTitle`) against jobs already
  ingested from Bundesagentur/StepStone/Adzuna/Jooble. If it's under ~10 unique and the
  site requires Playwright to scrape, do not build it — report that finding instead,
  per the task's own instruction.

Delete this file once `jobmesh.source.ts` is actually implemented and verified (or once
the live check confirms it should stay disabled, and that decision is documented in the
Wave-2 report instead).
