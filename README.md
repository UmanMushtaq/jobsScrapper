# IoT Job Search Bot

Automated job search bot for IoT/Embedded Systems positions across European Union, USA, and global startup platforms. Scans multiple job sources, filters by location preferences (France priority), relocation support, work mode, and experience level. Sends curated matches to Telegram every 3 hours.

## Key Features

✅ **Multi-source job boards** (architecture ready for):
  - Welcome to the Jungle (currently active)
  - LinkedIn Jobs
  - Indeed
  - Glassdoor  
  - EURES (EU portal)
  - AngelList/Wellfound (startups)
  - GitHub Jobs
  - Country-specific boards

✅ **Smart Location Filtering**:
  - France priority (100/100 score)
  - EU countries acceptable (60-85/100)
  - Relocation detection & scoring
  - USA support
  - Automatic country code validation

✅ **Job Preferences**:
  - Remote, Hybrid, and On-site positions
  - Startup detection & prioritization
  - IoT-specific keywords (MQTT, LoRa, Zigbee, etc.)
  - Experience level filtering (3-5 years)
  - Salary filtering (€3000+ monthly)
  - Language filtering (English)

✅ **Scheduling**:
  - **Local**: Every 3 hours (continuous mode)
  - **Deployed**: Every 3 hours via Kubernetes CronJob
  - Persistent history of seen/applied jobs

✅ **Telegram Integration**:
  - Real-time job notifications
  - Match scores & location details
  - Direct apply links
  - Relocation support indicators

## What works today

- **Active data source**: Welcome to the Jungle (automatic)
- **Filters**: English language, France + EU + USA regions
- **Rejects**: Internships, senior/staff/lead roles, outside 3-5 year band
- **Scoring**: 90%+ match on IoT keywords, experience, salary
- **Storage**: Seen/applied URLs prevent duplicates
- **Reporting**: Markdown reports + Telegram notifications

## Architecture for Extensibility

The bot is structured to support multiple job sources:

```
src/job-search/sources/
├── wttj.source.ts          ✅ Currently active
├── multi-source.ts         📋 Stub implementations:
│   ├── GitHubJobsSource()
│   ├── LinkedInJobsSource()
│   ├── IndeedJobsSource()
│   ├── GlassdoorJobsSource()
│   ├── EuresJobsSource()
│   └── AngelListSource()
├── registry.ts             🔧 Source manager
├── location-filter.ts      🌍 Location scoring
└── [future sources]
```

To add a new job board, implement the `JobSource` interface and register it. See `multi-source.ts` for API recommendations.

## Local Setup

```bash
npm install
cp .env.example .env
mkdir -p data
```

Add your Telegram values to `.env`:

```bash
TELEGRAM_BOT_TOKEN=8793734794:AAFPxBRJjaSYj6ui3IVGgS0pVW0MQO1T3lA
TELEGRAM_CHAT_ID=123456789
```

## Running Locally

### Single Scan (One-time search)

```bash
npm run jobs:scan
```

Output: `job_search_latest.md` with matches found, Telegram notification sent.

### Continuous Mode (Every 3 hours - ideal for local dev)

**Option 1: Docker Compose** (recommended)
```bash
docker compose up --build
```

**Option 2: Direct Node.js**
```bash
RUN_MODE=continuous npm run jobs:scan
```

This will:
- Check for new jobs every 3 hours
- Run indefinitely until you stop it (Ctrl+C)
- Store persistent history in `data/`
- Send Telegram notifications for each batch

### Helper Commands

```bash
# scan without cached build
npm run jobs:scan:dev

# mark a job as already applied (won't show again)
npm run jobs:applied:add -- 'https://example.com/job-link'

# reset history (WARNING: clears seen/applied jobs)
rm data/job_search_*.json
```

## Telegram Bot Setup

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow prompts
3. Copy the bot token (looks like `123456:ABC-DEF...`)
4. Start a chat with your new bot and send any message
5. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getMe`
6. Find your Chat ID or use **@userinfobot** → `/start`
7. Add both to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```

## Docker

Single scan in container:

```bash
docker build -t iot-job-bot .
docker run --rm --env-file .env -v "$(pwd)/data:/data" iot-job-bot
```

Continuous monitoring with Compose:

```bash
docker compose up --build
```

## Kubernetes Deployment

### 1. Create Namespace

```bash
kubectl create namespace job-bot
```

### 2. Create Secret (with your Telegram credentials)

```bash
kubectl create secret generic job-bot-secrets \
  --from-literal=TELEGRAM_BOT_TOKEN=8793734794:AAFPxBRJjaSYj6ui3IVGgS0pVW0MQO1T3lA \
  --from-literal=TELEGRAM_CHAT_ID=123456789 \
  -n job-bot
```

### 3. Create PersistentVolumeClaim

```bash
kubectl apply -f k8s/pvc.yaml -n job-bot
```

### 4. Deploy CronJob

Update image in `k8s/cronjob.yaml`:
```yaml
image: your-registry/iot-job-bot:latest
```

