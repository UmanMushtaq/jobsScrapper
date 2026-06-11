#!/usr/bin/env node
// Home proxy — run this on your PC, expose via Cloudflare Tunnel.
// Node.js 18+ required (uses native fetch).
//
// Usage:
//   JOB_PROXY_SECRET=your-secret node proxy/index.js
//
// Then in a second terminal (quick tunnel):
//   cloudflared tunnel --url http://localhost:9876
//
// Or for permanent URL (named tunnel, run setup-autostart.sh first):
//   cloudflared tunnel run job-proxy
//
// Copy the tunnel URL into Render as JOB_PROXY_URL.

const http = require('http');

const SECRET = process.env.JOB_PROXY_SECRET;
const PORT = process.env.PORT ?? 9876;

if (!SECRET) {
  console.error('ERROR: JOB_PROXY_SECRET env var is required.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  if (req.headers['x-proxy-secret'] !== SECRET) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  const { url, options } = payload;

  // AbortSignal can't cross process boundaries — strip it if Render accidentally serialised it.
  const { signal: _sig, ...safeOptions } = options ?? {};

  try {
    new URL(url);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  try {
    const upstream = await fetch(url, safeOptions);
    const body = await upstream.text();

    const responseHeaders = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    };
    // Forward session/auth headers so sources can implement cookie-based auth.
    // Use x-set-cookie to avoid browser cookie-jar semantics on the receiving end.
    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) responseHeaders['x-set-cookie'] = setCookie;
    const xsrf = upstream.headers.get('x-xsrf-token') || upstream.headers.get('x-csrf-token');
    if (xsrf) responseHeaders['x-xsrf-token'] = xsrf;

    res.writeHead(upstream.status, responseHeaders);
    res.end(body);

    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${upstream.status} ${url.slice(0, 80)}`);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] 502 ERROR ${url.slice(0, 80)} — ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Job proxy listening on http://localhost:${PORT}`);
  console.log('Secret auth active. All HTTPS targets accepted.');
  console.log('Waiting for tunnel URL from cloudflared...');
});

server.on('error', (err) => {
  const ts = new Date().toLocaleTimeString();
  console.error(`[${ts}] SERVER ERROR — ${err.message}`);
  // EADDRINUSE = port 9876 already in use; exit so launchd can restart after the conflict clears
  if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('uncaughtException', (err) => {
  const ts = new Date().toLocaleTimeString();
  console.error(`[${ts}] UNCAUGHT EXCEPTION — ${err.message}`);
  console.error(err.stack);
  process.exit(1); // exit so launchd KeepAlive restarts the process
});
