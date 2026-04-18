# DEPLOYMENT GUIDE

## Quick Start

You now have a comprehensive IoT job search bot with multi-source architecture. Here's how to use it:

---

## 🚀 LOCAL DEVELOPMENT (Your Machine)

### Start

```bash
# Single scan (one-time check)
npm run jobs:scan

# Continuous mode (every 3 hours, forever - ideal for testing)
RUN_MODE=continuous npm run jobs:scan

# Or use Docker for continuous monitoring
docker compose up --build
```

**That's it!** The bot will:
- Scan for IoT jobs every 3 hours
- Filter by your preferences (France priority, EU/USA support, relocation OK)
- Send matches to your Telegram every time
- Store history so no duplicates

---

## 📦 DOCKER (Local Container)

### Single Run
```bash
docker build -t iot-job-bot .
docker run --rm --env-file .env -v "$(pwd)/data:/data" iot-job-bot
```

### Continuous Mode (Recommended for Local)
```bash
# Runs every 3 hours indefinitely
docker compose up --build

# Stop with Ctrl+C
```

---

## 🚀 RAILWAY (Cloud Deployment with GitHub)

### Prerequisites
- [Railway account](https://railway.app) (free tier available)
- [Docker Hub account](https://hub.docker.com) (free)
- Telegram bot token and chat ID

### Step 1: Set up Docker Hub
```bash
# Create a Docker Hub repository
# Go to https://hub.docker.com and create a new repository called "iot-job-bot"
```

### Step 2: Configure GitHub Secrets
Go to your GitHub repository → Settings → Secrets and variables → Actions:

Add these secrets:
- `DOCKER_USERNAME`: Your Docker Hub username
- `DOCKER_PASSWORD`: Your Docker Hub password/token

### Step 3: Set up Railway Project
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Create new project
railway init iot-job-bot

# Link to existing project (if you created it via web)
railway link
```

### Step 4: Configure Environment Variables
```bash
# Set Telegram credentials
railway variables set TELEGRAM_BOT_TOKEN your_bot_token_here
railway variables set TELEGRAM_CHAT_ID your_chat_id_here

# Optional: Configure job search settings
railway variables set JOB_SEARCH_MAX_RESULTS 20
railway variables set JOB_SEARCH_MAX_PAGES 2
```

### Step 5: Deploy
```bash
# Push to GitHub (triggers automatic deployment)
git add .
git commit -m "Deploy to Railway"
git push origin main
```

### Step 6: Set up Cron Schedule
In Railway dashboard:
1. Go to your project
2. Navigate to "Cron Jobs" tab
3. Add new cron job:
   - **Command**: `npm run jobs:scan`
   - **Schedule**: `0 */3 * * *` (every 3 hours)
   - **Timezone**: `Europe/Paris`

### Step 7: Monitor
```bash
# View logs
railway logs

# Check cron job status
railway cron list
```

**Railway will automatically:**
- Build your Docker image via GitHub Actions
- Deploy to Railway's infrastructure
- Run the job search every 3 hours
- Send Telegram notifications

---

## ☸️ KUBERNETES (Production Deployment)

### Prerequisites
- Kubernetes cluster (EKS, GKE, AKS, self-hosted)
- kubectl configured
- Container registry (Docker Hub, ECR, GCR, etc.)

### Step 1: Build & Push Image

```bash
# Build
docker build -t your-registry/iot-job-bot:latest .

# Login to your registry (example: Docker Hub)
docker login

# Push
docker push your-registry/iot-job-bot:latest
```

### Step 2: Update Kubernetes Manifests

Edit `k8s/cronjob.yaml`:
```yaml
image: your-registry/iot-job-bot:latest  # ← UPDATE THIS
```

### Step 3: Create Namespace

```bash
kubectl create namespace job-bot
```

### Step 4: Create Telegram Secret

```bash
kubectl create secret generic job-bot-secrets \
  --from-literal=TELEGRAM_BOT_TOKEN=your_real_bot_token \
  --from-literal=TELEGRAM_CHAT_ID=your_real_chat_id \
  -n job-bot
```

Verify:
```bash
kubectl get secret job-bot-secrets -n job-bot -o yaml
```

### Step 5: Create Storage

```bash
kubectl apply -f k8s/pvc.yaml -n job-bot
```

Verify:
```bash
kubectl get pvc -n job-bot
```

### Step 6: Deploy CronJob

```bash
kubectl apply -f k8s/cronjob.yaml -n job-bot
```

Verify:
```bash
kubectl get cronjobs -n job-bot
```

### Step 7: Monitor

```bash
# Watch for scheduled jobs (every 3 hours)
kubectl get jobs -n job-bot --watch

# View logs from latest run
kubectl logs -n job-bot -f job-job-bot-<tab-to-autocomplete>

# Describe a specific job
kubectl describe job job-job-bot-<timestamp> -n job-bot
```

---

## 🔄 CRONJOB SCHEDULE

Current: **Every 3 hours**  
Cron format: `0 */3 * * *` (minute 0 of every 3rd hour)

Runs at:
- 00:00 (midnight)
- 03:00
- 06:00
- 09:00
- 12:00 (noon)
- 15:00
- 18:00
- 21:00

**Timezone**: `Europe/Paris` (can be changed in `cronjob.yaml`)

To change frequency, edit `cronjob.yaml`:
```yaml
schedule: "0 */6 * * *"  # Every 6 hours instead
```

Common schedules:
- `0 * * * *` → Every hour
- `0 */3 * * *` → Every 3 hours ✓ (current)
- `0 */6 * * *` → Every 6 hours
- `0 0 * * *` → Once daily
- `0 6,12,18 * * *` → Three times daily at 6am, noon, 6pm

---

## 🛠️ Adding More Job Sources

All job sources are in `src/job-search/sources/`. Currently active:
- ✅ Welcome to the Jungle

Stubs (ready to implement):
- 📋 LinkedIn Jobs
- 📋 Indeed
- 📋 Glassdoor
- 📋 EURES
- 📋 AngelList

### To Activate a Source

1. **Get API credentials** (varies by platform):
   - LinkedIn: https://business.linkedin.com/talent-solutions/recruiting
   - Indeed: https://opensource.indeedapis.com/
   - EURES: https://ec.europa.eu/eures/api/docs

2. **Add to `.env`** (if needed):
   ```
   LINKEDIN_API_KEY=...
   INDEED_API_KEY=...
   ```

3. **Implement the `JobSource` interface** in `src/job-search/sources/<platform>.source.ts`:
   ```typescript
   export class LinkedInJobsSource implements JobSource {
     name = 'linkedin';
     priority = 2; // Lower = higher priority
     
     async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
       // Fetch logic here
       return jobs;
     }
   }
   ```

4. **Register in `src/job-search/run.ts`**:
   ```typescript
   registry.register(new LinkedInJobsSource());
   ```

5. **Rebuild & redeploy**:
   ```bash
   npm run build
   docker build -t your-registry/iot-job-bot:latest .
   docker push your-registry/iot-job-bot:latest
   kubectl set image cronjob/startup-job-bot \
     job-bot=your-registry/iot-job-bot:latest -n job-bot
   ```

---

## ⚙️ CUSTOMIZATION

### Search Profile

Edit `job_search_profile.json`:

```json
{
  "search": {
    "queries": ["IoT engineer", "embedded systems", ...],
    "requiredKeywords": ["iot", "mqtt", ...],
    "preferredCountries": ["FR"],
    "acceptRemote": true,
    "acceptHybrid": true,
    "acceptOnSite": true,
    "willingToRelocate": true,
    "usaJobs": true,
    "startupJobs": true,
    "checkIntervalHours": 3,
    "maxAgeHours": 24,
    "maxResults": 20
  }
}
```

### Excluded Countries

Blacklist specific countries:
```json
"excludedCountries": ["RO", "BG", "LT", "CY", "LV", "HR"]
```

### Environment Variables

```bash
# .env file or Kubernetes secret
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
JOB_SEARCH_MAX_PAGES=2
JOB_SEARCH_MAX_RESULTS=20
RUN_MODE=once  # 'once' or 'continuous'
```

---

## 🐛 TROUBLESHOOTING

### No Jobs Found

```bash
# Check the report
cat job_search_latest.md

# Verify profile
cat job_search_profile.json | jq .search

# Test WTTJ API directly
curl "https://csekhvms53-dsn.algolia.net/1/indexes/wttj_jobs_production_en_published_at_desc/query" \
  -H "x-algolia-api-key: 4bd8f6215d0cc52b26430765769e65a0" \
  -H "x-algolia-application-id: CSEKHVMS53" \
  -d '{"params":"query=IoT%20engineer"}'
```

### Telegram Not Working

```bash
# Verify token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Check chat ID
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates

# Send test message
curl -X POST https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage \
  -d chat_id=<YOUR_CHAT_ID> \
  -d text="Test message"
```

### Docker Build Fails

```bash
# Check Docker daemon
docker version

# Clean build (no cache)
docker build --no-cache -t iot-job-bot .

# Check logs
docker compose logs
```

### Kubernetes Job Stuck

```bash
# Check PVC
kubectl get pvc -n job-bot

# Check secret
kubectl get secret job-bot-secrets -n job-bot

# View pod logs
kubectl logs -n job-bot -l job-name=<job-name> --all-containers=true

# Delete stuck job
kubectl delete job job-job-bot-<timestamp> -n job-bot
```

---

## 📊 MONITORING

### Local

```bash
# Watch continuous mode
RUN_MODE=continuous npm run jobs:scan

# Check report
cat job_search_latest.md

# View Telegram history (check your bot chat)
```

### Docker

```bash
# View logs
docker compose logs -f job-bot

# Execute command in running container
docker exec -it <container-id> npm run jobs:applied:add -- 'https://...'
```

### Kubernetes

```bash
# Watch cron triggers
kubectl get cronjobs -n job-bot -w

# View all jobs created
kubectl get jobs -n job-bot --sort-by=.metadata.creationTimestamp

# Tail logs (last 10 minutes)
kubectl logs -n job-bot -l app=job-bot --tail=100

# Describe recent failure
kubectl describe job job-job-bot-<timestamp> -n job-bot
```

---

## 🔐 SECURITY NOTES

### Secrets Management

**Local**: Use `.env.example` template, never commit `.env`

**Docker**: Use `--env-file .env` or environment secrets

**Kubernetes**: Use `kubectl create secret ...` (recommended)

### Production Best Practices

1. **Never commit secrets** to Git
2. **Use managed secrets** (AWS Secrets Manager, Azure Key Vault, etc.)
3. **Rotate tokens regularly** (Telegram can revoke)
4. **Monitor cronjob logs** for failures
5. **Set resource limits** in Kubernetes:
   ```yaml
   resources:
     limits:
       memory: "256Mi"
       cpu: "500m"
     requests:
       memory: "128Mi"
       cpu: "250m"
   ```

---

## 🚦 STATUS COMMANDS

```bash
# Local
npm run jobs:scan

# Docker
docker ps  # See running containers
docker compose ps

# Kubernetes
kubectl get all -n job-bot
kubectl describe cronjob -n job-bot
kubectl get events -n job-bot --sort-by=.metadata.creationTimestamp
```

---

**You're all set!** The bot is ready to find your next IoT role. 🎯

For questions, check the job reports and logs for debugging info.
