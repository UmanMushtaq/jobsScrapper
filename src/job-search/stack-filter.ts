export interface FrontendStackResult {
  reject: boolean;
  reason: string;
}

export interface RoleTypeResult {
  reject: boolean;
  reason: string;
}

const ANGULAR_TERMS = ['angularjs', 'angular', 'ngrx', 'rxjs'];
const VUE_TERMS = ['vuejs', 'vue.js', 'nuxt', 'vue'];
const NODE_TERMS = ['node.js', 'nodejs', 'node js', 'nestjs', 'nest.js', 'express'];

// Explicit primary-requirement phrasing near the frontend framework — these reject
// regardless of term counts, since the posting is describing Angular/Vue as the
// core skill being hired for rather than a passing mention.
const EXPLICIT_PRIMARY_PATTERNS: RegExp[] = [
  /excellente ma[iî]trise d.angular/i,
  /angular\s*\(confirm[eé]\)/i,
  /strong (?:experience|expertise) (?:with|in) angular/i,
  /solid experience with angular/i,
  /ma[iî]trise d.angular/i,
  /excellente ma[iî]trise d.vue/i,
  /vue\s*\(confirm[eé]\)/i,
  /strong (?:experience|expertise) (?:with|in) vue/i,
  /solid experience with vue/i,
  /ma[iî]trise d.vue/i,
];

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(text: string, terms: string[]): number {
  return terms.reduce((sum, term) => {
    const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    const matches = text.match(pattern);
    return sum + (matches ? matches.length : 0);
  }, 0);
}

/**
 * Deterministic rejection of roles where Angular or Vue is the primary framework
 * and Node.js is only a passing mention — the pattern that soft AI scoring
 * (-20 points) was letting through in practice.
 */
export function isFrontendPrimaryStack(title: string, description: string): FrontendStackResult {
  const titleLower = (title ?? '').toLowerCase();
  const fullText = `${titleLower} ${(description ?? '').toLowerCase()}`;

  if (EXPLICIT_PRIMARY_PATTERNS.some((p) => p.test(fullText))) {
    return { reject: true, reason: 'explicit primary-framework phrasing for Angular/Vue in description' };
  }

  const angularCount = countOccurrences(fullText, ANGULAR_TERMS);
  const vueCount = countOccurrences(fullText, VUE_TERMS);
  const frontendCount = angularCount + vueCount;
  const nodeCount = countOccurrences(fullText, NODE_TERMS);

  // Co-primary escape hatch: Node/NestJS clearly leads the title and appears
  // repeatedly — genuine fullstack roles are the owner's judgment call, not this filter's.
  const titleHasNode = /\b(?:node\.?js|nest\.?js)\b/i.test(titleLower);
  if (titleHasNode && nodeCount >= 3) {
    return { reject: false, reason: '' };
  }

  const titleHasAngular = /\bangular\b/i.test(titleLower);
  const titleHasVue = /\bvue\b|\bnuxt\b/i.test(titleLower);

  // Rule (a): title leads with Angular/Vue and Node is barely mentioned in the full text.
  if ((titleHasAngular || titleHasVue) && nodeCount <= 2) {
    return {
      reject: true,
      reason: `title leads with ${titleHasAngular ? 'Angular' : 'Vue'}, Node mentioned only ${nodeCount}x`,
    };
  }

  // Rule (b): frontend framework dominates the description, Node is a passing mention.
  if (frontendCount >= 3 && nodeCount <= 1) {
    return {
      reject: true,
      reason: `Angular/Vue mentioned ${frontendCount}x vs Node ${nodeCount}x — frontend-dominant`,
    };
  }

  return { reject: false, reason: '' };
}

// GTM/growth/marketing-engineering role-type mismatch. Backend engineering is the
// target profile; growth/attribution/MarTech hybrid roles are not, even when Node.js
// appears somewhere in the stack (these roles integrate marketing tools, not build
// backend services). Title match is a direct hard reject; the description-dominance
// check is deliberately conservative — a genuine backend role that merely lists one
// marketing-tool integration (e.g. "HubSpot") must still pass.
const MARKETING_TITLE_PATTERNS: RegExp[] = [
  /\bgtm\b/i,
  /martech/i,
  /growth engineer/i,
  /marketing engineer/i,
  /attribution/i,
];

const MARKETING_TOOLING_PATTERNS: RegExp[] = [
  /google tag manager|\bgtm\b/i,
  /meta capi|meta pixel/i,
  /hubspot/i,
  /attribution/i,
  /\broas\b/i,
  /funnels?/i,
  /ad platforms?/i,
  /zapier|n8n/i,
];

const BACKEND_CORE_PATTERNS: RegExp[] = [
  /node\.?js/i,
  /nestjs|nest\.js/i,
  /typescript backend/i,
  /microservices?/i,
  /api design/i,
];

export function isMarketingEngineeringRole(title: string, description: string): RoleTypeResult {
  const titleText = title ?? '';
  const titleMatch = MARKETING_TITLE_PATTERNS.find((p) => p.test(titleText));
  if (titleMatch) {
    return {
      reject: true,
      reason: `title matches growth/MarTech-engineering pattern (${titleMatch})`,
    };
  }

  const fullText = `${titleText} ${description ?? ''}`;
  const marketingHits = MARKETING_TOOLING_PATTERNS.filter((p) => p.test(fullText)).length;
  const backendHits = BACKEND_CORE_PATTERNS.filter((p) => p.test(fullText)).length;

  if (marketingHits >= 3 && backendHits <= 1) {
    return {
      reject: true,
      reason: `marketing-tooling keywords dominate (${marketingHits} distinct hits) with minimal backend core (${backendHits})`,
    };
  }

  return { reject: false, reason: '' };
}
