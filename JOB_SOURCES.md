# Job Sources Architecture

This document explains how to add new job sources to the bot.

## Current Architecture

### JobSource Interface

All job sources must implement:

```typescript
export interface JobSource {
  name: string;                    // Unique identifier
  priority: number;                // Lower = higher priority (1-10)
  fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]>;
}
```

### JobPosting Interface

Each job must map to:

```typescript
export interface JobPosting {
  source: string;                  // Source name (e.g., "linkedin")
  sourcePriority: number;          // Priority from JobSource
  canonicalUrl: string;            // Unique job URL
  title: string;                   // Job title
  company: string;                 // Company name
  companySummary: string;          // Company description
  companySlug: string;             // URL-safe company name
  locationLabel: string;           // e.g., "Paris, France"
  countryCode: string | null;      // ISO 3166-1 alpha-2 (e.g., "FR")
  city: string | null;             // City name
  workMode: 'remote' | 'hybrid' | 'on-site';
  language: string | null;         // e.g., "en"
  description: string;             // Full job description
  keyMissions: string[];           // Key responsibilities
  experienceLevelMinimum: number | null;  // Years required
  salaryCurrency: string | null;   // e.g., "EUR"
  salaryPeriod: string | null;     // e.g., "monthly"
  salaryMinimum: number | null;    // Minimum salary
  salaryMaximum: number | null;    // Maximum salary
  salaryYearlyMinimum: number | null;
  publishedAt: string;             // ISO timestamp
  publishedAtTimestamp: number;    // Unix timestamp
  startupSignals: string[];        // Indicators of startup
  applyUrl: string;                // Where to apply
  offersRelocation: boolean;       // Relocation support detected
  isStartup: boolean;              // Marked as startup
}
```

## Existing Sources

### Welcome to the Jungle (wttj.source.ts)

**Status**: ✅ Active  
**Priority**: 3  
**API**: Algolia (public, no auth needed)  
**Rate Limit**: Generous for public index  
**Countries**: Global  
**Update Frequency**: Real-time

```typescript
// Implementation
- Uses Algolia REST API
- Detects relocation keywords in description
- Maps WTTJ fields to JobPosting
- Handles pagination
- Deduplicates by URL
```

---

## Adding New Sources

### Example: LinkedIn Jobs

**File**: `src/job-search/sources/linkedin.source.ts`

```typescript
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

export class LinkedInJobsSource implements JobSource {
  name = 'linkedin';
  priority = 2;  // Higher priority than WTTJ (lower number = higher priority)

  async fetch(
    queries: string[],
    settings: SearchSettings,
  ): Promise<JobPosting[]> {
    const jobs: JobPosting[] = [];

    // 1. Authenticate
    const token = process.env.LINKEDIN_API_TOKEN;
    if (!token) {
      console.warn('LinkedIn requires LINKEDIN_API_TOKEN');
      return [];
    }

    // 2. For each query
    for (const query of queries) {
      try {
        // 3. Call LinkedIn API
        const results = await this.searchJobs(query, token, settings);
        
        // 4. Map to JobPosting
        const mappedJobs = results.map((job) => this.mapLinkedInJob(job));
        jobs.push(...mappedJobs);
      } catch (error) {
        console.error(`LinkedIn search failed for "${query}":`, error);
      }
    }

    return jobs;
  }

  private async searchJobs(
    query: string,
    token: string,
    settings: SearchSettings,
  ): Promise<any[]> {
    // Call LinkedIn API
    // Documentation: https://docs.microsoft.com/en-us/linkedin/talent/job-search-api
    
    const params = new URLSearchParams({
      keywords: query,
      limit: '50',
      // Filter by country, experience, etc.
    });

    const response = await fetch(
      'https://api.linkedin.com/v2/jobs?...params...',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`LinkedIn API error: ${response.status}`);
    }

    return response.json();
  }

  private mapLinkedInJob(linkedinJob: any): JobPosting {
    return {
      source: 'linkedin',
      sourcePriority: this.priority,
      canonicalUrl: linkedinJob.jobId || '',
      title: linkedinJob.jobTitle || '',
      company: linkedinJob.companyName || '',
      companySummary: linkedinJob.companyDescription || '',
      companySlug: linkedinJob.companyId?.toString() || '',
      locationLabel: this.formatLocation(linkedinJob),
      countryCode: linkedinJob.countryCode?.toUpperCase() || null,
      city: linkedinJob.city || null,
      workMode: this.mapWorkMode(linkedinJob),
      language: 'en', // Assuming English
      description: linkedinJob.description || '',
      keyMissions: this.extractKeyMissions(linkedinJob.description),
      experienceLevelMinimum: linkedinJob.seniorityLevel || null,
      salaryCurrency: linkedinJob.salaryCurrency || null,
      salaryPeriod: 'yearly',
      salaryMinimum: linkedinJob.salaryMinimum || null,
      salaryMaximum: linkedinJob.salaryMaximum || null,
      salaryYearlyMinimum: linkedinJob.salaryMinimum || null,
      publishedAt: new Date(linkedinJob.postedDate).toISOString(),
      publishedAtTimestamp: new Date(linkedinJob.postedDate).getTime() / 1000,
      startupSignals: [],
      applyUrl: `https://www.linkedin.com/jobs/view/${linkedinJob.jobId}`,
      offersRelocation: this.detectRelocation(linkedinJob.description),
      isStartup: this.detectStartup(linkedinJob.companyName, linkedinJob.companyDescription),
    };
  }

  private formatLocation(job: any): string {
    const parts = [job.city, job.state, job.country].filter(Boolean);
    return parts.join(', ');
  }

  private mapWorkMode(job: any): 'remote' | 'hybrid' | 'on-site' {
    if (job.workplaceType === 'REMOTE') return 'remote';
    if (job.workplaceType === 'HYBRID') return 'hybrid';
    return 'on-site';
  }

  private extractKeyMissions(description: string | null): string[] {
    if (!description) return [];
    // Parse bullet points or key sections
    return description
      .split('\n')
      .filter((line) => line.includes('•') || line.includes('-'))
      .slice(0, 5);
  }

  private detectRelocation(description: string | null): boolean {
    if (!description) return false;
    const lower = description.toLowerCase();
    return (
      lower.includes('relocation') ||
      lower.includes('visa sponsorship') ||
      lower.includes('assistance provided')
    );
  }

  private detectStartup(company: string, description: string | null): boolean {
    const lower = `${company} ${description || ''}`.toLowerCase();
    return lower.includes('startup');
  }
}
```

### Register in run.ts

```typescript
import { LinkedInJobsSource } from './sources/linkedin.source';

