// Orchestrator behaviour with in-memory agents: usage anticipation, risk tiers, guards,
// crash recovery and escalation. No processes are spawned except git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { Agent, RunRequest, RunResult } from '../src/agents/index.ts';
import type { GoalConfig, UsageWindow } from '../src/types.ts';
import { sleep } from '../src/proc.ts';

process.env.CORTEX_PHONE = 'off'; // never push to a real phone from tests

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

test("a judge that can't give a verdict is replaced by another judge and never charged to the worker", async () => {
  const tasks = [{ key: 'j', title: 'j', kind: 'code', brief: 'WRITE j.txt 1', deps: [], evals: [{ kind: 'judge', criterion: 'good' }] }];
  const calls: string[] = [];
  const { store, orch } = setup('broken', {
    planner: planner(tasks), w: worker('w', 'p1'),
    flaky: mem('flaky', 'p2', () => (calls.push('flaky'), { ok: false, output: '', costUsd: 0, error: 'Workspace Trust Required' })),
    solid: mem('solid', 'p3', () => (calls.push('solid'), ok('', { structured: { pass: true, reason: 'ok' } }))),
  }, { routing: { plan: 'planner', code: 'w', judge: ['flaky', 'solid'] }, budget: { max_attempts_per_task: 1 } });
  assert.equal(await orch.run(), 'done');
  assert.equal(store.task('broken', 'j')?.attempts, 1, 'passed on its only attempt despite the broken judge');
  assert.deepEqual(calls, ['flaky', 'solid']);
  assert.equal(store.countEvents('broken', 'judge.broken'), 1);
});

test('with no working judge at all, the attempt is retried later without counting', async () => {
  const tasks = [{ key: 'n', title: 'n', kind: 'code', brief: 'WRITE n.txt 1', deps: [], evals: [{ kind: 'judge', criterion: 'good' }] }];
  let fixed = false;
  const { store, orch } = setup('nojudge', {
    planner: planner(tasks), w: worker('w', 'p1'),
    only: mem('only', 'p2', () => (fixed ? ok('', { structured: { pass: true, reason: 'ok' } }) : ((fixed = true), { ok: false, output: '', costUsd: 0, error: 'crashed' }))),
  }, { routing: { plan: 'planner', code: 'w', judge: 'only' }, budget: { max_attempts_per_task: 1 } });
  assert.equal(await orch.run(), 'done');
  assert.equal(store.task('nojudge', 'n')?.status, 'passed', 'only 1 attempt allowed: the unjudged one must not have counted');
  assert.equal(store.countEvents('nojudge', 'attempt.judge_unavailable'), 1);
});

test('a checkpoint review waiting for a resting planner does not stall ready work', async () => {
  const tasks = [
    { key: 'a', title: 'a', kind: 'code', brief: 'WRITE a.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f a.txt' }] },
    { key: 'b', title: 'b', kind: 'code', brief: 'WRITE b.txt 1', deps: ['a'], evals: [{ kind: 'command', run: 'test -f b.txt' }] },
    { key: 'c', title: 'c', kind: 'code', brief: 'WRITE c.txt 1', deps: ['b'], evals: [{ kind: 'command', run: 'test -f c.txt' }] },
  ];
  let calls = 0;
  let wakeAt = 0;
  const p = mem('planner', 'p0', (req) => {
    calls++;
    if (calls === 1) return ok('', { structured: { tasks, cancel: [], notes: 'plan' } });
    if (calls === 2) {
      wakeAt = Date.now() + 1500; // the checkpoint review hits the planner's usage limit
      return { ok: false, output: '', costUsd: 0, error: 'limit', rateLimited: { untilMs: wakeAt } };
    }
    return ok('', { structured: { tasks: [], cancel: [], notes: 'no changes' } });
  });
  const { store, orch } = setup('stall', { planner: p, w: worker('w', 'p1') }, {
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, checkpoint_every: 1,
  });
  assert.equal(await orch.run(), 'done');
  const cStarted = Date.parse(store.events('stall', 1000, 'attempt.started').find((e) => e.task_id === 'c')!.ts);
  assert.ok(cStarted < wakeAt, 'work continued while the planner rested');
  assert.ok(calls >= 3, 'the deferred review still ran once the planner woke');
});

