import { mapAjaxJob, AjaxJob } from './jobbird.source';

function buildRaw(overrides: Partial<AjaxJob> = {}): AjaxJob {
  return {
    id: 25360359,
    title: 'Backend Developer',
    description: 'We use Node.js and TypeScript.',
    dateRefreshed: new Date().toISOString(),
    company: 'Acme Corp',
    location: 'Amsterdam',
    ...overrides,
  };
}

describe('jobbird mapAjaxJob — URL construction', () => {
  it('joins a bare "{id}-slug" url (no leading slash) under /nl/vacature/', () => {
    const job = mapAjaxJob(buildRaw({ url: '25360359-backend-developer' }), '25360359');
    expect(job).not.toBeNull();
    expect(job?.canonicalUrl).toContain('jobbird.com/');
    expect(job?.canonicalUrl).not.toMatch(/jobbird\.com\d/);
    expect(job?.canonicalUrl).toBe('https://www.jobbird.com/nl/vacature/25360359-backend-developer');
  });

  it('handles a root-relative url', () => {
    const job = mapAjaxJob(buildRaw({ url: '/nl/vacature/25360359-backend-developer' }), '25360359');
    expect(job?.canonicalUrl).toBe('https://www.jobbird.com/nl/vacature/25360359-backend-developer');
  });

  it('handles an absolute url unchanged', () => {
    const job = mapAjaxJob(buildRaw({ url: 'https://www.jobbird.com/nl/vacature/25360359-backend-developer' }), '25360359');
    expect(job?.canonicalUrl).toBe('https://www.jobbird.com/nl/vacature/25360359-backend-developer');
  });

  it('falls back to the id when the url field is missing', () => {
    const job = mapAjaxJob(buildRaw({ url: undefined }), '25360359');
    expect(job?.canonicalUrl).toBe('https://www.jobbird.com/nl/vacature/25360359');
    expect(job?.canonicalUrl).toContain('jobbird.com/');
  });
});
