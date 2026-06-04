# Job Search Bot

A personal backend job search automation tool built for **Uman Mushtaq** — Paris-based Node.js / NestJS engineer. Runs as a NestJS web service on Render, scans **18 job boards** across Europe every 3 hours, filters by language, experience, location and tech stack, and sends matching jobs with AI-generated cover letters and ATS analysis directly to Telegram.

---

## What it does

Every 3 hours the bot:

1. Fetches jobs from 18 sources across Europe and globally (remote)
2. Filters by language (English), experience (2–5 yrs), location, salary, and keywords
3. Scores each job 0–100 against your profile
4. Runs AI enrichment via Google Gemini (one call per job):
   - **Relevance score** — 0–100, drops jobs below 55
   - **Fraud detection** — drops jobs scoring 72+
   - **Company quality score** — flags red-flag employers
   - **APS visa compatibility** — checks if your French post-study permit works for this role
   - **ATS keyword gap analysis** — lists up to 8 keywords missing from your CV and where to add them
   - **Cover letter** — 3-paragraph, tailored to this company and role
   - **Email extraction** — if the job description includes a hiring manager email, generates a subject line and email body
   - **Salary estimate** — realistic monthly range in local currency + EUR equivalent
5. Checks every apply URL is still live (drops dead/filled positions)
6. Sends one Telegram message per matching job with full details and ✅ Applied / ❌ Reject buttons

### Dashboard

`GET /` — live web dashboard showing last run status, next run time, current matches, and buttons to mark jobs as Applied or Dismissed.

`GET /health` — Render healthcheck endpoint.

`POST /run-now` — trigger an immediate scan.

`GET /debug/keys` — validate all Gemini API keys (quota status, model, account guidance).

---

## Active sources (18)

| Source | Region | Notes |
|---|---|---|
| `welcometothejungle.com` | FR + EU | Algolia API, high quality |
| `wellfound.com` | Global | Startups, equity-focused roles |
| `adzuna.com` | FR, GB, DE, NL, PL, SE, ES, IT, BE, AT, CH, NO | Multi-country aggregator |
| `francetravail.fr` | FR | French government job board |
| `apec.fr` | FR | French executive/engineering roles |
| `greenhouse.io` | Global | ATS used by many EU tech companies |
| `jobs.lever.co` | Global | ATS used by many EU startups |
| `himalayas.app` | Remote | Remote-first companies |
| `jobicy.com` | Remote | Remote tech roles |
| `weworkremotely.com` | Remote | Remote roles |
| `remotive.com` | Remote | Remote software jobs |
| `remoteok.com` | Remote | Remote dev roles |
| `arbeitnow.com` | EU | English-language EU roles |
| `berlinstartupjobs.com` | DE | Berlin startup ecosystem |
| `bundesagentur.de` | DE | German federal job board |
| `startup.jobs` | Global | Startup-focused listings |
| `indeed.com` | FR + Remote | RSS feed, largest job board |
| `news.ycombinator.com` | Global | HN "Who's Hiring" monthly thread |

**No public API available:** `linkedin.com` (requires paid partner access)

---

## Filtering logic

| Filter | Rule |
|---|---|
| Language | English only |
| Experience | 2–5 years. "5+ years" → treated as exactly 5 |
| Title exclusions | intern, senior, staff, lead, principal, head of, manager |
| Role exclusions | frontend, react developer, flutter, iOS, Android, AI/ML, DevOps, SRE |
| Salary | Minimum €3,000/month EUR equivalent (skipped if not listed) |
| Score threshold | Adaptive: 58 (short desc) / 65 (medium) / 70 (long) |

### Mandatory scoring

A job must score **≥ 42** on the mandatory checks or it is rejected immediately:

| Signal | Points |
|---|---|
| Node.js / NestJS / Express.js present | +24 |
| TypeScript or JavaScript present | +18 |
| Backend / API / microservice role | +18 |

A job with TypeScript + backend but no Node.js (score 36) is rejected — this pattern matches .NET/Java full-stack postings.

### Location rules

| Location | Work mode | Result |
|---|---|---|
| France | any | Accepted |
| Anywhere | remote | Accepted |
| Europe (outside FR) | on-site or hybrid + relocation offered | Accepted |
| Europe (outside FR) | on-site or hybrid, no relocation | Rejected |
| USA | remote | Rejected (`usaJobs: false`) |
| Excluded countries | any | Rejected (RO, BG, LT, CY, LV, HR) |

---

## AI enrichment (Google Gemini — free tier)

Requires at least one `GEMINI_API_KEY`. Up to 10 keys can be configured (`GEMINI_API_KEY_1` … `GEMINI_API_KEY_10`). Keys from different Google accounts have independent 1,500 req/day quotas.

If Gemini is unavailable, jobs are still sent using a fallback cover letter template.

### Fields returned per job