test('below the free-disk minimum, no new task starts; work resumes once space is back', async () => {
  const { store, orch, stateDir } = setup('disk', { planner: planner(twoTasks), w: worker('w', 'p1') }, {
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, min_free_gb: 1e9, // impossible: "disk full"
  });
  const done = orch.run();
  for (let i = 0; i < 300 && !store.countEvents('disk', 'disk.low'); i++) await sleep(20);
  await sleep(200);
  assert.equal(store.countEvents('disk', 'attempt.started'), 0, 'nothing starts while the disk is low');
  assert.match(readFileSync(join(stateDir, 'notify.log'), 'utf8'), /Disk nearly full/);
  (orch as any).goal.min_free_gb = 0; // space freed
  assert.equal(await done, 'done');
  assert.equal(store.countEvents('disk', 'disk.ok'), 1);
});

test('a task marked deep goes to the deep agent first; routine work stays with the cheaper one', async () => {
  const tasks = [
    { key: 'easy', title: 'easy', kind: 'code', brief: 'WRITE e.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f e.txt' }] },
    { key: 'hard', title: 'hard', kind: 'research', deep: true, brief: 'WRITE h.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f h.txt' }] },
  ];
  const { orch, started } = setup('deep', { planner: planner(tasks), cheap: worker('cheap', 'p1'), strong: worker('strong', 'p2') }, {
    routing: { plan: 'planner', code: ['cheap', 'strong'], research: ['cheap', 'strong'], deep: ['strong'], judge: 'planner' },
  });
  assert.equal(await orch.run(), 'done');
  assert.deepEqual(started(), { 'easy#1': 'cheap', 'hard#1': 'strong' });
});

test('a worker building on a question sees the question as asked, not just the bare answer', async () => {
  const prompts: string[] = [];
  const tasks = [
    { key: 'q', title: 'q', kind: 'human', brief: 'Pick one. A. waive rule E6. B. find more events.', deps: [], evals: [] },
    { key: 'rec', title: 'rec', kind: 'code', brief: 'WRITE d.md 1', deps: ['q'], evals: [{ kind: 'command', run: 'test -f d.md' }] },
  ];
  const { store, orch } = setup('qctx', {
    planner: planner(tasks), w: mem('w', 'p1', (req) => (prompts.push(req.prompt), doBrief(req), ok())),
  }, { routing: { plan: 'planner', code: 'w', judge: 'planner' } });
  const done = orch.run();
  for (let i = 0; i < 500 && store.task('qctx', 'q')?.status !== 'needs_human'; i++) await sleep(20);
  store.updateTask('qctx', 'q', { status: 'passed', human_answer: 'A' });
  assert.equal(await done, 'done');
  assert.match(prompts[0], /Question as asked:\nPick one\. A\. waive rule E6/);
  assert.match(prompts[0], /Human answer \(verbatim\): A/);
});

test('your answer to an escalation reaches the planner and gives it a fresh replan budget', async () => {
  const seen: string[] = [];
  const plan = mem('planner', 'p0', (req) => {
    seen.push(req.prompt);
    if (req.prompt.includes("Owner's answer (verbatim): write done.txt"))
      return ok('', { structured: { tasks: [{ key: 'fix', title: 'fix', kind: 'code', brief: 'WRITE done.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f done.txt' }] }], cancel: [], notes: 'guided' } });
    if (req.prompt.includes('(no tasks yet)'))
      return ok('', { structured: { tasks: [{ key: 'start', title: 'start', kind: 'code', brief: 'WRITE start.txt 1', deps: [], evals: [{ kind: 'command', run: 'test -f start.txt' }] }], cancel: [], notes: 'plan' } });
    return ok('', { structured: { tasks: [], cancel: [], notes: 'no idea' } });
  });
  const { store, orch } = setup('guide', { planner: plan, w: worker('w', 'p1') }, {
    acceptance: [{ kind: 'command', run: 'test -f done.txt' }],
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, budget: { max_replans: 1 },
  });
  const done = orch.run();
  const waitBlocked = async () => {
    for (let i = 0; i < 500 && store.goal('guide')?.status !== 'blocked'; i++) await sleep(20);
  };
  await waitBlocked();
  const esc = store.tasks('guide').find((t) => t.status === 'needs_human')!;
  assert.match(esc.brief, /Replan limit \(1\) reached/);
  store.tx(() => {
    store.updateTask('guide', esc.id, { status: 'passed', human_answer: 'write done.txt' });
    store.event('guide', 'human.answer', { text: 'write done.txt' }, esc.id);
  });
  assert.equal(await done, 'done', 'the guided plan runs instead of re-escalating at once');
  assert.match(seen.at(-1)!, /Question as asked:\nReplan limit/);
  assert.equal(store.countEvents('guide', 'escalated'), 1);
});

