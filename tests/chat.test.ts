import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Store } from '../src/db.ts';
import { Chat, renderLive, renderEvent } from '../src/chat.ts';
import { liveLog } from '../src/agents/index.ts';
import type { GoalConfig } from '../src/types.ts';

process.env.CORTEX_PHONE = 'off'; // never push to a real phone from tests

test('live steps from Claude and Cursor streams read as one line each', () => {
  const claude = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'uv run pytest -q' } }] } };
  const cursor = { type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: '/a/b/c/d/popindex/x.py' } } } };
  assert.equal(renderLive(JSON.stringify(claude)), 'Bash: uv run pytest -q');
  assert.equal(renderLive(JSON.stringify(cursor)), 'Edit: d/popindex/x.py');
  assert.equal(renderLive('{"type":"thinking","subtype":"delta","text":"hm"}'), null);
  assert.equal(renderEvent({ id: 1, ts: new Date().toISOString(), goal_id: 'g', task_id: 't', type: 'agent.usage', data: {} }), null, 'bookkeeping stays hidden');
});

test('chat shows the run, follows a running agent, and answers, steers and pauses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-chat-'));
  const store = new Store(join(dir, 'state.db'));
  const cfg = { id: 'g', objective: 'Test goal', acceptance: [], agents: {}, routing: {} } as unknown as GoalConfig;
  store.upsertGoal(cfg, dir);
  store.insertTask({ id: 'q1', goal_id: 'g', title: 'Pick a source', kind: 'human', brief: 'A or B?', deps: [], evals: [], agent: null, status: 'needs_human' });
  store.insertTask({ id: 'w1', goal_id: 'g', title: 'Build it', kind: 'code', brief: 'build', deps: [], evals: [], agent: null, status: 'pending' });
  store.updateTask('g', 'w1', { status: 'running', attempts: 1 });
  const log = join(dir, 'logs', 'w1-1-claude.log');
  store.event('g', 'attempt.started', { attempt: 1, agent: 'claude', log }, 'w1');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(liveLog(log), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/SPEC.md' } }] } }) + '\n');

  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  let started = 0;
  const chat = new Chat({ store, goalId: 'g', stateDir: dir, pollMs: 20, input, output, startRun: async () => (started++, 'started') }).start();
  const say = async (l: string) => {
    input.write(l + '\n');
    await new Promise((r) => setTimeout(r, 60));
  };
  await say('/show q1');
  await say('/answer q1 B, because it is free');
  await say('/steer skip W8');
  await say('/pause');
  await say('/resume');
  await say('/tasks');
  await say('/quit');
  await chat;

  assert.match(text, /q1: Pick a source/, 'open questions show up front');
  assert.match(text, /w1 on claude/, 'running work shows up front');
  assert.match(text, /w1 · Read: \/p\/SPEC\.md/, 'the running agent’s steps are visible');
  assert.match(text, /A or B\?/, '/show prints the brief');
  assert.equal(store.task('g', 'q1')?.status, 'passed');
  assert.equal(store.task('g', 'q1')?.human_answer, 'B, because it is free');
  assert.equal(store.events('g', 10, 'human.steer')[0].data.text, 'skip W8');
  assert.equal(store.control('g'), 'run', 'resume after pause');
  assert.equal(started, 1, 'resume starts the run when no orchestrator is alive');
  assert.match(text, /answer recorded for q1/, 'new events stream into the thread');
});

test('chat: talk a question through, then agree a goal change; it shows the spec diff and sends it on y', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-chat-'));
  const store = new Store(join(dir, 'state.db'));
  store.upsertGoal({ id: 'g', objective: 'Index songs', acceptance: [{ kind: 'command', run: 'npm test' }], context_files: ['SPEC.md'], agents: {}, routing: {} } as unknown as GoalConfig, dir);
  store.insertTask({ id: 'q1', goal_id: 'g', title: 'Pick a source', kind: 'human', brief: 'Spotify API or scraping charts?', deps: [], evals: [], agent: null, status: 'needs_human' });
  writeFileSync(join(dir, 'SPEC.md'), '# Songs\n- weekly index\n');
  const prompts: string[] = [];
  const turns = [
    { reply: 'Spotify needs your keys; charts are free but coarse. I recommend charts.', action: { type: 'none' } },
    { reply: 'Daily means 7x the runs; doable.', action: { type: 'none' } },
    { reply: 'Agreed: daily.', action: { type: 'revise', text: 'Daily instead of weekly', spec_md: '# Songs\n- daily index\n', acceptance: [{ kind: 'judge', criterion: 'Updates daily' }] } },
  ];
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const chat = new Chat({
    store, goalId: 'g', stateDir: dir, pollMs: 20, input, output, startRun: async () => 'started',
    assistant: async (_args, prompt) => (prompts.push(prompt), { structured_output: turns.shift(), total_cost_usd: 0 }),
  }).start();
  const say = async (l: string) => {
    input.write(l + '\n');
    await new Promise((r) => setTimeout(r, 60));
  };
  await say('/discuss q1');
  await say('can we make it daily instead?');
  await say('yes do it');
  await say('y');
  await say('/quit');
  await chat;

  assert.match(prompts[0], /Help me decide on q1/);
  assert.match(prompts[0], /Spotify API or scraping charts\?/, 'the waiting question’s brief is in context');
  assert.match(prompts[0], /propose the revise action only once you both agree/);
  assert.match(text, /I recommend charts/);
  assert.match(text, /-- weekly index/, 'the spec diff shows what goes');
  assert.match(text, /\+- daily index/, 'and what comes');
  assert.match(text, /Do it\? revise the goal: “Daily instead of weekly”/);
  const rev = store.events('g', 5, 'human.revise')[0];
  assert.equal(rev.data.spec_md, '# Songs\n- daily index\n');
  assert.equal((rev.data.acceptance as any[])[0].criterion, 'Updates daily');
  assert.equal(rev.data.objective, undefined, 'unchanged parts stay out');
  assert.equal(store.task('g', 'q1')?.status, 'needs_human', 'discussing does not answer');
});
