import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { newProject, type Draft, type Llm, type Turn } from '../src/new.ts';

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'Price Tracker!', objective: 'Track prices.', spec_md: '# Price tracker\n- [ ] scrape', summary: 'A price tracker.',
  acceptance: [{ kind: 'command', run: 'npm test' }, { kind: 'judge', criterion: 'Works.' }, { kind: 'command' }], budget_usd: 30.4, max_hours: 24, ...over,
});
const ready = (over: Partial<Draft> = {}, reply = 'Here it is.'): Turn => ({ reply, ready: true, draft: draft(over) });
const talk = (reply: string): Turn => ({ reply, ready: false });

function io(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen = { text: '' };
  output.on('data', (d) => (seen.text += d));
  for (const l of lines) input.write(l + '\n');
  return { input, output, seen };
}

test('cortex new: a back-and-forth until the idea is sound, then confirm; it creates a committed project and starts it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-new-'));
  const prompts: string[] = [];
  const replies = [
    talk('Scraping Amazon breaks their terms and gets blocked. Which sites, and is an official API OK?'),
    talk('Keepa has an Amazon price API (paid). eBay has a free one. Want both?'),
    ready({ budget_usd: 20 }),
    talk('A bigger budget buys more retries; 30 is fine.'),
    ready(),
  ];
  const llm: Llm = async (p) => (prompts.push(p), { turn: replies.shift() });
  const { input, output, seen } = io(['what are my options?', 'eBay only, free', 'why 20?', 'make it 30', 's', 'y']);
  let started: string | undefined;
  const dir = await newProject({ idea: 'track prices for me', parent, llm, input, output, start: async (d) => void (started = d) });

  assert.equal(dir, join(parent, 'price-tracker'));
  assert.equal(started, dir);
  assert.equal(prompts.length, 5, 'one Claude turn per message; showing the spec costs none');
  assert.match(prompts[0], /track prices for me/);
  assert.match(prompts[0], /Push back/);
  assert.match(prompts[1], /Owner: what are my options\?/);
  assert.match(prompts[3], /Owner: why 20\?/, 'a question after the draft is discussed, not a forced redraft');
  assert.match(seen.text, /breaks their terms/);
  assert.match(seen.text, /Keepa/);
  assert.match(seen.text, /# Price tracker/);
  const goal = JSON.parse(readFileSync(join(dir!, 'cortex.goal.json'), 'utf8'));
  assert.equal(goal.id, 'price-tracker');
  assert.equal(goal.budget.usd_total, 30, 'the latest draft is the one created');
  assert.equal(goal.acceptance.length, 2, 'incomplete checks are dropped');
  assert.deepEqual(goal.routing.code, ['cursor', 'claude']);
  assert.match(goal.objective, /decisions\//);
  assert.ok(existsSync(join(dir!, 'SPEC.md')));
  assert.equal(execFileSync('git', ['-C', dir!, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'everything committed');
});

test('cortex new: y before it is ready asks Claude to settle the rest and draft; it still waits for your confirmation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-new-'));
  const prompts: string[] = [];
  const replies = [talk('Which sites?'), ready()];
  const { input, output } = io(['y', 'n']);
  const dir = await newProject({ idea: 'x', parent, llm: async (p) => (prompts.push(p), { turn: replies.shift() }), input, output, start: async () => assert.fail('must not start') });
  assert.match(prompts[1], /settle the remaining open points yourself/);
  assert.equal(dir, null);
});

test('cortex new: saying no creates nothing', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-new-'));
  const { input, output } = io(['n']);
  const dir = await newProject({ idea: 'x', parent, llm: async () => ({ turn: ready() }), input, output, start: async () => assert.fail('must not start') });
  assert.equal(dir, null);
  assert.equal(existsSync(join(parent, 'price-tracker')), false);
});
