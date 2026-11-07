import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.ts';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = await run('git', args, { cwd });
  if (p.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${p.stderr.trim() || p.stdout.trim()}`);
  return p.stdout.trim();
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await run('git', args, { cwd })).code === 0;
}

const AUTHOR = ['-c', 'user.name=cortex', '-c', 'user.email=cortex@localhost'];

/**
 * Isolation model: the user's checkout is never touched. All work lands on an integration
 * branch (cortex/<goal>/main) checked out in its own worktree. Each attempt gets a fresh
 * worktree + branch off the integration tip; passing attempts are merged back, one at a time.
 */
export class Workspace {
  readonly integrationBranch: string;
  readonly integrationDir: string;
  private mergeLock: Promise<unknown> = Promise.resolve();

  readonly projectDir: string;
  readonly goalId: string;
  readonly stateDir: string;
  readonly baseBranch?: string;

  constructor(projectDir: string, goalId: string, stateDir: string, baseBranch?: string) {
    this.projectDir = projectDir;
    this.goalId = goalId;
    this.stateDir = stateDir;
    this.baseBranch = baseBranch;
    this.integrationBranch = `cortex/${goalId}/main`;
    this.integrationDir = join(stateDir, 'integration');
  }

  async init() {
    if (!(await gitOk(this.projectDir, 'rev-parse', '--git-dir'))) {
      throw new Error(`${this.projectDir} is not a git repository. Run: git -C "${this.projectDir}" init && git -C "${this.projectDir}" commit --allow-empty -m init`);
    }
    if (!(await gitOk(this.projectDir, 'rev-parse', '--verify', 'HEAD'))) {
      throw new Error(`${this.projectDir} has no commits yet. Make an initial commit first.`);
    }
    await git(this.projectDir, 'worktree', 'prune');
    const exists = await gitOk(this.projectDir, 'rev-parse', '--verify', `refs/heads/${this.integrationBranch}`);
    if (!exists) await git(this.projectDir, 'branch', this.integrationBranch, this.baseBranch ?? 'HEAD');
    if (!existsSync(join(this.integrationDir, '.git'))) {
      rmSync(this.integrationDir, { recursive: true, force: true });
      mkdirSync(this.stateDir, { recursive: true });
      await git(this.projectDir, 'worktree', 'add', this.integrationDir, this.integrationBranch);
    }
  }

  /**
   * New worktree for an attempt. With `carryForward`, a retry continues from the previous
   * attempt's branch (its code, downloads and caches), with the latest integration work merged
   * in, so a timeout or a near-miss doesn't throw hours of work away. If that merge conflicts,
   * it falls back to a clean start from the integration tip.
   */
  async createAttempt(taskId: string, attempt: number, carryForward = true): Promise<{ dir: string; branch: string; carried: boolean }> {
    const branch = `cortex/${this.goalId}/t/${taskId}-${attempt}`;
    const dir = join(this.stateDir, 'wt', `${taskId}-${attempt}`);
    await this.removeAttempt(dir);
    await run('git', ['branch', '-D', branch], { cwd: this.projectDir });
    mkdirSync(join(this.stateDir, 'wt'), { recursive: true });

    let base = this.integrationBranch;
    if (carryForward && attempt > 1) {
      const prevDir = join(this.stateDir, 'wt', `${taskId}-${attempt - 1}`);
      const prevBranch = `cortex/${this.goalId}/t/${taskId}-${attempt - 1}`;
      // An attempt killed by a restart still has its work uncommitted on disk: snapshot it first.
      if (existsSync(join(prevDir, '.git'))) {
        await this.commitAll(prevDir, `cortex(${taskId}): snapshot of interrupted attempt ${attempt - 1}`).catch(() => false);
        await this.removeAttempt(prevDir);
      }
      if (await gitOk(this.projectDir, 'rev-parse', '--verify', `refs/heads/${prevBranch}`)) base = prevBranch;
    }
    await git(this.projectDir, 'worktree', 'add', '-b', branch, dir, base);
    if (base === this.integrationBranch) return { dir, branch, carried: false };

    if (await gitOk(dir, ...AUTHOR, 'merge', '--no-edit', '--no-verify', this.integrationBranch)) return { dir, branch, carried: true };
    await run('git', ['merge', '--abort'], { cwd: dir });
    await this.removeAttempt(dir);
    await run('git', ['branch', '-D', branch], { cwd: this.projectDir });
    await git(this.projectDir, 'worktree', 'add', '-b', branch, dir, this.integrationBranch);
    return { dir, branch, carried: false };
  }

  async removeAttempt(dir: string) {
    if (existsSync(dir)) await run('git', ['worktree', 'remove', '--force', dir], { cwd: this.projectDir });
    rmSync(dir, { recursive: true, force: true });
  }

  /** Snapshot whatever the agent left behind. Returns false when there was nothing to commit. */
  async commitAll(dir: string, message: string): Promise<boolean> {
    await git(dir, 'add', '-A');
    if (await gitOk(dir, 'diff', '--cached', '--quiet')) return false;
    await git(dir, ...AUTHOR, 'commit', '-q', '--no-verify', '-m', message);
    return true;
  }

  /** The integration commit an attempt is measured against. */
  async base(dir: string): Promise<string> {
    return (await git(dir, 'merge-base', 'HEAD', this.integrationBranch)).trim();
  }

  /** What this attempt changed relative to the integration tip it started from. */
  async diff(dir: string, maxChars = 30000): Promise<string> {
    const base = await git(dir, 'merge-base', 'HEAD', this.integrationBranch);
    const stat = await git(dir, 'diff', '--stat', base, 'HEAD');
    const full = await git(dir, 'diff', base, 'HEAD');
    return `${stat}\n\n${full.length > maxChars ? full.slice(0, maxChars) + '\n…(diff truncated)' : full}`;
  }

  async integrationLog(n = 30): Promise<string> {
    return git(this.integrationDir, 'log', '--oneline', `-${n}`);
  }

  /** Serialized: parallel tasks can finish at the same moment. */
  merge(branch: string, message: string): Promise<boolean> {
    const next = this.mergeLock.then(async () => {
      const ok = await gitOk(this.integrationDir, ...AUTHOR, 'merge', '--no-ff', '--no-verify', '-m', message, branch);
      if (!ok) await run('git', ['merge', '--abort'], { cwd: this.integrationDir });
      return ok;
    });
    this.mergeLock = next.catch(() => {});
    return next;
  }
}
