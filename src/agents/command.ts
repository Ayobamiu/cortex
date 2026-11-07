import type { AgentSpec } from '../types.ts';
import { sh, extractJson } from '../proc.ts';
import { writeLog, type Agent } from './index.ts';
import { detectRateLimit } from './limits.ts';

/**
 * Any CLI as an agent: prompt on stdin, answer on stdout. Use it for providers without a
 * dedicated adapter (e.g. `codex exec -`) and for tests. If the last stdout line is
 * `CORTEX_COST_USD=<n>` it is recorded as spend.
 */
export function commandAgent(name: string, spec: AgentSpec): Agent {
  if (!spec.command) throw new Error(`agent ${name}: command adapter needs "command"`);
  return {
    name,
    provider: spec.provider ?? name,
    async run(req) {
      const env = req.jsonSchema ? { CORTEX_JSON_SCHEMA: JSON.stringify(req.jsonSchema) } : {};
      const p = await sh(spec.command!, { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, env });
      writeLog(req.logFile, { command: spec.command!, prompt: req.prompt, stdout: p.stdout, stderr: p.stderr });
      let output = p.stdout;
      let costUsd = 0;
      const m = output.match(/\nCORTEX_COST_USD=([\d.]+)\s*$/);
      if (m) {
        costUsd = Number(m[1]);
        output = output.slice(0, m.index);
      }
      if (p.timedOut) return { ok: false, output, costUsd, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (p.code !== 0) {
        const until = detectRateLimit(`${p.stdout.slice(-2000)} ${p.stderr.slice(-2000)}`);
        return { ok: false, output, costUsd, error: p.stderr.slice(-2000) || `exit ${p.code}`, rateLimited: until ? { untilMs: until } : undefined };
      }
      return { ok: true, output, structured: req.jsonSchema ? extractJson(output) : undefined, costUsd };
    },
  };
}
