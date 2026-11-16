# cortex

An orchestrator for long, unattended runs of coding and research agents from different providers (Claude Code, Muse, anything with a CLI).

You give it a **goal** with checks it can verify. It plans a task graph, sends each task to an agent, checks the result, retries with feedback, re-plans when stuck, and messages you at checkpoints. It runs for hours or days on your laptop and resumes after crashes and reboots.

```
Goal ──► Plan (task DAG) ──► Task ──► Attempt ──► Eval ──► Decision
  ▲                                                          │
  └──── replan ◄──── escalate ◄──── retry w/ feedback ◄──────┘
```

## Design

- **The orchestrator is plain code, not an LLM.** Models are called only to plan, do the work, and judge results. All state lives in SQLite plus an append-only event log, so nothing important exists only in an agent's context.
- **Every task starts with fresh context.** A worker sees only the goal, its own brief, how it will be checked, and the summaries of the tasks it depends on.
- **Evals:** command checks (exit 0 passes) run first. Judge checks then ask a model, preferably **from a different provider than the worker**, so no model grades its own work.
- **Isolation:** your checkout is never touched. Each attempt runs in its own git worktree off `cortex/<goal>/main`. Attempts that pass are merged back one at a time. A merge conflict counts as a failed attempt and is retried on the latest code.
- **Decisions:** a failed task retries up to `max_attempts_per_task`, getting the failure as feedback. Every 2 failures it switches to the next agent in the routing list. Once out of retries, the planner re-plans. After `max_replans` it escalates to you.
- **Autonomy:** fully unattended between checkpoints. A question for you (a `human` task) blocks **only the tasks that depend on it**; everything else keeps running. Every `checkpoint_every` passed tasks, you get a digest and the planner reviews whether the plan has drifted from the goal. Neither of these pauses the run.
- **Invariants:** `task_checks` run on every attempt before the task's own evals. Use them for rules like "the frozen contract is unchanged", so tampering is caught immediately instead of at the end.
- **Deep vs routine:** the planner marks a task `deep` only when it needs deep thinking (method choices, costly trade-offs, red-teaming, hard debugging). Deep tasks go to the first agent in `routing.deep`; everything else follows its role's list, so you can put a cheaper agent first there. Either way, every 2 failures move the task to the next agent.
- **Your answers carry their question:** a task building on a question sees the question as it was asked plus your verbatim answer, so a reply like "A" is recorded with its meaning. Answering an escalation ("Guidance needed") sends your answer to the planner, which re-plans with it and gets a fresh replan budget.
- **Review by risk:** the planner gives each task a risk level, so review is spent where mistakes are costly.
  - `low`: command checks only, no judge.
  - `normal`: one judge per criterion.
  - `high`: two judges from different providers per criterion, plus an integrity review (no gamed tests, no fabricated data).
- **Guards** run on every attempt, are free, and need no model:
  - A leaked credential, a file over 50 MB, or a change to `protected_paths` fails the attempt.
  - A deleted test raises that attempt to high-risk review instead of failing it.
- **Usage anticipation:** Claude reports how full its 5-hour and weekly windows are on every call, and `cortex status` shows it.
  - Past `limits.soft` (default 85%), new work goes to fallback agents. Planning may still use the agent.
  - At `limits.hard` (97%), the agent rests until the window resets, before it hits the wall.
  - A limit that is hit anyway (any provider) rests the agent without counting as a failure.
- **Guardrails:** `usd_total`, `usd_per_attempt`, `max_hours` (working hours: time blocked on your answers or with cortex stopped doesn't count), `min_free_gb` (default 5: below it no new task starts, so a full disk can't corrupt git or the state DB), a timeout per attempt, a lock allowing one orchestrator per goal, and recovery of interrupted tasks at startup.

## Start a project

```sh
cortex new "what you want, in your own words"    # or just: cortex new
```

Claude asks up to three questions if the answers would change what gets built (press Enter to let it decide), then shows what it will build, how it will be checked, and the limits. Answer `y` to start, `s` to read the full spec, or type what to change. On `y`, Cortex creates `./<name>/` (use `--in <dir>` for elsewhere) with `SPEC.md` and `cortex.goal.json`, commits them, starts the run as a background service, and opens `cortex chat`.

## Use

Cortex is generic. The goal lives in **your project's folder** as `cortex.goal.json` (see `examples/goal.example.json`). The project must be a git repo with at least one commit.

```sh
node bin/cortex.mjs run ~/path/to/project      # run or resume (foreground)
node bin/cortex.mjs chat [goal]                # live thread for a run (see below)
node bin/cortex.mjs status                     # tasks, spend, open questions
node bin/cortex.mjs answer <goal> <task> "…"  # answer a question / unblock
node bin/cortex.mjs steer <goal> "…"           # instruction the planner applies on its next plan
node bin/cortex.mjs pause|resume|stop <goal>   # pause new work · go again (starts the run) · finish running work and exit
node bin/cortex.mjs events <goal> 50           # the event log
node bin/cortex.mjs digest <goal>              # write a digest now
node bin/cortex.mjs service ~/path/to/project  # launchd agent: survives reboots, keeps Mac awake
```

