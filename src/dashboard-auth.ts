// Password gate for the dashboard's status-changing actions (Applied / Dismissed /
// Revert). Separate from ADMIN_PASSWORD (the /admin permit-settings login) — different
// concern, different env var, on purpose.
//
// Never assign a literal string here — this only ever reads
// process.env.DASHBOARD_STATUS_PASSWORD, which Uman sets manually in Render's
// environment variables after deploy.
import { timingSafeEqual } from 'node:crypto';

export function isDashboardStatusPasswordConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_STATUS_PASSWORD);
}

// Constant-time comparison — a naive `===`/string compare leaks how many leading
// characters matched via response-time variance. Node's crypto.timingSafeEqual requires
// equal-length buffers, so a length mismatch is handled by still performing a same-cost
// dummy comparison before returning false, rather than short-circuiting immediately.
export function verifyDashboardStatusPassword(candidate: string | undefined | null): boolean {
  const expected = process.env.DASHBOARD_STATUS_PASSWORD;
  if (!expected) return false; // fail closed when not configured

  const candidateBuf = Buffer.from(candidate ?? '', 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (candidateBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(candidateBuf, expectedBuf);
}
