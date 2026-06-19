import { chromium } from 'playwright';

const KEYWORDS = ['webservices', 'api', 'offre', 'search', 'recherche', 'result'];
const TARGET = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=nodejs';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('rechercheOffre') && request.method() === 'POST') {
      console.log('REQUEST BODY:', request.postData());
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const lower = url.toLowerCase();
    if (!KEYWORDS.some((kw) => lower.includes(kw))) return;

    const status = response.status();
    const method = response.request().method();
    let body = '';
    try {
      const buf = await response.body();
      body = buf.toString('utf8').slice(0, 300);
    } catch {
      body = '(could not read body)';
    }

    console.log(`\n${status} | ${method} | ${url}`);
    console.log(body);
  });

  console.log(`[apec-discover] navigating to ${TARGET}`);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  console.log('[apec-discover] waiting 10s...');
  await new Promise((r) => setTimeout(r, 10_000));

  await browser.close();
  console.log('[apec-discover] done');
})();
