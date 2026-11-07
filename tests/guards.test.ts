import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGuards } from '../src/guards.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-guards-'));
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'locked'));
  writeFileSync(join(dir, 'tests', 'test_core.py'), 'def test(): pass\n');
  writeFileSync(join(dir, 'locked', 'contract.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
const commit = (dir: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'attempt');
};

test('clean change passes', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'a.py'), 'x = 1\n');
  commit(dir);
  assert.deepEqual(await runGuards(dir, base, ['locked/']), { problems: [], escalate: [] });
});

test('leaked credentials fail the attempt', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'config.py'), `KEY = "sk-ant-api03-${'a'.repeat(40)}"\nAWS = "AKIA${'B'.repeat(16)}"\n`);
  commit(dir);
  const g = await runGuards(dir, base);
  assert.equal(g.problems.length, 2);
  assert.match(g.problems.join(' '), /Anthropic API key/);
  assert.match(g.problems.join(' '), /AWS access key/);
});

test('a secret that existed before the attempt is not blamed on it', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'old.py'), `K = "ghp_${'c'.repeat(36)}"\n`);
  commit(dir);
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'b.py'), 'y = 2\n');
  commit(dir);
  assert.deepEqual((await runGuards(dir, base)).problems, []);
});

test('protected paths: directory prefix and exact file', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'locked', 'contract.txt'), 'v2\n');
  writeFileSync(join(dir, 'SPEC.md'), 'changed\n');
  commit(dir);
  const g = await runGuards(dir, base, ['locked/', 'SPEC.md']);
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /locked\/contract\.txt/);
  assert.match(g.problems[0], /SPEC\.md/);
});

test('deleting a test escalates review instead of failing', async () => {
  const { dir, base } = repo();
  rmSync(join(dir, 'tests', 'test_core.py'));
  commit(dir);
  const g = await runGuards(dir, base);
  assert.deepEqual(g.problems, []);
  assert.match(g.escalate[0], /tests\/test_core\.py/);
});

test('files over 50 MB fail', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(51e6));
  commit(dir);
  assert.match((await runGuards(dir, base)).problems[0], /big\.bin is 51 MB/);
});
