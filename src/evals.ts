import type { EvalOutcome, EvalSpec } from './types.ts';
import { sh, tail } from './proc.ts';
import { JUDGE_SCHEMA, judgePrompt } from './prompts.ts';
import type { Agent } from './agents/index.ts';
import type { Sandbox } from './sandbox.ts';

export interface JudgeContext {
  /** A judge whose provider isn't in `excludeProviders` and that isn't in `excludeAgents`, or undefined. */
  pickJudge: (excludeProviders: string[], excludeAgents: string[]) => Agent | undefined;
  record: (agent: Agent, usd: number) => void;
  logFile: (label: string) => string;
  taskContext: string;
  workerSummary: string;
  diff: () => Promise<string>;
}

export interface EvalOptions {
  /** Independent judges per criterion, each from a different provider (high-risk tasks use 2). */
  judges?: number;
  /** Eval commands run agent-written code, so they get the same sandbox as the agent. */
  sandbox?: Sandbox;
}

/** Runs checks in order and stops at the first failure: cheap deterministic checks should come first. */
export async function runEvals(evals: EvalSpec[], cwd: string, ctx: JudgeContext, opts: EvalOptions = {}): Promise<EvalOutcome> {
  const passed: string[] = [];
  // A judge that can't produce a verdict is skipped for the rest of this attempt and another one
  // reviews instead; its failure is never charged to the worker.
  const broken: string[] = [];
  const brokenWhy: string[] = [];
  for (const [i, e] of evals.entries()) {
    if (e.kind === 'command') {
      if (!e.run) continue;
      const p = await sh(e.run, { cwd, timeoutMs: (e.timeout_min ?? 20) * 60000, sandbox: opts.sandbox });
      if (p.code !== 0) {
        return {
          pass: false,
          feedback: `Check failed: \`${e.run}\` ${p.timedOut ? 'timed out' : `exited ${p.code}`}.\n${tail(p.stdout + '\n' + p.stderr, 3000)}`,
        };
      }
      passed.push(`\`${e.run}\``);
      continue;
    }
    if (!e.criterion) continue;
    const used: string[] = [];
    let verdicts = 0;
    for (let j = 0; verdicts < (opts.judges ?? 1); j++) {
      const judge = ctx.pickJudge(used, broken);
      if (!judge) {
        if (verdicts > 0) break; // fewer distinct providers than requested: judge with what exists
        return {
          pass: false,
          feedback: `No working judge for "${e.criterion}": ${brokenWhy.join(' | ')}`,
          brokenJudges: broken,
          judgeUnavailable: true,
        };
      }
      const res = await judge.run({
        prompt: judgePrompt(e.criterion, ctx.taskContext, ctx.workerSummary, await ctx.diff()),
        cwd,
        timeoutMs: (e.timeout_min ?? 15) * 60000,
        jsonSchema: JUDGE_SCHEMA,
        logFile: ctx.logFile(`judge-${i}-${j}`),
        sandbox: opts.sandbox,
      });
      ctx.record(judge, res.costUsd);
      if (res.rateLimited) {
        return { pass: false, feedback: `Judge ${judge.name} hit its usage limit`, rateLimited: { agent: judge.name, untilMs: res.rateLimited.untilMs }, brokenJudges: broken };
      }
      const verdict = res.structured as { pass?: boolean; reason?: string } | undefined;
      if (!res.ok || typeof verdict?.pass !== 'boolean') {
        broken.push(judge.name);
        brokenWhy.push(`${judge.name}: ${(res.error ?? 'unparseable output').replace(/\s+/g, ' ').slice(0, 300)}`);
        continue;
      }
      used.push(judge.provider);
      verdicts++;
      if (!verdict.pass) return { pass: false, feedback: `Reviewer (${judge.name}) rejected: "${e.criterion}"\n${verdict.reason ?? ''}`, brokenJudges: broken };
    }
    passed.push(`judge${used.length > 1 ? ` ×${used.length}` : ''}: ${e.criterion}`);
  }
  return { pass: true, feedback: passed.length ? `Passed: ${passed.join('; ')}` : 'No checks defined', brokenJudges: broken };
}
