/** `redteam` = adversarial work against what builders produced; route it to a different provider than `code`. */
export type TaskKind = 'code' | 'research' | 'review' | 'redteam' | 'human';
export type TaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'needs_human' | 'cancelled';
export type GoalStatus = 'active' | 'blocked' | 'done' | 'budget_exhausted' | 'time_exhausted';
export type Role = 'plan' | 'judge' | 'code' | 'research' | 'review' | 'redteam';
/**
 * How much checking a task's attempts get. low: command checks only (no judge spend).
 * normal: commands, then one judge per criterion. high: two judges from different providers per
 * criterion, plus an integrity review (no gamed tests, no fabricated data).
 */
export type TaskRisk = 'low' | 'normal' | 'high';

/** A check. `command` = deterministic (exit 0 passes). `judge` = an LLM verdict on a criterion. */
export interface EvalSpec {
  kind: 'command' | 'judge';
  run?: string;
  criterion?: string;
  timeout_min?: number;
}

export interface AgentSpec {
  adapter: 'claude' | 'muse' | 'cursor' | 'command';
  model?: string;
  effort?: string;
  /** claude only. Default "auto". */
  permission_mode?: string;
  /** command adapter: shell command; prompt arrives on stdin. */
  command?: string;
  /** Used to keep judges on a different provider than the worker. */
  provider?: string;
  extra_args?: string[];
}

export interface Budget {
  usd_total?: number;
  usd_per_attempt?: number;
  max_attempts_per_task?: number;
  max_hours?: number;
  max_replans?: number;
  attempt_timeout_min?: number;
}

/** Lives in the target project as cortex.goal.json. Cortex itself is goal-agnostic. */
export interface GoalConfig {
  id: string;
  objective: string;
  /** Project files every agent should read first (e.g. SPEC.md). */
  context_files?: string[];
  /** Final acceptance checks, run on the integration branch once all tasks pass. */
  acceptance: EvalSpec[];
  /** Invariants checked on every attempt before the task's own evals (e.g. "frozen files unchanged"). */
  task_checks?: EvalSpec[];
  agents: Record<string, AgentSpec>;
  /** Role -> agent name, or ordered list (later entries are fallbacks after repeated failures). */
  routing: Partial<Record<Role, string | string[]>>;
  budget?: Budget;
  concurrency?: number;
  /** Send a digest + run a drift review every N passed tasks. */
  checkpoint_every?: number;
  notify?: { macos?: boolean; webhook?: string };
  /** Branch the integration branch is created from. Default: current HEAD. */
  base_branch?: string;
  /** Paths no task may change (directories end with /). Checked on every attempt. */
  protected_paths?: string[];
  /**
   * Usage anticipation, as a fraction of an agent's provider window (5-hour, weekly...).
   * Above `soft`, work goes to fallback agents (planning/judging still allowed); at `hard`
   * the agent rests until the window resets. Defaults 0.85 / 0.97.
   */
  limits?: { soft?: number; hard?: number };
}

export interface Task {
  id: string;
  goal_id: string;
  title: string;
  kind: TaskKind;
  brief: string;
  deps: string[];
  evals: EvalSpec[];
  agent: string | null;
  status: TaskStatus;
  risk: TaskRisk;
  attempts: number;
  feedback: string | null;
  summary: string | null;
  human_answer: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvalOutcome {
  pass: boolean;
  feedback: string;
  /** A judge hit its usage limit: the verdict is unknown, so the attempt must not count. */
  rateLimited?: { agent: string; untilMs: number };
}

/** One provider usage window as reported by the agent CLI (e.g. Claude's five_hour / seven_day). */
export interface UsageWindow {
  window: string;
  /** 0..1 */
  utilization: number;
  resetsAtMs: number;
}
