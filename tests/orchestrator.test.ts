// Orchestrator behaviour with in-memory agents: usage anticipation, risk tiers, guards,
// crash recovery and escalation. No processes are spawned except git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { Agent, RunRequest, RunResult } from '../src/agents/index.ts';
import type { GoalConfig, UsageWindow } from '../src/types.ts';
import { sleep } from '../src/proc.ts';

type Fn = (req: RunRequest) => RunResult | Promise<RunResult>;
const mem = (name: string, provider: string, fn: Fn): Agent => ({ name, provider, run: async (r) => fn(r) });
const ok = (output = 'done', extra: Partial<RunResult> = {}): RunResult => ({ ok: true, output, costUsd: 0, ...extra });

/** Obeys "WRITE <file> <content>" / "DELETE <file>" in its brief, like the fixture worker. */
function doBrief(req: RunRequest) {
  for (const m of req.prompt.matchAll(/WRITE (\S+) (\S+)/g)) {
    mkdirSync(join(req.cwd, m[1], '..'), { recursive: true });
    writeFileSync(join(req.cwd, m[1]), m[2] + '\n');
  }
  for (const m of req.prompt.matchAll(/DELETE (\S+)/g)) rmSync(join(req.cwd, m[1]), { force: true });
}
const worker = (name: string, provider: string, extra?: (req: RunRequest) => Partial<RunResult>) =>
  mem(name, provider, (req) => {
    doBrief(req);
    return ok('done', extra?.(req));
  });

function planner(tasks: object[]): Agent {
  return mem('planner', 'p0', (req) =>
    ok('', { structured: req.prompt.includes('(no tasks yet)') ? { tasks, cancel: [], notes: 'plan' } : { tasks: [], cancel: [], notes: 'no changes' } }),
  );
}

function setup(id: string, agents: Record<string, Agent>, goal: Partial<GoalConfig>, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cortex-orch-'));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', project]);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(project, f, '..'), { recursive: true });
    writeFileSync(join(project, f), c);
  }
  execFileSync('git', ['-C', project, 'add', '-A']);
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const cfg: GoalConfig = {
    id, objective: 'Test goal', acceptance: [{ kind: 'command', run: 'true' }], agents: {},
    routing: { plan: 'planner', judge: 'planner' }, budget: { max_attempts_per_task: 3 }, concurrency: 1, notify: { macos: false },
    ...goal,
  };
  const stateDir = join(root, 'state');
  const store = new Store(join(stateDir, 'state.db'));
  store.upsertGoal(cfg, project);
  const orch = new Orchestrator({ store, goal: cfg, projectDir: project, stateDir, agents, pollMs: 20 });
  const started = () => Object.fromEntries(store.events(id, 1000, 'attempt.started').map((e) => [`${e.task_id}#${e.data.attempt}`, e.data.agent]));
  return { store, orch, stateDir, started };
}

const window = (utilization: number): UsageWindow[] => [{ window: 'five_hour', utilization, resetsAtMs: Date.now() + 3600e3 }];
const twoTasks = [
  { key: 't1', title: 'one', kind: 'code', brief: 'WRITE a.txt x', deps: [], evals: [{ kind: 'command', run: 'test -f a.txt' }] },
  { key: 't2', title: 'two', kind: 'code', brief: 'WRITE b.txt y', deps: ['t1'], evals: [{ kind: 'command', run: 'test -f b.txt' }] },
];

test('past the soft limit, new work goes to the fallback agent before the provider limit is hit', async () => {
  const { store, orch, stateDir, started } = setup('soft', {
    planner: planner(twoTasks),
    heavy: worker('heavy', 'p1', () => ({ usage: window(0.9) })),
    light: worker('light', 'p2'),
  }, { routing: { plan: 'planner', code: ['heavy', 'light'], judge: 'planner' } });
  assert.equal(await orch.run(), 'done');
  assert.deepEqual(started(), { 't1#1': 'heavy', 't2#1': 'light' });
  assert.equal(store.countEvents('soft', 'agent.usage'), 1);
  assert.equal(store.countEvents('soft', 'agent.cooldown'), 0, 'soft limit reroutes; it does not rest the agent');
  assert.match(readFileSync(join(stateDir, 'notify.log'), 'utf8'), /heavy is at 90% of its five_hour window/);
});

test('at the hard limit the agent rests until its window resets', async () => {
  const { store, orch, started } = setup('hard', {
    planner: planner(twoTasks),
    heavy: worker('heavy', 'p1', () => ({ usage: window(0.99) })),
    light: worker('light', 'p2'),
  }, { routing: { plan: 'planner', code: ['heavy', 'light'], judge: 'planner' } });
  assert.equal(await orch.run(), 'done');
  assert.equal(started()['t2#1'], 'light');
  const cd = store.events('hard', 10, 'agent.cooldown');
  assert.equal(cd.length, 1);
  assert.equal(cd[0].data.agent, 'heavy');
  assert.equal(cd[0].data.anticipated, true);
});

