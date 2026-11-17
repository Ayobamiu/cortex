import { createInterface, type Interface } from 'node:readline';
import { existsSync, openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store, EventRow } from './db.ts';
import type { EvalSpec, Revision, Task } from './types.ts';
import { liveLog } from './agents/index.ts';
import { run, extractJson } from './proc.ts';

/**
 * `cortex chat <goal>`: one terminal thread for a run. Shows what's happening as it happens
 * (task events and each running agent's tool calls), takes commands (/answer, /pause, /steer...),
 * and answers plain-language questions about the run with a read-only Claude that can propose
 * an action for you to confirm. It only reads the state DB and writes control events, so it is
 * safe to open, close, or open twice while the run goes on in the background service.
 */

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), magenta: paint('35'), cyan: paint('36') };
const one = (s: unknown, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const clock = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (ts: string) => {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

/** One readable line per event worth seeing; null hides bookkeeping. */
export function renderEvent(e: EventRow): string | null {
  const d = e.data as Record<string, any>;
  const t = e.task_id ?? '';
  switch (e.type) {
    case 'attempt.started':
      return `${c.blue('▶')} ${c.bold(t)} attempt ${d.attempt} on ${d.agent}`;
    case 'attempt.finished':
      return d.ok ? null : `${c.red('■')} ${t}: ${d.agent} run failed: ${one(d.error, 140)}`;
    case 'eval':
      return d.pass ? `${c.green('✓')} ${c.bold(t)} passed its checks` : `${c.yellow('✗')} ${t} attempt ${d.attempt} failed checks: ${one(String(d.feedback).replace(/^Passed:[^\n]*\n?/gm, ''), 140)}`;
    case 'task.status':
      if (d.status === 'failed') return `${c.red('✗')} ${c.bold(t)} out of retries`;
      if (d.status === 'needs_human') return `${c.magenta('?')} ${c.bold(t)} needs you — /show ${t}`;
      return null;
    case 'question.asked':
      return `${c.magenta('?')} Question ${c.bold(t)} — /discuss ${t} to talk it through, or /answer ${t} <answer>`;
    case 'escalated':
      return `${c.magenta('?')} Cortex needs guidance: ${one(d.why, 120)} — /discuss ${d.task}`;
    case 'plan.started':
      return `${c.cyan('◆')} planning (${d.agent})…`;
    case 'plan':
      return `${c.cyan('◆')} plan updated: +${(d.added ?? []).length} −${(d.cancelled ?? []).length}${d.notes ? c.dim(' · ' + one(d.notes, 120)) : ''}`;
    case 'plan.failed':
      return `${c.red('◆')} planner failed (${d.attempt}/3): ${one(d.error, 120)}`;
    case 'human.answer':
      return `${c.green('↩')} answer recorded for ${t}: ${one(d.text, 100)}`;
    case 'human.revise':
      return `${c.green('✎')} goal revision sent: ${one(d.summary, 120)}`;
    case 'spec.revised':
      return `${c.cyan('✎')} goal revised and committed${(d.files ?? []).length ? ` (${d.files.join(', ')})` : ''}; replanning`;
    case 'human.steer':
      return `${c.green('↪')} instruction for the planner: ${one(d.text, 120)}`;
    case 'control.pause':
      return `${c.yellow('⏸')} pause requested`;
    case 'control.resume':
      return `${c.green('▶')} resume requested`;
    case 'control.stop':
      return `${c.yellow('⏹')} stop requested`;
    case 'goal.status':
      return `${c.bold('●')} run ${c.bold(d.status)}${d.reason ? c.dim(' · ' + one(d.reason, 100)) : ''}`;
    case 'run.started':
      return `${c.bold('●')} orchestrator started`;
    case 'agent.cooldown':
      return `${c.yellow('…')} ${d.agent} resting until ${clock(d.until)}${d.anticipated ? ' (near its usage limit)' : ''}`;
    case 'attempt.rate_limited':
      return `${c.yellow('…')} ${t}: ${d.agent} hit a usage limit; retrying later (not counted)`;
    case 'attempt.interrupted':
      return `${c.yellow('…')} ${t} attempt ${d.attempt} was interrupted; it will resume`;
    case 'judge.broken':
      return `${c.yellow('!')} judge ${d.agent} is broken: ${one(d.why, 100)}`;
    case 'acceptance':
      return d.pass ? `${c.green('★')} final acceptance passed` : `${c.red('★')} final acceptance failed: ${one(String(d.feedback).replace(/^Passed:[^\n]*\n?/gm, ''), 140)}`;
    case 'checkpoint':
      return `${c.cyan('◆')} checkpoint (${d.passed} tasks passed)`;
    case 'disk.low':
      return `${c.red('!')} disk low: ${d.free_gb} GB free (min ${d.min_gb}); new work paused`;
    default:
      return null;
  }
}

/** A running agent's tool calls and messages from its live stream (Claude or Cursor stream-json). */
export function renderLive(line: string): string | null {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const short = (p: unknown) => String(p ?? '').split('/').slice(-3).join('/');
  if (ev.type === 'assistant') {
    const out: string[] = [];
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_use') {
        const i = b.input ?? {};
        const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? '';
        out.push(`${b.name}${arg ? ': ' + one(i.file_path || i.path ? short(arg) : arg, 110) : ''}`);
      } else if (b.type === 'text' && b.text?.trim()) out.push(c.dim('“' + one(b.text, 110) + '”'));
    }
    return out.length ? out.join(' · ') : null;
  }
  if (ev.type === 'tool_call' && ev.subtype === 'started') {
    const [key, v]: [string, any] = Object.entries(ev.tool_call ?? {})[0] ?? ['tool', {}];
    const a = v?.args ?? {};
    const name = key.replace(/ToolCall$/, '');
    const arg = a.command ?? a.path ?? a.pattern ?? a.globPattern ?? a.url ?? a.query ?? '';
    return `${name[0]?.toUpperCase()}${name.slice(1)}${arg ? ': ' + one(a.path ? short(arg) : arg, 110) : ''}`;
  }
  return null;
}

