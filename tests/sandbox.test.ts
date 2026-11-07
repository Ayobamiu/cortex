import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfile, makeSandbox, sandboxAvailable, sandboxEnv } from '../src/sandbox.ts';
import { sh } from '../src/proc.ts';

const skip = !sandboxAvailable();
const H = homedir();

test('writes are confined to the declared folders', { skip }, async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-sbx-')));
  const sb = makeSandbox({ writable: [work], readable: [work] })!;
  const escape = join(H, `.cortex-sbx-escape-${process.pid}`);
  const p = await sh(`echo ok > inside.txt && echo x > ${escape}`, { cwd: work, sandbox: sb, timeoutMs: 20000 });
  assert.equal(existsSync(join(work, 'inside.txt')), true);
  assert.notEqual(p.code, 0);
  assert.equal(existsSync(escape), false, 'nothing may be written to the home folder');
  rmSync(escape, { force: true });
});

test('credentials and other folders are unreadable; declared ones are readable', { skip }, async () => {
  const secretDir = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-sbx-secret-')));
  writeFileSync(join(secretDir, 'key'), 'hunter2');
  const sb = makeSandbox({ writable: [], readable: [] }, { extra_read_deny: [secretDir] })!;
  assert.notEqual((await sh(`cat ${secretDir}/key`, { sandbox: sb, timeoutMs: 20000 })).code, 0);
  assert.notEqual((await sh(`ls ${H}/Documents`, { sandbox: sb, timeoutMs: 20000 })).code, 0, '~/Documents listing is hidden');
  const allowed = makeSandbox({ writable: [], readable: [] }, { extra_read_deny: [secretDir], extra_readable: [secretDir] })!;
  assert.equal((await sh(`cat ${secretDir}/key`, { sandbox: allowed, timeoutMs: 20000 })).stdout.trim(), 'hunter2');
});

test('the SSH agent and secret-looking env vars are removed', { skip }, async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { GITHUB_TOKEN: 't', MY_API_KEY: 'k', SSH_AUTH_SOCK: '/tmp/x', KEEP_ME: 'yes', NEEDED_TOKEN: 'n' });
  try {
    const env = sandboxEnv({ pass_env: ['NEEDED_TOKEN'] });
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.MY_API_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.KEEP_ME, 'yes');
    assert.equal(env.NEEDED_TOKEN, 'n', 'pass_env keeps a needed credential');
    assert.equal(env.DISABLE_AUTOUPDATER, '1');
  } finally {
    process.env = saved;
  }
});

test('the profile never makes agent binaries writable, and can be disabled', () => {
  const profile = buildProfile({ writable: ['/w'], readable: [] });
  assert.doesNotMatch(profile, /\.local\/bin"/);
  assert.doesNotMatch(profile, /\.local\/share\/claude"/);
  assert.equal(makeSandbox({ writable: [], readable: [] }, { enabled: false }), undefined);
});