// In main() or runJobSearch():
const registry = new JobSourceRegistry();
registry.register(new LinkedInJobsSource());
registry.register(new WttjJobsSource()); // Still needed
// ... other sources ...

const jobs = await registry.fetchFromAll(queries, settings);
```

---

## API Reference by Platform

### LinkedIn

- **Official API**: https://docs.microsoft.com/en-us/linkedin/talent/job-search-api
- **Authentication**: OAuth 2.0 (requires partnership)
- **Limits**: 100 req/min
- **Cost**: Free for partners with approval
- **Data**: Job details, company info, salary ranges

### Indeed

- **Free API**: https://opensource.indeedapis.com/
- **Authentication**: API key
- **Limits**: 600 req/day (free tier)
- **Cost**: Free
- **Data**: Job listings, basic salary, location

### EURES (EU)

- **API**: https://ec.europa.eu/eures/api/docs
- **Authentication**: Optional (public endpoint available)
- **Limits**: Generous
- **Cost**: Free
- **Data**: EU-wide jobs, strong on subsidized roles
- **Notes**: Excellent for Europe-only search

### AngelList (Wellfound)

- **API**: Limited free tier
- **Authentication**: API key
- **Limits**: 100 req/day
- **Cost**: Free for basic, paid for high volume
- **Data**: Startup jobs specifically

### Glassdoor

- **API**: Partner API only (no free tier)
- **Authentication**: OAuth
- **Limits**: N/A
- **Cost**: Partner requirement
- **Data**: Company reviews + jobs

### GitHub Jobs (Deprecated)

- **Status**: ⚠️ Archived
- **Alternative**: Use GitHub's GraphQL API or scrape jobs.github.com

---

## Best Practices

1. **Rate Limiting**
   ```typescript
   async function rateLimitedFetch(
     url: string,
     delayMs: number = 1000,
   ): Promise<Response> {
     await new Promise((resolve) => setTimeout(resolve, delayMs));
     return fetch(url);
   }
   ```

2. **Error Handling**
   ```typescript
   try {
     const jobs = await source.fetch(queries, settings);
   } catch (error) {
     console.error(`Source ${source.name} failed:`, error);
     // Continue with other sources, don't crash
   }
   ```

3. **Deduplication**
   ```typescript
   const seen = new Set<string>();
   jobs = jobs.filter((job) => {
     if (seen.has(job.canonicalUrl)) return false;
     seen.add(job.canonicalUrl);
     return true;
   });
   ```

4. **Data Validation**
   ```typescript
   private validateJob(job: JobPosting): boolean {
     return !!(
       job.title &&
       job.company &&
       job.canonicalUrl &&
       job.countryCode
     );
   }
   ```

5. **Logging**
   ```typescript
   console.log(`[${this.name}] Fetching page ${page} for "${query}"`);
   console.log(`[${this.name}] Found ${results.length} jobs`);
   console.error(`[${this.name}] Error:`, error.message);
   ```

---

## Testing a New Source

### 1. Create Mock Data

```typescript
// src/job-search/sources/__mocks__/linkedin.mock.ts
export const mockLinkedInResponse = {
  hits: [
    {
      jobId: '123456',
      jobTitle: 'IoT Engineer',
      companyName: 'TechCorp',
      description: 'Build IoT solutions with MQTT',
      // ... full mock object
    },
  ],
};
```

### 2. Unit Test

```typescript
// src/job-search/sources/linkedin.source.spec.ts
describe('LinkedInJobsSource', () => {
  it('should map LinkedIn job to JobPosting', () => {
    const source = new LinkedInJobsSource();
    const job = source['mapLinkedInJob'](mockLinkedInResponse.hits[0]);
    
    expect(job.source).toBe('linkedin');
    expect(job.title).toBe('IoT Engineer');
  });
});
```

### 3. Integration Test

```bash
# Add API token to .env for testing
LINKEDIN_API_TOKEN=test-token npm test
```

---

## Source Priority Guide

| Priority | Use Case |
|----------|----------|
| 1 | Your primary source (highest quality matches) |
| 2 | Major platform (LinkedIn, Indeed) |
| 3 | Secondary platform (WTTJ, Glassdoor) |
| 4 | Niche platform (AngelList, EURES) |
| 5-10 | Experimental sources |

---

## Troubleshooting Sources

**Source not returning results?**
- Check API credentials in `.env`
- Verify query terms match API documentation
- Add debug logging: `console.log('Fetching from', source.name)`

**Rate limited?**
- Add exponential backoff: `delay = delay * 2`
- Implement queue system
- Use fewer queries or pages

**Data quality issues?**
- Validate each field before mapping
- Add data transformation helpers
- Test with sample responses

**Memory leaks in long-running?**
- Avoid storing large datasets in memory
- Stream results if processing large batches
- Clear processed jobs from cache

---

Good luck adding sources! 🚀