/** Follows a file that only grows, handing back complete new lines. */
class Tail {
  private pos = 0;
  private rest = '';
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  read(): string[] {
    if (!existsSync(this.file)) return [];
    let fd: number;
    try {
      fd = openSync(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.pos) return [];
      const buf = Buffer.alloc(Math.min(size - this.pos, 4 << 20));
      readSync(fd, buf, 0, buf.length, this.pos);
      this.pos += buf.length;
      const lines = (this.rest + buf.toString('utf8')).split('\n');
      this.rest = lines.pop() ?? '';
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}

export interface ChatOptions {
  store: Store;
  goalId: string;
  stateDir: string;
  /** Starts the background run again (service or detached process). Returns what it did. */
  startRun: () => Promise<string>;
  model?: string;
  pollMs?: number;
  /** Runs one assistant turn and returns Claude's JSON result (tests pass a fake). */
  assistant?: (args: string[], prompt: string, cwd: string) => Promise<any>;
  /** Defaults to the terminal (tests pass streams). */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your answer to the owner, plain and short.' },
    action: {
      type: 'object',
      description: 'Only when the owner asked for a change: the one action that does it. The owner confirms before it runs.',
      properties: {
        type: { type: 'string', enum: ['none', 'answer', 'steer', 'revise', 'pause', 'resume', 'stop'] },
        task: { type: 'string', description: 'answer: the task id being answered' },
        text: { type: 'string', description: 'answer: the answer, in the owner’s words where possible. steer: the instruction for the planner. revise: one or two sentences on what changes and why.' },
        objective: { type: 'string', description: 'revise: the whole new objective, only when it changes.' },
        spec_md: { type: 'string', description: 'revise: the whole new spec file, only when it changes (start from the current one; change only what was agreed).' },
        acceptance: {
          type: 'array',
          description: 'revise: the whole new final acceptance, only when it changes.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['command', 'judge'] }, run: { type: 'string' }, criterion: { type: 'string' } }, required: ['kind'] },
        },
      },
      required: ['type'],
    },
  },
  required: ['reply'],
};

type Action = { type: string; task?: string; text?: string; objective?: string; spec_md?: string; acceptance?: EvalSpec[] };

export class Chat {
  private store: Store;
  private goalId: string;
  private stateDir: string;
  private opts: ChatOptions;
  private rl!: Interface;
  private lastEvent = 0;
  private tails = new Map<string, { tail: Tail; label: string }>();
  private live = true;
  private watch: string | null = null;
  private pending: Action | null = null;
  private session = randomUUID();
  private asked = 0;
  private busy = false;
  private timer?: NodeJS.Timeout;

