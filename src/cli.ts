import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { Orchestrator } from './orchestrator.ts';
import type { GoalConfig } from './types.ts';

export const CORTEX_HOME = () => process.env.CORTEX_HOME ?? join(homedir(), '.cortex');
const stateDir = (goalId: string) => join(CORTEX_HOME(), 'goals', goalId);
const openStore = (goalId: string) => new Store(join(stateDir(goalId), 'state.db'));

const USAGE = `cortex — long-running multi-agent orchestrator

  cortex run <project-dir> [--goal <file>]   Run (or resume) the goal in <project-dir>/cortex.goal.json
  cortex status [goal-id]                    Task table, spend, open questions
  cortex answer <goal-id> <task-id> <text>   Answer a question / unblock an escalated task
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
    console.log(`\nfinished: ${status}`);
  } finally {
    release();
  }
}

function cmdStatus(goalId?: string) {
  const goalsDir = join(CORTEX_HOME(), 'goals');
  const ids = goalId ? [goalId] : existsSync(goalsDir) ? readdirSync(goalsDir) : [];
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
  const t = store.task(goalId, taskId);
  if (!t) throw new Error(`no task ${taskId} in ${goalId}`);
  // A question can be answered before it's asked (while its research is still running).
  const early = t.kind === 'human' && t.status === 'pending';
  if (t.status !== 'needs_human' && t.status !== 'failed' && !early) throw new Error(`task ${taskId} is ${t.status}, not waiting on you`);
  store.tx(() => {
    if (t.kind === 'human') {
      store.updateTask(goalId, taskId, { status: 'passed', human_answer: text, summary: `Human answered: ${text}` });
    } else {
      // An escalated work task: fresh retries, with the guidance as feedback.
      store.updateTask(goalId, taskId, { status: 'pending', attempts: 0, human_answer: text, feedback: `Guidance from the user: ${text}\n\nPrevious failure:\n${t.feedback ?? ''}` });
    }
    store.event(goalId, 'human.answer', { text }, taskId);
  });
  console.log(`Recorded. A running orchestrator picks this up within its poll interval; otherwise run: cortex run ${store.goal(goalId)?.project_dir}`);
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
  <key>StandardOutPath</key><string>${join(logDir, 'service.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'service.log')}</string>
</dict></plist>
`;
  const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plist);
  console.log(`Wrote ${path}
Start:   launchctl bootstrap gui/$(id -u) ${path}
Stop:    launchctl bootout gui/$(id -u)/${label}
Logs:    tail -f ${join(logDir, 'service.log')}
It restarts after crashes and at login, and keeps the Mac awake while running (not with the lid closed on battery).`);
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