test('when every candidate is past the soft limit, the least loaded one still works', async () => {
  const { orch, started } = setup('allsoft', {
    planner: planner(twoTasks),
    a: worker('a', 'p1', () => ({ usage: window(0.95) })),
    b: worker('b', 'p2', () => ({ usage: window(0.88) })),
  }, { routing: { plan: 'planner', code: ['a', 'b'], judge: 'planner' } });
  assert.equal(await orch.run(), 'done');
  assert.equal(started()['t2#1'], 'b');
});

test('risk tiers: low skips judges, normal uses one, high uses two providers plus an integrity review', async () => {
  const calls: { task: string; judge: string; criterion: string }[] = [];
  const judge = (name: string, provider: string) =>
    mem(name, provider, (req) => {
      calls.push({ task: req.prompt.match(/Task: (\w+)/)![1], judge: name, criterion: req.prompt.match(/# Criterion\n(.*)/)![1] });
      return ok('', { structured: { pass: true, reason: 'fine' } });
    });
  const tasks = [
    { key: 'lo', title: 'lo', kind: 'code', risk: 'low', brief: 'WRITE lo.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f lo.txt' }, { kind: 'judge', criterion: 'lo is good' }] },
    { key: 'mid', title: 'mid', kind: 'code', brief: 'WRITE mid.txt 1', deps: [], evals: [{ kind: 'judge', criterion: 'mid is good' }] },
    { key: 'hi', title: 'hi', kind: 'code', risk: 'high', brief: 'WRITE hi.txt 1', deps: [], evals: [{ kind: 'judge', criterion: 'hi is good' }] },
  ];
  const { store, orch } = setup('risk', {
    planner: planner(tasks), w: worker('w', 'p1'), j1: judge('j1', 'p2'), j2: judge('j2', 'p3'),
  }, { routing: { plan: 'planner', code: 'w', judge: ['j1', 'j2'] } });
  assert.equal(await orch.run(), 'done');
  assert.equal(store.task('risk', 'hi')?.risk, 'high');
  const of = (t: string) => calls.filter((c) => c.task === t);
  assert.equal(of('lo').length, 0);
  assert.equal(of('mid').length, 1);
  const hi = of('hi');
  assert.equal(hi.length, 4, 'two criteria × two judges');
  assert.deepEqual(hi.map((c) => c.judge), ['j1', 'j2', 'j1', 'j2']);
  assert.match(hi[2].criterion, /without gaming its own checks/);
});

test('guards: a leaked key fails the attempt with feedback; the retry passes', async () => {
  const key = `sk-ant-api03-${'k'.repeat(40)}`;
  const tasks = [{ key: 'sec', title: 'sec', kind: 'code', brief: 'Write config', deps: [], evals: [{ kind: 'command', run: 'test -f config.py' }] }];
  const { store, orch } = setup('guard', {
    planner: planner(tasks),
    w: mem('w', 'p1', (req) => {
      const fixed = req.prompt.includes('Anthropic API key appears'); // only in the guard's feedback
      writeFileSync(join(req.cwd, 'config.py'), fixed ? 'KEY = os.environ["KEY"]\n' : `KEY = "${key}"\n`);
      return ok();
    }),
  }, { routing: { plan: 'planner', code: 'w', judge: 'planner' } });
  assert.equal(await orch.run(), 'done');
  assert.equal(store.task('guard', 'sec')?.attempts, 2);
  const evals = store.events('guard', 10, 'eval').map((e) => String(e.data.feedback));
  assert.match(evals[0], /Anthropic API key/);
});

test('guards: protected paths can never be changed; deleting a test gets the high-risk review', async () => {
  const verdicts: string[] = [];
  const tasks = [
    { key: 'lock', title: 'lock', kind: 'code', brief: 'WRITE locked/contract.txt v2 WRITE ok.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f ok.txt' }] },
    { key: 'del', title: 'del', kind: 'code', brief: 'DELETE tests/test_x.py', deps: [], evals: [{ kind: 'judge', criterion: 'tidy' }] },
  ];
  const judge = (n: string, p: string) => mem(n, p, (req) => {
    verdicts.push(n);
    return ok('', { structured: { pass: true, reason: req.prompt.length ? 'ok' : '' } });
  });
  const { store, orch } = setup('prot', {
    planner: planner(tasks), w: worker('w', 'p1'), j1: judge('j1', 'p2'), j2: judge('j2', 'p3'),
  }, {
    routing: { plan: 'planner', code: 'w', judge: ['j1', 'j2'] },
    protected_paths: ['locked/'],
    budget: { max_attempts_per_task: 2, max_replans: 1 },
  }, { 'locked/contract.txt': 'v1\n', 'tests/test_x.py': 'def test(): pass\n' });
  const done = orch.run();
  for (let i = 0; i < 500 && store.goal('prot')?.status !== 'blocked'; i++) await sleep(20);
  assert.equal(store.task('prot', 'lock')?.status, 'needs_human', 'a task that keeps editing a protected path is never merged');
  assert.match(String(store.task('prot', 'lock')?.feedback), /Protected paths were changed: locked\/contract\.txt/);
  assert.equal(store.task('prot', 'del')?.status, 'passed');
  assert.equal(store.countEvents('prot', 'attempt.escalated_review'), 1);
  assert.equal(verdicts.length, 4, 'deleted test → criterion + integrity, each judged twice');
  for (const t of store.tasks('prot').filter((x) => x.status === 'needs_human')) store.updateTask('prot', t.id, { status: 'cancelled' });
  assert.equal(await done, 'done');
});