  constructor(o: ChatOptions) {
    this.opts = o;
    this.store = o.store;
    this.goalId = o.goalId;
    this.stateDir = o.stateDir;
  }

  async start() {
    const g = this.store.goal(this.goalId);
    if (!g) throw new Error(`unknown goal ${this.goalId}`);
    this.rl = createInterface({ input: this.opts.input ?? process.stdin, output: this.opts.output ?? process.stdout, prompt: c.bold('› '), terminal: tty && !this.opts.output });
    this.out(`${c.bold('cortex chat')} · ${this.goalId} · ${c.dim(one(g.config.objective, 100))}`);
    this.out(this.summary());
    const recent = this.store.events(this.goalId, 400).map((e) => [e, renderEvent(e)] as const).filter(([, r]) => r);
    if (recent.length) this.out(c.dim('— recent —'));
    for (const [e, r] of recent.slice(-8)) this.out(`${c.dim(clock(e.ts))} ${r}`);
    this.lastEvent = this.store.events(this.goalId, 1).at(-1)?.id ?? 0;
    this.followLive(true);
    this.out(c.dim('Ask anything about the run, or /help for commands.'));
    this.rl.prompt();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 1500);
    this.rl.on('line', (l) => void this.onLine(l.trim()));
    await new Promise<void>((resolve) => this.rl.on('close', resolve));
    clearInterval(this.timer);
  }

  /** Prints above the prompt without eating what you're typing. */
  private out(s: string) {
    const o = this.opts.output ?? process.stdout;
    const live = tty && !this.opts.output;
    if (live) o.write('\r\x1b[K');
    o.write(s + '\n');
    if (this.rl && live) this.rl.prompt(true);
  }

  private tick() {
    try {
      for (const e of this.store.eventsAfter(this.goalId, this.lastEvent)) {
        this.lastEvent = e.id;
        const r = renderEvent(e);
        if (r) this.out(`${c.dim(clock(e.ts))} ${r}`);
      }
      this.followLive(false);
    } catch (e: any) {
      this.out(c.red(`(could not read the run: ${e?.message ?? e})`));
    }
  }

  /** Attempts and plans running now, with where their live output goes. */
  private running(): { key: string; label: string; log: string; since: string; agent: string }[] {
    const tasks = this.store.tasks(this.goalId).filter((t) => t.status === 'running');
    const out = tasks.flatMap((t) => {
      const e = this.store.lastTaskEvent(this.goalId, t.id, 'attempt.started');
      return e?.data.log ? [{ key: t.id, label: t.id, log: String(e.data.log), since: e.ts, agent: String(e.data.agent) }] : [];
    });
    const lastPlan = this.store.events(this.goalId, 1, 'plan.started')[0];
    const after = lastPlan && this.store.eventsAfter(this.goalId, lastPlan.id, 100000).some((e) => e.type === 'plan' || e.type === 'plan.failed');
    if (lastPlan && !after && this.processAlive()) out.push({ key: 'plan', label: 'planner', log: String(lastPlan.data.log), since: lastPlan.ts, agent: String(lastPlan.data.agent) });
    return out;
  }

  private followLive(first: boolean) {
    const now = this.running();
    for (const r of now) {
      const file = liveLog(r.log);
      if (!this.tails.has(file)) {
        const tail = new Tail(file);
        this.tails.set(file, { tail, label: r.label });
        // Catch up quietly on what it did before we started watching: show only the last few steps.
        const seen = tail.read().map(renderLive).filter(Boolean) as string[];
        if (this.live && (!this.watch || this.watch === r.label)) for (const s of seen.slice(first ? -3 : -5)) this.out(`  ${c.dim(r.label + ' ·')} ${s}`);
      }
    }
    for (const [file, { tail, label }] of this.tails) {
      if (!now.some((r) => liveLog(r.log) === file)) {
        this.tails.delete(file);
        continue;
      }
      const lines = tail.read().map(renderLive).filter(Boolean) as string[];
      if (this.live && (!this.watch || this.watch === label)) for (const s of lines) this.out(`  ${c.dim(label + ' ·')} ${s}`);
    }
  }

