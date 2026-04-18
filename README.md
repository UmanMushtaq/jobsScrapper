# Job Search Bot

This project now runs as a Railway-friendly Nest service for Uman Mushtaq's job search. It keeps an HTTP server alive for healthchecks and dashboard access, runs job scans on an interval, stores recent matches, and lets jobs be marked as `applied` or `dismissed` without editing JSON by hand.

## What it does

- Serves `GET /health` for Railway healthchecks
- Serves `GET /` as a small dashboard with:
  - last run status
  - next run time
  - current matches
  - buttons to mark jobs as `Applied` or `Dismiss`
- Runs the scanner automatically in-process every `CHECK_INTERVAL_MINUTES`
- Expires `seen` cache after `seenTtlHours` from `job_search_profile.json`
- Keeps `applied` and `dismissed` jobs permanently so they do not come back
- Prioritizes startup companies across all fetched jobs, not just startup job boards

## Current source status

Active:

- `welcometothejungle.com`

Tracked but blocked in this environment:

- `wellfound.com`
- `startup.jobs`
- `indeed.com`
- `linkedin.com`

## Interval and cache logic

- Default interval: `60` minutes
- Config source: `CHECK_INTERVAL_MINUTES`
- Default seen-cache TTL: `1` hour
- Config source: `job_search_profile.json -> search.seenTtlHours`
- Search window: latest `7` days by default
- Fallback behavior: if no strong matches are found in the normal window, the bot broadens the search window automatically so it does not stay empty for weeks

## Job decisions

There are 3 job states:

- `seen`: temporary, expires after the TTL
- `applied`: permanent, never shown again
- `dismissed`: permanent, never shown again

You can set decisions in 2 ways:

```bash
npm run jobs:applied:add -- 'https://job-link'
npm run jobs:dismiss:add -- 'https://job-link'
```

Or from the dashboard at `/` by pressing `Applied` or `Dismiss`.

## Local run

```bash
npm install
cp .env.example .env
npm run build
node dist/main
```

One-off scan:

```bash
npm run jobs:scan
```

## Railway deploy

This app is designed to run as a Railway web service, not as a one-off worker.

### Required Railway variables

```bash
RUN_MODE=continuous
CHECK_INTERVAL_MINUTES=60
TELEGRAM_BOT_TOKEN=your_real_bot_token
TELEGRAM_CHAT_ID=your_real_chat_id
JOB_SEARCH_SEEN_FILE=/data/job_search_seen.json
JOB_SEARCH_APPLIED_FILE=/data/job_search_applied.json
JOB_SEARCH_DISMISSED_FILE=/data/job_search_dismissed.json
JOB_SEARCH_REPORT_PATH=/data/job_search_latest.md
JOB_SEARCH_STATE_FILE=/data/job_search_state.json
WTTJ_MAX_PAGES=2
```

### Important Railway notes

- Missing Telegram secrets will **not** break the app anymore
- The app still runs and the dashboard/healthcheck still works without Telegram
- Railway healthcheck should use `/health`
- Railway cron is not required for the main behavior anymore, because the service schedules itself in-process

## Verification

```bash
npm run build
npm test -- matcher
npm test -- storage
curl http://127.0.0.1:3000/health
```

## About generated text

The bot creates tailored cover letter drafts grounded in your experience. They are much more specific than generic AI templates, but you should still review and lightly edit them before sending.
