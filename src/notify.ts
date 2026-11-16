import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.ts';
import { loadPhone, push, buttonsFor, type PhoneConfig } from './phone.ts';

export type Level = 'info' | 'warn' | 'needs_human' | 'done';

const PHONE: Partial<Record<Level, { priority: number; tags: string[] }>> = {
  needs_human: { priority: 4, tags: ['question'] },
  warn: { priority: 3, tags: ['warning'] },
  done: { priority: 4, tags: ['tada'] },
};

/** Callbacks out of the run: terminal log, notify.log, macOS notification, your phone (ntfy), optional webhook. */
export class Notifier {
  private goalId: string;
  private stateDir: string;
  private opts: { macos?: boolean; webhook?: string; phone?: boolean };
  private phone?: PhoneConfig;

  constructor(goalId: string, stateDir: string, opts: { macos?: boolean; webhook?: string; phone?: boolean } = {}, phone: PhoneConfig | null | undefined = loadPhone()) {
    this.goalId = goalId;
    this.stateDir = stateDir;
    this.opts = opts;
    this.phone = opts.phone === false || !phone ? undefined : phone;
    mkdirSync(stateDir, { recursive: true });
  }

  async send(level: Level, title: string, body = '') {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${title}${body ? `\n${body}` : ''}\n`;
    process.stdout.write(line);
    appendFileSync(join(this.stateDir, 'notify.log'), line);
    if (this.opts.macos !== false && process.platform === 'darwin' && level !== 'info') {
      await run('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run',
        `cortex · ${this.goalId}`, `${title}${body ? ' — ' + body.slice(0, 180) : ''}`,
      ]);
    }
    const ph = PHONE[level];
    if (this.phone && ph) {
      // On the phone you answer by replying in the topic, not with the CLI.
      const phoneBody = body.replace(/(?:→ )?cortex answer \S+ (\S+) "<[^>]+>"/g, 'Reply here: $1 <your answer>');
      // One question per push gets its buttons; a list of several just links to the topic.
      const asked = [...phoneBody.matchAll(/Reply here: (\S+) /g)].map((m) => m[1]);
      const kind = asked.length === 1 ? 'question' : level === 'done' ? 'done' : 'problem';
      await push(this.phone, { title: `${this.goalId}: ${title}`, body: phoneBody, ...ph, buttons: buttonsFor(this.phone, this.goalId, kind, asked[0]) });
    }
    if (this.opts.webhook) {
      try {
        await fetch(this.opts.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal: this.goalId, level, title, body, text: `[cortex:${this.goalId}] ${title}\n${body}` }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {}
    }
  }
}
