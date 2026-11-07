import type { AgentSpec, UsageWindow } from '../types.ts';
import { run, extractJson } from '../proc.ts';
import { writeLog, type Agent } from './index.ts';
import { detectRateLimit } from './limits.ts';

/**
 * Claude Code in headless print mode, streaming JSON events. Prompt goes over stdin.
 * Besides the final `result` event, the stream carries `rate_limit_event`s with the account's
 * real utilization of each usage window (five_hour, seven_day), which Cortex uses to move work
 * elsewhere before a limit is hit.
 */
export function claudeAgent(name: string, spec: AgentSpec): Agent {
  return {
    name,
    provider: spec.provider ?? 'anthropic',
    async run(req) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', spec.permission_mode ?? 'auto', '--no-session-persistence'];
      if (spec.model) args.push('--model', spec.model);
      if (spec.effort) args.push('--effort', spec.effort);
      if (req.maxUsd) args.push('--max-budget-usd', String(req.maxUsd));
      if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
      args.push(...(spec.extra_args ?? []));

      const p = await run('claude', args, { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, sandbox: req.sandbox });
      writeLog(req.logFile, { args: args.join(' '), prompt: req.prompt, stdout: p.stdout, stderr: p.stderr });

      const { result: res, usage, rejectedUntil } = parseStream(p.stdout);
      const costUsd = Number(res?.total_cost_usd ?? 0);
      if (p.timedOut) return { ok: false, output: res?.result ?? '', costUsd, usage, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (!res || res.is_error || p.code !== 0) {
        const error = [res?.subtype, res?.result, p.stderr.slice(-2000)].filter(Boolean).join(' · ') || `exit ${p.code}`;
        const until = rejectedUntil ?? detectRateLimit(`${res?.result ?? ''} ${p.stderr} ${p.stdout.slice(-2000)}`);
        return { ok: false, output: res?.result ?? '', costUsd, usage, error, rateLimited: until ? { untilMs: until } : undefined };
      }
      const structured = req.jsonSchema ? (res.structured_output ?? extractJson(String(res.result ?? ''))) : undefined;
      return { ok: true, output: String(res.result ?? ''), structured, costUsd, usage };
    },
  };
}

/** Pulls the final result and the latest usage windows out of Claude's stream-json output. */
export function parseStream(stdout: string): { result: any; usage?: UsageWindow[]; rejectedUntil?: number } {
  let result: any;
  let usage: UsageWindow[] | undefined;
  let rejectedUntil: number | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'result') result = ev;
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      const info = ev.rate_limit_info;
      const windows = info.unifiedWindows ?? {};
      usage = Object.entries(windows).map(([window, w]: [string, any]) => ({
        window,
        utilization: Number(w.utilization ?? 0),
        resetsAtMs: Number(w.resetsAt ?? 0) * 1000,
      }));
      if (info.status === 'rejected' && info.resetsAt) rejectedUntil = Number(info.resetsAt) * 1000 + 60000;
    }
  }
  return { result, usage, rejectedUntil };
}
