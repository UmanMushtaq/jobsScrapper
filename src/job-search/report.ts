import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MatchResult } from './types';

export async function writeReport(
  reportPath: string,
  matches: MatchResult[],
  blockedSources: string[],
): Promise<string> {
  const absolutePath = resolve(reportPath);
  const lines: string[] = [];

  lines.push('# Job search report');
  lines.push('');
  lines.push(
    '| Role | Company | Location | Mode | Exp | Salary | Score | Apply |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const match of matches) {
    lines.push(
      `| ${escapePipes(match.job.title)} | ${escapePipes(match.job.company)} | ${escapePipes(match.job.locationLabel)} | ${match.job.workMode} | ${match.job.experienceLevelMinimum ?? 'n/a'} | ${escapePipes(match.salaryLabel)} | ${match.score}% | [Apply](${match.job.applyUrl}) |`,
    );
  }

  lines.push('');
  if (blockedSources.length > 0) {
    lines.push('## Source notes');
    lines.push('');
    lines.push(
      `Priority startup boards that are still blocked from unattended scraping in this version: ${blockedSources.join(', ')}.`,
    );
    lines.push('');
  }

  for (const match of matches.slice(0, 5)) {
    lines.push(`## ${match.job.title} — ${match.job.company}`);
    lines.push('');
    lines.push(`- Link: ${match.job.applyUrl}`);
    lines.push(`- Match score: ${match.score}%`);
    lines.push(`- Why it fits: ${match.reasons.join('; ')}`);
    lines.push(`- Salary: ${match.salaryLabel}`);
    lines.push('');
    lines.push('### Draft cover letter');
    lines.push('');
    lines.push('```text');
    lines.push(match.coverLetter);
    lines.push('```');
    lines.push('');
    lines.push('### Short answers');
    lines.push('');
    for (const answer of match.shortAnswers) {
      lines.push(`- ${answer}`);
    }
    lines.push('');
  }

  await writeFile(absolutePath, `${lines.join('\n')}\n`, 'utf-8');
  return absolutePath;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}

