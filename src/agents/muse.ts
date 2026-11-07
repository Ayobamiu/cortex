import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSpec } from '../types.ts';
import { run, extractJson } from '../proc.ts';
import { writeLog, type Agent } from './index.ts';
import { detectRateLimit } from './limits.ts';

/**
 * Muse headless mode (`muse exec --json`). It emits JSONL events; the answer text arrives as
 * `run.output.delta` payloads. Muse reports no dollar cost, so its spend counts as 0 and only
 * attempt/time limits bound it.
 */
export function museAgent(name: string, spec: AgentSpec): Agent {
  return {
    name,
    provider: spec.provider ?? 'meta',
    async run(req) {
      const promptFile = req.logFile.replace(/\.log$/, '') + '.prompt.md';
      mkdirSync(dirname(promptFile), { recursive: true });
      let prompt = req.prompt;
      if (req.jsonSchema) {
        prompt += `\n\nEnd your reply with ONLY a JSON object matching this schema, in a \`\`\`json block:\n${JSON.stringify(req.jsonSchema)}`;
      }
      writeFileSync(promptFile, prompt);

      const args = ['exec', '--json', '--workspace', req.cwd, '--prompt-file', promptFile];
      if (spec.model) args.push('--model', spec.model);
      if (spec.effort) args.push('--effort', spec.effort);
      args.push(...(spec.extra_args ?? []));

      const p = await run('muse', args, { cwd: req.cwd, timeoutMs: req.timeoutMs });
      writeLog(req.logFile, { args: args.join(' '), stdout: p.stdout, stderr: p.stderr });

      let output = '';
      let failed: string | undefined;
      for (const line of p.stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.payload_type === 'run.output.delta' && typeof ev.payload?.text === 'string') output += ev.payload.text;
          if (typeof ev.payload_type === 'string' && /run\.lifecycle\.(failed|errored|cancelled)/.test(ev.payload_type)) {
            failed = JSON.stringify(ev.payload).slice(0, 1000);
          }
        } catch {}
      }
      if (p.timedOut) return { ok: false, output, costUsd: 0, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (p.code !== 0 || failed) {
        const error = failed ?? (p.stderr.slice(-2000) || `exit ${p.code}`);
        const until = detectRateLimit(`${failed ?? ''} ${p.stderr.slice(-4000)}`);
        return { ok: false, output, costUsd: 0, error, rateLimited: until ? { untilMs: until } : undefined };
      }
      return { ok: true, output, structured: req.jsonSchema ? extractJson(output) : undefined, costUsd: 0 };
    },
  };
}
