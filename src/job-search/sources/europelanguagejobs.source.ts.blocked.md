# Europe Language Jobs source — blocked pending live verification

**Date:** 2026-07-12
**Status:** NOT implemented. `europelanguagejobs.source.ts` does not exist yet.

## What was asked

Add coverage for `europelanguagejobs.com` — English-language + Germany + `developer`/
`node` searches, PLUS (bonus) a country-loop over Uman's other target countries
(Netherlands, Belgium, Luxembourg, Italy, Spain, Sweden, Denmark, Czech Republic,
Ireland, Hungary, Poland, Greece, France) since the board covers all of Europe, capped
at ~15 requests/run total. Each job on this board lists required languages as a
structured field — the task asked to extract that directly and feed it to
`language-requirement-filter.ts` rather than relying on free-text detection (the same
pattern already used for EURES's `requiredLanguages`).

## What was attempted

- `curl` against `https://www.europelanguagejobs.com/` — connection never completed,
  `HTTP 000` / exit 56, confirmed as a 403 policy-denial CONNECT rejection via
  `$HTTPS_PROXY/__agentproxy/status`.
- `WebFetch` was not separately retried against this domain in this pass (identical
  proxy-level block confirmed for all 6 Wave-2 target domains plus
  `rest.arbeitsagentur.de` via the proxy status endpoint — see the batch check in this
  session), consistent with every other domain attempted.

## Why this stops here

Two things need live discovery, neither possible here:
1. The actual URL structure for country-scoped searches (needed to build the bonus
   country-loop safely within the 15-request/run cap).
2. The exact structured shape of the per-job "required languages" field, so it can be
   mapped onto `JobPosting.requiredLanguages` (`{ code, level?, required? }[]`) the same
   way `eures.source.ts`'s `extractRequiredLanguages` does — guessing this shape risks
   either silently dropping the field (falling back to weaker free-text detection) or
   crashing on an unexpected structure.

## Next steps (for whoever picks this up next)

From an environment with real internet access:

```bash
curl -sI https://www.europelanguagejobs.com/robots.txt
curl -sI https://www.europelanguagejobs.com/sitemap.xml
curl -s "https://www.europelanguagejobs.com/jobs?keyword=developer&country=germany" | head -c 3000
```

Report back:
- Whether search is server-rendered HTML (cheerio-viable) or backed by a JSON API
  (preferred — plain fetch).
- The real URL parameter for country (to build the bonus loop) and whether it's a
  slug, ISO code, or numeric ID.
- The real markup/JSON shape of the "required languages" field on a job listing or
  detail page, with 2-3 example values, so it can be mapped onto
  `requiredLanguages: { code, level?, required? }[]`.

Delete this file once `europelanguagejobs.source.ts` is actually implemented and
verified.
