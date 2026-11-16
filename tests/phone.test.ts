import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { PhoneLink, type PhoneConfig } from '../src/phone.ts';
import { Notifier } from '../src/notify.ts';
import type { GoalConfig } from '../src/types.ts';

const cfg: PhoneConfig = { server: 'https://ntfy.test', topic: 'cortex-secret' };

/** A fake ntfy: records pushes, serves queued replies to polls after their `since`. */
function fakeNtfy() {
  const pushes: any[] = [];
  const inbox: { id: string; time: number; event: string; message: string; tags?: string[] }[] = [];
  let n = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      pushes.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }
    const since = new URL(u).searchParams.get('since')!;
    const i = inbox.findIndex((m) => m.id === since);
    const after = i >= 0 ? inbox.slice(i + 1) : inbox.filter((m) => m.time >= Number(since));
    return new Response(after.map((m) => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
  }) as typeof fetch;
  const reply = (message: string, tags?: string[]) => inbox.push({ id: `m${++n}`, time: Math.floor(Date.now() / 1000) + 1, event: 'message', message, tags });
  return { f, pushes, reply };
}

function store() {
  const s = new Store(join(mkdtempSync(join(tmpdir(), 'cortex-phone-')), 'state.db'));
  s.upsertGoal({ id: 'g', objective: 'x', acceptance: [], agents: {}, routing: {}, budget: { usd_total: 10 } } as unknown as GoalConfig, '/tmp');
  s.insertTask({ id: 'h-source', goal_id: 'g', title: 'Pick a source', kind: 'human', brief: 'A or B?', deps: [], evals: [], agent: null, status: 'needs_human' });
  return s;
}

test('questions, problems and results reach the phone; routine info does not', async () => {
  const { f, pushes } = fakeNtfy();
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const n = new Notifier('g', mkdtempSync(join(tmpdir(), 'cortex-n-')), { macos: false }, cfg);
    await n.send('info', '✓ t1 passed');
    await n.send('needs_human', 'Question (h-source); other work continues', 'A or B?\n  → cortex answer g h-source "<your answer>"');
    await n.send('done', 'Goal complete');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].topic, 'cortex-secret');
    assert.equal(pushes[0].priority, 4);
    assert.match(pushes[0].message, /Reply here: h-source <your answer>/);
    assert.ok(pushes.every((p) => p.tags.includes('cortex')), 'our pushes are tagged so replies skip them');
    const off = new Notifier('g', mkdtempSync(join(tmpdir(), 'cortex-n-')), { macos: false, phone: false }, cfg);
    await off.send('done', 'x');
    assert.equal(pushes.length, 2, 'notify.phone=false keeps a goal off the phone');
  } finally {
    globalThis.fetch = saved;
  }
});

test('replies from the phone answer questions, steer, pause and report status, each once', async () => {
  const s = store();
  const { f, pushes, reply } = fakeNtfy();
  const link = new PhoneLink(s, 'g', cfg, f);
  reply('Cortex: a question', ['question', 'cortex']); // our own push: ignored
  reply('h-sou B, the free one');
  reply('steer skip the docs work');
  reply('pause');
  reply('status');
  reply('other-goal pause');
  await link.poll();
  assert.equal(s.task('g', 'h-source')?.human_answer, 'B, the free one', 'a unique id prefix works');
  assert.equal(s.events('g', 5, 'human.steer')[0].data.text, 'skip the docs work');
  assert.equal(s.control('g'), 'pause');
  assert.equal(pushes.length, 4, 'one confirmation per handled message; nothing for another goal or our own push');
  assert.match(pushes[3].message, /Waiting on you|passed/);
  await link.poll();
  assert.equal(pushes.length, 4, 'nothing is handled twice');
  const again = new PhoneLink(s, 'g', cfg, f);
  await again.poll();
  assert.equal(pushes.length, 4, 'nor after a restart');
  reply('g resume');
  await again.poll();
  assert.equal(s.control('g'), 'run', '"<goal> resume" targets this goal');
});
