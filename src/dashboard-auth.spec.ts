import { verifyDashboardStatusPassword, isDashboardStatusPasswordConfigured } from './dashboard-auth';

describe('verifyDashboardStatusPassword', () => {
  const ORIGINAL_ENV = process.env.DASHBOARD_STATUS_PASSWORD;

  afterEach(() => {
    process.env.DASHBOARD_STATUS_PASSWORD = ORIGINAL_ENV;
  });

  it('accepts the correct password', () => {
    process.env.DASHBOARD_STATUS_PASSWORD = 'super-secret-123';
    expect(verifyDashboardStatusPassword('super-secret-123')).toBe(true);
  });

  it('rejects a wrong password of the same length', () => {
    process.env.DASHBOARD_STATUS_PASSWORD = 'super-secret-123';
    expect(verifyDashboardStatusPassword('super-secret-124')).toBe(false);
  });

  it('rejects a wrong password of a different length', () => {
    process.env.DASHBOARD_STATUS_PASSWORD = 'super-secret-123';
    expect(verifyDashboardStatusPassword('short')).toBe(false);
  });

  it('rejects an empty/missing candidate', () => {
    process.env.DASHBOARD_STATUS_PASSWORD = 'super-secret-123';
    expect(verifyDashboardStatusPassword(undefined)).toBe(false);
    expect(verifyDashboardStatusPassword(null)).toBe(false);
    expect(verifyDashboardStatusPassword('')).toBe(false);
  });

  it('fails closed when DASHBOARD_STATUS_PASSWORD is not configured', () => {
    delete process.env.DASHBOARD_STATUS_PASSWORD;
    expect(verifyDashboardStatusPassword('anything')).toBe(false);
    expect(verifyDashboardStatusPassword('')).toBe(false);
  });
});

describe('isDashboardStatusPasswordConfigured', () => {
  const ORIGINAL_ENV = process.env.DASHBOARD_STATUS_PASSWORD;

  afterEach(() => {
    process.env.DASHBOARD_STATUS_PASSWORD = ORIGINAL_ENV;
  });

  it('is true when the env var is set', () => {
    process.env.DASHBOARD_STATUS_PASSWORD = 'x';
    expect(isDashboardStatusPasswordConfigured()).toBe(true);
  });

  it('is false when the env var is unset', () => {
    delete process.env.DASHBOARD_STATUS_PASSWORD;
    expect(isDashboardStatusPasswordConfigured()).toBe(false);
  });
});
