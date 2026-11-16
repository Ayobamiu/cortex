import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Sandbox } from './sandbox.ts';

/** Every descendant pid of `root`. Agents (e.g. Muse) put their tool commands in new process groups, so a group kill alone misses them. */
function descendants(root: number): number[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run inside this macOS sandbox, with its scrubbed environment instead of ours. */
  sandbox?: Sandbox;
  /** Also append stdout to this file as it arrives, so a running agent can be watched live. */
  tee?: string;
}

/** Runs a process in its own process group so a timeout kills the whole tree (agents spawn children). */
export function run(cmd: string, args: string[], opts: ProcOptions = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    const [file, argv] = opts.sandbox ? ['/usr/bin/sandbox-exec', ['-p', opts.sandbox.profile, cmd, ...args]] : [cmd, args];
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: { ...(opts.sandbox?.env ?? process.env), ...opts.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const killTree = () => {
      if (!child.pid) return;
      const pids = descendants(child.pid);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, opts.timeoutMs);
    }
    const onExit = () => killTree();
    process.once('exit', onExit);
    let tee: ReturnType<typeof createWriteStream> | undefined;
    if (opts.tee) {
      try {
        mkdirSync(dirname(opts.tee), { recursive: true });
        tee = createWriteStream(opts.tee, { flags: 'a' });
        tee.on('error', () => (tee = undefined));
      } catch {}
    }
    child.stdout.on('data', (d) => {
      stdout += d;
      tee?.write(d);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      process.off('exit', onExit);
      tee?.end();
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** Runs a shell command through a login shell so PATH matches the user's terminal (matters under launchd). */
export function sh(command: string, opts: ProcOptions = {}): Promise<ProcResult> {
  const shell = process.env.SHELL || '/bin/zsh';
  return run(shell, ['-lc', command], opts);
}

export function tail(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}

export function head(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** Pulls the first JSON object out of free text (fenced block, or outermost braces). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {}
  }
  return undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
