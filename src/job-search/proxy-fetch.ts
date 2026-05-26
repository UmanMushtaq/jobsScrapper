// Routes a fetch call through the home proxy when JOB_PROXY_URL is set.
// Sources blocked by cloud IP (APEC, RemoteOK) use this instead of fetch().

export async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  const proxyUrl = process.env.JOB_PROXY_URL;
  const proxySecret = process.env.JOB_PROXY_SECRET;

  if (proxyUrl && proxySecret) {
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    let res: Response;
    try {
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Secret': proxySecret,
        },
        body: JSON.stringify({ url, options }),
      });
    } catch (err) {
      // Network failure — proxy tunnel is offline or DNS not resolving
      console.error(`[proxy] OFFLINE — cannot reach ${proxyUrl} for ${host}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[proxy] Check on Mac: launchctl list | grep jobscrapper  (both proxy + cloudflared must be running)');
      return new Response(null, { status: 503 });
    }

    // Proxy tunnel itself returned an error (502/523 = cloudflared down, 503 = node server down)
    if (res.status === 502 || res.status === 503 || res.status === 523) {
      console.error(`[proxy] TUNNEL DOWN — ${proxyUrl} returned ${res.status} for ${host}`);
      console.error('[proxy] Check on Mac: tail -f /tmp/jobscrapper-proxy.log and tail -f /tmp/jobscrapper-cloudflared.log');
    }

    return res;
  }

  // No proxy configured — call directly (will 403 from Render for cloud-blocked sources)
  return fetch(url, options);
}