  private processAlive(): { pid: number } | null {
    const f = join(this.stateDir, 'run.pid');
    if (!existsSync(f)) return null;
    const pid = Number(readFileSync(f, 'utf8'));
    try {
      process.kill(pid, 0);
      return { pid };
    } catch {
      return null;
    }
  }

  summary(): string {
    const g = this.store.goal(this.goalId)!;
    const b = g.config.budget ?? {};
    const tasks = this.store.tasks(this.goalId);
    const count = (s: string) => tasks.filter((t) => t.status === s).length;
    const alive = this.processAlive();
    const control = this.store.control(this.goalId);
    const lines = [
      `${c.bold(g.status)}${control !== 'run' ? c.yellow(` (${control} requested)`) : ''} · ${alive ? c.green('orchestrator running') : c.yellow('orchestrator not running')}` +
        ` · $${this.store.spent(this.goalId).toFixed(2)}${b.usd_total ? ` of $${b.usd_total}` : ''}` +
        ` · ${this.store.activeHours(this.goalId).toFixed(1)}${b.max_hours ? ` of ${b.max_hours}` : ''} working h`,
      `tasks: ${count('passed')} passed · ${count('running')} running · ${count('pending')} pending · ${count('needs_human')} need you · ${count('failed')} failed · ${count('cancelled')} cancelled`,
    ];
    for (const r of this.running()) lines.push(`  ${c.blue('▶')} ${c.bold(r.label)} on ${r.agent} for ${ago(r.since)}`);
    for (const t of this.questions()) lines.push(`  ${c.magenta('?')} ${c.bold(t.id)}: ${one(t.title, 90)} — /show ${t.id}`);
    return lines.join('\n');
  }

  private questions(): Task[] {
    return this.store.tasks(this.goalId).filter((t) => t.status === 'needs_human' || (t.kind === 'human' && t.status === 'pending' && this.store.lastTaskEvent(this.goalId, t.id, 'question.asked')));
  }

  private async onLine(line: string) {
    if (!line) return this.rl.prompt();
    if (this.pending && /^(y|yes)$/i.test(line)) {
      const a = this.pending;
      this.pending = null;
      await this.act(a);
      return this.rl.prompt();
    }
    if (this.pending && /^(n|no)$/i.test(line)) {
      this.pending = null;
      this.out(c.dim('Not done.'));
      return this.rl.prompt();
    }
    this.pending = null;
    try {
      if (line.startsWith('/')) await this.command(line);
      else await this.ask(line);
    } catch (e: any) {
      this.out(c.red(e?.message ?? String(e)));
    }
    this.rl.prompt();
  }

