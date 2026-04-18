FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY job_search_profile.json ./job_search_profile.json
COPY job_search_profile.md ./job_search_profile.md
COPY job_search_seen.json ./job_search_seen.json
COPY job_search_applied.json ./job_search_applied.json
COPY .env.example ./.env.example

CMD ["node", "dist/job-search/run.js"]

