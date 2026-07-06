# Gemini relay (Cloudflare Worker)

A thin, transparent passthrough proxy for Gemini API calls. It exists to route around an
outbound-IP-level block between the deploy host (Render) and
`generativelanguage.googleapis.com`, by sending requests through Cloudflare's network
instead. It does not parse, validate, or transform the Gemini request/response in any way.

This is **entirely separate infrastructure** from the main NestJS app — it runs on
Cloudflare Workers, not Render, has no shared dependencies with the rest of the repo, and
is **optional**: the app works exactly as before if this is never deployed (see
`GEMINI_RELAY_URL` in the main README).

## Setup

1. **Install the Wrangler CLI** (Cloudflare's Workers deployment tool):
   ```
   npm install -g wrangler
   ```

2. **Log in to your Cloudflare account** (free tier is sufficient — Workers free tier
   covers 100,000 requests/day, far more than this bot needs):
   ```
   wrangler login
   ```
   This opens a browser to authorize the CLI. You need a free Cloudflare account if you
   don't already have one — sign up at https://dash.cloudflare.com/sign-up.

3. **Deploy the worker** (run from inside this `gemini-relay/` folder):
   ```
   cd gemini-relay
   wrangler deploy
   ```

4. **Set the shared secret** — this protects the relay from being discovered and used as
   an open proxy by anyone who finds the URL. Pick a long random value yourself (e.g.
   `openssl rand -hex 32`), then:
   ```
   wrangler secret put RELAY_SECRET
   ```
   Paste the value when prompted. Never commit this value anywhere.

5. **Copy the deployed URL.** After `wrangler deploy` succeeds, Cloudflare prints a URL
   like:
   ```
   https://jobsscrapper-gemini-relay.<your-subdomain>.workers.dev
   ```

6. **Set two new environment variables on Render** (in the Render dashboard, under your
   service's Environment tab):
   - `GEMINI_RELAY_URL` = the URL from step 5
   - `GEMINI_RELAY_SECRET` = the same value you set in step 4

   Then redeploy the Render service so it picks up the new env vars. With
   `GEMINI_RELAY_URL` unset (the default), the app calls Google directly exactly as
   before — this is fully opt-in and reversible; unset the env var to go back to direct
   calls at any time.

## How it works

The main app's Gemini client is configured with `httpOptions.baseUrl` pointed at
`GEMINI_RELAY_URL` when that env var is set. The Gemini SDK still constructs the same
request path (`/v1beta/models/{model}:generateContent`) and still attaches the real
`x-goog-api-key` header itself — only the origin changes, from
`generativelanguage.googleapis.com` to this worker's URL. The worker checks the
`x-relay-secret` header, then forwards everything else (method, headers, body) verbatim
to the real Google endpoint and streams the response straight back, unmodified.
