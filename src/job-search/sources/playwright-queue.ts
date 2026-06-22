// Global Playwright mutex: ensures only one Chromium instance runs at a time.
// All Playwright scrapers (cadremploi, hellowork, eurobrussels) chain onto this
// promise so browser launches are strictly sequential.
let playwrightLock: Promise<void> = Promise.resolve();

export function acquirePlaywrightLock<T>(task: () => Promise<T>): Promise<T> {
  const next = playwrightLock.then(() => task());
  // Chain a swallowed error so a failed task doesn't block the queue permanently
  playwrightLock = next.then(() => undefined, () => undefined);
  return next;
}
