import type { AgentSpec } from '../types.ts';
import { run, extractJson } from '../proc.ts';
import { writeLog, type Agent } from './index.ts';
import { detectRateLimit } from './limits.ts';

/** Claude Code in headless print mode. Prompt goes over stdin; one JSON result object comes back. */
export function claudeAgent(name: string, spec: AgentSpec): Agent {
  return {
    name,
    provider: spec.provider ?? 'anthropic',
    async run(req) {
      const args = ['-p', '--output-format', 'json', '--permission-mode', spec.permission_mode ?? 'auto', '--no-session-persistence'];
      if (spec.model) args.push('--model', spec.model);
      if (spec.effort) args.push('--effort', spec.effort);
      if (req.maxUsd) args.push('--max-budget-usd', String(req.maxUsd));
      if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
      args.push(...(spec.extra_args ?? []));

      const p = await run('claude', args, { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs });
      writeLog(req.logFile, { args: args.join(' '), prompt: req.prompt, stdout: p.stdout, stderr: p.stderr });

      const lastLine = p.stdout.trim().split('\n').pop() ?? '';
      let res: any;
      try {
        res = JSON.parse(lastLine);
      } catch {
        res = undefined;
      }
      const costUsd = Number(res?.total_cost_usd ?? 0);
      if (p.timedOut) return { ok: false, output: res?.result ?? '', costUsd, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (!res || res.is_error || p.code !== 0) {
        const error = [res?.subtype, res?.result, p.stderr.slice(-2000)].filter(Boolean).join(' · ') || `exit ${p.code}`;
        const until = detectRateLimit(`${res?.result ?? ''} ${p.stderr} ${p.stdout.slice(-2000)}`);
        return { ok: false, output: res?.result ?? '', costUsd, error, rateLimited: until ? { untilMs: until } : undefined };
      }
      const structured = req.jsonSchema ? (res.structured_output ?? extractJson(String(res.result ?? ''))) : undefined;
      return { ok: true, output: String(res.result ?? ''), structured, costUsd };
    },
  };
}
