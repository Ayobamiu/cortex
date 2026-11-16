import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Store } from './db.ts';

/**
 * Your phone, through ntfy (https://ntfy.sh, free, no account): Cortex pushes questions,
 * problems and results to a private topic, and you can reply in the same topic from the ntfy
 * app ("h-w3 option B", "pause", "status"). The topic name is the only key, so it is long and
 * random; keep it to yourself. Configured once per machine in ~/.cortex/config.json:
 *   { "phone": { "server": "https://ntfy.sh", "topic": "cortex-…" } }
 */

export interface PhoneConfig {
  server: string;
  topic: string;
}

type Fetch = typeof fetch;
const configFile = () => join(process.env.CORTEX_HOME ?? join(homedir(), '.cortex'), 'config.json');
/** Marks our own pushes so the reply listener skips them. */
const OUT_TAG = 'cortex';

export function loadPhone(): PhoneConfig | undefined {
  if (process.env.CORTEX_PHONE === 'off') return undefined; // tests, or a one-off quiet run
  try {
    const p = JSON.parse(readFileSync(configFile(), 'utf8')).phone;
    return p?.topic ? { server: (p.server ?? 'https://ntfy.sh').replace(/\/$/, ''), topic: p.topic } : undefined;
  } catch {
    return undefined;
  }
}

export function savePhone(p: PhoneConfig | null) {
  const f = configFile();
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(f, 'utf8'));
  } catch {}
  if (p) cfg.phone = p;
  else delete cfg.phone;
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export const newTopic = () => `cortex-${randomBytes(12).toString('hex')}`;

export async function push(p: PhoneConfig, msg: { title: string; body: string; priority?: number; tags?: string[] }, f: Fetch = fetch): Promise<boolean> {
  try {
    const r = await f(p.server, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: p.topic, title: msg.title.slice(0, 250), message: msg.body.slice(0, 3500) || msg.title, priority: msg.priority ?? 3, tags: [...(msg.tags ?? []), OUT_TAG] }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

interface NtfyMessage {
  id: string;
  time: number;
  event: string;
  message?: string;
  tags?: string[];
}

/**
 * Listens to the topic for your replies while a run is live, and acts on the ones meant for this
 * goal. Each message is handled once, even across restarts (handled ids are in the event log).
 */
export class PhoneLink {
  private store: Store;
  private goalId: string;
  private cfg: PhoneConfig;
  private f: Fetch;
  private since: string;
  private busy = false;

  constructor(store: Store, goalId: string, cfg: PhoneConfig, f: Fetch = fetch) {
    this.store = store;
    this.goalId = goalId;
    this.cfg = cfg;
    this.f = f;
    const last = store.events(goalId, 1, 'phone.handled')[0];
    // First time: only messages from now on, so old chatter in the topic is never replayed.
    this.since = last ? String(last.data.id) : String(Math.floor(Date.now() / 1000));
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.f(`${this.cfg.server}/${this.cfg.topic}/json?poll=1&since=${encodeURIComponent(this.since)}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      const msgs = (await r.text())
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as NtfyMessage;
          } catch {
            return undefined;
          }
        })
        .filter((m): m is NtfyMessage => !!m && m.event === 'message');
      for (const m of msgs) {
        this.since = m.id;
        if (m.tags?.includes(OUT_TAG) || !m.message?.trim()) continue;
        const reply = this.handle(m.message.trim());
        if (reply === null) continue;
        this.store.event(this.goalId, 'phone.handled', { id: m.id, text: m.message.slice(0, 500) });
        await push(this.cfg, { title: `cortex · ${this.goalId}`, body: reply, priority: 2 }, this.f);
      }
    } catch {
      // Offline or ntfy down: try again next poll.
    } finally {
      this.busy = false;
    }
  }

  /** Your message → what it did, or null when it isn't for this goal. */
  handle(text: string): string | null {
    let [word, ...rest] = text.split(/\s+/);
    let arg = text.slice(word.length).trim();
    // "<goal-id> pause" etc. targets one goal; without a goal id, a command applies to every live run.
    if (word === this.goalId && rest.length) {
      [word, ...rest] = arg.split(/\s+/);
      arg = arg.slice(word.length).trim();
    }
    const cmd = word.toLowerCase();
    switch (cmd) {
      case 'help':
      case '?':
        return `Reply with:\n<task-id> <answer> — answer a question\nstatus — where it is\npause · resume · stop\nsteer <instruction> — tell the planner\nPrefix with a goal id when several runs are live (${this.goalId} pause).`;
      case 'status':
        return this.status();
      case 'pause':
      case 'resume':
      case 'stop':
        this.store.setControl(this.goalId, cmd);
        return cmd === 'pause' ? 'Pausing: running tasks finish, nothing new starts. Reply "resume" to go on.' : cmd === 'resume' ? 'Resuming.' : 'Stopping after running tasks finish. Resume from the Mac: cortex resume ' + this.goalId;
      case 'steer':
        if (!arg) return 'Steer with what? e.g. "steer skip the docs work"';
        this.store.steer(this.goalId, arg);
        return 'Sent to the planner; it replans with it next.';
    }
    // "<task-id> <answer>": only tasks of this goal that are waiting on you.
    const tasks = this.store.tasks(this.goalId);
    const t = tasks.find((x) => x.id === word) ?? (word.length >= 4 ? tasks.filter((x) => x.id.startsWith(word)) : []).at(0);
    if (!t) return null;
    if (!arg) return `What's your answer for ${t.id}? Reply "${t.id} <answer>".`;
    try {
      this.store.answer(this.goalId, t.id, arg);
      return `Answered ${t.id}: “${arg.slice(0, 200)}”`;
    } catch (e: any) {
      return `Couldn't answer ${t.id}: ${e?.message ?? e}`;
    }
  }

  private status(): string {
    const g = this.store.goal(this.goalId)!;
    const tasks = this.store.tasks(this.goalId);
    const n = (s: string) => tasks.filter((t) => t.status === s).length;
    const running = tasks.filter((t) => t.status === 'running').map((t) => t.id);
    const waiting = tasks.filter((t) => t.status === 'needs_human').map((t) => t.id);
    const b = g.config.budget ?? {};
    return [
      `${g.status} · $${this.store.spent(this.goalId).toFixed(2)}${b.usd_total ? ` of $${b.usd_total}` : ''} · ${this.store.activeHours(this.goalId).toFixed(1)} working h`,
      `${n('passed')} passed · ${n('running')} running · ${n('pending')} pending`,
      running.length ? `Running: ${running.join(', ')}` : '',
      waiting.length ? `Waiting on you: ${waiting.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

export const phoneSetupText = (p: PhoneConfig) => `Phone notifications are on.

1. Install the free "ntfy" app (App Store or Google Play).
2. In the app, tap + and subscribe to this topic (server: ${p.server}):

   ${p.topic}

   Treat it like a password: anyone with the name can read your pushes and reply to your runs.
3. You'll get questions, problems (lost logins, failures, budget at 80%), checkpoints and results.
   Reply in the same topic: "<task-id> <answer>", "status", "pause", "resume", "steer <instruction>", "help".

Note: pushes go through ${p.server} and include task titles and questions.
Test again: cortex phone test · Turn off: cortex phone off`;

export const phoneConfigured = () => existsSync(configFile()) && !!loadPhone();
