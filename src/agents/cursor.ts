import type { AgentSpec } from '../types.ts';
import { run, extractJson } from '../proc.ts';
import { writeLog, type Agent } from './index.ts';
import { detectRateLimit } from './limits.ts';

/**
 * Cursor's agent CLI in print mode (`cursor-agent -p --output-format json`), prompt on stdin.
 * Unattended edits need a permission flag. None is passed by default: set it explicitly via
 * `extra_args` (e.g. ["--force"]) once you've decided that's acceptable.
 * Cost isn't reported (subscription), so spend counts as 0.
 */
export function cursorAgent(name: string, spec: AgentSpec): Agent {
  return {
    name,
    provider: spec.provider ?? 'cursor',
    async run(req) {
      let prompt = req.prompt;
      if (req.jsonSchema) {
        prompt += `\n\nEnd your reply with ONLY a JSON object matching this schema, in a \`\`\`json block:\n${JSON.stringify(req.jsonSchema)}`;
      }
      const args = ['-p', '--output-format', 'json'];
      if (spec.model) args.push('--model', spec.model);
      args.push(...(spec.extra_args ?? []));

      const p = await run('cursor-agent', args, { cwd: req.cwd, input: prompt, timeoutMs: req.timeoutMs });
      writeLog(req.logFile, { args: args.join(' '), prompt, stdout: p.stdout, stderr: p.stderr });

      let res: any;
      try {
        res = JSON.parse(p.stdout.trim().split('\n').pop() ?? '');
      } catch {}
      const output = String(res?.result ?? p.stdout);
      if (p.timedOut) return { ok: false, output, costUsd: 0, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (p.code !== 0 || res?.is_error) {
        const error = (res?.result ? String(res.result) : '') + p.stderr.slice(-2000) || `exit ${p.code}`;
        const until = detectRateLimit(error);
        return { ok: false, output, costUsd: 0, error, rateLimited: until ? { untilMs: until } : undefined };
      }
      return { ok: true, output, structured: req.jsonSchema ? extractJson(output) : undefined, costUsd: 0 };
    },
  };
}