Then deploy:
```bash
kubectl apply -f k8s/cronjob.yaml -n job-bot
```

**Schedule**: `0 */3 * * *` → Every 3 hours at minute 0 (00:00, 03:00, 06:00, etc.)

**Monitor**:
```bash
kubectl get cronjobs -n job-bot
kubectl get jobs -n job-bot --sort-by=.metadata.creationTimestamp
kubectl logs -n job-bot -f job-job-bot-<timestamp>
```

## Configuration

Edit `job_search_profile.json`:

### Search Queries
```json
"queries": [
  "IoT engineer",
  "embedded systems",
  "firmware engineer",
  "MQTT developer",
  ...
]
```

### Location Priorities
```json
"preferredCountries": ["FR"],      // France gets highest score
"acceptRemote": true,               // Accept remote jobs
"acceptHybrid": true,               // Accept hybrid 
"acceptOnSite": true,               // Accept on-site
"willingToRelocate": true,          // Unlock EU on-site jobs
"usaJobs": true,                    // Include USA positions
"startupJobs": true,                // Include startup roles
```

### Blacklist Countries
```json
"excludedCountries": ["RO", "BG", "LT", "CY", "LV", "HR"]
```

### Keywords
```json
"requiredKeywords": [
  "iot", "embedded", "firmware", "mqtt", "lora", ...
],
"preferredKeywordGroups": [...],
"relocationKeywords": [
  "relocation", "visa sponsorship", "assistance provided", ...
]
```

### Scheduling
```json
"checkIntervalHours": 3,          // Run every 3 hours
"maxAgeHours": 24,                // Only jobs from last 24h
"maxResults": 20                  // Max matches per scan
```

## Adding New Job Sources

Example: Add LinkedIn jobs

1. Create `src/job-search/sources/linkedin.source.ts`:

```typescript
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

export class LinkedInJobsSource implements JobSource {
  name = 'linkedin';
  priority = 2; // Lower number = higher priority

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    // 1. Authenticate (LinkedIn API requires OAuth)
    // 2. Query jobs for each search term
    // 3. Filter by country, experience, salary
    // 4. Map to JobPosting interface
    // 5. Return array of jobs
    
    return [];
  }
}
```

2. Register in `src/job-search/run.ts`:

```typescript
import { LinkedInJobsSource } from './sources/linkedin.source';

// Add to existing sources:
registry.register(new LinkedInJobsSource());
```

3. Get API credentials:
   - LinkedIn: https://business.linkedin.com/talent-solutions/recruiting
   - Indeed: https://opensource.indeedapis.com/
   - EURES: https://ec.europa.eu/eures/api/docs
   - AngelList: https://angel.co/api/

## Environment Variables

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# File locations
JOB_SEARCH_SEEN_FILE=/data/job_search_seen.json
JOB_SEARCH_APPLIED_FILE=/data/job_search_applied.json
JOB_SEARCH_REPORT_PATH=/data/job_search_latest.md

# Job search limits
JOB_SEARCH_MAX_RESULTS=20
JOB_SEARCH_MAX_PAGES=2

# Execution mode
RUN_MODE=once              # 'once' for single run, 'continuous' for 3-hour loops
```

## Troubleshooting

**No jobs found?**
- Check `job_search_latest.md` for the report
- Verify search queries in `job_search_profile.json`
- Ensure location filters aren't too restrictive
- Try increasing `JOB_SEARCH_MAX_PAGES`

**Telegram not working?**
- Verify token and chat ID: `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Ensure bot is started: Send message to bot, then check `getUpdates`
- Check logs for errors

**Jobs repeating?**
- Seen/applied history in `data/` directory
- Delete to reset: `rm data/job_search_*.json`

**Building in Docker fails?**
- Ensure `docker compose up` is run from project root
- Check Docker daemon is running: `docker version`

## Performance Notes

- **WTTJ API**: ~500-1000ms per query, 50 results per page
- **Algolia**: Rate limited but generous for public indexes
- **Multi-source**: Runs parallel fetches with 3s+ timeout
- **Deduplication**: Fast Set-based lookup (O(1))
- **Scoring**: ~50ms for 100+ jobs with full profile matching

## Future Enhancements

- [ ] LinkedIn API integration (requires partnership)
- [ ] Indeed API integration (requires API key)
- [ ] EURES integration (public API available)
- [ ] Email fallback (if Telegram unavailable)
- [ ] Web dashboard for job review
- [ ] Apply automation (careful with agreements!)
- [ ] Salary trend tracking
- [ ] Tag-based job filtering
- [ ] Cover letter generation refinement

## About Generated Content

The bot creates tailored cover letter drafts grounded in your experience. However, reviewers may detect AI assistance. **Always review and edit before sending.**

---

**Created for**: Uman Mushtaq  
**IoT Focus**: Embedded Systems, Firmware, MQTT, LoRa  
**Target**: France (priority), EU (with relocation support), USA (remote/startup)  
**Update Frequency**: Every 3 hours (local/deployed)

