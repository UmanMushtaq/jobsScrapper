# Job Search Profile — Uman Mushtaq (English-only, Europe)

Use this file as the single source of truth for my job-search constraints and matching rules.

## Candidate snapshot (from resume)
- **Name**: Uman Mushtaq
- **Location**: Paris, Île-de-France, France
- **Role**: Software Engineer (backend)
- **Core stack**: Node.js, TypeScript, JavaScript, NestJS, Express.js, PostgreSQL, MongoDB, Sequelize, Mongoose, Docker, AWS
- **Architecture focus**: REST APIs, microservices, serverless, CI/CD, data retrieval optimization, third‑party API integrations
- **Experience**:
  - Software Engineer, OptimusFox — Oct 2021 to Jul 2024
  - Node.js Developer, Teams.pk — Jun 2020 to Sep 2021

## What to search for (targets)
- **Titles**: Backend Engineer, Node.js Developer, Node.js Backend Engineer, TypeScript Backend Engineer, NestJS Developer, API Engineer
- **Keywords**: Node.js, TypeScript, NestJS, Express, REST APIs, PostgreSQL, microservices, Docker, AWS

## Source priority
- Search startup-focused platforms first:
  - `wellfound.com`
  - `startup.jobs`
  - `welcometothejungle.com`
- Then search company career pages and other job boards across the internet.
- Prefer direct company application links when available.

## Location / work model constraints
- **Language**: English-only roles (job posting must be in English and/or explicitly say English is the working language).
- **Geography**:
  - Prefer **European remote** roles.
  - Also include roles in **France** (on-site, hybrid, or remote).
  - Include other **European countries** if they support **relocation** (visa support/relocation package).
- **Do NOT include jobs located in**: Romania, Bulgaria, Lithuania, Cyprus, Latvia, Croatia.

## Seniority / experience constraints
- Match roles that fit my background (roughly **3–5 years** backend experience in Node.js/TypeScript).
- Exclude:
  - Internships, apprenticeships, student roles
  - Senior/Staff/Lead/Principal roles
  - Roles explicitly requiring **6+ years** experience

## Compensation constraints
- Minimum salary must be **more than €3000/month** (or an equivalent clearly above that threshold).
- If salary is not listed, include **only** if it looks market-aligned for France/EU mid-level backend and the stack strongly matches; mark as **“salary not listed”**.

## Matching rule (strict)
- Only return jobs where my resume matches **≥ 90%** of the job description.
- Operationalize this as:
  - **Must-have match**: Node.js + (TypeScript or strong JS) + backend API work.
  - **Strong preference**: NestJS/Express + PostgreSQL + Docker + AWS/microservices.
  - If the job is heavy on a different primary stack (e.g., Java/Spring, .NET, PHP, Ruby) then reject unless the posting explicitly accepts Node.js as primary.

## Output requirements (every run)
- Return a **deduped** list of the best matches (max 15), newest first.
- For each job include: role, company, country/city, remote/hybrid/on-site, experience required, salary (or “not listed”), posted date, application link, and a brief “why it matches” note.
- Never repeat jobs already recorded in:
  - `job_search_seen.json` (`seen_urls`)
  - `job_search_applied.json` (`applied_urls`)

## Applying (safety/consent)
- Do **not** submit applications automatically.
- If an “Easy Apply” flow exists, provide the link and generate a tailored cover letter + short answers draft in the output so I can approve and submit quickly.