  private async command(line: string) {
    const [cmd, ...args] = line.slice(1).split(/\s+/);
    const rest = line.slice(1 + cmd.length).trim();
    switch (cmd) {
      case 'help':
      case '?':
        return this.out(
          [
            '/status                 where the run is',
            '/tasks [all]            open tasks (all: every task)',
            '/show <task>            a task’s brief, last result and feedback',
            '/answer <task> <text>   answer a question or guide a stuck task',
            '/discuss <task>         talk a question through: options, tradeoffs, a recommendation',
            '/steer <text>           an instruction for the planner ("skip W8", "use Cursor for docs")',
            '/pause  /resume  /stop  pause new work · go again (starts the run if needed) · finish running work and exit',
            '/live on|off            show agents’ steps as they work',
            '/watch <task>|all       follow one task’s steps only',
            '/quit                   leave the chat (the run keeps going)',
            'Anything else goes to Claude: ask about the run, or talk through a change, even to the goal itself.',
            'When you agree on a change, Claude proposes it (a goal change shows the spec diff) and you confirm with y.',
          ].join('\n'),
        );
      case 'status':
        return this.out(this.summary());
      case 'tasks': {
        const all = args[0] === 'all';
        const order = ['running', 'needs_human', 'failed', 'pending', 'passed', 'cancelled'];
        const ts = this.store
          .tasks(this.goalId)
          .filter((t) => all || !['passed', 'cancelled'].includes(t.status))
          .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
        if (!ts.length) return this.out(c.dim('No open tasks.'));
        return this.out(ts.map((t) => `${t.status.padEnd(11)} ${t.id.padEnd(30)} ${t.kind.padEnd(8)} a=${t.attempts} ${one(t.title, 60)}`).join('\n'));
      }
      case 'show': {
        const t = this.task(args[0]);
        const e = this.store.lastTaskEvent(this.goalId, t.id, 'eval');
        const parts = [
          `${c.bold(t.id)} · ${t.kind} · ${t.status} · attempts ${t.attempts}${t.deps.length ? ' · after ' + t.deps.join(', ') : ''}`,
          c.bold(t.title),
          t.brief.trim(),
        ];
        if (t.human_answer) parts.push(c.green('Your answer: ') + t.human_answer);
        if (t.summary) parts.push(c.bold('Last result: ') + t.summary.trim().slice(0, 1500));
        if (e && !e.data.pass) parts.push(c.yellow('Last checks: ') + String(e.data.feedback).slice(0, 1500));
        if (t.status === 'needs_human') parts.push(c.magenta(`Reply with: /answer ${t.id} <your answer>`));
        return this.out(parts.join('\n\n'));
      }
      case 'answer': {
        const t = this.task(args[0]);
        const text = rest.slice(args[0].length).trim();
        if (!text) throw new Error('usage: /answer <task> <text>');
        return this.act({ type: 'answer', task: t.id, text });
      }
      case 'discuss': {
        const t = this.task(args[0]);
        const more = rest.slice(args[0].length).trim();
        return this.ask(
          `Help me decide on ${t.id}. In plain words: what is being asked and why it came up, the realistic options and what each would mean for the run (work, cost, risk), and your recommendation. Read the transcript of the attempt that raised it if that helps. Don't propose an answer action yet; I'll tell you what I pick.${more ? `\n\nMy thoughts: ${more}` : ''}`,
        );
      }
      case 'steer':
        if (!rest) throw new Error('usage: /steer <instruction>');
        return this.act({ type: 'steer', text: rest });
      case 'pause':
      case 'resume':
      case 'stop':
        return this.act({ type: cmd });
      case 'live':
        this.live = args[0] !== 'off';
        return this.out(c.dim(`Live steps ${this.live ? 'on' : 'off'}.`));
      case 'watch':
        this.watch = !args[0] || args[0] === 'all' ? null : this.task(args[0]).id;
        this.live = true;
        return this.out(c.dim(this.watch ? `Following ${this.watch} only.` : 'Following every running agent.'));
      case 'quit':
      case 'exit':
      case 'q':
        return this.rl.close();
      default:
        throw new Error(`unknown command /${cmd} — /help lists them`);
    }
  }

  private task(id: string | undefined): Task {
    if (!id) throw new Error('which task?');
    const t = this.store.task(this.goalId, id) ?? this.store.tasks(this.goalId).find((x) => x.id.startsWith(id));
    if (!t) throw new Error(`no task ${id}`);
    return t;
  }