`npm link` puts `cortex` on your PATH.

State lives in `~/.cortex/goals/<goal>/`: `state.db`, `logs/` (full transcript of every agent call), `digests/`, `notify.log`, and the worktrees. Results go to the branch `cortex/<goal>/main` in your project. Merge it whenever you like.

## Chat

`cortex chat [goal]` (default: the goal that changed last) is one terminal thread for a run, like a Claude Code session:

- **Progress as it happens**: status, spend and working hours up front, then every meaningful event (attempts, checks, plans, questions) and each running agent's steps (`Bash: uv run pytest…`, `Edit: popindex/x.py`) streamed live from its output.
- **Commands**: `/answer <task> <text>`, `/steer <text>`, `/pause`, `/resume` (starts the service or a background run if nothing is running), `/stop`, `/show <task>`, `/tasks [all]`, `/watch <task>`, `/live off`, `/help`.
- **Ask anything**: plain text goes to a read-only Claude (Sonnet) that sees the run's state and can read the project and every transcript. Ask it for a change ("skip the W8 work") and it proposes one action (answer, steer, pause, resume, stop) for you to confirm with `y`. Its cost counts toward the goal budget as role `chat`.

The chat only reads the state DB and writes control events, so open and close it any time; the run goes on in the background. Pause holds new work (working hours stop counting); stop lets running attempts finish, then exits so launchd won't restart it, including at login, until you resume. A steer reaches the planner once, verbatim, and resets the replan budget like an answer to an escalation does.

## Agents

| adapter | how it runs | cost tracking |
|---|---|---|
| `claude` | `claude -p --output-format stream-json`, structured output via `--json-schema` | yes (`total_cost_usd`), plus usage-window utilization |
| `muse` | `muse exec --json --workspace <worktree>` | no (bounded by attempts and time) |
| `cursor` | `cursor-agent -p --output-format stream-json --model auto`. As a read-only judge: `"extra_args": ["--mode", "ask", "--trust"]` (`--trust` skips the per-folder trust prompt). Write access needs a permission flag you add yourself | no |
| `command` | any shell command; prompt on stdin, answer on stdout | optional `CORTEX_COST_USD=<n>` last line |

For Codex: `{ "adapter": "command", "command": "codex exec -", "provider": "openai" }`.

## Notifications

macOS notifications for warnings, questions, checkpoints and completion. Set `notify.webhook` to POST JSON events (with a `text` field, so a Slack incoming webhook works directly).

## Sandbox (macOS)

Everything cortex runs for an agent runs inside a macOS `sandbox-exec` profile (`src/sandbox.ts`), on by default. That covers agent CLIs, judges, the planner, and eval commands, since evals execute code the agents wrote.

| | Allowed | Blocked |
|---|---|---|
| **Write** | the attempt's worktree and its git admin dir; agent CLI state and caches (`~/.claude`, `~/.cursor`, `~/.config/muse`, `~/.cache`, uv, npm) | the rest of the home folder, your project checkout, git refs and tags, agent binaries (`~/.local/bin`, CLI `versions/`), and anything your own tools later run outside the sandbox (Claude Code settings, hooks, skills, agents, commands and plugins; Cursor MCP config and rules; shell rc files; `.gitconfig`; LaunchAgents). The planner writes nothing. |
| **Read** | the system, the project, the run's logs | credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, cloud CLIs, `.npmrc`, `.netrc`…), browser profiles, Mail/Messages, shell history, `~/Documents`, `~/Desktop`, `~/Downloads`, other goals' state |
| **Other** | the network (research needs it) | the SSH agent socket. Env vars named like secrets (`*TOKEN*`, `*API_KEY*`…) are dropped, and auto-updates are off. |

Known limits:
- The login keychain stays reachable, because Claude, Muse and Cursor keep their logins there.
- `~/.claude.json` and `~/.cursor/cli-config.json` stay writable, because the CLIs rewrite them on every run. The first can register MCP servers, which a separate config dir per agent would close.

Configure it per goal:

```json
"sandbox": {
  "extra_writable": [],
  "extra_readable": ["Documents/shared-data"],
  "extra_read_deny": [],
  "pass_env": ["NEEDED_TOKEN"],
  "enabled": true
}
```

Tested with real Claude, Muse and Cursor runs. Cursor's own `--sandbox enabled` did *not* stop writes outside the workspace when combined with `--force`, so cortex doesn't rely on it.

## Judges that break

If a judge can't produce a verdict (it crashes, its config is wrong, it asks for input), another judge reviews instead, and the broken one rests for 30 minutes. If no working judge is left, the attempt is retried later without counting against the worker. A broken reviewer never fails good work.

## Development

```sh
npm test          # 38 tests with fake agents and fake CLIs, sandboxed (no API spend)
npm run typecheck
```

No runtime dependencies: Node ≥ 22.18 (built-in TypeScript stripping and `node:sqlite`).
