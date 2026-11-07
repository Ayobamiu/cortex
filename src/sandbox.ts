import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OS-level sandbox for everything Cortex runs on an agent's behalf: agent CLIs, judges, the
 * planner, and eval commands (which execute agent-written code). Uses macOS `sandbox-exec`.
 *
 * Policy, in plain words: an agent may read the system and its own project, write only to
 * its worktree plus the caches/state its CLI needs, and use the network. It may not read
 * credentials (SSH, cloud, GitHub, browser profiles, keychain files, shell history), your
 * other documents or other goals' state, use your SSH agent, or modify agent binaries.
 *
 * Limits: the network stays open (research needs it). The login keychain stays reachable,
 * because Claude, Muse and Cursor keep their own logins there; an agent could ask it for
 * items it hands out without a prompt.
 */
export interface SandboxSpec {
  /** Directories the sandboxed process may write (its worktree, etc.). */
  writable: string[];
  /** Directories readable even inside an otherwise hidden area (the project inside ~/Documents). */
  readable: string[];
}

export interface SandboxConfig {
  enabled?: boolean;
  /** Extra writable paths (absolute, or relative to the home directory). */
  extra_writable?: string[];
  /** Extra paths agents may not read. */
  extra_read_deny?: string[];
  /** Extra paths agents may read even inside a hidden area (e.g. ~/Documents/shared-data). */
  extra_readable?: string[];
  /** Environment variables to keep even though their names look like secrets. */
  pass_env?: string[];
}

const HOME = homedir();
const h = (p: string) => (p.startsWith('/') ? p : join(HOME, p));

/** What agent CLIs and toolchains need to write. Binaries (~/.local/bin, versions/) are excluded on purpose. */
const WRITABLE_STATE = [
  '.claude', '.claude.json', '.claude.json.backup', '.local/state', '.local/share/muse', '.config/muse',
  '.cursor', '.cache', '.config/uv', '.local/share/uv', '.npm', '.config/configstore', 'Library/Caches',
  'Library/Application Support/Cursor', 'Library/Logs',
];

/** Credentials and personal data. Relative to the home directory. */
const READ_DENY = [
  '.ssh', '.aws', '.azure', '.docker', '.kube', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.config/gh', '.config/gcloud', '.config/github-copilot', '.config/stripe', '.config/rclone', '.config/temporalio',
  '.railway', '.ngrok', '.mcp-auth', '.codex', '.gemini', '.plumb', '.expo', '.pm2',
  '.zsh_history', '.bash_history', '.python_history', '.zsh_sessions', '.cortex',
  'Library/Cookies', 'Library/Messages', 'Library/Mail', 'Library/Safari',
  'Library/Application Support/Google', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware',
  'Library/Application Support/Arc', 'Library/Application Support/Claude', 'Library/Application Support/com.apple.TCC',
  'Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'plumb-backups',
];

/** Readable even though they sit inside a hidden folder (Muse loads skills from ~/.codex/skills; ~/.codex/auth.json stays hidden). */
const READ_ALLOW = ['.codex/skills'];

/** Env vars dropped before an agent starts: anything named like a credential, plus the SSH agent socket. */
const SECRET_ENV = /(TOKEN|SECRET|PASSW|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH_SOCK)/i;

/** Resolve symlinks (macOS /tmp -> /private/tmp) since the sandbox matches real paths. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const q = (p: string) => JSON.stringify(real(p));

export function buildProfile(spec: SandboxSpec, cfg: SandboxConfig = {}): string {
  const writable = [...WRITABLE_STATE.map(h), ...(cfg.extra_writable ?? []).map(h), ...spec.writable];
  const denyRead = [...READ_DENY.map(h), ...(cfg.extra_read_deny ?? []).map(h)];
  return [
    '(version 1)',
    '(allow default)',
    // Writes: nowhere in the home folder or the project's own git repo, except the allowed places.
    `(deny file-write* (subpath ${q(HOME)}))`,
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // Reads: credentials, personal files and other goals' state are hidden...
    // file-read-data, not file-read*: paths can still be looked up (git stats parent folders),
    // but file contents and directory listings can't be read.
    `(deny file-read-data ${denyRead.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // ...except what this run needs (its project, its worktree), which may live inside them.
    `(allow file-read-data ${[...READ_ALLOW.map(h), ...spec.readable, ...(cfg.extra_readable ?? []).map(h), ...spec.writable].map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // The SSH agent socket would let an agent use your keys without reading them.
    '(deny network-outbound (regex #"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/Listeners$"))',
  ].join('\n');
}

export function sandboxEnv(cfg: SandboxConfig = {}): NodeJS.ProcessEnv {
  const keep = new Set(cfg.pass_env ?? []);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.has(k) || !SECRET_ENV.test(k)) env[k] = v;
  // Agent CLIs must not rewrite their own binaries from inside the sandbox.
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

export const sandboxAvailable = () => process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

/** A ready-to-use sandbox for one process: the profile plus a scrubbed environment. */
export interface Sandbox {
  profile: string;
  env: NodeJS.ProcessEnv;
}

export function makeSandbox(spec: SandboxSpec, cfg: SandboxConfig = {}): Sandbox | undefined {
  if (cfg.enabled === false || !sandboxAvailable()) return undefined;
  return { profile: buildProfile(spec, cfg), env: sandboxEnv(cfg) };
}
