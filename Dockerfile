FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN ls -la dist/ && echo "BUILD SUCCESS"

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# System dependencies required by Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxtst6 \
  wget xdg-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Download Playwright's bundled Chromium browser
RUN npx playwright install chromium

COPY --from=build /app/dist ./dist
COPY job_search_profile.json ./job_search_profile.json
COPY job_search_profile.md ./job_search_profile.md
COPY .env.example ./.env.example

# Start the NestJS server (not the job scraper)
CMD ["node", "dist/main"]
