import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { newProject, type Draft, type Llm } from '../src/new.ts';

const draft = (over: Partial<Draft> = {}): Draft => ({
  questions: [], id: 'Price Tracker!', objective: 'Track prices.', spec_md: '# Price tracker\n- [ ] scrape', summary: 'A price tracker.',
  acceptance: [{ kind: 'command', run: 'npm test' }, { kind: 'judge', criterion: 'Works.' }, { kind: 'command' }], budget_usd: 30.4, max_hours: 24, ...over,
});

test('cortex new: describe, answer its questions, ask for a change, confirm; it creates a committed project and starts it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-new-'));
  const prompts: string[] = [];
  const replies = [draft({ questions: ['Which sites?'] }), draft({ budget_usd: 20 }), draft()];
  const llm: Llm = async (p) => (prompts.push(p), { draft: replies.shift() });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  let started: string | undefined;
  for (const l of ['Amazon and eBay', 'make the budget 30', 'y']) input.write(l + '\n');
  const dir = await newProject({ idea: 'track prices for me', parent, llm, input, output, start: async (d) => void (started = d) });

  assert.equal(dir, join(parent, 'price-tracker'));
  assert.equal(started, dir);
  assert.match(prompts[0], /track prices for me/);
  assert.match(prompts[1], /Amazon and eBay/);
  assert.match(prompts[2], /make the budget 30/);
  assert.match(text, /Which sites\?/);
  const goal = JSON.parse(readFileSync(join(dir!, 'cortex.goal.json'), 'utf8'));
  assert.equal(goal.id, 'price-tracker');
  assert.equal(goal.budget.usd_total, 30);
  assert.equal(goal.acceptance.length, 2, 'incomplete checks are dropped');
  assert.deepEqual(goal.routing.code, ['cursor', 'claude']);
  assert.match(goal.objective, /decisions\//);
  assert.ok(existsSync(join(dir!, 'SPEC.md')));
  assert.equal(execFileSync('git', ['-C', dir!, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'everything committed');
});

test('cortex new: saying no creates nothing', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-new-'));
  const input = new PassThrough();
  input.write('n\n');
  const dir = await newProject({ idea: 'x', parent, llm: async () => ({ draft: draft() }), input, output: new PassThrough(), start: async () => assert.fail('must not start') });
  assert.equal(dir, null);
  assert.equal(existsSync(join(parent, 'price-tracker')), false);
});
