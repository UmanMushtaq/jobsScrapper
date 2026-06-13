export function buildScraperUrl(url: string): string {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return url;
  return `https://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&country_code=fr&render=false`;
}
