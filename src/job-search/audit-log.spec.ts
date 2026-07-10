import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logStatusChange } from './audit-log';

describe('logStatusChange', () => {
  const testFile = resolve('test-audit-log.tmp.log');
  const ORIGINAL_ENV = process.env.JOB_STATUS_AUDIT_LOG_FILE;

  beforeEach(() => {
    process.env.JOB_STATUS_AUDIT_LOG_FILE = testFile;
  });

  afterEach(async () => {
    process.env.JOB_STATUS_AUDIT_LOG_FILE = ORIGINAL_ENV;
    await rm(testFile, { force: true });
  });

  it('appends a JSON line with all fields for each status change', async () => {
    await logStatusChange({
      jobId: 'abc123',
      jobUrl: 'https://example.com/job',
      title: 'Backend Engineer',
      company: 'Acme',
      oldStatus: 'open',
      newStatus: 'applied',
      timestamp: '2026-07-10T12:00:00.000Z',
    });

    const content = await readFile(testFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual({
      jobId: 'abc123',
      jobUrl: 'https://example.com/job',
      title: 'Backend Engineer',
      company: 'Acme',
      oldStatus: 'open',
      newStatus: 'applied',
      timestamp: '2026-07-10T12:00:00.000Z',
    });
  });

  it('appends multiple entries across calls without overwriting', async () => {
    await logStatusChange({
      jobId: '1', jobUrl: 'u1', title: 't1', company: 'c1',
      oldStatus: 'open', newStatus: 'applied', timestamp: '2026-07-10T12:00:00.000Z',
    });
    await logStatusChange({
      jobId: '2', jobUrl: 'u2', title: 't2', company: 'c2',
      oldStatus: 'applied', newStatus: 'open', timestamp: '2026-07-10T12:05:00.000Z',
    });

    const content = await readFile(testFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).jobId).toBe('1');
    expect(JSON.parse(lines[1]).jobId).toBe('2');
  });
});
