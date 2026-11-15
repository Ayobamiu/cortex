/**
 * Subscription plans (Claude Pro, Cursor, …) have usage windows. Hitting one is not the
 * agent's fault: cortex should wait for the reset (or use another agent), not burn a retry.
 */

// Provider-level phrases only. Deliberately not bare "429"/"rate limit": a worker's own script
// being throttled by some website (e.g. Wikipedia) must not look like the agent's plan running out.
const LIMIT_RE =
  /(usage limit (reached|exceeded)|hit your (usage )?limit|5-hour limit|weekly limit|rate_limit_error|quota (exceeded|exhausted)|out of (extra )?usage|you've reached your .*limit)/i;

const DEFAULT_WAIT_MS = 30 * 60000;

// The account can't be used at all (billing, payment). Not the agent's fault either, and not
// fixed by waiting minutes: rest it for hours and let the owner fix the account.
const ACCOUNT_RE = /(API error 402|billing verification failed|payment required|insufficient (credits|balance|funds)|credit balance is too low)/i;
const ACCOUNT_WAIT_MS = 3 * 3600e3;
// The agent CLI lost its login (token revoked or expired). Only the owner can log in again; rest
// the agent instead of charging failed attempts to the task. Exact CLI phrases only, so a worker's
// own script failing to authenticate to some website doesn't match.
const AUTH_RE = /(OAuth token (?:revoked|has expired|expired)|Please (?:log in again|run \/login)|run '?cursor-agent login'?)/i;
const AUTH_WAIT_MS = 3600e3;
/** Never retry sooner than this after a limit (overridable for tests). */
const floor = () => Number(process.env.CORTEX_LIMIT_FLOOR_MS ?? 60000);

/** Returns when to retry (ms epoch), or undefined if the text doesn't look like a usage limit. */
export function detectRateLimit(text: string, now = Date.now()): number | undefined {
  if (text && ACCOUNT_RE.test(text)) return now + ACCOUNT_WAIT_MS;
  if (text && AUTH_RE.test(text)) return now + AUTH_WAIT_MS;
  if (!text || !LIMIT_RE.test(text)) return undefined;

  // Claude Code: "Claude AI usage limit reached|1793930400"
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Math.max(now + floor(), Number(epoch[1]) * 1000 + floor());

  // "resets in 2h 15m" / "try again in 45 minutes"
  const rel = text.match(/(?:resets?|try again|retry)\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) return now + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0) + 1) * 60000;

  // "resets 3pm" / "resets at 3:30 PM"
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'pm') h += 12;
    const d = new Date(now);
    d.setHours(h, Number(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime() + 60000;
  }
  return now + DEFAULT_WAIT_MS;
}