  private async act(a: Action) {
    switch (a.type) {
      case 'revise': {
        const r: Revision = { summary: a.text ?? 'Goal revised', ...(a.objective ? { objective: a.objective } : {}), ...(a.spec_md ? { spec_md: a.spec_md } : {}), ...(a.acceptance?.length ? { acceptance: a.acceptance } : {}) };
        this.store.revise(this.goalId, r);
        const g = this.store.goal(this.goalId)!;
        if (this.processAlive()) return this.out(c.green('Sent. The run commits it and replans against it next.'));
        return this.out(c.green('Saved. ') + c.yellow(g.status === 'done' ? 'The goal was done; /resume reopens it with the change.' : 'The run isn’t live; /resume applies it.'));
      }
      case 'answer':
        this.store.answer(this.goalId, a.task!, a.text!);
        return this.out(c.green(`Answered ${a.task}.`) + (this.processAlive() ? '' : c.yellow(' The orchestrator isn’t running: /resume starts it.')));
      case 'steer':
        this.store.steer(this.goalId, a.text!);
        return this.out(c.green('Sent to the planner; it replans with it next.'));
      case 'pause':
        this.store.setControl(this.goalId, 'pause');
        return this.out(c.yellow('Pausing: running tasks finish, nothing new starts. /resume to continue.'));
      case 'stop':
        this.store.setControl(this.goalId, 'stop');
        return this.out(c.yellow('Stopping after the running tasks finish. /resume starts it again.'));
      case 'resume': {
        this.store.setControl(this.goalId, 'resume');
        if (this.processAlive()) return this.out(c.green('Resuming.'));
        return this.out(c.green(await this.opts.startRun()));
      }
    }
  }

  /** The current spec: the integration branch's copy (what agents read), else the project's. */
  private specPath(g: { project_dir: string; config: { context_files?: string[] } }): string {
    const f = g.config.context_files?.[0] ?? 'SPEC.md';
    const integ = join(this.stateDir, 'integration', f);
    return existsSync(integ) ? integ : join(g.project_dir, f);
  }

  /** What a proposed revision changes: objective, acceptance, and the spec as a diff. */
  private async revisionPreview(a: Action, g: { project_dir: string; config: { objective: string; context_files?: string[] } }): Promise<string> {
    const parts: string[] = [];
    if (a.objective) parts.push(`${c.bold('Objective')}\n${c.red('- ' + one(g.config.objective, 400))}\n${c.green('+ ' + one(a.objective, 400))}`);
    if (a.acceptance?.length) parts.push(`${c.bold('Final acceptance')}\n${a.acceptance.map((e) => `  - ${e.kind === 'command' ? `\`${e.run}\` passes` : e.criterion}`).join('\n')}`);
    if (a.spec_md) {
      const cur = this.specPath(g);
      const tmp = mkdtempSync(join(tmpdir(), 'cortex-rev-'));
      const old = join(tmp, 'current');
      const next = join(tmp, 'revised');
      writeFileSync(old, existsSync(cur) ? readFileSync(cur, 'utf8') : '');
      writeFileSync(next, a.spec_md.trim() + '\n');
      const d = await run('git', ['diff', '--no-index', '--no-color', '-U1', old, next]);
      const lines = d.stdout.split('\n').slice(4).filter((l) => l && !l.startsWith('\\'));
      const shown = lines.slice(0, 60).map((l) => (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : c.dim(l)));
      parts.push(`${c.bold('Spec')}\n${lines.length ? shown.join('\n') : c.dim('(no change)')}${lines.length > 60 ? c.dim(`\n… ${lines.length - 60} more lines`) : ''}`);
    }
    return parts.join('\n\n');
  }

