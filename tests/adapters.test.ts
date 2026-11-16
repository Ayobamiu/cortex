import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeAgent } from '../src/agents/claude.ts';
import { cursorAgent } from '../src/agents/cursor.ts';

const bin = resolve(import.meta.dirname, 'fixtures', 'bin');
const dir = mkdtempSync(join(tmpdir(), 'cortex-adapters-'));

/** Runs `fn` with the fake CLIs first on PATH and the given fake mode. */
async function withFakes<T>(mode: string, fn: (argsFile: string) => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, FAKE_MODE: process.env.FAKE_MODE, FAKE_ARGS_FILE: process.env.FAKE_ARGS_FILE };
  const argsFile = join(dir, `args-${Math.random().toString(36).slice(2)}.json`);
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, FAKE_MODE: mode, FAKE_ARGS_FILE: argsFile });
  try {
    return await fn(argsFile);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const req = (logName: string, jsonSchema?: object) => ({ prompt: 'p', cwd: dir, timeoutMs: 20000, logFile: join(dir, logName), jsonSchema });

test('claude adapter reads result, structured output, cost and usage windows from the stream', async () => {
  await withFakes('ok', async (argsFile) => {
    const r = await claudeAgent('c', { adapter: 'claude', model: 'opus' }).run(req('c.log', { type: 'object' }));
    assert.equal(r.ok, true);
    assert.equal(r.output, 'done');
    assert.deepEqual(r.structured, { pass: true, reason: 'ok' });
    assert.equal(r.costUsd, 0.25);
    assert.deepEqual(r.usage?.map((w) => [w.window, w.utilization]), [['five_hour', 0.42], ['seven_day', 0.18]]);
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.ok(args.includes('stream-json') && args.includes('--verbose') && args.includes('--json-schema'));
    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });
});

test('claude adapter treats a rejected usage window as a rate limit until its reset', async () => {
  await withFakes('rejected', async () => {
    const r = await claudeAgent('c', { adapter: 'claude' }).run(req('c2.log'));
    assert.equal(r.ok, false);
    assert.ok(r.rateLimited, 'should be rate limited');
    assert.ok(r.rateLimited!.untilMs > Date.now() + 3500 * 1000, 'waits for the window reset');
    assert.equal(r.usage?.find((w) => w.window === 'five_hour')?.utilization, 1);
  });
});

test('cursor adapter defaults to the auto model, passes extra args, and parses a JSON verdict', async () => {
  await withFakes('ok', async (argsFile) => {
    const r = await cursorAgent('cur', { adapter: 'cursor', extra_args: ['--mode', 'ask'] }).run(req('cur.log', { type: 'object' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.structured, { pass: false, reason: 'nope' });
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--model', 'auto', '--mode', 'ask']);
  });
});

test('agents stream their output to a live file while running, removed once the full log is written', async () => {
  await withFakes('ok', async () => {
    const { liveLog } = await import('../src/agents/index.ts');
    const r = req('live.log');
    await cursorAgent('cur', { adapter: 'cursor' }).run(r);
    assert.equal(existsSync(liveLog(r.logFile)), false, 'live file is temporary');
    assert.match(readFileSync(r.logFile, 'utf8'), /tool_call/, 'full log keeps the stream');
  });
});

test('cursor adapter recognizes "out of usage" as a provider limit', async () => {
  await withFakes('limit', async () => {
    const r = await cursorAgent('cur', { adapter: 'cursor', model: 'gpt-5.3-codex' }).run(req('cur2.log'));
    assert.equal(r.ok, false);
    assert.ok(r.rateLimited, 'out of usage must rest the agent, not count as a failure');
  });
});
