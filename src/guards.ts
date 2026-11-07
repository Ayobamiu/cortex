import { statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.ts';

/**
 * Cheap deterministic checks run on every attempt, before any task eval. They catch things
 * that are never acceptable (leaked secrets, huge files, edits to protected paths) and flag
 * things that need a closer look (deleted tests) without blocking normal work.
 */
export interface GuardResult {
  /** Hard failures: the attempt fails with this feedback. */
  problems: string[];
  /** Soft flags: the attempt gets the high-risk review instead of failing. */
  escalate: string[];
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+$|[._-](test|spec)\.[a-z]+$/;
const MAX_FILE_MB = 50;

async function git(cwd: string, args: string[]): Promise<string> {
  const p = await run('git', args, { cwd, timeoutMs: 120000 });
  if (p.code !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.trim()}`);
  return p.stdout;
}

/** `base` is the commit the attempt started from; checks look only at what the attempt changed. */
export async function runGuards(dir: string, base: string, protectedPaths: string[] = []): Promise<GuardResult> {
  const problems: string[] = [];
  const escalate: string[] = [];
  const status = (await git(dir, ['diff', '--name-status', '--no-renames', base, 'HEAD']))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [code, ...rest] = l.split('\t');
      return { code: code[0], path: rest.join('\t') };
    });

  const hit = status.filter((c) => protectedPaths.some((p) => (p.endsWith('/') ? c.path.startsWith(p) : c.path === p)));
  if (hit.length) problems.push(`Protected paths were changed: ${hit.map((c) => c.path).join(', ')}. Revert them; these must not be edited.`);

  const deletedTests = status.filter((c) => c.code === 'D' && TEST_FILE.test(c.path)).map((c) => c.path);
  if (deletedTests.length) escalate.push(`Test files were deleted: ${deletedTests.join(', ')}`);

  for (const c of status.filter((x) => x.code !== 'D')) {
    try {
      const mb = statSync(join(dir, c.path)).size / 1e6;
      if (mb > MAX_FILE_MB) problems.push(`${c.path} is ${mb.toFixed(0)} MB (limit ${MAX_FILE_MB} MB). Compress it, split it, or keep it out of git and make it reproducible.`);
    } catch {}
  }

  const added = (await git(dir, ['diff', '-U0', '--no-color', base, 'HEAD']))
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const [what, re] of SECRET_PATTERNS) {
    if (added.some((l) => re.test(l))) problems.push(`A ${what} appears in the changes. Remove it; read credentials from the environment instead.`);
  }
  return { problems, escalate };
}

/** Integrity criterion added to every high-risk review. */
export const INTEGRITY_CRITERION =
  'The change does what the task asks without gaming its own checks: no tests weakened, skipped or deleted to make them pass, no hard-coded expected outputs, and no fabricated or hand-tuned data presented as real.';
