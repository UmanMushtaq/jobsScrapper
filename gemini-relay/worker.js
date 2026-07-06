// Thin, transparent passthrough relay for Gemini API calls.
//
// Purpose: bypass an outbound-IP-level block between the deploy host (Render) and
// generativelanguage.googleapis.com by routing requests through Cloudflare's network
// instead. This worker does NOT parse, validate, or transform the Gemini request or
// response in any way — it forwards the body and headers verbatim to Google and streams
// the response straight back unmodified. All Gemini logic (models, keys, retries) still
// lives entirely in the main app; this is just a different network path.
//
// Auth: requires a matching `x-relay-secret` header so this can't be discovered and used
// as an open proxy by third parties. Set the real secret via `wrangler secret put RELAY_SECRET`
// (never commit it, never put it in wrangler.toml).

const GOOGLE_GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const providedSecret = request.headers.get('x-relay-secret');
    if (!env.RELAY_SECRET || !providedSecret || providedSecret !== env.RELAY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const incomingUrl = new URL(request.url);
    const targetUrl = `${GOOGLE_GEMINI_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`;

    // Forward every header except `host` (must match the target origin, Cloudflare/undici
    // set this automatically) and `x-relay-secret` (relay-only, not meant for Google).
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('host');
    forwardedHeaders.delete('x-relay-secret');

    const upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: forwardedHeaders,
      body: request.body,
    });

    // Stream the response straight back, status/headers/body unmodified.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers,
    });
  },
};
