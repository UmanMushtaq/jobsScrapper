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

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY job_search_profile.json ./job_search_profile.json
COPY job_search_profile.md ./job_search_profile.md
COPY .env.example ./.env.example

# Start the NestJS server (not the job scraper)
CMD ["node", "dist/main"]

