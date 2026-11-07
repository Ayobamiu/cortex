import type { EvalSpec, GoalConfig, Task } from './types.ts';
import { head } from './proc.ts';

const UNATTENDED = `You are one worker in an autonomous, unattended multi-agent run orchestrated by Cortex. No human is watching: never ask questions or wait for input. Make reasonable decisions and state your assumptions.`;

function describeEvals(evals: EvalSpec[]): string {
  if (!evals.length) return '- (none)';
  return evals.map((e) => (e.kind === 'command' ? `- Command must exit 0: \`${e.run}\`` : `- An independent reviewer will judge: "${e.criterion}"`)).join('\n');
}

function contextFiles(goal: GoalConfig): string {
  return goal.context_files?.length ? `Read these project files first (if present): ${goal.context_files.join(', ')}.` : '';
}

export function workerPrompt(goal: GoalConfig, task: Task, deps: Task[], attempt: number, maxAttempts: number, carried = false): string {
  const depCtx = deps
    .filter((d) => d.summary || d.human_answer)
    .map((d) => `## ${d.title} (${d.id})\n${d.human_answer ? `Human answer: ${d.human_answer}\n` : ''}${head(d.summary ?? '', 3000)}`)
    .join('\n\n');
  return `${UNATTENDED}

# Overall goal
${goal.objective}

# Your task (${task.kind}): ${task.title}
${task.brief}

# How your work will be checked
${describeEvals([...(goal.task_checks ?? []), ...task.evals])}
${depCtx ? `\n# Results of earlier tasks you build on\n${depCtx}\n` : ''}${task.feedback ? `\n# Feedback — this is attempt ${attempt} of ${maxAttempts}; earlier work failed\n${task.feedback}\n` : ''}${carried ? `\nThis directory already contains the previous attempt's work, including any downloads and caches. Continue from it; don't start over.\n` : ''}
# Rules
- You are in a git worktree on a dedicated branch. Work only inside this directory. Cortex commits everything you leave behind, so don't worry about git.
- ${contextFiles(goal)}
- Keep the change focused on this task. Don't redo other tasks' work.
- Automatic guards fail any attempt that commits a credential or a file over 50 MB${goal.protected_paths?.length ? `, or changes a protected path (${goal.protected_paths.join(', ')})` : ''}. Deleting tests triggers an extra integrity review.
- Research tasks: write findings into files in the repo, and cite a source URL for every factual claim. Mark anything unverified as such.
- Finish with a short summary: what you did, what you found, and anything later tasks must know. This summary is passed on to them.`;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short kebab-case id, unique' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['code', 'research', 'review', 'redteam', 'human'] },
          risk: { type: 'string', enum: ['low', 'normal', 'high'], description: 'how much review attempts get' },
          brief: { type: 'string', description: 'self-contained instructions; for kind=human, the question for the user' },
          deps: { type: 'array', items: { type: 'string' }, description: 'keys of new tasks or ids of existing tasks' },
          evals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['command', 'judge'] },
                run: { type: 'string' },
                criterion: { type: 'string' },
              },
              required: ['kind'],
            },
          },
        },
        required: ['key', 'title', 'kind', 'brief', 'deps', 'evals'],
      },
    },
    cancel: { type: 'array', items: { type: 'string' }, description: 'ids of existing tasks to cancel' },
    notes: { type: 'string' },
  },
  required: ['tasks', 'cancel', 'notes'],
} as const;

export interface PlanOutput {
  tasks: { key: string; title: string; kind: Task['kind']; risk?: Task['risk']; brief: string; deps: string[]; evals: EvalSpec[] }[];
  cancel: string[];
  notes: string;
}

export function planPrompt(goal: GoalConfig, tasks: Task[], reasons: string[], integrationLog: string, spentUsd: number): string {
  const state = tasks.length
    ? tasks
        .map(
          (t) =>
            `- [${t.status}] ${t.id} (${t.kind}, attempts ${t.attempts}) "${t.title}" deps=[${t.deps.join(', ')}]` +
            (t.status === 'failed' && t.feedback ? `\n    last failure: ${head(t.feedback, 800)}` : '') +
            (t.status === 'passed' && t.summary ? `\n    result: ${head(t.summary, 400)}` : '') +
            (t.human_answer ? `\n    human answer: ${t.human_answer}` : ''),
        )
        .join('\n')
    : '(no tasks yet)';
  return `You are the planner for Cortex, an orchestrator that runs coding and research agents unattended for hours or days. You do NOT do the work yourself; you decide the task graph. You may read files in this directory (the current integration branch) to understand where things stand. Do not modify anything.

# Goal
${goal.objective}
${contextFiles(goal)}

# Final acceptance (checked once every task has passed)
${describeEvals(goal.acceptance)}

# Why you're being called
${reasons.map((r) => `- ${r}`).join('\n')}

# Current tasks
${state}

# Recent integration history
${integrationLog || '(none)'}

# Spend so far: $${spentUsd.toFixed(2)}${goal.budget?.usd_total ? ` of $${goal.budget.usd_total}` : ''}

# Rules
- Return ONLY new tasks to add, plus ids of existing tasks to cancel. Never re-add passed work.
- Each task should be completable by one agent in under ~1 hour, with a self-contained brief (the agent sees only the goal, its brief, and its deps' summaries).
- Every code/research/review task needs at least one eval. Prefer command evals (tests, scripts, file checks) over judge evals. For research, use a judge eval like "every claim in research/X.md cites a source and the sources support it".
- Kinds: "code" builds, "research" gathers and cites, "review" audits, "redteam" attacks what builders made (tries to game, break or disprove it). Redteam runs on a different provider than the builders, so never label adversarial work "code".
- Risk sets how much review each attempt gets, so spend review where mistakes are costly:
  - "low": command checks only, no reviewer. For notes, docs, logbook entries, isolated scripts and exploratory research whose output later tasks verify anyway. Give low tasks command evals.
  - "normal" (default): command checks, then one independent reviewer per judge criterion.
  - "high": two reviewers from different providers per criterion, plus an integrity review (no gamed tests, no fabricated data). For core logic, scoring or anything the final acceptance depends on, data provenance, security, and red-team fixes.
- Use kind "human" only when progress truly requires the user's decision or credentials. Its brief is the question. Only tasks that depend on it wait; everything else continues.
- A failed task has exhausted its retries. Cancel it and add a different approach (smaller steps, different method), or add a "human" task if it's genuinely blocked. If you cancel a task, tasks depending on it proceed without it, so cancel or replace those too if needed.
- On a checkpoint review: check the plan still serves the goal. Cancel drifting or pointless pending tasks; add missing ones. Returning no changes is fine.
- If the final acceptance failed, add tasks that fix exactly those failures.`;
}

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
} as const;

export function judgePrompt(criterion: string, taskContext: string, workerSummary: string, diff: string): string {
  return `You are an independent, strict reviewer in an automated pipeline. Judge whether the work below meets the criterion. You may read files in this directory to verify; do not modify anything. Fail it if the criterion isn't clearly met; your reason will be sent back to the worker, so make it specific and actionable.

# Criterion
${criterion}

# Context
${taskContext}

# Worker's own summary (may be overconfident; verify)
${head(workerSummary, 4000) || '(none)'}

# Changes
${diff || '(no changes)'}

Answer with JSON: {"pass": boolean, "reason": string}.`;
}
