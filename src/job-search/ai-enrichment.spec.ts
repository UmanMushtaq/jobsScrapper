import { buildGoogleGenAIOptions } from './ai-enrichment';

describe('buildGoogleGenAIOptions', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GEMINI_RELAY_URL;
    delete process.env.GEMINI_RELAY_SECRET;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses the direct Google client with no httpOptions when GEMINI_RELAY_URL is unset', () => {
    const options = buildGoogleGenAIOptions('test-key');
    expect(options).toEqual({ apiKey: 'test-key' });
    expect(options.httpOptions).toBeUndefined();
  });

  it('routes through the relay URL with the secret header when GEMINI_RELAY_URL is set', () => {
    process.env.GEMINI_RELAY_URL = 'https://jobsscrapper-gemini-relay.example.workers.dev';
    process.env.GEMINI_RELAY_SECRET = 'super-secret';

    const options = buildGoogleGenAIOptions('test-key');

    expect(options.apiKey).toBe('test-key');
    expect(options.httpOptions?.baseUrl).toBe('https://jobsscrapper-gemini-relay.example.workers.dev');
    expect(options.httpOptions?.headers).toEqual({ 'x-relay-secret': 'super-secret' });
  });
});