test('the time limit counts working hours only, not time blocked on you or with cortex stopped', () => {
  const root = mkdtempSync(join(tmpdir(), 'cortex-hours-'));
  const store = new Store(join(root, 'state.db'));
  const at = (iso: string, type: string, data: object = {}) =>
    store.db.prepare('INSERT INTO events (ts, goal_id, task_id, type, data) VALUES (?, ?, NULL, ?, ?)').run(iso, 'h', type, JSON.stringify(data));
  at('2026-01-01T00:00:00Z', 'goal.created');
  at('2026-01-01T02:00:00Z', 'goal.status', { status: 'blocked' }); // 2h working
  at('2026-01-03T00:00:00Z', 'goal.status', { status: 'active' }); // 46h blocked: not counted
  at('2026-01-03T01:00:00Z', 'attempt.started'); // 1h working, then the process died
  at('2026-01-05T00:00:00Z', 'run.started'); // down ~47h: not counted
  at('2026-01-05T00:00:00Z', 'goal.status', { status: 'active' });
  assert.equal(store.activeHours('h', Date.parse('2026-01-05T03:00:00Z')), 6); // 2 + 1 + 3
});

test('guidance on a failed task resumes from its last attempt, with fresh retries', async () => {
  const tasks = [{ key: 'g', title: 'g', kind: 'code', brief: 'two steps', deps: [], evals: [{ kind: 'command', run: 'test -f step1.txt && test -f step2.txt' }] }];
  const w = mem('w', 'p1', (req) => {
    // Without guidance it only ever does step 1; with guidance it finishes, but only on top of step 1.
    if (!existsSync(join(req.cwd, 'step1.txt'))) writeFileSync(join(req.cwd, 'step1.txt'), '1\n');
    else if (req.prompt.includes('Guidance from the user')) writeFileSync(join(req.cwd, 'step2.txt'), '2\n');
    return ok();
  });
  const { store, orch, started } = setup('resume', { planner: planner(tasks), w }, {
    routing: { plan: 'planner', code: 'w', judge: 'planner' }, budget: { max_attempts_per_task: 2, max_replans: 0 },
  });
  const done = orch.run();
  for (let i = 0; i < 500 && store.task('resume', 'g')?.status !== 'needs_human'; i++) await sleep(20);
  assert.equal(store.task('resume', 'g')?.attempts, 2);
  store.answer('resume', 'g', 'finish step 2');
  for (let i = 0; i < 500 && store.task('resume', 'g')?.status !== 'passed'; i++) await sleep(20);
  assert.equal(store.task('resume', 'g')?.status, 'passed');
  assert.deepEqual(Object.keys(started()), ['g#1', 'g#2', 'g#3'], 'attempt numbers keep counting');
  assert.equal(store.lastTaskEvent('resume', 'g', 'attempt.carried_forward')?.data.from, 2);
  for (const t of store.tasks('resume').filter((x) => x.status === 'needs_human')) store.updateTask('resume', t.id, { status: 'cancelled' });
  assert.equal(await done, 'done');
});

test('pause starts nothing new until resume; stop finishes running work and exits until resumed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = mem('slow', 'p1', async (req) => {
    doBrief(req);
    if (req.prompt.includes('a.txt')) await gate;
    return ok();
  });
  const { store, orch } = setup('ctl', { planner: planner(twoTasks), slow }, { routing: { plan: 'planner', code: 'slow', judge: 'planner' } });
  const done = orch.run();
  while (!store.tasks('ctl').some((t) => t.status === 'running')) await sleep(10);
  store.setControl('ctl', 'pause');
  release();
  while (store.task('ctl', 't1')?.status !== 'passed') await sleep(10);
  await sleep(150);
  assert.equal(store.goal('ctl')?.status, 'paused');
  assert.equal(store.task('ctl', 't2')?.status, 'pending', 'nothing new starts while paused');
  store.setControl('ctl', 'stop');
  assert.equal(await done, 'stopped');
  assert.equal(store.goal('ctl')?.status, 'stopped');
  assert.equal(await orch.run(), 'stopped', 'a stopped goal stays stopped across restarts');
  store.setControl('ctl', 'resume');
  assert.equal(await orch.run(), 'done');
  assert.equal(store.activeHours('ctl') < 1, true);
});

