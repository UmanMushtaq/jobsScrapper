// Routes a fetch call through the home proxy when JOB_PROXY_URL is set.
// Sources blocked by cloud IP (APEC, RemoteOK) use this instead of fetch().

export async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  const proxyUrl = process.env.JOB_PROXY_URL;
  const proxySecret = process.env.JOB_PROXY_SECRET;

  if (proxyUrl && proxySecret) {
    return fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': proxySecret,
      },
      body: JSON.stringify({ url, options }),
    });
  }

  // No proxy configured — call directly (will 403 from Render for blocked sources)
  return fetch(url, options);
}
