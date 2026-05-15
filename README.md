# Job Search Bot

A personal backend job search automation tool built for **Uman Mushtaq**. It runs as a NestJS web service on Render, scans multiple job boards every few hours, filters results by language, experience, location and tech stack, and sends matching jobs to Telegram.

## What it does

- Serves `GET /health` for Render healthchecks
- Serves `GET /` as a live dashboard showing:
  - Last run status and next run time
  - Current matching jobs with score and reasoning
  - Buttons to mark jobs as `Applied` or `Dismiss`
- Runs the scanner automatically on a configurable interval (default: every 3 hours)
- Filters jobs to English-language only, 2–5 years experience, backend roles
- Expires `seen` cache after `seenTtlHours` so jobs rotate back if not acted on
- Keeps `applied` and `dismissed` jobs permanently so they never reappear

## Active sources

| Source | Notes |
|---|---|
| `welcometothejungle.com` | English-indexed Algolia API |
| `adzuna.com` | Multi-country (FR, GB, DE, NL, BE) |
| `francetravail.fr` | French government job board — requires API credentials |
| `greenhouse.io` | 30+ French/EU tech companies using Greenhouse ATS — no credentials needed |
| `remotive.com` | Remote-only roles |
| `remoteok.com` | Remote-only roles |
| `arbeitnow.com` | European English-language roles |

Blocked (require auth/scraping not suitable for automation):

- `wellfound.com` — `startup.jobs` — `indeed.com` — `linkedin.com`

## Filtering logic

- **Language**: English only (`profile.search.language = "en"`)
- **Experience**: 2–5 years. Text patterns like "5+ years" are treated as 6 (filtered out)
- **Title exclusions**: intern, senior, staff, lead, principal, head of, manager
- **Frontend exclusions**: frontend, react developer, flutter, iOS, Android, etc.
- **Salary**: minimum €3,000/month EUR equivalent
- **Location**: France preferred, EU remote accepted

## Job decisions

Jobs have 3 states:

- `seen`: temporary, expires after the TTL (default 1 hour)
- `applied`: permanent, never shown again
- `dismissed`: permanent, never shown again

Mark decisions from the dashboard at `/` or via CLI:

```bash
npm run jobs:applied:add -- 'https://job-link'
npm run jobs:dismiss:add -- 'https://job-link'
```

## Local run

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run build
node dist/main
```

One-off scan without starting the server:

```bash
npm run jobs:scan
```

## Render deployment

This app runs as a Render web service with auto-deploy from the `main` branch.

### Environment variables

```bash
# Runtime mode
RUN_MODE=continuous
CHECK_INTERVAL_MINUTES=180

# Telegram notifications (optional — app runs without them)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Persistent file paths (use Render Disk mount at /data)
JOB_SEARCH_SEEN_FILE=/data/job_search_seen.json
JOB_SEARCH_APPLIED_FILE=/data/job_search_applied.json
JOB_SEARCH_DISMISSED_FILE=/data/job_search_dismissed.json
JOB_SEARCH_REPORT_PATH=/data/job_search_latest.md
JOB_SEARCH_STATE_FILE=/data/job_search_state.json

# Adzuna (https://developer.adzuna.com)
ADZUNA_APP_ID=your_app_id
ADZUNA_APP_KEY=your_app_key
ADZUNA_COUNTRIES=fr,gb,de,nl,be

# France Travail (https://francetravail.io — subscribe to "Offres d'emploi v2")
FRANCE_TRAVAIL_CLIENT_ID=your_client_id
FRANCE_TRAVAIL_CLIENT_SECRET=your_client_secret

# Optional tuning
WTTJ_MAX_PAGES=2
ADZUNA_MAX_PAGES=2
ARBEITNOW_MAX_PAGES=3
JOB_SEARCH_MAX_RESULTS=20
```

### Healthcheck

Render healthcheck should point to `/health`.

## Verification

```bash
npm run build
npm test -- matcher
npm test -- storage
curl http://127.0.0.1:3000/health
```

## Cover letters

The bot generates a tailored cover letter draft for each match based on your profile. Review and lightly edit before sending.
