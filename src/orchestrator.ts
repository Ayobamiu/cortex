import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { EvalOutcome, EvalSpec, GoalConfig, GoalStatus, Revision, Role, Task, TaskKind, TaskRisk, UsageWindow } from './types.ts';
import { makeAgent, type Agent } from './agents/index.ts';
import { Workspace } from './workspace.ts';
import { Notifier } from './notify.ts';
import { PhoneLink, loadPhone, type PhoneConfig } from './phone.ts';
import { runEvals, type JudgeContext } from './evals.ts';
import { INTEGRITY_CRITERION, runGuards } from './guards.ts';
import { makeSandbox, type Sandbox } from './sandbox.ts';
import { PLAN_SCHEMA, planPrompt, workerPrompt, type PlanOutput } from './prompts.ts';
import { head, sleep, tail } from './proc.ts';

interface Reason {
  text: string;
  /** Failure-driven replans count against budget.max_replans; checkpoint reviews don't. */
  failure: boolean;
  /** Id of the answered escalation this reason carries to the planner. */
  guidance?: string;
  /** Id of the steer event (your mid-run instruction) this reason carries. */
  steer?: number;
}

export interface OrchestratorOptions {
  store: Store;
  goal: GoalConfig;
  projectDir: string;
  stateDir: string;
  /** Override agents (tests). */
  agents?: Record<string, Agent>;
  pollMs?: number;
  /** Phone link (ntfy). Default: the one set up with `cortex phone`; null = none. */
  phone?: PhoneConfig | null;
  /** fetch for the phone link (tests). */
  fetch?: typeof fetch;
}

const KINDS: TaskKind[] = ['code', 'research', 'review', 'redteam', 'human'];
const RISKS: TaskRisk[] = ['low', 'normal', 'high'];
const CONFLICT_MSG = 'Your change passed its checks but conflicted with work another task merged meanwhile.';

/**
 * The conductor. Deterministic code owns the state machine; LLMs are called only to plan,
 * do work, and judge. Every decision is written to the store first, so a crash or reboot
 * resumes from the last recorded state.
 */
export class Orchestrator {
  private store: Store;
  private goal: GoalConfig;
  private stateDir: string;
  private projectDir: string;
  private ws: Workspace;
  private notifier: Notifier;
  private agents: Record<string, Agent>;
  private pollMs: number;
  private running = new Map<string, Promise<void>>();
  /** agent name -> ms epoch when its usage limit resets. */
  private cooldowns = new Map<string, number>();
  /** agent name -> latest provider usage windows it reported. */
  private usage = new Map<string, UsageWindow[]>();
  private softLimit: number;
  private hardLimit: number;
  private reasons: Reason[] = [];
  private planFailures = 0;
  private notifiedBlocked = false;
  private diskLow = false;
  private logSeq = 0;
  private paused = false;
  private phone?: PhoneConfig;
  private fetchImpl?: typeof fetch;
  /** agent name -> when we last told you it lost its login. */
  private authWarned = new Map<string, number>();
  /** Steer events already handed to the planner by this process. */
  private steersQueued = new Set<number>();

  private maxAttempts: number;
  private maxReplans: number;
  private attemptTimeoutMs: number;
  private concurrency: number;

  constructor(o: OrchestratorOptions) {
    this.store = o.store;
    this.goal = o.goal;
    this.stateDir = o.stateDir;
    this.projectDir = o.projectDir;
    this.pollMs = o.pollMs ?? 30000;
    this.ws = new Workspace(o.projectDir, o.goal.id, o.stateDir, o.goal.base_branch);
    this.phone = o.phone === null || o.goal.notify?.phone === false ? undefined : (o.phone ?? loadPhone());
    this.fetchImpl = o.fetch;
    this.notifier = new Notifier(o.goal.id, o.stateDir, o.goal.notify, this.phone ?? null);
    const raw = o.agents ?? Object.fromEntries(Object.entries(o.goal.agents).map(([n, s]) => [n, makeAgent(n, s)]));
    this.agents = Object.fromEntries(Object.entries(raw).map(([n, a]) => [n, this.instrument(a)]));
    this.softLimit = o.goal.limits?.soft ?? 0.85;
    this.hardLimit = o.goal.limits?.hard ?? 0.97;
    const b = o.goal.budget ?? {};
    this.maxAttempts = b.max_attempts_per_task ?? 3;
    this.maxReplans = b.max_replans ?? 8;
    this.attemptTimeoutMs = (b.attempt_timeout_min ?? 60) * 60000;
    this.concurrency = o.goal.concurrency ?? 2;
    for (const [role, names] of Object.entries(o.goal.routing)) {
      for (const n of [names].flat()) if (n && !this.agents[n]) throw new Error(`routing.${role} names unknown agent "${n}"`);
    }
    if (!Object.keys(this.agents).length) throw new Error('goal config defines no agents');
  }

  private get id() {
    return this.goal.id;
  }