  /** A read-only Claude that knows the run's state and can read its project and logs. */
  private async ask(question: string) {
    if (this.busy) return this.out(c.dim('Still answering the last question…'));
    this.busy = true;
    this.out(c.dim('thinking…'));
    try {
      const g = this.store.goal(this.goalId)!;
      const recent = this.store
        .events(this.goalId, 300)
        .map((e) => [e, renderEvent(e)] as const)
        .filter(([, r]) => r)
        .slice(-40)
        .map(([e, r]) => `${e.ts.slice(0, 16)} ${r}`)
        .join('\n');
      const tasks = this.store
        .tasks(this.goalId)
        .filter((t) => t.status !== 'cancelled')
        .map((t) => `${t.status} ${t.id} (${t.kind}, a=${t.attempts}): ${one(t.title, 90)}`)
        .join('\n');
      const waiting = this.questions()
        .map((t) => `[${t.id}] ${t.title}\n${one(t.brief, 1500)}`)
        .join('\n\n');
      const acceptance = (g.config.acceptance ?? []).map((a) => `- ${a.kind === 'command' ? `\`${a.run}\` passes` : a.criterion}`).join('\n');
      const state = `Status now:\n${strip(this.summary())}\n\nCurrent objective: ${g.config.objective}\nCurrent final acceptance:\n${acceptance || '(none)'}\n\nTasks (cancelled hidden):\n${tasks}${waiting ? `\n\nWaiting on the owner:\n${waiting}` : ''}\n\nRecent events:\n${strip(recent)}`;
      const prompt =
        this.asked === 0
          ? `You are the run assistant inside \`cortex chat\`, talking to the owner of a long-running multi-agent run.
Goal "${this.goalId}": ${g.config.objective}

You can read the project (${g.project_dir}) and the run's state folder (${this.stateDir}: logs/ has every agent transcript, digests/ the checkpoints) with Read, Grep and Glob. Transcripts are named <time>-<seq>-<task>-<attempt>-<agent>.log, with judges' verdicts in <task>-<attempt>-…judge… files: open them when the question needs evidence instead of guessing. You cannot change anything yourself.
Answer plainly and briefly (a few lines; the owner reads this in a terminal). Cite task ids. Say when you're unsure.
If the owner asks for a change, propose exactly one action and they will confirm it:
- answer: answer a task waiting on them (task id + text, in their words);
- steer: an instruction the planner applies on its next plan (e.g. "cancel W8 tasks", "route docs to cursor");
- revise: a change to the goal itself (objective, spec, final acceptance). The run commits it on its branch and replans against it. Give the whole new text of each part that changes, starting from the current version (the current spec is ${this.specPath(g)}; read it first), and only what was agreed;
- pause / resume / stop.
Otherwise action.type is "none".

Talk things through before acting. When the owner is unsure, or a question is waiting on them, explain the options, their tradeoffs and what each means for the run, and recommend one. For a change to the goal itself, first say plainly what it costs (merged work that gets redone, budget, risk) and push back if it's a bad idea; propose the revise action only once you both agree on what changes. Never propose an action the owner hasn't agreed to.

${state}

Owner: ${question}`
          : `${state}\n\nOwner: ${question}`;
      const args = ['-p', '--output-format', 'json', '--model', this.opts.model ?? 'sonnet', '--tools', 'Read', 'Grep', 'Glob', '--add-dir', this.stateDir, '--json-schema', JSON.stringify(ACTION_SCHEMA)];
      args.push(...(this.asked === 0 ? ['--session-id', this.session] : ['--resume', this.session]));
      const res = await (this.opts.assistant ?? claudeTurn)(args, prompt, g.project_dir);
      this.asked++;
      const usd = Number(res.total_cost_usd ?? 0);
      if (usd) this.store.addCost(this.goalId, null, 'chat', 'chat', usd);
      const out = (res.structured_output ?? extractJson(String(res.result ?? ''))) as { reply?: string; action?: Action } | undefined;
      this.out(out?.reply ?? String(res.result ?? ''));
      const a = out?.action;
      if (a && a.type !== 'none') {
        if (a.type === 'revise' && !a.objective && !a.spec_md && !a.acceptance?.length) return this.out(c.dim('(Claude proposed a revision with no changes; ignored.)'));
        this.pending = a;
        if (a.type === 'revise') this.out(await this.revisionPreview(a, g));
        const what =
          a.type === 'answer' ? `answer ${a.task}: “${a.text}”` : a.type === 'steer' ? `tell the planner: “${a.text}”` : a.type === 'revise' ? `revise the goal: “${a.text}”` : a.type;
        this.out(c.bold(`Do it? ${what} (y/n)`));
      }
    } finally {
      this.busy = false;
    }
  }
}

async function claudeTurn(args: string[], prompt: string, cwd: string): Promise<any> {
  const p = await run('claude', args, { cwd, input: prompt, timeoutMs: 5 * 60000 });
  let res: any;
  try {
    res = JSON.parse(p.stdout);
  } catch {}
  if (!res || res.is_error) throw new Error(`assistant failed: ${one(res?.result ?? p.stderr ?? p.stdout, 300)}`);
  return res;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export const launchdLabel = (goalId: string) => `com.cortex.${goalId}`;
export const launchdPlist = (goalId: string) => join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(goalId)}.plist`);
