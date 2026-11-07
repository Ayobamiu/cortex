import type { EvalOutcome, EvalSpec } from './types.ts';
import { sh, tail } from './proc.ts';
import { JUDGE_SCHEMA, judgePrompt } from './prompts.ts';
import type { Agent } from './agents/index.ts';

export interface JudgeContext {
  pickJudge: () => Agent;
  record: (agent: Agent, usd: number) => void;
  logFile: (label: string) => string;
  taskContext: string;
  workerSummary: string;
  diff: () => Promise<string>;
}

/** Runs checks in order and stops at the first failure: cheap deterministic checks should come first. */
export async function runEvals(evals: EvalSpec[], cwd: string, ctx: JudgeContext): Promise<EvalOutcome> {
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
    } else {
      if (!e.criterion) continue;
      const judge = ctx.pickJudge();
      const res = await judge.run({
        prompt: judgePrompt(e.criterion, ctx.taskContext, ctx.workerSummary, await ctx.diff()),
        cwd,
        timeoutMs: (e.timeout_min ?? 15) * 60000,
        jsonSchema: JUDGE_SCHEMA,
        logFile: ctx.logFile(`judge-${i}`),
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
      passed.push(`judge: ${e.criterion}`);
    }
  }
  return { pass: true, feedback: passed.length ? `Passed: ${passed.join('; ')}` : 'No checks defined' };
}
