import { chromium } from 'playwright';

const QUERIES = [
  'nodejs', 'node.js', 'node js', 'NodeJS', 'Node.js',
  'nestjs', 'nest.js', 'NestJS', 'backend typescript', 'backend node',
];

const KEYWORDS = ['api', 'search', 'job', 'vacancy', 'result', 'offer', 'listing', 'graphql', 'rest', 'xhr', 'stelle', 'stellen'];

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const query of QUERIES) {
    const url = `https://www.stepstone.de/jobs/${encodeURIComponent(query)}`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`QUERY: ${query} | URL: ${url}`);
    console.log('='.repeat(60));

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    page.on('request', (req) => {
      const method = req.method();
      if (method === 'POST') {
        const body = req.postData();
        if (body) console.log(`POST BODY | ${req.url()}\n  ${body.slice(0, 300)}`);
      }
    });

    page.on('response', async (response) => {
      const resUrl = response.url();
      const lower = resUrl.toLowerCase();
      if (!KEYWORDS.some((kw) => lower.includes(kw))) return;
      if (resUrl.includes('.css') || resUrl.includes('.js') || resUrl.includes('.png') || resUrl.includes('.svg')) return;

      const status = response.status();
      const method = response.request().method();
      let body = '';
      try {
        const buf = await response.body();
        body = buf.toString('utf8').slice(0, 300);
      } catch {
        body = '(could not read body)';
      }

      console.log(`\n${status} | ${method} | ${resUrl}`);
      console.log(body);
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 8_000));
    } catch (err) {
      console.log(`ERROR navigating: ${(err as Error).message}`);
    }

    await context.close();
    await new Promise((r) => setTimeout(r, 3_000));
  }

  await browser.close();
  console.log('\n[discover-stepstone-de] done');
})();
