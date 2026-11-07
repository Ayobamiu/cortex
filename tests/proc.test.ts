import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/proc.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a timeout kills the whole tree, including children in their own process group (as Muse does)', async () => {
  // Parent prints the pid of a detached grandchild, then hangs.
  const script = `const c = require('child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const p = await run('node', ['-e', script], { timeoutMs: 1500 });
  assert.equal(p.timedOut, true);
  const grandchild = Number(p.stdout.trim());
  assert.ok(grandchild > 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(grandchild), false, 'the detached grandchild must not outlive the attempt');
});

test('normal exit returns output and code', async () => {
  const p = await run('sh', ['-c', 'echo hi; echo err >&2; exit 3'], { timeoutMs: 5000 });
  assert.deepEqual([p.code, p.stdout.trim(), p.stderr.trim(), p.timedOut], [3, 'hi', 'err', false]);
});
