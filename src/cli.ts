import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, statSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { Orchestrator } from './orchestrator.ts';
import type { GoalConfig } from './types.ts';
import { Chat, launchdLabel, launchdPlist } from './chat.ts';
import { newProject } from './new.ts';
import { planCleanup, applyCleanup } from './cleanup.ts';
import { createInterface } from 'node:readline/promises';
import { loadPhone, savePhone, newTopic, push, phoneSetupText } from './phone.ts';
import { run } from './proc.ts';

export const CORTEX_HOME = () => process.env.CORTEX_HOME ?? join(homedir(), '.cortex');
const stateDir = (goalId: string) => join(CORTEX_HOME(), 'goals', goalId);
const openStore = (goalId: string) => {
  // A goal id is a kebab-case name, never a path: anything else would create stray state folders.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(goalId)) throw new Error(`"${goalId}" isn't a goal id (lowercase-kebab, e.g. my-project). cortex status lists them.`);
  return new Store(join(stateDir(goalId), 'state.db'));
};

const USAGE = `cortex — long-running multi-agent orchestrator

  cortex new ["what you want"] [--in <dir>]  Describe it; Claude drafts the spec and goal, you confirm, it starts
  cortex run <project-dir> [--goal <file>]   Run (or resume) the goal in <project-dir>/cortex.goal.json
  cortex phone [test|off]                    Questions and problems on your phone (ntfy); reply there to answer
  cortex chat [goal-id]                      Live thread for a run: progress, questions, commands, ask anything
  cortex status [goal-id]                    Task table, spend, open questions
  cortex answer <goal-id> <task-id> <text>   Answer a question / unblock an escalated task
  cortex steer <goal-id> <text>              An instruction the planner applies on its next plan
  cortex pause|resume|stop <goal-id>         Pause new work · go again (starts the run) · finish running work and exit
  cortex cleanup <goal-id> [--yes]           Remove leftover attempt branches and folders (never your work)
  cortex events <goal-id> [n]                Last n events from the log (default 30)
  cortex digest <goal-id>                    Write a digest now and print its path
  cortex service <project-dir>               Write a launchd agent so the run survives reboots/crashes
`;

export function loadGoal(projectDir: string, goalFile?: string): GoalConfig {
  const file = resolve(goalFile ?? join(projectDir, 'cortex.goal.json'));
  if (!existsSync(file)) throw new Error(`No goal file at ${file}. See examples/goal.example.json in the cortex repo.`);
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as GoalConfig;
  for (const k of ['id', 'objective', 'agents', 'routing'] as const) if (!cfg[k]) throw new Error(`${file}: missing "${k}"`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cfg.id)) throw new Error(`${file}: id must be lowercase kebab-case`);
  cfg.acceptance ??= [];
  return cfg;
}

