import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.ts';

export type Level = 'info' | 'warn' | 'needs_human' | 'done';

/** Callbacks out of the run: terminal log, notify.log, macOS notification, optional webhook. */
export class Notifier {
  private goalId: string;
  private stateDir: string;
  private opts: { macos?: boolean; webhook?: string };

  constructor(goalId: string, stateDir: string, opts: { macos?: boolean; webhook?: string } = {}) {
    this.goalId = goalId;
    this.stateDir = stateDir;
    this.opts = opts;
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
