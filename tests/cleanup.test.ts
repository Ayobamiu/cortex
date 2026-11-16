import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.ts';
import { planCleanup, applyCleanup } from '../src/cleanup.ts';
import type { GoalConfig } from '../src/types.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

test('cleanup removes finished tasks’ attempts and stray folders, keeps what unfinished work continues from', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cortex-clean-'));
  const project = join(root, 'p');
  const state = join(root, 'state');
  git(root, 'init', '-q', project);
  git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const store = new Store(join(state, 'state.db'));
  store.upsertGoal({ id: 'g', objective: 'x', acceptance: [], agents: {}, routing: {} } as unknown as GoalConfig, project);
  const task = (id: string, status: any) => store.insertTask({ id, goal_id: 'g', title: id, kind: 'code', brief: '', deps: [], evals: [], agent: null, status });
  task('done-task', 'passed');
  task('gone', 'cancelled');
  task('stuck', 'needs_human');
  task('busy', 'running');
  git(project, 'branch', 'cortex/g/main');
  git(project, 'branch', 'mine');
  git(project, 'branch', 'cortex/g/t/old-task-from-another-plan-1');
  for (const b of ['done-task-1', 'done-task-2', 'gone-1', 'stuck-1', 'stuck-2', 'busy-1']) {
    git(project, 'worktree', 'add', '-q', '-b', `cortex/g/t/${b}`, join(state, 'wt', b));
  }
  mkdirSync(join(state, 'wt', 'leftover'));
  writeFileSync(join(state, 'wt', 'leftover', 'x'), 'x');

  const plan = await planCleanup(store, 'g', project, state, false);
  assert.deepEqual(plan.branches.sort(), ['cortex/g/t/done-task-1', 'cortex/g/t/done-task-2', 'cortex/g/t/gone-1', 'cortex/g/t/old-task-from-another-plan-1', 'cortex/g/t/stuck-1']);
  assert.deepEqual(plan.kept.sort(), ['cortex/g/t/busy-1', 'cortex/g/t/stuck-2']);
  await applyCleanup(project, state, plan);

  const def = git(project, 'branch', '--show-current').trim();
  const left = git(project, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
  assert.deepEqual(left, ['cortex/g/main', 'cortex/g/t/busy-1', 'cortex/g/t/stuck-2', def, 'mine'].sort());
  assert.equal(existsSync(join(state, 'wt', 'done-task-1')), false);
  assert.equal(existsSync(join(state, 'wt', 'leftover')), false);
  assert.equal(existsSync(join(state, 'wt', 'stuck-2')), true, 'the attempt a stuck task continues from stays');
  assert.equal(existsSync(join(state, 'wt', 'busy-1')), true, 'a running attempt is never touched');
  assert.equal(existsSync(join(state, 'state.db')), true);
});
