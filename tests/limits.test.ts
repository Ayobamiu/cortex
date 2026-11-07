import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRateLimit } from '../src/agents/limits.ts';

const now = Date.parse('2026-11-06T10:00:00');

test('parses Claude epoch format', () => {
  const reset = now / 1000 + 3600;
  assert.equal(detectRateLimit(`Claude AI usage limit reached|${reset}`, now), reset * 1000 + 60000);
  // A reset time already in the past still waits the minimum floor.
  assert.equal(detectRateLimit(`Claude AI usage limit reached|${now / 1000 - 10}`, now), now + 60000);
});

test('parses relative resets', () => {
  assert.equal(detectRateLimit("You've hit your limit · resets in 2h 15m", now), now + (135 + 1) * 60000);
});

test('parses clock resets (next occurrence)', () => {
  const t = new Date(detectRateLimit("You've hit your limit · resets 3pm", now)!);
  assert.equal(t.getHours(), 15);
  assert.equal(t.getMinutes(), 1);
});

test('unknown reset time defaults to 30 min', () => {
  assert.equal(detectRateLimit('rate_limit_error: quota exceeded', now), now + 30 * 60000);
});

test("a worker's own HTTP throttling is NOT a provider limit", () => {
  assert.equal(detectRateLimit('HTTP 429 for https://wikimedia.org/...; backing off 36s (rate limit)', now), undefined);
  assert.equal(detectRateLimit('Too many requests from GDELT, retrying', now), undefined);
  assert.equal(detectRateLimit('tests failed: 3 errors', now), undefined);
});
