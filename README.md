# Job Search Bot

A personal backend job search automation tool built for **Uman Mushtaq**. Runs as a NestJS web service on Render, scans 7 job boards every 3 hours, filters by language, experience, location and tech stack, and sends matching jobs with AI-generated salary suggestions directly to Telegram.

## What it does

Every 3 hours the bot:

1. Fetches jobs from 7 sources across 12 countries
2. Filters by language (English only), experience (2–5 years), location, salary, and keywords
3. Scores each job 0–100% against your profile
4. Runs AI enrichment (Google Gemini free tier):
   - **Fraud detection** — scores 0–100, drops jobs scoring 60+
   - **Salary suggestion** — realistic monthly range in local currency + EUR equivalent, adjusted for required experience level
5. Checks every apply URL is still live (drops dead/filled positions)
6. Sends one Telegram message per matching job with full details

### Dashboard

`GET /` — live web dashboard showing last run status, next run time, current matches, and buttons to mark jobs as Applied or Dismissed.

`GET /health` — Render healthcheck endpoint.

`POST /run-now` — trigger an immediate scan.

---

## Active sources

| Source | Countries | Notes |
|---|---|---|
| `welcometothejungle.com` | FR + EU | Algolia API, highest quality |
| `adzuna.com` | FR, GB, DE, NL, PL, SE, ES, IT, BE, AT, CH, NO | Multi-country REST API |
| `francetravail.fr` | FR | French government board — requires API credentials |
| `greenhouse.io` | Global | 30+ EU tech companies, no credentials needed |
| `remotive.com` | Remote | Remote-only roles |
| `arbeitnow.com` | EU | English-language EU roles |

**Blocked** (require login or scraping not suitable for automation):
`wellfound.com` · `startup.jobs` · `indeed.com` · `linkedin.com`

**Blocked by cloud IP** (works locally but not from Render):
`remoteok.com` — returns 403 on all cloud provider IPs

---

## Filtering logic

| Filter | Rule |
|---|---|
| Language | English only |
| Experience | 2–5 years required. "5+ years" treated as 6 (rejected) |
| Title exclusions | intern, senior, staff, lead, principal, head of, manager |
| Frontend exclusions | frontend, react developer, flutter, iOS, Android, etc. |
| Salary | Minimum €3,000/month EUR equivalent (ignored if not listed) |
| Score threshold | Must reach 85% to be included |

### Location rules

| Location | Mode | Result |
|---|---|---|
| France | any | Accepted, score 100 |
| Anywhere | remote | Accepted, score 90 |
| Europe (outside FR) | hybrid + relocation offered | Accepted, score 80 |
| Europe (outside FR) | hybrid, no relocation | Accepted, score 65 |
| Europe (outside FR) | on-site + relocation offered | Accepted, score 70 |
| Europe (outside FR) | on-site, no relocation | **Rejected** |
| Excluded countries | any | **Rejected** (RO, BG, LT, CY, LV, HR) |

---

## AI enrichment (Google Gemini — free tier)

Requires `GEMINI_API_KEY`. If not set, the bot runs normally with a fallback cover letter template and no salary suggestion.

### Fraud detection

Gemini analyzes each job for: unrealistic salary, vague description, no real company info, no specific tech requirements, grammar errors. Jobs scoring ≥ 60/100 are silently dropped.

### Salary suggestion

Gemini estimates the gross monthly salary for the role in the job's local city and country, adjusted for experience:

| Job requires | Quoted at |
|---|---|
| 2 years | 2yr market rate |
| 3 years | 3yr market rate |
| 4 or 4.5 years | 3.5yr market rate |
| 5+ years | your actual 4yr rate |
| Not stated | your actual 4yr rate |

Exchange rate fetched live from `cdn.jsdelivr.net/currency-api` (cached 1 hour). Output: `PLN 18,000–22,000/month (~€4,200–5,100/month)`.

---

## Telegram message format

**Message 1** — summary of all new matches:
```
3 new matches for Uman Mushtaq:

1. Backend Engineer — Paace Ltd
   London, UK | hybrid | ~€6,767/month | 100%
2. Node.js Developer — Studocu
   Amsterdam, NL | hybrid | salary not listed | 96%
```

**Messages 2…N** — one per job:
```
[1/3] Backend Engineer
Company: Paace Ltd
Location: London, UK | hybrid
Score: 100%
Apply: https://...
Why: Node.js explicitly required; NestJS/TypeScript match
Fraud risk: 8% ✓
Salary to quote: GBP 4,200–5,000/month (~€4,900–5,800/month)
```

---

## Job decisions

Jobs have three states:

| State | Storage | Expires |
|---|---|---|
| `seen` | `job_search_seen.json` | After `seenTtlHours` (default 168h / 7 days) |
| `applied` | `job_search_applied.json` | Never |
| `dismissed` | `job_search_dismissed.json` | Never |
| `sent` | `job_search_sent.json` | Never — prevents re-sending to Telegram |

Mark decisions from the dashboard at `/` or via CLI:

```bash
npm run jobs:applied:add -- 'https://job-link'
npm run jobs:dismiss:add -- 'https://job-link'
```

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

Auto-deploys from `main` branch. Requires a persistent disk mounted at `/data/`.

### Environment variables

```bash
# Runtime
RUN_MODE=continuous
CHECK_INTERVAL_MINUTES=180

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Persistent file paths (Render disk mounted at /data)
JOB_SEARCH_SEEN_FILE=/data/job_search_seen.json
JOB_SEARCH_APPLIED_FILE=/data/job_search_applied.json
JOB_SEARCH_DISMISSED_FILE=/data/job_search_dismissed.json
JOB_SEARCH_SENT_FILE=/data/job_search_sent.json
JOB_SEARCH_REPORT_PATH=/data/job_search_latest.md
JOB_SEARCH_STATE_FILE=/data/job_search_state.json

# Google Gemini — free tier (fraud detection, cover letters, salary estimates)
GEMINI_API_KEY=your_gemini_key

# Adzuna (https://developer.adzuna.com)
ADZUNA_APP_ID=your_app_id
ADZUNA_APP_KEY=your_app_key
# Defaults to all 12 supported countries if not set:
# ADZUNA_COUNTRIES=fr,gb,de,nl,pl,se,es,it,be,at,ch,no

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

## Verification

```bash
npm run build
npm test -- matcher
npm test -- storage
curl http://127.0.0.1:3000/health
```

---

## Candidate profile

Edit `job_search_profile.json` to change search preferences:

- `candidate` — name, location, skills, experience years
- `search.titles` — job titles to match
- `search.queries` — keywords sent to each source API
- `search.requiredKeywords` — keywords that boost score
- `search.preferredKeywordGroups` — grouped keywords (each group adds 6pts if any match)
- `search.minimumSalaryMonthlyEur` — minimum salary in EUR/month
- `search.maxAgeHours` — how old a job can be (default 24h)
- `search.checkIntervalHours` — fallback interval if env var not set
- `search.excludedTitleKeywords` — title words that disqualify a job
- `search.excludedCountries` — country codes to always reject