| Field | Description |
|---|---|
| `relevanceScore` | 0–100. Jobs below 55 are dropped. |
| `visaFriendly` | true/false/null. Based on APS visa rules for FR, remote, or relocation. |
| `fraudScore` | 0–100. Jobs at 72+ are dropped. |
| `companyQualityScore` | 0–100. Flags rockstar/ninja culture, no salary, etc. |
| `atsMissingKeywords` | Up to 8 technical keywords from the job not clearly in your CV. |
| `atsPlacementSuggestions` | Where to add those keywords in your CV. |
| `coverLetter` | 3 paragraphs, 140–175 words. Mentions NexusPay, OptimusFox or Swiss Block as relevant. No dashes. |
| `hiringEmail` | Hiring manager email if explicitly in job description. |
| `emailSubject` / `emailBody` | Ready-to-send email if hiring email found. |
| `suggestedSalary` | Estimated gross monthly in local currency + EUR. |

### Quota behaviour

When a key returns a daily quota error it is blacklisted for the rest of the process run. Once all keys are exhausted, Gemini is skipped entirely for remaining jobs — no wasted API calls.

---

## Telegram message format

**Message 1 — summary:**
```
3 new matches for Uman Mushtaq:

1. Backend Engineer — Paace Ltd
   London, UK | hybrid | ~€6,767/month | 100%
2. Node.js Developer — Studocu
   Amsterdam, NL | hybrid | salary not listed | 96%
```

**Messages 2…N — one per job:**
```
[1/3] Backend Engineer
Company: Paace Ltd
Location: London, UK | hybrid
Score: 100% [Tech:60 | KW:20 | Loc:10 | Startup:10]
Apply: https://...
Why: Node.js explicitly required; TypeScript stack match
AI relevance: 82/100 ✓
APS visa: compatible ✓
Fraud risk: 8% ✓
Company quality: 85/100 ✓
Salary to quote: GBP 4,200–5,000/month (~€4,900–5,800/month)
ATS gaps: Jest, Kafka, OpenAPI
Tip: Add 'Jest' to Skills > Tools

--- Cover letter ---
...

[✅ Applied] [❌ Reject]
```

---

## Job states and TTLs

| State | Storage key | Expires |
|---|---|---|
| `seen` | `job:seen` ZSET | After `seenTtlHours` (default 48h) |
| `sent` | `job:sent_z` ZSET | 30 days |
| `applied` | `job:applied_z` ZSET | 180 days |
| `dismissed` | `job:dismissed_z` ZSET | 60 days |
| `applied_roles` | `job:applied_roles` ZSET | 180 days |
| `dismissed_roles` | `job:dismissed_roles` ZSET | 60 days |

Role deduplication: if you applied to or dismissed a company+role combination, reposts of the same role with a new URL are also skipped.

---

## Local run

```bash
npm install
cp .env.example .env   # fill in credentials
npm run build
node dist/main
```

One-off scan without starting the server:

```bash
npm run jobs:scan
```

---

## Render deployment

Auto-deploys from `main` branch. Requires **Upstash Redis** for persistent state (set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). Without Redis, state is lost on every restart.

### Environment variables

```bash
# Runtime
RUN_MODE=continuous
CHECK_INTERVAL_MINUTES=180

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Upstash Redis (persistent state across restarts)
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token

# Google Gemini — free tier (1 key minimum, up to 10 keys from different accounts)
GEMINI_API_KEY_1=AIzaSy...
GEMINI_API_KEY_2=AIzaSy...
GEMINI_API_KEY_3=AIzaSy...
GEMINI_API_KEY_4=AIzaSy...

# Adzuna (https://developer.adzuna.com)
ADZUNA_APP_ID=your_app_id
ADZUNA_APP_KEY=your_app_key

# France Travail (https://francetravail.io — subscribe to "Offres d'emploi v2")
FRANCE_TRAVAIL_CLIENT_ID=your_client_id
FRANCE_TRAVAIL_CLIENT_SECRET=your_client_secret

# Optional tuning
ADZUNA_MAX_PAGES=2
JOB_SEARCH_MAX_RESULTS=20
```

### Healthcheck

Point Render healthcheck to `/health`.

---

## Candidate profile

Edit `job_search_profile.json` to update search preferences:

- `candidate.name` / `candidate.location` / `candidate.experienceYears`
- `candidate.cvText` — full CV text fed to Gemini for tailored cover letters and ATS analysis
- `search.titles` — job titles to boost score
- `search.queries` — keywords sent to each source API
- `search.requiredKeywords` — keywords that add to score
- `search.preferredKeywordGroups` — keyword groups (each group that matches adds 6 pts)
- `search.minimumSalaryMonthlyEur` — minimum salary in EUR/month
- `search.maxAgeHours` — how old a job can be (default 72h)
- `search.checkIntervalHours` — fallback interval if env var not set
- `search.experience.min` / `search.experience.max` — experience filter bounds
- `search.excludedTitleKeywords` — title words that disqualify a job
- `search.excludedCountries` — country codes to always reject
