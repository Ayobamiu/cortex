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
- **Guardrails:** `usd_total`, `usd_per_attempt`, `max_hours`, a timeout per attempt, a lock allowing one orchestrator per goal, and recovery of interrupted tasks at startup.

## Use

Cortex is generic. The goal lives in **your project's folder** as `cortex.goal.json` (see `examples/goal.example.json`). The project must be a git repo with at least one commit.

```sh
node bin/cortex.mjs run ~/path/to/project      # run or resume (foreground)
node bin/cortex.mjs status                     # tasks, spend, open questions
node bin/cortex.mjs answer <goal> <task> "…"  # answer a question / unblock
node bin/cortex.mjs events <goal> 50           # the event log
node bin/cortex.mjs digest <goal>              # write a digest now
node bin/cortex.mjs service ~/path/to/project  # launchd agent: survives reboots, keeps Mac awake
```

`npm link` puts `cortex` on your PATH.

State lives in `~/.cortex/goals/<goal>/`: `state.db`, `logs/` (full transcript of every agent call), `digests/`, `notify.log`, and the worktrees. Results go to the branch `cortex/<goal>/main` in your project. Merge it whenever you like.

## Agents

| adapter | how it runs | cost tracking |
|---|---|---|
| `claude` | `claude -p --output-format json`, structured output via `--json-schema` | yes (`total_cost_usd`) |
| `muse` | `muse exec --json --workspace <worktree>` | no (bounded by attempts and time) |
| `command` | any shell command; prompt on stdin, answer on stdout | optional `CORTEX_COST_USD=<n>` last line |

For Codex: `{ "adapter": "command", "command": "codex exec -", "provider": "openai" }`.

## Notifications

macOS notifications for warnings, questions, checkpoints and completion. Set `notify.webhook` to POST JSON events (with a `text` field, so a Slack incoming webhook works directly).

## Security note

Workers run unattended with write access to their worktree. Claude defaults to `permission_mode: "auto"`, where risky actions are blocked rather than prompted. Agents still run as your user on your laptop, so keep secrets out of reach of projects you point cortex at.

## Development

```sh
npm test          # end-to-end tests using fake agents (no API spend)
npm run typecheck
```

No runtime dependencies: Node ≥ 22.18 (built-in TypeScript stripping and `node:sqlite`).
