FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install chromium --with-deps

COPY --from=build /app/dist ./dist
COPY job_search_profile.json ./job_search_profile.json
COPY job_search_profile.md ./job_search_profile.md
COPY .env.example ./.env.example

# Start the NestJS server (not the job scraper)
CMD ["node", "dist/main"]