test('a mid-run instruction reaches the planner once, verbatim', async () => {
  const seen: string[] = [];
  const p = mem('planner', 'p0', (req) => {
    if (req.prompt.includes('mid-run')) seen.push(req.prompt);
    return ok('', { structured: req.prompt.includes('(no tasks yet)') ? { tasks: twoTasks, cancel: [], notes: 'plan' } : { tasks: [], cancel: [], notes: 'ok' } });
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const w = mem('w', 'p1', async (req) => {
    doBrief(req);
    if (req.prompt.includes('a.txt')) await gate;
    return ok();
  });
  const { store, orch } = setup('steer', { planner: p, w }, { routing: { plan: 'planner', code: 'w', judge: 'planner' } });
  const done = orch.run();
  while (!store.tasks('steer').some((t) => t.status === 'running')) await sleep(10);
  store.steer('steer', 'skip the docs task');
  await sleep(100);
  release();
  assert.equal(await done, 'done');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\(verbatim\): skip the docs task/);
  const plan = store.events('steer', 10, 'plan').at(-1)!;
  assert.equal((plan.data.steers as number[]).length, 1);
  assert.ok(store.events('steer', 100, 'attempt.started').every((e) => typeof e.data.log === 'string'), 'attempts say where their live log is');
});

test('a mid-run revision commits the new spec, changes acceptance, replans once, and reopens a finished goal', async () => {
  const seen: string[] = [];
  const p = mem('planner', 'p0', (req) => {
    if (req.prompt.includes('revised the goal')) {
      seen.push(req.prompt);
      return ok('', { structured: { tasks: [{ key: 't3', title: 'three', kind: 'code', brief: 'WRITE c.txt z', deps: [], evals: [{ kind: 'command', run: 'test -f c.txt' }] }], cancel: [], notes: 'revised' } });
    }
    return ok('', { structured: req.prompt.includes('(no tasks yet)') ? { tasks: twoTasks, cancel: [], notes: 'plan' } : { tasks: [], cancel: [], notes: 'ok' } });
  });
  const { store, orch, stateDir } = setup('rev', { planner: p, w: worker('w', 'p1') }, { routing: { plan: 'planner', code: 'w', judge: 'planner' }, context_files: ['SPEC.md'] }, {
    'SPEC.md': '# v1\n',
    'cortex.goal.json': '{"id":"rev","objective":"old"}\n',
  });
  assert.equal(await orch.run(), 'done');
  store.revise('rev', { summary: 'Also write c.txt', objective: 'Test goal, plus c.txt', spec_md: '# v2\n- c.txt too', acceptance: [{ kind: 'command', run: 'test -f c.txt' }] });

  const again = new Orchestrator({ store, goal: { ...store.goal('rev')!.config, objective: 'Test goal' }, projectDir: store.goal('rev')!.project_dir, stateDir, agents: { planner: p, w: worker('w', 'p1') }, pollMs: 20 });
  assert.equal(await again.run(), 'done', 'the revision reopens the done goal and finishes it');
  assert.equal(seen.length, 1, 'planned with once');
  assert.match(seen[0], /Also write c\.txt/);
  assert.match(seen[0], /\+# v2/, 'the planner sees the spec diff');
  const integration = join(stateDir, 'integration');
  assert.equal(readFileSync(join(integration, 'SPEC.md'), 'utf8'), '# v2\n- c.txt too\n');
  assert.equal(JSON.parse(readFileSync(join(integration, 'cortex.goal.json'), 'utf8')).objective, 'Test goal, plus c.txt');
  assert.ok(existsSync(join(integration, 'c.txt')));
  assert.equal(store.goal('rev')!.config.objective, 'Test goal, plus c.txt', 'the revision outlives the stale goal file');
  assert.equal(store.events('rev', 10, 'acceptance').at(-1)!.data.pass, true);
  assert.equal(store.countEvents('rev', 'spec.revised'), 1);
});