test('a task left running by a crash resumes without spending one of its attempts', async () => {
  const { store, orch } = setup('crash', { planner: planner([]), w: worker('w', 'p1') }, {
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, budget: { max_attempts_per_task: 1 },
  });
  store.insertTask({ id: 'r', goal_id: 'crash', title: 'r', kind: 'code', brief: 'WRITE r.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f r.txt' }], agent: null, status: 'running' });
  store.updateTask('crash', 'r', { attempts: 1 });
  assert.equal(await orch.run(), 'done');
  assert.equal(store.countEvents('crash', 'attempt.interrupted'), 1);
  assert.equal(store.task('crash', 'r')?.status, 'passed');
});

test('a task that keeps failing is replanned, then parked for the human while the goal waits', async () => {
  const tasks = [{ key: 'f', title: 'f', kind: 'code', brief: 'never writes the file', deps: [], evals: [{ kind: 'command', run: 'test -f never.txt' }] }];
  const { store, orch, stateDir } = setup('esc', { planner: planner(tasks), w: worker('w', 'p1') }, {
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, budget: { max_attempts_per_task: 1, max_replans: 1 },
  });
  const done = orch.run();
  for (let i = 0; i < 500 && store.goal('esc')?.status !== 'blocked'; i++) await sleep(20);
  assert.equal(store.goal('esc')?.status, 'blocked');
  assert.equal(store.task('esc', 'f')?.status, 'needs_human');
  assert.equal(store.countEvents('esc', 'plan'), 2, 'initial plan + one failure replan');
  assert.match(readFileSync(join(stateDir, 'notify.log'), 'utf8'), /cortex answer esc f/);
  store.updateTask('esc', 'f', { status: 'cancelled' });
  assert.equal(await done, 'done');
});

test('a judge that cannot be independent of the first is skipped, not duplicated', async () => {
  const calls: string[] = [];
  const tasks = [{ key: 'h', title: 'h', kind: 'code', risk: 'high', brief: 'WRITE h.txt 1', deps: [], evals: [{ kind: 'judge', criterion: 'good' }] }];
  const { orch } = setup('solo', {
    planner: planner(tasks), w: worker('w', 'p1'),
    j: mem('j', 'p2', () => (calls.push('j'), ok('', { structured: { pass: true, reason: 'ok' } }))),
  }, { routing: { plan: 'planner', code: 'w', judge: 'j' } });
  assert.equal(await orch.run(), 'done');
  assert.equal(calls.length, 2, 'one judge per criterion when only one provider exists');
});

test('a question is asked only after the research it depends on has passed', async () => {
  const tasks = [
    { key: 'res', title: 'res', kind: 'research', brief: 'WRITE findings.md 1', deps: [], evals: [{ kind: 'command', run: 'test -f findings.md' }] },
    { key: 'ask', title: 'ask', kind: 'human', brief: 'Read findings.md and decide', deps: ['res'], evals: [] },
    { key: 'use', title: 'use', kind: 'code', brief: 'WRITE use.txt 1', deps: ['ask'], evals: [{ kind: 'command', run: 'test -f use.txt' }] },
  ];
  let askedWhileResearchPending = false;
  const { store, orch } = setup('gate', {
    planner: planner(tasks),
    w: mem('w', 'p1', (req) => {
      if (store.task('gate', 'ask')?.status === 'needs_human') askedWhileResearchPending = true;
      doBrief(req);
      return ok();
    }),
  }, { routing: { plan: 'planner', code: 'w', research: 'w', judge: 'planner' } });
  const done = orch.run();
  for (let i = 0; i < 500 && store.goal('gate')?.status !== 'blocked'; i++) await sleep(20);
  assert.equal(askedWhileResearchPending, false, 'the question must wait for its research');
  assert.equal(store.task('gate', 'res')?.status, 'passed');
  assert.equal(store.task('gate', 'ask')?.status, 'needs_human');
  assert.equal(store.countEvents('gate', 'question.asked'), 1);
  store.updateTask('gate', 'ask', { status: 'passed', human_answer: 'go', summary: 'Human answered: go' });
  assert.equal(await done, 'done');
});
