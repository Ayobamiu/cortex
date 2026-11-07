import type { EvalOutcome, EvalSpec } from './types.ts';
import { sh, tail } from './proc.ts';
import { JUDGE_SCHEMA, judgePrompt } from './prompts.ts';
import type { Agent } from './agents/index.ts';

export interface JudgeContext {
  /** A judge whose provider isn't in `excludeProviders`, or undefined if there's none. */
  pickJudge: (excludeProviders: string[]) => Agent | undefined;
  record: (agent: Agent, usd: number) => void;
  logFile: (label: string) => string;
  taskContext: string;
  workerSummary: string;
  diff: () => Promise<string>;
}

export interface EvalOptions {
  /** Independent judges per criterion, each from a different provider (high-risk tasks use 2). */
  judges?: number;
}

/** Runs checks in order and stops at the first failure: cheap deterministic checks should come first. */
export async function runEvals(evals: EvalSpec[], cwd: string, ctx: JudgeContext, opts: EvalOptions = {}): Promise<EvalOutcome> {
  const passed: string[] = [];
  for (const [i, e] of evals.entries()) {
    if (e.kind === 'command') {
      if (!e.run) continue;
      const p = await sh(e.run, { cwd, timeoutMs: (e.timeout_min ?? 20) * 60000 });
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
    for (let j = 0; j < (opts.judges ?? 1); j++) {
      const judge = ctx.pickJudge(used);
      if (!judge) break; // fewer distinct providers than requested: judge with what exists
      used.push(judge.provider);
      const res = await judge.run({
        prompt: judgePrompt(e.criterion, ctx.taskContext, ctx.workerSummary, await ctx.diff()),
        cwd,
        timeoutMs: (e.timeout_min ?? 15) * 60000,
        jsonSchema: JUDGE_SCHEMA,
        logFile: ctx.logFile(`judge-${i}-${j}`),
      });
      ctx.record(judge, res.costUsd);
      if (res.rateLimited) {
        return { pass: false, feedback: `Judge ${judge.name} hit its usage limit`, rateLimited: { agent: judge.name, untilMs: res.rateLimited.untilMs } };
      }
      const verdict = res.structured as { pass?: boolean; reason?: string } | undefined;
      if (!res.ok || typeof verdict?.pass !== 'boolean') {
        return { pass: false, feedback: `Judge (${judge.name}) could not produce a verdict: ${res.error ?? 'unparseable output'}` };
      }
      if (!verdict.pass) return { pass: false, feedback: `Reviewer (${judge.name}) rejected: "${e.criterion}"\n${verdict.reason ?? ''}` };
    }
    passed.push(`judge${used.length > 1 ? ` ×${used.length}` : ''}: ${e.criterion}`);
  }
  return { pass: true, feedback: passed.length ? `Passed: ${passed.join('; ')}` : 'No checks defined' };
}
