import type { AgentSpec } from '../types.ts';
import { run, extractJson } from '../proc.ts';
import { writeLog, liveLog, finishLive, type Agent } from './index.ts';
import { detectRateLimit, isAuthError } from './limits.ts';

/**
 * Cursor's agent CLI in print mode (`cursor-agent -p --output-format stream-json`), prompt on stdin.
 * The stream is followed live by `cortex chat`; its final `result` event carries the answer.
 * Unattended edits need a permission flag. None is passed by default: set it explicitly via
 * `extra_args` (e.g. ["--force"]) once you've decided that's acceptable.
 * For read-only roles (judging), `extra_args: ["--mode", "ask"]` needs no extra permissions.
 * Note: `--sandbox enabled` did not stop writes outside the workspace when combined with
 * --force (tested 2026-11-06), so it isn't a substitute for an OS-level sandbox.
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
      // `auto` stays available when named models are out of quota on the account.
      const args = ['-p', '--output-format', 'stream-json', '--model', spec.model ?? 'auto'];
      args.push(...(spec.extra_args ?? []));

      const p = await run('cursor-agent', args, { cwd: req.cwd, input: prompt, timeoutMs: req.timeoutMs, sandbox: req.sandbox, tee: liveLog(req.logFile) });
      writeLog(req.logFile, { args: args.join(' '), prompt, stdout: p.stdout, stderr: p.stderr });
      finishLive(req.logFile);

      const { result: res, text } = parseCursorStream(p.stdout);
      const output = String(res?.result ?? text);
      if (p.timedOut) return { ok: false, output, costUsd: 0, error: `timed out after ${req.timeoutMs / 60000} min` };
      if (p.code !== 0 || res?.is_error) {
        const error = [res?.result ? String(res.result) : '', p.stderr.slice(-2000)].filter(Boolean).join(' · ') || `exit ${p.code}`;
        const until = detectRateLimit(error);
        return { ok: false, output, costUsd: 0, error, rateLimited: until ? { untilMs: until, auth: isAuthError(error) } : undefined };
      }
      return { ok: true, output, structured: req.jsonSchema ? extractJson(output) : undefined, costUsd: 0 };
    },
  };
}

/** The final `result` event of cursor-agent's stream (or a plain json reply), plus the assistant text seen so far. */
export function parseCursorStream(stdout: string): { result: any; text: string } {
  let result: any;
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'result') result = ev;
    if (ev.type === 'assistant') for (const c of ev.message?.content ?? []) if (c.type === 'text') texts.push(c.text);
  }
  return { result, text: texts.join('') || stdout.slice(-4000) };
}
