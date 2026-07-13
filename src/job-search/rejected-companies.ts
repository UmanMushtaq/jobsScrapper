// Explicit, permanent auto-skip list for companies that have confirmed-rejected Uman.
// Distinct from the dismissed-company threshold in run.ts (2+ dismissals auto-skips
// future postings) — these trigger on the FIRST match because they are confirmed
// rejections, not inferred from repeated dismissals.
//
// Append one name per line, lowercase, with a short comment noting the rejection date.
// Suffix stripping (GmbH/SAS/B.V./etc.) and word-boundary matching happen in
// isRejectedCompany() below — list entries should just be the bare company name.
export const REJECTED_COMPANIES: string[] = [
  'dashlane', // rejected — July 8 2026 manual review
  'redcare pharmacy', // rejected — July 8 2026 manual review
  'strv', // rejected — July 8 2026 manual review
  'swan', // rejected — July 8 2026 manual review
  'team.blue', // rejected — July 8 2026 manual review
  'papaya', // rejected — July 8 2026 manual review
  'tricentis', // rejected — July 8 2026 manual review
  'sweep', // rejected — July 8 2026 manual review
  'atolls', // rejected — July 8 2026 manual review
  'securepoint', // rejected — July 8 2026 manual review
  'swile', // rejected — July 8 2026 manual review
  'devoteam', // rejected — July 8 2026 manual review
  'oskey', // rejected — July 8 2026 manual review
  'modjo', // rejected — July 8 2026 manual review
  'sii', // rejected — July 8 2026 manual review
  'creative clicks', // rejected — July 8 2026 manual review
  'winamax', // rejected — July 8 2026 manual review
  'theodo', // permanent blocklist — grandes ecoles filter, July 13 2026
  'transparent hiring', // permanent blocklist — paid service, not a real employer, July 13 2026
];

// Trailing corporate suffixes stripped before matching, so "Swile SAS" / "STRV s.r.o."
// still resolve to their bare blocklist form. Matching itself is word-boundary substring
// search (see isRejectedCompany), not exact equality, so this is a defensive extra pass
// rather than a strict requirement for most entries. Does NOT blanket-strip internal
// periods from the company name — some blocklist entries (e.g. "team.blue") legitimately
// contain a period as part of the brand name, so only a single TRAILING period (e.g.
// "Acme Corp.") and whole trailing suffix words are removed.
const CORPORATE_SUFFIXES = [
  'gmbh', 'mbh', 'ug', 'sas', 'sa', 's.a.', 'sarl', 's.a.r.l.', 'bv', 'b.v.', 'nv', 'n.v.',
  'ltd', 'llc', 'inc', 'plc', 'ag', 'kg', 'oy', 'ab', 'as',
  'spa', 's.p.a.', 'srl', 's.r.l.', 'sro', 's.r.o.', 'oyj', 'kft',
];

// Exported so other cross-source matching (e.g. run.ts's cross-source dedup key) uses the
// exact same normalization — German company names in particular vary wildly in how the
// legal suffix is written across sources ("Acme GmbH" from Bundesagentur vs "Acme" from
// StepStone vs "ACME GmbH & Co. KG" from Adzuna) and would otherwise dedupe inconsistently.
export function normalizeCompanyName(raw: string): string {
  let name = (raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  name = name.replace(/\.$/, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CORPORATE_SUFFIXES) {
      if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1)).replace(/\.$/, '').trim();
        changed = true;
      }
    }
    // Common German compound legal form ("GmbH & Co. KG" — the "KG" is stripped by the
    // suffix loop above, leaving "... & co" behind) — strip that joiner too so the next
    // pass can reach "GmbH".
    if (/\s&\s?co$/.test(name)) {
      name = name.replace(/\s&\s?co$/, '').trim();
      changed = true;
    }
  }
  return name;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary substring match — "SII Toulouse" and "Groupe SII" both match the "sii"
// blocklist entry, but a company merely containing the blocklist token as part of a
// longer word does not (matching requires the token to stand as its own word/phrase).
const REJECTED_PATTERNS = REJECTED_COMPANIES.map(
  (name) => new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
);

export function isRejectedCompany(companyName: string): boolean {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return false;
  return REJECTED_PATTERNS.some((p) => p.test(normalized));
}
