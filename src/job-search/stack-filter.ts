export interface FrontendStackResult {
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