  async run(): Promise<GoalStatus> {
    // While the run is live, your replies in the phone topic act on it.
    const link = this.phone ? new PhoneLink(this.store, this.id, this.phone, this.fetchImpl) : undefined;
    const timer = link ? setInterval(() => void link.poll(), Math.max(this.pollMs, 15000)) : undefined;
    try {
      return await this.loop();
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async loop(): Promise<GoalStatus> {
    await this.ws.init();
    this.applyRevisionsToConfig();
    const existing = this.store.goal(this.id);
    // A revision after the goal was done reopens it.
    if (existing?.status === 'done' && !this.unplannedRevisions().length) {
      await this.notifier.send('info', 'Goal already done; nothing to do.');
      return 'done';
    }
    if (this.store.control(this.id) === 'stop') {
      await this.notifier.send('info', `Stopped by you. Resume with: cortex resume ${this.id}`);
      return 'stopped';
    }
    this.recover();
    this.store.event(this.id, 'run.started');
    this.store.setGoalStatus(this.id, 'active', 'run started');
    await this.notifier.send('info', `Run started: ${head(this.goal.objective, 120)}`);

    while (true) {
      const limit = this.limitHit();
      if (limit) {
        await this.notifier.send('warn', `Stopping: ${limit.reason}. Waiting for ${this.running.size} running task(s) to finish.`);
        await Promise.allSettled(this.running.values());
        this.store.setGoalStatus(this.id, limit.status, limit.reason);
        await this.checkpoint('final (limit reached)');
        return limit.status;
      }

      this.budgetWarning();
      const control = this.store.control(this.id);
      if (control === 'stop') {
        await this.notifier.send('info', `Stopping: waiting for ${this.running.size} running task(s) to finish.`);
        await Promise.allSettled(this.running.values());
        this.store.setGoalStatus(this.id, 'stopped', 'stopped by you');
        await this.notifier.send('info', `Stopped. Resume with: cortex resume ${this.id}`);
        return 'stopped';
      }
      if (control === 'pause') {
        if (!this.paused) {
          this.paused = true;
          this.store.setGoalStatus(this.id, 'paused', 'paused by you');
          await this.notifier.send('info', `Paused: nothing new starts; ${this.running.size} running task(s) finish.`);
        }
        await Promise.race([...this.running.values(), sleep(Math.min(this.pollMs, 5000))]);
        continue;
      }
      if (this.paused) {
        this.paused = false;
        this.notifiedBlocked = false;
        this.store.setGoalStatus(this.id, 'active', 'resumed');
        await this.notifier.send('info', 'Resumed.');
      }
      await this.queueSteers();

      let tasks = this.store.tasks(this.id);
      if (!tasks.length && !this.reasons.length) this.reasons.push({ text: 'Initial plan: break the goal into tasks.', failure: false });

      // Planning happens between launches so the planner sees a consistent picture.
      // Planning happens when the planner is available. If it's resting after a usage limit, the
      // reasons wait and ready work keeps running on other agents meanwhile (a checkpoint review
      // must never stall the whole run).
      if (this.reasons.length && (!tasks.length || this.agentFor('plan', 1))) {
        await this.plan();
        continue;
      }

      this.maybeCheckpoint(tasks);
      await this.askReadyQuestions(tasks);

      const ready = (await this.diskOk()) ? tasks.filter((t) => t.status === 'pending' && t.kind !== 'human' && !this.running.has(t.id) && this.depsSatisfied(t, tasks)) : [];
      let resting = 0;
      for (const t of ready) {
        if (this.running.size >= this.concurrency) break;
        if (!this.agentFor(t.kind as Role, this.countedAttempts(t, t.attempts + 1), t.agent)) {
          resting++;
          continue;
        }
        this.launch(t);
      }
      if (this.running.size) {
        if (this.notifiedBlocked) {
          this.notifiedBlocked = false;
          this.store.setGoalStatus(this.id, 'active', 'unblocked');
        }
        await Promise.race([...this.running.values(), sleep(this.pollMs)]);
        continue;
      }

      // Work is ready but every agent that could do it is resting, or the disk is nearly full.
      if (resting || this.diskLow) {
        await sleep(Math.max(1000, Math.min(this.nextWake() - Date.now(), this.pollMs * 10)));
        continue;
      }

      // Nothing running and nothing launchable while replanning waits for a resting planner.
      if (this.reasons.length) {
        await sleep(Math.max(1000, Math.min(this.nextWake() - Date.now(), this.pollMs * 10)));
        continue;
      }

      // Nothing running and nothing launchable: decide why.
      tasks = this.store.tasks(this.id);
      const live = tasks.filter((t) => t.status !== 'cancelled');
      // Your answer to an escalation is guidance for the planner, not a pass: plan with it first.
      const guidance = this.unreadGuidance(tasks);
      if (guidance.length) {
        this.reasons.push(
          ...guidance.map((g) => ({ text: `The owner answered escalation ${g.id}.\nQuestion as asked:\n${head(g.brief, 3000)}\n\nOwner's answer (verbatim): ${g.human_answer}`, failure: false, guidance: g.id })),
        );
        continue;
      }
      if (live.every((t) => t.status === 'passed')) {
        if (await this.finalAcceptance()) return 'done';
        continue;
      }
      const failed = live.filter((t) => t.status === 'failed');
      if (failed.length) {
        this.reasons.push({ text: `Tasks out of retries: ${failed.map((t) => t.id).join(', ')}`, failure: true });
        continue;
      }
      const humans = live.filter((t) => t.status === 'needs_human');
      if (!humans.length) {
        // Pending tasks whose deps can never be satisfied (cycle / bad reference).
        const stuck = live.filter((t) => t.status === 'pending').map((t) => t.id);
        this.reasons.push({ text: `Deadlock: pending tasks [${stuck.join(', ')}] have dependencies that can never pass. Fix the graph.`, failure: true });
        continue;
      }
      if (!this.notifiedBlocked) {
        this.notifiedBlocked = true;
        this.store.setGoalStatus(this.id, 'blocked', 'waiting on human answers');
        await this.notifier.send(
          'needs_human',
          `Blocked on ${humans.length} question(s); everything else is done.`,
          humans.map((h) => `${h.id}: ${head(h.brief, 300)}\n  → cortex answer ${this.id} ${h.id} "<your answer>"`).join('\n'),
        );
      }
      await sleep(this.pollMs);
    }
  }

  /**
   * Agents download data; a full disk corrupts git and SQLite. Below `min_free_gb`, running tasks
   * finish but nothing new starts until space is freed. Notifies once per low-disk episode.
   */
  private async diskOk(): Promise<boolean> {
    const min = this.goal.min_free_gb ?? 5;
    let freeGb = Infinity;
    try {
      const s = statfsSync(this.projectDir);
      freeGb = (s.bavail * s.bsize) / 1e9;
    } catch {}
    const low = freeGb < min;
    if (low && !this.diskLow) {
      this.store.event(this.id, 'disk.low', { free_gb: Number(freeGb.toFixed(1)), min_gb: min });
      await this.notifier.send('warn', `Disk nearly full: ${freeGb.toFixed(1)} GB free (minimum ${min} GB). Running tasks finish; no new tasks start until space is freed.`);
    } else if (!low && this.diskLow) {
      this.store.event(this.id, 'disk.ok', { free_gb: Number(freeGb.toFixed(1)) });
      await this.notifier.send('info', `Disk space recovered (${freeGb.toFixed(1)} GB free); resuming.`);
    }
    this.diskLow = low;
    return !low;
  }

  /** A question for the human is asked only once the work it depends on (e.g. the research it cites) has passed. */
  private async askReadyQuestions(tasks: Task[]) {
    for (const h of tasks.filter((t) => t.kind === 'human' && t.status === 'pending' && this.depsSatisfied(t, tasks))) {
      this.store.updateTask(this.id, h.id, { status: 'needs_human' });
      this.store.event(this.id, 'question.asked', {}, h.id);
      await this.notifier.send('needs_human', `Question (${h.id}); other work continues`, `${h.brief}\n  → cortex answer ${this.id} ${h.id} "<your answer>"`);
    }
  }

  // ---------- task execution ----------

  private launch(t: Task) {
    const p = this.runTask(t)
      .catch(async (e) => {
        await this.notifier.send('warn', `Internal error running ${t.id}`, String(e?.stack ?? e));
        this.store.updateTask(this.id, t.id, { status: 'pending', feedback: `Internal orchestrator error: ${e}` });
      })
      .finally(() => this.running.delete(t.id));
    this.running.set(t.id, p);
  }

  /**
   * Attempts that weren't the agent's fault (usage limit, orchestrator restart) don't count
   * toward retries or agent fallback. Capped, so a misdetected limit can't loop forever.
   */
  private countedAttempts(task: Task, attempt: number): number {
    // Your guidance on a failed task gives it fresh retries: count only attempts made since.
    const answer = this.store.lastTaskEvent(this.id, task.id, 'human.answer');
    const base = Number(answer?.data.attempts_before ?? 0);
    const free = this.store.countTaskEvents(this.id, task.id, ['attempt.rate_limited', 'attempt.interrupted', 'attempt.judge_unavailable'], answer?.id ?? 0);
    return Math.max(1, attempt - base - Math.min(free, 6));
  }

  private async runTask(task: Task) {
    const attempt = task.attempts + 1;
    const counted = this.countedAttempts(task, attempt);
    this.store.updateTask(this.id, task.id, { status: 'running', attempts: attempt });
    const agent = this.agentFor(task.kind as Role, counted, task.agent)!;
    const logFile = this.logFile(`${task.id}-${attempt}-${agent.name}`);
    this.store.event(this.id, 'attempt.started', { attempt, counted, agent: agent.name, log: logFile }, task.id);
    let limited: { agent: string; untilMs: number } | undefined;

    let wt: { dir: string; branch: string; carried: boolean } | undefined;
    let outcome: EvalOutcome;
    let output = '';
    try {
      const conflicted = (task.feedback ?? '').includes(CONFLICT_MSG);
      wt = await this.ws.createAttempt(task.id, attempt, !conflicted);
      if (wt.carried) this.store.event(this.id, 'attempt.carried_forward', { attempt, from: attempt - 1 }, task.id);
      const tasks = this.store.tasks(this.id);
      const deps = tasks.filter((t) => task.deps.includes(t.id));
      const sandbox = await this.sandboxFor(wt.dir, true);
      const res = await agent.run({
        sandbox,
        prompt: workerPrompt(this.goal, task, deps, counted, this.maxAttempts, wt.carried),
        cwd: wt.dir,
        timeoutMs: this.attemptTimeoutMs,
        maxUsd: this.goal.budget?.usd_per_attempt,
        logFile,
      });
      output = res.output;
      this.store.addCost(this.id, task.id, task.kind, agent.name, res.costUsd);
      const changed = await this.ws.commitAll(wt.dir, `cortex(${task.id}): ${task.title} [attempt ${attempt}, ${agent.name}]`);
      this.store.event(this.id, 'attempt.finished', { attempt, agent: agent.name, ok: res.ok, usd: res.costUsd, changed, error: res.error }, task.id);

      if (res.rateLimited) {
        limited = { agent: agent.name, untilMs: res.rateLimited.untilMs };
        outcome = { pass: false, feedback: '' };
      } else if (!res.ok) {
        const timeoutHint = /timed out/.test(res.error ?? '')
          ? `\nYour work so far (files, downloads, caches) is preserved and the next attempt continues from it. Each attempt is capped at ${this.attemptTimeoutMs / 60000} min: make long jobs resumable from cache, and reduce scope if it still won't fit.`
          : '';
        outcome = { pass: false, feedback: `The agent run failed (${agent.name}): ${res.error}${timeoutHint}\nPartial output:\n${tail(res.output, 1500)}` };
      } else {
        const dir = wt.dir;
        const guards = await runGuards(dir, await this.ws.base(dir), this.goal.protected_paths);
        if (guards.problems.length) {
          outcome = { pass: false, feedback: `Cortex guard checks failed:\n${guards.problems.map((p) => `- ${p}`).join('\n')}` };
        } else {
          let risk = task.risk;
          if (guards.escalate.length && risk !== 'high') {
            risk = 'high';
            this.store.event(this.id, 'attempt.escalated_review', { attempt, why: guards.escalate }, task.id);
          }
          const evals = [...(this.goal.task_checks ?? []), ...this.evalsFor(task.evals, risk)];
          outcome = await runEvals(evals, dir, this.judgeCtx(task, agent, res.output, () => this.ws.diff(dir), `${task.id}-${attempt}`), {
            judges: risk === 'high' ? 2 : 1,
            sandbox,
          });
        }
        if (outcome.rateLimited) limited = outcome.rateLimited;
        for (const name of outcome.brokenJudges ?? []) this.judgeBroke(name, outcome.feedback);
      }
      if (outcome.pass) {
        const merged = await this.ws.merge(wt.branch, `cortex: merge ${task.id} — ${task.title}`);
        if (!merged) {
          outcome = { pass: false, feedback: `${CONFLICT_MSG} Redo it on top of the latest code.` };
        }
      }
    } catch (e: any) {
      outcome = { pass: false, feedback: `Orchestrator error during attempt: ${e?.message ?? e}` };
    } finally {
      if (wt) await this.ws.removeAttempt(wt.dir).catch(() => {});
    }

    if (outcome.judgeUnavailable) {
      // Nobody could judge the work: unknown, not failed. Retry later without spending an attempt.
      this.store.event(this.id, 'attempt.judge_unavailable', { attempt, why: head(outcome.feedback, 1500) }, task.id);
      this.store.updateTask(this.id, task.id, { status: 'pending' });
      return;
    }
    if (limited) {
      // Work is committed on the attempt branch and carries into the next attempt. Feedback is left as it was.
      this.coolDown(limited.agent, limited.untilMs);
      this.store.event(this.id, 'attempt.rate_limited', { attempt, agent: limited.agent, until: new Date(limited.untilMs).toISOString() }, task.id);
      this.store.updateTask(this.id, task.id, { status: 'pending' });
      return;
    }
    this.store.event(this.id, 'eval', { attempt, pass: outcome.pass, feedback: head(outcome.feedback, 4000) }, task.id);
    if (outcome.pass) {
      this.store.updateTask(this.id, task.id, { status: 'passed', summary: head(output, 6000), feedback: outcome.feedback });
      await this.notifier.send('info', `✓ ${task.id} passed (attempt ${attempt}, ${agent.name})`);
    } else if (counted >= this.maxAttempts) {
      this.store.updateTask(this.id, task.id, { status: 'failed', feedback: outcome.feedback });
      this.reasons.push({ text: `Task ${task.id} failed ${counted} times. Last failure: ${head(outcome.feedback, 1500)}`, failure: true });
      await this.notifier.send('warn', `✗ ${task.id} out of retries; replanning`, head(outcome.feedback, 300));
    } else {
      this.store.updateTask(this.id, task.id, { status: 'pending', feedback: outcome.feedback });
      await this.notifier.send('info', `↻ ${task.id} attempt ${attempt} failed; retrying`);
    }
  }

  /**
   * low: only command checks (unless the task has none, so something still checks it).
   * high: every criterion plus the integrity review (judged twice by runEvals).
   */
  private evalsFor(evals: EvalSpec[], risk: TaskRisk): EvalSpec[] {
    if (risk === 'low') {
      const commands = evals.filter((e) => e.kind === 'command');
      return commands.length ? commands : evals;
    }
    if (risk === 'high') return [...evals, { kind: 'judge', criterion: INTEGRITY_CRITERION }];
    return evals;
  }

  private depsSatisfied(t: Task, all: Task[]): boolean {
    return t.deps.every((d) => {
      const dep = all.find((x) => x.id === d);
      return !dep || dep.status === 'passed' || dep.status === 'cancelled';
    });
  }

  // ---------- agents ----------

  private cooling(name: string): boolean {
    return (this.cooldowns.get(name) ?? 0) > Date.now();
  }

  /** A judge that failed to produce a verdict rests for 30 minutes so it doesn't stall every review. */
  private judgeBroke(name: string, why: string) {
    if (this.cooling(name)) return;
    this.store.event(this.id, 'judge.broken', { agent: name, why: head(why, 1500) });
    this.coolDown(name, Date.now() + 30 * 60000, `couldn't produce a verdict; other judges review instead for 30 min. Check its config/logs`);
  }

  /** Records the usage windows every agent call reports, so limits are seen coming. */
  private instrument(a: Agent): Agent {
    return {
      name: a.name,
      provider: a.provider,
      run: async (req) => {
        const res = await a.run(req);
        if (res.usage?.length) this.noteUsage(a.name, res.usage);
        if (res.rateLimited?.auth && Date.now() - (this.authWarned.get(a.name) ?? 0) > 3600e3) {
          this.authWarned.set(a.name, Date.now());
          this.store.event(this.id, 'agent.auth_lost', { agent: a.name });
          const fix = (this.goal.agents[a.name]?.adapter ?? '') === 'cursor' ? 'cursor-agent login' : 'claude, then /login';
          void this.notifier.send('warn', `${a.name} lost its login`, `Its work goes to other agents meanwhile. Fix on the Mac: ${fix}`);
        }
        return res;
      },
    };
  }

  private noteUsage(name: string, windows: UsageWindow[]) {
    const before = this.pressure(name);
    this.usage.set(name, windows);
    this.store.event(this.id, 'agent.usage', { agent: name, windows });
    const now = this.pressure(name);
    const top = this.fullest(name);
    if (!top) return;
    const resets = new Date(top.resetsAtMs).toLocaleString();
    if (now >= this.hardLimit) {
      this.coolDown(name, top.resetsAtMs + 60000, `${Math.round(now * 100)}% of its ${top.window} window used; resting it until it resets (${resets}) before it hits the limit`);
    } else if (now >= this.softLimit && before < this.softLimit) {
      void this.notifier.send('info', `${name} is at ${Math.round(now * 100)}% of its ${top.window} window; sending new work to fallback agents until ${resets}`);
    }
  }

  /** The agent's fullest usage window that hasn't reset yet. */
  private fullest(name: string): UsageWindow | undefined {
    return (this.usage.get(name) ?? [])
      .filter((w) => w.resetsAtMs > Date.now())
      .sort((a, b) => b.utilization - a.utilization)[0];
  }

  private pressure(name: string): number {
    return this.fullest(name)?.utilization ?? 0;
  }

  private coolDown(name: string, untilMs: number, why?: string) {
    this.cooldowns.set(name, untilMs);
    this.store.event(this.id, 'agent.cooldown', { agent: name, until: new Date(untilMs).toISOString(), anticipated: !!why });
    void this.notifier.send('info', why ? `${name}: ${why}` : `${name} hit its usage limit; resting it until ${new Date(untilMs).toLocaleTimeString()} (not counted as a failure)`);
  }

  /**
   * Ordered candidates for a role; every 2 counted failures moves to the next fallback agent.
   * Agents resting after a usage limit are skipped; returns undefined if every candidate is resting.
   */
  private agentFor(role: Role, attempt: number, preferred?: string | null): Agent | undefined {
    let names = [preferred, ...[this.goal.routing[role] ?? this.goal.routing.code ?? []].flat()].filter(
      (n, i, a): n is string => !!n && !!this.agents[n] && a.indexOf(n) === i,
    );
    if (!names.length) names = Object.keys(this.agents);
    const start = Math.min(Math.floor((attempt - 1) / 2), names.length - 1);
    const order = [...names.slice(start), ...names.slice(0, start)].filter((n) => !this.cooling(n));
    // Planning is small and essential: it may use an agent up to the hard limit. Work moves to
    // fallbacks at the soft limit, but if every candidate is past it, use the least loaded.
    const soft = role === 'plan' ? this.hardLimit : this.softLimit;
    const name = order.find((n) => this.pressure(n) < soft) ?? [...order].sort((a, b) => this.pressure(a) - this.pressure(b))[0];
    return name ? this.agents[name] : undefined;
  }

  /**
   * Judges come from a different provider than the worker whenever possible, are never resting,
   * and prefer agents under the soft usage limit. `exclude` holds providers that already judged
   * this criterion: a second judge must be independent of the first, else there is none.
   */
  private pickJudge(workerProvider: string | undefined, exclude: string[], excludeAgents: string[] = []): Agent | undefined {
    const names = [this.goal.routing.judge ?? this.goal.routing.plan ?? []].flat().filter((n) => this.agents[n]);
    const all = (names.length ? names : Object.keys(this.agents)).map((n) => this.agents[n]);
    const awake = all.filter((a) => !this.cooling(a.name));
    const usable = all.filter((a) => !excludeAgents.includes(a.name));
    const awakeUsable = awake.filter((a) => !excludeAgents.includes(a.name));
    const pool = (awakeUsable.length ? awakeUsable : usable).filter((a) => !exclude.includes(a.provider));
    if (!pool.length) return undefined;
    const rank = (a: Agent) => (a.provider === workerProvider ? 2 : 0) + (this.pressure(a.name) >= this.softLimit ? 1 : 0);
    return [...pool].sort((a, b) => rank(a) - rank(b))[0];
  }

  /** Soonest moment a resting agent wakes up (for sleeping when everything is rate-limited). */
  private nextWake(): number {
    const times = [...this.cooldowns.values()].filter((t) => t > Date.now());
    return times.length ? Math.min(...times) : Date.now() + this.pollMs;
  }

  private judgeCtx(task: Task | null, worker: Agent | null, summary: string, diff: () => Promise<string>, label: string): JudgeContext {
    return {
      pickJudge: (exclude, excludeAgents) => this.pickJudge(worker?.provider, exclude, excludeAgents),
      record: (a, usd) => this.store.addCost(this.id, task?.id ?? null, 'judge', a.name, usd),
      logFile: (l) => this.logFile(`${label}-${l}`),
      taskContext: task ? `Goal: ${this.goal.objective}\n\nTask: ${task.title}\n${task.brief}` : `Goal: ${this.goal.objective}\n\n(Final acceptance of the whole goal.)`,
      workerSummary: summary,
      diff,
    };
  }

  // ---------- planning ----------

  private async plan() {
    const reasons = this.reasons.splice(0);
    const failure = reasons.some((r) => r.failure);
    // Owner guidance on an escalation starts a fresh replan budget.
    const plans = this.store.events(this.id, 10000, 'plan');
    const lastGuided = plans.findLastIndex((e) => ((e.data.guidance as string[] | undefined)?.length ?? 0) + ((e.data.steers as number[] | undefined)?.length ?? 0) > 0);
    const failureReplans = plans.slice(lastGuided + 1).filter((e) => e.data.failure).length;
    const guidance = reasons.flatMap((r) => (r.guidance ? [r.guidance] : []));
    const steers = reasons.flatMap((r) => (r.steer ? [r.steer] : []));

    if (failure && !guidance.length && !steers.length && failureReplans >= this.maxReplans) {
      await this.escalate(`Replan limit (${this.maxReplans}) reached`, reasons);
      return;
    }

    const planner = this.agentFor('plan', 1);
    if (!planner) {
      this.reasons.unshift(...reasons);
      await sleep(Math.min(this.nextWake() - Date.now(), this.pollMs * 10));
      return;
    }
    const tasks = this.store.tasks(this.id);
    let log = '';
    try {
      log = await this.ws.integrationLog();
    } catch {}
    const planLog = this.logFile(`plan-${planner.name}`);
    this.store.event(this.id, 'plan.started', { agent: planner.name, log: planLog, reasons: reasons.length });
    const res = await planner.run({
      sandbox: await this.sandboxFor(this.ws.integrationDir, false),
      prompt: planPrompt(this.goal, tasks, reasons.map((r) => r.text), log, this.store.spent(this.id)),
      cwd: this.ws.integrationDir,
      timeoutMs: 20 * 60000,
      maxUsd: this.goal.budget?.usd_per_attempt,
      jsonSchema: PLAN_SCHEMA,
      logFile: planLog,
    });
    this.store.addCost(this.id, null, 'plan', planner.name, res.costUsd);
    if (res.rateLimited) {
      this.coolDown(planner.name, res.rateLimited.untilMs);
      this.reasons.unshift(...reasons);
      return;
    }
    const out = res.structured as PlanOutput | undefined;

    if (!res.ok || !out || !Array.isArray(out.tasks) || (!tasks.length && !out.tasks.length)) {
      this.planFailures++;
      this.store.event(this.id, 'plan.failed', { error: res.error ?? 'no usable plan', attempt: this.planFailures });
      if (this.planFailures >= 3) {
        this.planFailures = 0;
        await this.escalate(`Planner (${planner.name}) failed 3 times: ${res.error ?? 'no usable plan'}`, reasons);
      } else {
        this.reasons.unshift(...reasons);
        await this.notifier.send('warn', `Planner failed (${this.planFailures}/3); retrying`, res.error ?? '');
        await sleep(Math.min(this.pollMs, 60000));
      }
      return;
    }
    this.planFailures = 0;

    const added: string[] = [];
    const cancelled: string[] = [];
    this.store.tx(() => {
      for (const id of out.cancel ?? []) {
        const t = tasks.find((x) => x.id === id);
        if (t && t.status !== 'passed' && t.status !== 'running' && t.status !== 'cancelled') {
          this.store.updateTask(this.id, id, { status: 'cancelled' });
          cancelled.push(id);
        }
      }
      const taken = new Set(tasks.map((t) => t.id));
      const keyToId = new Map<string, string>();
      for (const nt of out.tasks) {
        let id = slug(nt.key || nt.title);
        for (let i = 2; taken.has(id); i++) id = `${slug(nt.key || nt.title)}-${i}`;
        taken.add(id);
        keyToId.set(nt.key, id);
      }
      for (const nt of out.tasks) {
        const id = keyToId.get(nt.key)!;
        const kind: TaskKind = KINDS.includes(nt.kind) ? nt.kind : 'code';
        const deps = (nt.deps ?? []).map((d) => keyToId.get(d) ?? d).filter((d) => taken.has(d) && d !== id);
        const evals = (nt.evals ?? []).filter((e: EvalSpec) => (e.kind === 'command' && e.run) || (e.kind === 'judge' && e.criterion));
        const risk: TaskRisk = RISKS.includes(nt.risk as TaskRisk) ? (nt.risk as TaskRisk) : 'normal';
        this.store.insertTask({
          id, goal_id: this.id, title: nt.title, kind, brief: nt.brief, deps, evals, risk,
          // A deep task prefers the first `deep` agent; the role's list stays as its fallbacks.
          agent: nt.deep && kind !== 'human' ? ([this.goal.routing.deep ?? []].flat().find((n) => this.agents[n]) ?? null) : null,
          status: 'pending', // human questions are asked by askReadyQuestions once their deps pass
        });
        added.push(id);
      }
      // A failed task the planner neither cancelled nor replaced would deadlock its dependents.
      for (const t of this.store.tasks(this.id).filter((x) => x.status === 'failed')) {
        this.store.updateTask(this.id, t.id, { status: 'needs_human' });
      }
      this.store.event(this.id, 'plan', { failure, reasons: reasons.map((r) => r.text), notes: out.notes, added, cancelled, agent: planner.name, guidance, steers });
    });

    await this.notifier.send('info', `Plan updated: +${added.length} task(s), −${cancelled.length}`, head(out.notes ?? '', 500));
  }

  /** Out of automatic options: park the problem as a question for the human. Only its dependents wait. */
  private async escalate(why: string, reasons: Reason[]) {
    const id = `human-${Date.now().toString(36)}`;
    const failed = this.store.tasks(this.id).filter((t) => t.status === 'failed');
    this.store.tx(() => {
      this.store.insertTask({
        id, goal_id: this.id, kind: 'human', status: 'needs_human', agent: null, deps: [], evals: [],
        title: 'Guidance needed',
        brief: `${why}.\n${reasons.map((r) => `- ${head(r.text, 600)}`).join('\n')}\nHow should Cortex proceed?`,
      });
      for (const t of failed) this.store.updateTask(this.id, t.id, { status: 'needs_human' });
      this.store.event(this.id, 'escalated', { why, task: id });
    });
    await this.notifier.send('needs_human', why, `cortex answer ${this.id} ${id} "<guidance>"`);
  }

  // ---------- finish, limits, checkpoints ----------

  private async finalAcceptance(): Promise<boolean> {
    const outcome = await runEvals(
      this.goal.acceptance,
      this.ws.integrationDir,
      this.judgeCtx(null, null, 'See integration history.', () => this.ws.integrationLog(100), 'acceptance'),
      { sandbox: await this.sandboxFor(this.ws.integrationDir, true) },
    );
    if (outcome.rateLimited) {
      // Verdict unknown: rest the judge and try acceptance again later, without counting a failure.
      this.coolDown(outcome.rateLimited.agent, outcome.rateLimited.untilMs);
      await sleep(Math.min(outcome.rateLimited.untilMs - Date.now(), this.pollMs * 10));
      return false;
    }
    for (const name of outcome.brokenJudges ?? []) this.judgeBroke(name, outcome.feedback);
    if (outcome.judgeUnavailable) {
      await this.notifier.send('warn', 'Final acceptance: no working judge; retrying later', head(outcome.feedback, 500));
      await sleep(this.pollMs * 10);
      return false;
    }
    this.store.event(this.id, 'acceptance', { pass: outcome.pass, feedback: head(outcome.feedback, 4000) });
    if (outcome.pass) {
      this.store.setGoalStatus(this.id, 'done', 'final acceptance passed');
      const digest = await this.checkpoint('final');
      await this.notifier.send('done', 'Goal complete — final acceptance passed', `Branch: ${this.ws.integrationBranch}\nDigest: ${digest}`);
      return true;
    }
    this.reasons.push({ text: `Final acceptance failed:\n${head(outcome.feedback, 2000)}`, failure: true });
    return false;
  }

  /** Escalations you answered after the planner last ran: their answers haven't been planned with yet. */
  /** Your mid-run instructions not yet given to the planner become planning reasons. */
  private async queueSteers() {
    const consumed = this.plannedSteers();
    for (const e of this.store.events(this.id, 10000, 'human.steer')) {
      if (consumed.has(e.id) || this.steersQueued.has(e.id)) continue;
      this.steersQueued.add(e.id);
      this.reasons.push({
        text: `The owner sent this instruction mid-run (verbatim): ${e.data.text}\nAdjust the plan to follow it: add, cancel or change tasks as needed. If it asks for something only the owner can decide, add a 'human' question.`,
        failure: false,
        steer: e.id,
      });
    }
    for (const e of this.unplannedRevisions()) {
      if (this.steersQueued.has(e.id)) continue;
      this.steersQueued.add(e.id);
      const r = e.data as unknown as Revision;
      const diff = await this.applyRevision(e.id, r);
      this.reasons.push({
        text: [
          `The owner revised the goal mid-run (their summary, verbatim): ${r.summary}`,
          r.objective ? `New objective: ${r.objective}` : '',
          r.acceptance ? `New final acceptance:\n${r.acceptance.map((a) => `- ${a.kind === 'command' ? `\`${a.run}\` passes` : a.criterion}`).join('\n')}` : '',
          diff ? `Committed on the integration branch:\n${head(diff, 6000)}` : '',
          'Re-plan against the revised goal: cancel tasks that no longer serve it, and add or change tasks for what is new or different (including reworking merged work the revision contradicts). Work that still fits stays.',
        ].filter(Boolean).join('\n\n'),
        failure: false,
        steer: e.id,
      });
    }
  }

  /** Steer and revision event ids the planner has already planned with. */
  private plannedSteers(): Set<number> {
    return new Set(this.store.events(this.id, 10000, 'plan').flatMap((e) => (e.data.steers as number[] | undefined) ?? []));
  }

  private unplannedRevisions() {
    const planned = this.plannedSteers();
    return this.store.events(this.id, 10000, 'human.revise').filter((e) => !planned.has(e.id));
  }

  /** Revisions are the record: the goal file on disk may predate them, so replay them on start. */
  private applyRevisionsToConfig() {
    const revs = this.store.events(this.id, 10000, 'human.revise');
    if (!revs.length) return;
    for (const e of revs) {
      const r = e.data as unknown as Revision;
      if (r.objective) this.goal.objective = r.objective;
      if (r.acceptance) this.goal.acceptance = r.acceptance;
    }
    this.store.upsertGoal(this.goal, this.projectDir);
  }

  /** Commits the revised spec (and goal file) on the integration branch, once. Returns the diff. */
  private async applyRevision(id: number, r: Revision): Promise<string> {
    this.applyRevisionsToConfig();
    const done = this.store.events(this.id, 10000, 'spec.revised').find((e) => e.data.revision === id);
    if (done) return String(done.data.diff ?? '');
    const files: Record<string, string> = {};
    if (r.spec_md?.trim()) files[this.goal.context_files?.[0] ?? 'SPEC.md'] = r.spec_md.trim() + '\n';
    const goalFile = join(this.ws.integrationDir, 'cortex.goal.json');
    if ((r.objective || r.acceptance) && existsSync(goalFile)) {
      try {
        const g = JSON.parse(readFileSync(goalFile, 'utf8'));
        if (r.objective) g.objective = r.objective;
        if (r.acceptance) g.acceptance = r.acceptance;
        files['cortex.goal.json'] = JSON.stringify(g, null, 2) + '\n';
      } catch {}
    }
    let diff = '';
    try {
      if (Object.keys(files).length) diff = await this.ws.commitIntegration(files, `cortex: owner revised the goal: ${head(r.summary, 100)}`);
    } catch (err: any) {
      await this.notifier.send('warn', 'Could not commit your revised spec; the planner still gets it', head(String(err?.message ?? err), 300));
    }
    this.store.event(this.id, 'spec.revised', { revision: id, summary: r.summary, files: Object.keys(files), diff: head(diff, 20000) });
    await this.notifier.send('info', `Goal revised: ${head(r.summary, 120)}. Replanning.`);
    return diff;
  }

  private unreadGuidance(tasks: Task[]): Task[] {
    const escalations = new Set(this.store.events(this.id, 10000, 'escalated').map((e) => String(e.data.task)));
    const lastPlan = this.store.events(this.id, 1, 'plan')[0]?.id ?? 0;
    const answeredAfter = new Set(this.store.events(this.id, 10000, 'human.answer').filter((e) => e.id > lastPlan).map((e) => e.task_id));
    return tasks.filter((t) => escalations.has(t.id) && t.status === 'passed' && t.human_answer && answeredAfter.has(t.id));
  }

  /** One heads-up when 80% of the budget is spent. */
  private budgetWarning() {
    const total = this.goal.budget?.usd_total;
    if (!total) return;
    const spent = this.store.spent(this.id);
    if (spent < 0.8 * total || this.store.countEvents(this.id, 'budget.warned')) return;
    this.store.event(this.id, 'budget.warned', { spent, total });
    void this.notifier.send('warn', `80% of the budget spent ($${spent.toFixed(2)} of $${total})`, 'Raise budget.usd_total in cortex.goal.json to keep going past it; the run stops cleanly at the limit.');
  }

  private limitHit(): { status: GoalStatus; reason: string } | undefined {
    const b = this.goal.budget ?? {};
    const spent = this.store.spent(this.id);
    if (b.usd_total && spent >= b.usd_total) return { status: 'budget_exhausted', reason: `budget spent ($${spent.toFixed(2)} of $${b.usd_total})` };
    if (b.max_hours && this.store.activeHours(this.id) >= b.max_hours) {
      return { status: 'time_exhausted', reason: `time limit of ${b.max_hours} working hours reached` };
    }
    return undefined;
  }

  private maybeCheckpoint(tasks: Task[]) {
    const every = this.goal.checkpoint_every;
    if (!every) return;
    const passed = tasks.filter((t) => t.status === 'passed' && t.kind !== 'human').length;
    const last = this.store.events(this.id, 1, 'checkpoint')[0];
    const lastPassed = Number(last?.data.passed ?? 0);
    if (passed - lastPassed < every) return;
    this.store.event(this.id, 'checkpoint', { passed });
    void this.checkpoint(`every ${every} tasks`).then((path) =>
      this.notifier.send('needs_human', `Checkpoint: ${passed} tasks done; work continues`, `Digest: ${path}`),
    );
    this.reasons.push({ text: `Checkpoint review after ${passed} passed tasks: is the plan still the best path to the goal?`, failure: false });
  }

  /** Writes a human-readable digest of where things stand. Returns its path. */
  async checkpoint(label: string): Promise<string> {
    const tasks = this.store.tasks(this.id);
    const by = (s: string) => tasks.filter((t) => t.status === s);
    const spend = this.store.spentByAgent(this.id);
    const lines = [
      `# Cortex digest: ${this.id} (${label})`,
      `${new Date().toISOString()} · goal status: ${this.store.goal(this.id)?.status}`,
      '',
      `**Goal:** ${this.goal.objective}`,
      '',
      `**Tasks:** ${by('passed').length} passed · ${by('pending').length + by('running').length} open · ${by('needs_human').length} need you · ${by('failed').length} failed · ${by('cancelled').length} cancelled`,
      `**Spend:** $${this.store.spent(this.id).toFixed(2)} (${Object.entries(spend).map(([a, u]) => `${a} $${u.toFixed(2)}`).join(', ') || 'none'})`,
      `**Branch:** \`${this.ws.integrationBranch}\``,
      '',
      '## Needs you',
      ...(by('needs_human').map((t) => `- **${t.id}**: ${t.brief}\n  \`cortex answer ${this.id} ${t.id} "..."\``) || []),
      by('needs_human').length ? '' : '- nothing',
      '',
      '## Done',
      ...by('passed').map((t) => `- **${t.title}** (${t.id}, ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}): ${head((t.summary ?? t.human_answer ?? '').replace(/\s+/g, ' '), 300)}`),
      '',
      '## Recent plan notes',
      ...this.store.events(this.id, 3, 'plan').map((e) => `- ${e.ts}: ${head(String(e.data.notes ?? ''), 500)}`),
    ];
    const dir = join(this.stateDir, 'digests');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  /** After a crash or reboot: anything marked running was interrupted. Requeue it (attempt not refunded). */
  private recover() {
    for (const t of this.store.tasks(this.id).filter((x) => x.status === 'running')) {
      this.store.updateTask(this.id, t.id, { status: 'pending' });
      // Not the agent's fault: doesn't count toward retries.
      this.store.event(this.id, 'attempt.interrupted', { attempt: t.attempts }, t.id);
    }
    // A question asked before the work it depends on had passed (older cortex versions) goes back to waiting.
    const all = this.store.tasks(this.id);
    for (const h of all.filter((t) => t.kind === 'human' && t.status === 'needs_human' && !t.human_answer && t.deps.length && !this.depsSatisfied(t, all))) {
      this.store.updateTask(this.id, h.id, { status: 'pending' });
      this.store.event(this.id, 'question.deferred', { reason: 'dependencies not passed yet' }, h.id);
    }
    // Usage readings and usage-limit rests survive restarts.
    for (const e of this.store.events(this.id, 500, 'agent.usage')) {
      this.usage.set(String(e.data.agent), e.data.windows as UsageWindow[]);
    }
    for (const e of this.store.events(this.id, 200, 'agent.cooldown')) {
      const until = Date.parse(String(e.data.until));
      if (until > Date.now()) this.cooldowns.set(String(e.data.agent), until);
    }
  }

  /**
   * The sandbox for work in `dir`. Writable: the directory and its git admin dir (or nothing,
   * for the read-only planner). Readable: the project (its .git holds the objects) and the run's
   * logs (Muse reads its prompt from there). Everything else follows sandbox.ts.
   */
  private async sandboxFor(dir: string, write: boolean): Promise<Sandbox | undefined> {
    const writable = write ? [dir, await this.ws.gitDir(dir)] : [];
    return makeSandbox({ writable, readable: [dir, this.projectDir, join(this.stateDir, 'logs')] }, this.goal.sandbox);
  }

  private logFile(label: string): string {
    const dir = join(this.stateDir, 'logs');
    return join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${++this.logSeq}-${label.replace(/[^\w.-]/g, '_')}.log`);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}
