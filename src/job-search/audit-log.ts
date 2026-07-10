// Append-only audit trail for every job status change (Applied / Dismissed / Revert) —
// so any mistake (including an accidental Revert to the wrong destination) is traceable
// after the fact. Deliberately a plain log file (not Redis/Postgres) so it keeps working
// regardless of which of those is configured in a given environment.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface StatusChangeAuditEntry {
  jobId: string;
  jobUrl: string;
  title: string;
  company: string;
  oldStatus: string;
  newStatus: string;
  timestamp: string; // ISO 8601
}

const DEFAULT_AUDIT_LOG_FILE = 'job_status_audit.log';

export async function logStatusChange(entry: StatusChangeAuditEntry): Promise<void> {
  const filePath = resolve(process.env.JOB_STATUS_AUDIT_LOG_FILE ?? DEFAULT_AUDIT_LOG_FILE);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.error('[audit-log] failed to write status-change entry:', (err as Error).message);
  }
}
