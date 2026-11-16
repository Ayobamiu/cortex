import { existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Store } from './db.ts';
import { run } from './proc.ts';

/**
 * `cortex cleanup`: removes what attempts leave behind, never your work.
 * - Attempt branches (cortex/<goal>/t/<task>-<n>): a finished task (passed or cancelled) needs
 *   none, since passing work is already merged; an unfinished task keeps its latest attempt,
 *   which the next attempt continues from.
 * - Attempt worktrees (<state>/wt/...) whose branch goes, and stray folders there.
 * - The integration worktree once the goal is done and no run is live (its branch stays; a
 *   later run recreates the folder).
 * Never touched: the integration branch cortex/<goal>/main, your own branches, tags, logs.
 */

export interface CleanupPlan {
  branches: string[];
  worktrees: string[];
  strays: string[];
  integration?: string;
  kept: string[];
}

const ATTEMPT = /^(.*)-(\d+)$/;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function planCleanup(store: Store, goalId: string, projectDir: string, stateDir: string, runLive: boolean): Promise<CleanupPlan> {
  const prefix = `cortex/${goalId}/t/`;
  const refs = (await git(projectDir, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`)).split('\n').filter(Boolean);
  const tasks = new Map(store.tasks(goalId).map((t) => [t.id, t]));
  const latest = new Map<string, number>();
  for (const ref of refs) {
    const m = ATTEMPT.exec(ref.slice(prefix.length));
    if (m) latest.set(m[1], Math.max(latest.get(m[1]) ?? 0, Number(m[2])));
  }
  const branches: string[] = [];
  const kept: string[] = [];
  for (const ref of refs) {
    const m = ATTEMPT.exec(ref.slice(prefix.length));
    if (!m) {
      kept.push(ref);
      continue;
    }
    const t = tasks.get(m[1]);
    const finished = !t || t.status === 'passed' || t.status === 'cancelled';
    if (t?.status === 'running' || (!finished && Number(m[2]) === latest.get(m[1]))) kept.push(ref);
    else branches.push(ref);
  }

  // Worktrees git knows about, by branch.
  const wtRoot = join(real(stateDir), 'wt');
  const listed = (await git(projectDir, 'worktree', 'list', '--porcelain')).split('\n\n').flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    return path ? [{ path: real(path), branch }] : [];
  });
  // A branch checked out outside cortex's folders (e.g. in your own checkout) stays.
  for (const w of listed) {
    if (w.branch && !w.path.startsWith(wtRoot + sep) && branches.includes(w.branch)) {
      branches.splice(branches.indexOf(w.branch), 1);
      kept.push(w.branch);
    }
  }
  const going = new Set(branches);
  const worktrees = listed.filter((w) => w.path.startsWith(wtRoot + sep) && (!w.branch || going.has(w.branch))).map((w) => w.path);
  const known = new Set(listed.map((w) => w.path));
  const keptDirs = new Set(listed.filter((w) => w.branch && kept.includes(w.branch)).map((w) => w.path));
  const strays = existsSync(wtRoot) ? readdirSync(wtRoot).map((d) => join(wtRoot, d)).filter((d) => !known.has(d) && !keptDirs.has(d)) : [];

  const goal = store.goal(goalId);
  const integration = join(real(stateDir), 'integration');
  return { branches, worktrees, strays, kept, integration: goal?.status === 'done' && !runLive && existsSync(integration) ? integration : undefined };
}

export async function applyCleanup(projectDir: string, stateDir: string, plan: CleanupPlan): Promise<void> {
  const inside = (p: string) => real(p).startsWith(real(stateDir) + sep);
  for (const dir of [...plan.worktrees, ...(plan.integration ? [plan.integration] : [])]) {
    if (!inside(dir)) throw new Error(`refusing to remove ${dir}: outside ${stateDir}`);
    await run('git', ['worktree', 'remove', '--force', dir], { cwd: projectDir });
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of plan.strays) {
    if (!inside(dir)) throw new Error(`refusing to remove ${dir}: outside ${stateDir}`);
    rmSync(dir, { recursive: true, force: true });
  }
  await run('git', ['worktree', 'prune'], { cwd: projectDir });
  // Delete in batches: one git call per branch is slow with hundreds of them.
  for (let i = 0; i < plan.branches.length; i += 100) await git(projectDir, 'branch', '-D', ...plan.branches.slice(i, i + 100));
}

/** git reports real paths (/private/var on macOS); compare like with like. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
