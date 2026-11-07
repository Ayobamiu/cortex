import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GoalConfig, GoalStatus, Task } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL, goal_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, brief TEXT NOT NULL,
  deps TEXT NOT NULL, evals TEXT NOT NULL, agent TEXT, status TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'normal',
  attempts INTEGER NOT NULL DEFAULT 0,
  feedback TEXT, summary TEXT, human_answer TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, id)
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  agent TEXT NOT NULL, usd REAL NOT NULL, ts TEXT NOT NULL
);
-- Append-only log of everything that happened. The source of truth for audits and digests.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, goal_id TEXT NOT NULL, task_id TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_goal ON events(goal_id, id);
`;

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
  return {
    ...(r as unknown as Task),
    deps: JSON.parse(r.deps as string),
    evals: JSON.parse(r.evals as string),
    risk: (r.risk as Task['risk']) ?? 'normal',
  };
}

export interface EventRow {
  id: number;
  ts: string;
  goal_id: string;
  task_id: string | null;
  type: string;
  data: Record<string, unknown>;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL + busy timeout so `cortex answer` / `cortex status` can touch the DB while a run is live.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    // Databases created before task risk levels existed.
    const cols = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'risk')) this.db.exec("ALTER TABLE tasks ADD COLUMN risk TEXT NOT NULL DEFAULT 'normal'");
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  event(goalId: string, type: string, data: Record<string, unknown> = {}, taskId: string | null = null) {
    this.db
      .prepare('INSERT INTO events (ts, goal_id, task_id, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(now(), goalId, taskId, type, JSON.stringify(data));
  }

  events(goalId: string, limit = 50, type?: string): EventRow[] {
    const rows = type
      ? this.db.prepare('SELECT * FROM events WHERE goal_id = ? AND type = ? ORDER BY id DESC LIMIT ?').all(goalId, type, limit)
      : this.db.prepare('SELECT * FROM events WHERE goal_id = ? ORDER BY id DESC LIMIT ?').all(goalId, limit);
    return (rows as Row[]).map((r) => ({ ...(r as unknown as EventRow), data: JSON.parse(r.data as string) })).reverse();
  }

  countEvents(goalId: string, type: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE goal_id = ? AND type = ?').get(goalId, type) as Row;
    return Number(r.n);
  }

  countTaskEvents(goalId: string, taskId: string, types: string[]): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE goal_id = ? AND task_id = ? AND type IN (${types.map(() => '?').join(',')})`)
      .get(goalId, taskId, ...types) as Row;
    return Number(r.n);
  }

  upsertGoal(cfg: GoalConfig, projectDir: string) {
    const existing = this.goal(cfg.id);
    if (existing) {
      this.db
        .prepare('UPDATE goals SET config = ?, project_dir = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(cfg), projectDir, now(), cfg.id);
    } else {
      this.db
        .prepare('INSERT INTO goals (id, project_dir, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cfg.id, projectDir, JSON.stringify(cfg), 'active', now(), now());
      this.event(cfg.id, 'goal.created', { objective: cfg.objective, projectDir });
    }
  }

  goal(id: string): { id: string; project_dir: string; config: GoalConfig; status: GoalStatus; created_at: string } | undefined {
    const r = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    return { ...(r as any), config: JSON.parse(r.config as string) };
  }

  setGoalStatus(id: string, status: GoalStatus, reason = '') {
    const g = this.goal(id);
    if (g?.status === status) return;
    this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    this.event(id, 'goal.status', { status, reason });
  }

  insertTask(t: Omit<Task, 'created_at' | 'updated_at' | 'attempts' | 'feedback' | 'summary' | 'human_answer' | 'risk'> & { risk?: Task['risk'] }) {
    const risk = t.risk ?? 'normal';
    this.db
      .prepare(
        `INSERT INTO tasks (id, goal_id, title, kind, brief, deps, evals, agent, status, risk, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(t.id, t.goal_id, t.title, t.kind, t.brief, JSON.stringify(t.deps), JSON.stringify(t.evals), t.agent, t.status, risk, now(), now());
    this.event(t.goal_id, 'task.created', { title: t.title, kind: t.kind, deps: t.deps, status: t.status, risk }, t.id);
  }

  updateTask(goalId: string, id: string, patch: Partial<Pick<Task, 'status' | 'attempts' | 'feedback' | 'summary' | 'human_answer'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => patch[k] ?? null);
    this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE goal_id = ? AND id = ?`).run(...(vals as any[]), now(), goalId, id);
    if (patch.status) this.event(goalId, 'task.status', { status: patch.status, attempts: patch.attempts }, id);
  }

  tasks(goalId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at, rowid').all(goalId) as Row[]).map(toTask);
  }

  task(goalId: string, id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE goal_id = ? AND id = ?').get(goalId, id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }

  addCost(goalId: string, taskId: string | null, role: string, agent: string, usd: number) {
    this.db.prepare('INSERT INTO costs (goal_id, task_id, role, agent, usd, ts) VALUES (?, ?, ?, ?, ?, ?)').run(goalId, taskId, role, agent, usd, now());
  }

  spent(goalId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM costs WHERE goal_id = ?').get(goalId) as Row;
    return Number(r.s);
  }

  spentByAgent(goalId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT agent, SUM(usd) AS s FROM costs WHERE goal_id = ? GROUP BY agent').all(goalId) as Row[];
    return Object.fromEntries(rows.map((r) => [r.agent as string, Number(r.s)]));
  }
}