/** One orchestrator per goal: a second `cortex run` would double-execute tasks. */
function acquireLock(goalId: string): () => void {
  const lock = join(stateDir(goalId), 'run.pid');
  mkdirSync(stateDir(goalId), { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error(`goal ${goalId} is already running (pid ${pid})`);
    } catch (e: any) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  writeFileSync(lock, String(process.pid));
  return () => {
    try {
      if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
    } catch {}
  };
}

async function cmdRun(projectArg: string, goalFile?: string) {
  const projectDir = resolve(projectArg);
  const goal = loadGoal(projectDir, goalFile);
  const release = acquireLock(goal.id);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  const store = openStore(goal.id);
  store.upsertGoal(goal, projectDir);
  try {
    const status = await new Orchestrator({ store, goal, projectDir, stateDir: stateDir(goal.id) }).run();
    console.log(`\nfinished: ${status}${status === 'stopped' ? ` (resume with: cortex resume ${goal.id})` : ''}`);
  } finally {
    release();
  }
}

function cmdStatus(goalId?: string) {
  const goalsDir = join(CORTEX_HOME(), 'goals');
  const ids = goalId ? [goalId] : existsSync(goalsDir) ? readdirSync(goalsDir).filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id)) : [];
  if (!ids.length) return console.log('No goals yet.');
  for (const id of ids) {
    const store = openStore(id);
    const g = store.goal(id);
    if (!g) {
      console.log(`${id}: unknown goal`);
      continue;
    }
    console.log(`\n${id} · ${g.status} · $${store.spent(id).toFixed(2)} spent · ${g.project_dir}`);
    console.log(`  ${g.config.objective.slice(0, 140)}`);
    // Latest provider usage per agent, as last reported (only windows that haven't reset).
    const latest = new Map<string, { window: string; utilization: number; resetsAtMs: number }[]>();
    for (const e of store.events(id, 500, 'agent.usage')) latest.set(String(e.data.agent), e.data.windows as any);
    for (const [agent, windows] of latest) {
      const live = windows.filter((w) => w.resetsAtMs > Date.now());
      if (live.length) console.log(`  usage ${agent}: ${live.map((w) => `${w.window} ${Math.round(w.utilization * 100)}% (resets ${new Date(w.resetsAtMs).toLocaleString()})`).join(' · ')}`);
    }
    for (const t of store.tasks(id)) {
      const risk = t.risk && t.risk !== 'normal' ? ` [${t.risk}]` : '';
      console.log(`  ${t.status.padEnd(11)} ${t.id.padEnd(32)} ${t.kind.padEnd(8)} a=${t.attempts}  ${t.title.slice(0, 70)}${risk}`);
      if (t.status === 'needs_human') console.log(`              ↳ ${t.brief.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
}

function cmdAnswer(goalId: string, taskId: string, text: string) {
  const store = openStore(goalId);
  store.answer(goalId, taskId, text);
  console.log(`Recorded. A running orchestrator picks this up within its poll interval; otherwise run: cortex run ${store.goal(goalId)?.project_dir}`);
}

/** The goal you most likely mean: the one whose state changed last. */
function defaultGoal(): string {
  const dir = join(CORTEX_HOME(), 'goals');
  const ids = existsSync(dir) ? readdirSync(dir).filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id) && existsSync(join(dir, id, 'state.db'))) : [];
  if (!ids.length) throw new Error('No goals yet. Start one with: cortex run <project-dir>');
  const mtime = (id: string) => Math.max(...['state.db', 'state.db-wal'].map((f) => (existsSync(join(dir, id, f)) ? statSync(join(dir, id, f)).mtimeMs : 0)));
  return ids.sort((a, b) => mtime(b) - mtime(a))[0];
}

/** Starts a goal's run in the background: through its launchd service if installed, else as a detached process. */
async function startRun(goalId: string): Promise<string> {
  const g = openStore(goalId).goal(goalId);
  if (!g) throw new Error(`unknown goal ${goalId}`);
  if (process.platform === 'darwin' && existsSync(launchdPlist(goalId))) {
    const target = `gui/${process.getuid?.()}/${launchdLabel(goalId)}`;
    const loaded = (await run('launchctl', ['print', target])).code === 0;
    const r = loaded ? await run('launchctl', ['kickstart', target]) : await run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, launchdPlist(goalId)]);
    if (r.code !== 0) throw new Error(`launchctl failed: ${r.stderr.trim()}`);
    return `Started the ${launchdLabel(goalId)} service.`;
  }
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cortex.mjs');
  const log = openSync(join(stateDir(goalId), 'service.log'), 'a');
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', bin, 'run', g.project_dir], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return `Started the run in the background (pid ${child.pid}; log: ${join(stateDir(goalId), 'service.log')}).`;
}

async function cmdChat(goalId = defaultGoal()) {
  const store = openStore(goalId);
  if (!store.goal(goalId)) throw new Error(`unknown goal ${goalId}`);
  await new Chat({ store, goalId, stateDir: stateDir(goalId), startRun: () => startRun(goalId) }).start();
}

async function cmdPhone(arg?: string) {
  if (arg === 'off') {
    savePhone(null);
    return console.log('Phone notifications off. (The topic still exists in your ntfy app; delete it there.)');
  }
  let p = loadPhone();
  if (!p) {
    if (arg === 'test') throw new Error('Not set up yet: run cortex phone');
    p = { server: 'https://ntfy.sh', topic: newTopic() };
    savePhone(p);
    console.log(phoneSetupText(p));
  } else if (arg !== 'test') console.log(phoneSetupText(p));
  const ok = await push(p, { title: 'cortex: test', body: 'Phone notifications work. Reply "help" here while a run is live to see what you can send.', priority: 3, tags: ['white_check_mark'] });
  console.log(ok ? '\nSent a test push.' : '\nThe test push failed: check your internet connection, then: cortex phone test');
}

async function cmdCleanup(goalId: string, yes: boolean) {
  const store = openStore(goalId);
  const g = store.goal(goalId);
  if (!g) throw new Error(`unknown goal ${goalId}`);
  let live = false;
  try {
    process.kill(Number(readFileSync(join(stateDir(goalId), 'run.pid'), 'utf8')), 0);
    live = true;
  } catch {}
  const plan = await planCleanup(store, goalId, g.project_dir, stateDir(goalId), live);
  const n = plan.branches.length + plan.worktrees.length + plan.strays.length + (plan.integration ? 1 : 0);
  if (!n) return console.log('Nothing to clean up.');
  console.log(`In ${g.project_dir}:
  ${plan.branches.length} attempt branch(es) to delete (finished tasks' work is already merged into cortex/${goalId}/main)
  ${plan.worktrees.length + plan.strays.length} attempt folder(s) to remove${plan.integration ? `\n  the integration folder (the goal is done; the branch cortex/${goalId}/main stays)` : ''}
  keeping ${plan.kept.length} branch(es) that unfinished tasks continue from, the integration branch, your branches, tags and logs`);
  if (!yes) {
    if (!process.stdin.isTTY) return console.log('Run again with --yes to do it.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('Remove them? (y/n) ')).trim();
    rl.close();
    if (!/^y(es)?$/i.test(a)) return console.log('Nothing removed.');
  }
  await applyCleanup(g.project_dir, stateDir(goalId), plan);
  console.log('Done.');
}

async function cmdControl(what: 'pause' | 'resume' | 'stop', goalId: string) {
  const store = openStore(goalId);
  if (!store.goal(goalId)) throw new Error(`unknown goal ${goalId}`);
  store.setControl(goalId, what);
  if (what !== 'resume') return console.log(what === 'pause' ? 'Pausing: running tasks finish, nothing new starts.' : 'Stopping after the running tasks finish.');
  const pidFile = join(stateDir(goalId), 'run.pid');
  let alive = false;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    alive = true;
  } catch {}
  console.log(alive ? 'Resuming.' : await startRun(goalId));
}

function cmdEvents(goalId: string, n = 30) {
  for (const e of openStore(goalId).events(goalId, n)) {
    console.log(`${e.ts}  ${e.type.padEnd(16)} ${(e.task_id ?? '').padEnd(28)} ${JSON.stringify(e.data).slice(0, 220)}`);
  }
}

async function cmdDigest(goalId: string) {
  const store = openStore(goalId);
  const g = store.goal(goalId);
  if (!g) throw new Error(`unknown goal ${goalId}`);
  const o = new Orchestrator({ store, goal: g.config, projectDir: g.project_dir, stateDir: stateDir(goalId) });
  console.log(await o.checkpoint('manual'));
}

function cmdService(projectArg: string) {
  const projectDir = resolve(projectArg);
  const { path, label, logDir } = writeService(projectDir);
  console.log(`Wrote ${path}
Start:   launchctl bootstrap gui/$(id -u) ${path}
Stop:    cortex stop ${label.replace(/^com\.cortex\./, '')}
Logs:    tail -f ${join(logDir, 'service.log')}
It runs at lower priority than your apps (nice 10; not ProcessType=Background, which pins it to efficiency cores and made test suites 5x slower), restarts after crashes and at login, and keeps the Mac awake while running (not with the lid closed on battery).`);
}

/** The launchd agent for a project's goal: survives reboots and crashes, keeps the Mac awake. */
function writeService(projectDir: string): { path: string; label: string; logDir: string } {
  const goal = loadGoal(projectDir);
  const label = `com.cortex.${goal.id}`;
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cortex.mjs');
  const logDir = stateDir(goal.id);
  mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>${process.execPath}</string><string>--no-warnings=ExperimentalWarning</string>
    <string>${bin}</string><string>run</string><string>${projectDir}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string><key>HOME</key><string>${homedir()}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(logDir, 'service.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'service.log')}</string>
</dict></plist>
`;
  const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plist);
  return { path, label, logDir };
}

/** Describe it, confirm, and it runs: project folder, spec, goal, service, then the chat. */
async function cmdNew(idea: string, parent: string) {
  const dir = await newProject({
    idea,
    parent: resolve(parent),
    start: async (projectDir, goal) => {
      if (process.platform === 'darwin') {
        const { path } = writeService(projectDir);
        const r = await run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, path]);
        if (r.code !== 0) throw new Error(`launchctl failed: ${r.stderr.trim()}`);
        console.log('Started in the background (it keeps going if you close this, and after a restart).');
      } else {
        const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cortex.mjs');
        mkdirSync(stateDir(goal.id), { recursive: true });
        const log = openSync(join(stateDir(goal.id), 'service.log'), 'a');
        spawn(process.execPath, ['--no-warnings=ExperimentalWarning', bin, 'run', projectDir], { detached: true, stdio: ['ignore', log, log] }).unref();
        console.log('Started in the background.');
      }
      // The run registers the goal as it starts; then open the thread.
      for (let i = 0; i < 60 && !(existsSync(join(stateDir(goal.id), 'state.db')) && openStore(goal.id).goal(goal.id)); i++) await new Promise((r) => setTimeout(r, 500));
      console.log('Opening the chat. /quit leaves it; the run keeps going. Come back any time with: cortex chat\n');
      await cmdChat(goal.id);
    },
  });
  if (!dir) process.exitCode = 1;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    if (i === -1) return undefined;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v;
  };
  switch (cmd) {
    case 'run': {
      const goalFile = flag('--goal');
      if (!rest[0]) throw new Error('usage: cortex run <project-dir>');
      return cmdRun(rest[0], goalFile);
    }
    case 'status':
      return cmdStatus(rest[0]);
    case 'chat':
      return cmdChat(rest[0]);
    case 'phone':
      return cmdPhone(rest[0]);
    case 'cleanup': {
      const yes = rest.includes('--yes');
      const id = rest.filter((r) => r !== '--yes')[0];
      if (!id) throw new Error('usage: cortex cleanup <goal-id> [--yes]');
      return cmdCleanup(id, yes);
    }
    case 'new': {
      const parent = flag('--in') ?? process.cwd();
      return cmdNew(rest.join(' '), parent);
    }
    case 'pause':
    case 'resume':
    case 'stop':
      if (!rest[0]) throw new Error(`usage: cortex ${cmd} <goal-id>`);
      return cmdControl(cmd, rest[0]);
    case 'steer':
      if (rest.length < 2) throw new Error('usage: cortex steer <goal-id> <text>');
      if (!openStore(rest[0]).goal(rest[0])) throw new Error(`unknown goal ${rest[0]}`);
      openStore(rest[0]).steer(rest[0], rest.slice(1).join(' '));
      return console.log('Sent to the planner; it replans with it next.');
    case 'answer':
      if (rest.length < 3) throw new Error('usage: cortex answer <goal-id> <task-id> <text>');
      return cmdAnswer(rest[0], rest[1], rest.slice(2).join(' '));
    case 'events':
      if (!rest[0]) throw new Error('usage: cortex events <goal-id> [n]');
      return cmdEvents(rest[0], rest[1] ? Number(rest[1]) : undefined);
    case 'digest':
      if (!rest[0]) throw new Error('usage: cortex digest <goal-id>');
      return cmdDigest(rest[0]);
    case 'service':
      if (!rest[0]) throw new Error('usage: cortex service <project-dir>');
      return cmdService(rest[0]);
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && /cortex(\.mjs)?$|cli\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`cortex: ${e?.message ?? e}`);
    process.exit(1);
  });
}
