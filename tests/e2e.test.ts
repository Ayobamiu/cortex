import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { GoalConfig } from '../src/types.ts';
import { sleep } from '../src/proc.ts';

const fx = resolve(import.meta.dirname, 'fixtures');

const ACCEPT: Record<string, string> = {
  basic: 'test -f a.txt && test -f b.txt',
  human: 'grep -q banana c.txt && test -f d.txt',
  limited: 'test -f l.txt && test -f attack.txt',
};

function setup(id: string, scenario: string, overrides: Partial<GoalConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cortex-test-'));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const goal: GoalConfig = {
    id,
    objective: 'Test goal',
    acceptance: [{ kind: 'command', run: ACCEPT[scenario] }],
    task_checks: [{ kind: 'command', run: 'test ! -f forbidden.txt' }],
    agents: {
      planner: { adapter: 'command', command: `CORTEX_TEST_PLAN=${scenario} node ${fx}/fake-planner.mjs`, provider: 'p1' },
      worker: { adapter: 'command', command: `node ${fx}/fake-worker.mjs`, provider: 'p1' },
      judge: { adapter: 'command', command: `echo '{"pass": true, "reason": "fine"}'`, provider: 'p2' },
    },
    routing: { plan: 'planner', code: 'worker', research: 'worker', judge: ['planner', 'judge'] },
    budget: { usd_total: 5, max_attempts_per_task: 3 },
    concurrency: 2,
    notify: { macos: false },
    // The fake agents live in ~/Documents, which the sandbox hides unless declared readable.
    sandbox: { extra_readable: [fx] },
    ...overrides,
  };
  const stateDir = join(root, 'state');
  const store = new Store(join(stateDir, 'state.db'));
  store.upsertGoal(goal, project);
  const orch = new Orchestrator({ store, goal, projectDir: project, stateDir, pollMs: 20 });
  const show = (file: string) => execFileSync('git', ['-C', project, 'show', `cortex/${id}/main:${file}`]).toString().trim();
  return { store, orch, show, stateDir };
}

test('plans, runs, retries with feedback, judges on another provider, merges, accepts', async () => {
  const { store, orch, show } = setup('basic', 'basic');
  assert.equal(await orch.run(), 'done');
  const tasks = Object.fromEntries(store.tasks('basic').map((t) => [t.id, t]));
  assert.equal(tasks.a.status, 'passed');
  assert.equal(tasks.a.attempts, 1);
  assert.equal(tasks.b.status, 'passed');
  assert.equal(tasks.b.attempts, 2, 'flaky task should pass on the retry that carries feedback');
  assert.equal(show('a.txt'), 'hello');
  assert.equal(show('b.txt'), 'world');
  assert.equal(tasks.r.attempts, 2, 'crashed attempt 1 progress must carry into attempt 2');
  assert.equal(show('progress.txt'), 'half done');
  assert.equal(store.countEvents('basic', 'attempt.carried_forward') >= 1, true);
  // Judge must have been the other-provider agent, not the planner listed first.
  const judgeCosts = store.db.prepare("SELECT agent FROM costs WHERE role = 'judge'").all() as { agent: string }[];
  assert.deepEqual([...new Set(judgeCosts.map((r) => r.agent))], ['judge']);
  assert.ok(store.spent('basic') > 0);
  assert.equal(store.goal('basic')?.status, 'done');
});

test('human question blocks only its dependents; answering unblocks', async () => {
  const { store, orch, show, stateDir } = setup('human', 'human');
  const done = orch.run();
  // Wait until the independent task finishes and the goal reports blocked.
  for (let i = 0; i < 300 && store.goal('human')?.status !== 'blocked'; i++) await sleep(20);
  assert.equal(store.goal('human')?.status, 'blocked');
  assert.equal(store.task('human', 'd')?.status, 'passed', 'independent work continues while waiting');
  assert.equal(store.task('human', 'c')?.status, 'pending');
  assert.match(readFileSync(join(stateDir, 'notify.log'), 'utf8'), /cortex answer human q/);

  store.updateTask('human', 'q', { status: 'passed', human_answer: 'banana', summary: 'Human answered: banana' });
  assert.equal(await done, 'done');
  assert.equal(show('c.txt'), 'banana');
});

test('usage limit rests the agent without burning a retry; redteam routes to its own agent', async () => {
  process.env.CORTEX_LIMIT_FLOOR_MS = '500';
  const mark = join(mkdtempSync(join(tmpdir(), 'cortex-mark-')), 'limited');
  const { store, orch } = setup('limited', 'limited', {
    agents: {
      planner: { adapter: 'command', command: `CORTEX_TEST_PLAN=limited node ${fx}/fake-planner.mjs`, provider: 'p1' },
      worker: { adapter: 'command', command: `CORTEX_TEST_MARK=${mark} node ${fx}/fake-worker.mjs`, provider: 'p1' },
      attacker: { adapter: 'command', command: `node ${fx}/fake-worker.mjs`, provider: 'p2' },
    },
    routing: { plan: 'planner', code: 'worker', redteam: 'attacker', judge: 'planner' },
    budget: { max_attempts_per_task: 1 },
  });
  assert.equal(await orch.run(), 'done');
  const l = store.task('limited', 'l')!;
  assert.equal(l.status, 'passed', 'only 1 attempt allowed: the limited one must not have counted');
  assert.equal(l.attempts, 2);
  assert.equal(store.countEvents('limited', 'attempt.rate_limited'), 1);
  assert.equal(store.countEvents('limited', 'agent.cooldown'), 1);
  const rt = store.events('limited', 500, 'attempt.started').find((e) => e.task_id === 'rt');
  assert.equal(rt?.data.agent, 'attacker');
  delete process.env.CORTEX_LIMIT_FLOOR_MS;
});

test('budget limit stops the run', async () => {
  const { store, orch } = setup('broke', 'basic');
  store.addCost('broke', null, 'plan', 'planner', 10);
  assert.equal(await orch.run(), 'budget_exhausted');
});
