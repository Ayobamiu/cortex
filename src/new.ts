import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { run, extractJson } from './proc.ts';
import type { EvalSpec, GoalConfig } from './types.ts';

/**
 * `cortex new`: describe what you want in plain words, then talk it through. Claude stress-tests
 * the idea (feasibility, data, what "done" means, risks), pushes back, looks things up, and only
 * offers a draft once the idea is sound. You confirm, and Cortex sets up the project folder,
 * commits, and starts the run. No spec writing, no git, no JSON.
 */

export interface Draft {
  id: string;
  objective: string;
  spec_md: string;
  acceptance: EvalSpec[];
  budget_usd: number;
  max_hours: number;
  summary: string;
}

/** One turn of the conversation. */
export interface Turn {
  reply: string;
  ready: boolean;
  draft?: Draft;
}

const DRAFT = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short lowercase-kebab project name, e.g. "price-tracker".' },
    objective: { type: 'string', description: 'The goal in 3-6 sentences: what exists when done, for whom, and what is out of scope.' },
    spec_md: { type: 'string', description: 'SPEC.md: what to build, requirements as a checklist, what "done" means, out of scope, open questions the agents should research.' },
    acceptance: {
      type: 'array',
      description: 'Final checks. "command": a shell command that must exit 0 once the work exists (e.g. "npm test"). "judge": a plain-English criterion an AI judge checks against the result.',
      items: { type: 'object', properties: { kind: { type: 'string', enum: ['command', 'judge'] }, run: { type: 'string' }, criterion: { type: 'string' } }, required: ['kind'] },
    },
    budget_usd: { type: 'number', description: 'Claude spend cap in USD (Cursor is flat-rate). Small: 20-40, medium: 50-100, large: 100-200.' },
    max_hours: { type: 'number', description: 'Working-hours cap. Small: 24, medium: 72, large: 168.' },
    summary: { type: 'string', description: 'For the owner: 3-6 plain lines on what will be built and how it will be checked.' },
  },
  required: ['id', 'objective', 'spec_md', 'acceptance', 'budget_usd', 'max_hours', 'summary'],
};

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What you say to the owner this turn, plain and short: your pushback, the risks you see, what you checked, your questions (at most 3), or your answer to theirs.' },
    ready: { type: 'boolean', description: 'true only when the idea is sound and settled enough to run unattended for days, and draft is complete. Never true with an unresolved blocker.' },
    draft: { ...DRAFT, description: 'The complete project. Give it (in full) whenever ready is true; omit it while still discussing.' },
  },
  required: ['reply', 'ready'],
};

const BRIEF = `You set up projects for Cortex, an orchestrator that runs AI agents (Cursor for routine work, Claude for planning and hard tasks) unattended for hours or days on a goal, in a fresh git repo.
The owner describes what they want in plain words. You are their sharp, honest technical co-founder: a weak idea run unattended for days is the most expensive failure there is, so make it sound before it starts.

Talk it through with the owner, as many turns as it takes:
- Stress-test it. Can agents do this unattended (no logins, no paid APIs or data without the owner's keys, no manual steps)? Does the data or access actually exist? Is "done" checkable? What is the biggest risk, and is there a simpler version that delivers the same value?
- Push back plainly when something won't work or isn't worth it, and propose the better version. Agree when it's good; don't invent objections.
- Check facts that feasibility depends on (APIs, data sources, prices, licences) with web search instead of guessing, and say what you found.
- Ask only questions whose answers change what gets built, at most 3 per turn. For everything else make a sensible choice and say so.
- When the owner asks you something, answer it. When they disagree, weigh it honestly: change your view if they're right, explain if not.
- Set ready only when the objective, scope, definition of done and key risks are settled, or the owner told you to decide the rest. Then give the full draft, with what you chose for them listed in the spec. After that, if the owner wants changes, keep discussing and give the full revised draft again when settled.

The draft:
- SPEC.md is what every agent reads first: concrete requirements, a clear definition of done, out of scope.
- Acceptance must be checkable at the end: a test command that will exist once built (the agents write the tests), plus judge criteria for what a test can't check. For research or writing projects, judge criteria alone are fine.
- Keep scope honest: the smallest version that fully delivers what the owner asked for.`;

export type Llm = (prompt: string, first: boolean) => Promise<{ turn?: Turn; error?: string }>;

/** Claude Opus that can search the web (nothing else), one session across the conversation. */
export function claudeLlm(model = 'opus'): Llm {
  const session = randomUUID();
  return async (prompt, first) => {
    const web = ['WebSearch', 'WebFetch'];
    const args = ['-p', '--output-format', 'json', '--model', model, '--tools', ...web, '--allowedTools', ...web, '--json-schema', JSON.stringify(TURN_SCHEMA), ...(first ? ['--session-id', session] : ['--resume', session])];
    const p = await run('claude', args, { input: prompt, timeoutMs: 10 * 60000 });
    let res: any;
    try {
      res = JSON.parse(p.stdout);
    } catch {}
    if (!res || res.is_error) return { error: String(res?.result ?? p.stderr ?? 'no reply').slice(0, 500) };
    return { turn: (res.structured_output ?? extractJson(String(res.result ?? ''))) as Turn };
  };
}

/** The goal file for a draft: Cursor first for routine work, Claude for planning and deep tasks. */
export function goalFromDraft(d: Draft): GoalConfig {
  const example = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'goal.example.json'), 'utf8')) as GoalConfig;
  return {
    id: d.id,
    objective: `${d.objective.trim()} Decide routine and method choices yourself and record each in decisions/<topic>.md with the options and why; ask the owner (a 'human' task) only when every reasonable option would change the goal itself.`,
    context_files: ['SPEC.md'],
    acceptance: d.acceptance.filter((e) => (e.kind === 'command' && e.run) || (e.kind === 'judge' && e.criterion)),
    agents: example.agents,
    routing: example.routing,
    budget: { ...example.budget, usd_total: Math.round(d.budget_usd), max_hours: Math.round(d.max_hours) },
    concurrency: example.concurrency,
    checkpoint_every: example.checkpoint_every,
    notify: example.notify,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';

/** A new git repo holding SPEC.md and cortex.goal.json, committed. Refuses a non-empty folder. */
export async function createProject(dir: string, d: Draft): Promise<GoalConfig> {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty`);
  mkdirSync(dir, { recursive: true });
  const goal = goalFromDraft(d);
  writeFileSync(join(dir, 'SPEC.md'), d.spec_md.trim() + '\n');
  writeFileSync(join(dir, 'cortex.goal.json'), JSON.stringify(goal, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.venv/\n__pycache__/\n.DS_Store\n.env\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'Project spec and cortex goal']]) {
    const r = await run('git', args, { cwd: dir });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return goal;
}

export interface NewOptions {
  /** What you want, if given on the command line. */
  idea?: string;
  /** Folder that will hold the project folder. Default: the current directory. */
  parent: string;
  llm?: Llm;
  /** Starts the run and opens the chat (the CLI's job). */
  start: (projectDir: string, goal: GoalConfig) => Promise<void>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function newProject(o: NewOptions): Promise<string | null> {
  const out = o.output ?? process.stdout;
  const say = (s: string) => out.write(s + '\n');
  const rl = createInterface({ input: o.input ?? process.stdin, output: out, terminal: !o.output && !!process.stdout.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string): Promise<string> => {
    out.write(q);
    const n = await lines.next();
    if (n.done) throw new Error('cancelled');
    return String(n.value).trim();
  };
  const llm = o.llm ?? claudeLlm();
  try {
    let idea = o.idea?.trim() || '';
    while (!idea) idea = await ask('What do you want to build? Describe it in your own words.\n› ');
    say('Thinking…');
    let reply = await llm(`${BRIEF}\n\nThe owner's description:\n${idea}`, true);
    let showReply = true;
    for (;;) {
      if (reply.error || !reply.turn) throw new Error(`Claude couldn't reply: ${reply.error ?? 'empty reply'}`);
      const t = reply.turn;
      const d = t.ready && t.draft ? t.draft : undefined;
      if (showReply) {
        if (t.reply?.trim()) say(`\n${t.reply.trim()}`);
        if (d) {
          d.id = slug(d.id);
          const goal = goalFromDraft(d);
          say(`\n${d.summary.trim()}\n`);
          say(`Folder:     ${join(o.parent, d.id)}`);
          say('Done when:');
          for (const e of goal.acceptance) say(`  - ${e.kind === 'command' ? `\`${e.run}\` passes` : e.criterion}`);
          say(`Limits:     $${goal.budget!.usd_total} of Claude spend, ${goal.budget!.max_hours} working hours`);
        }
      }
      showReply = true;
      const a = await ask(
        d ? '\nStart it? (y = start · s = full spec · n = cancel · or keep talking)\n› ' : '\n(reply · Enter = let Claude decide the open points and draft · n = cancel)\n› ',
      );
      if (/^(n|no|q|quit|cancel)$/i.test(a)) {
        say('Cancelled; nothing was created.');
        return null;
      }
      if (d && /^(y|yes|go|start)$/i.test(a)) {
        const dir = join(o.parent, d.id);
        const goal = await createProject(dir, d);
        say(`Created ${dir} (SPEC.md and cortex.goal.json, committed).`);
        await o.start(dir, goal);
        return dir;
      }
      if (d && /^(s|spec|show)$/i.test(a)) {
        say('\n' + d.spec_md.trim());
        showReply = false;
        continue;
      }
      say('Thinking…');
      reply =
        !a || /^(y|yes|go|start)$/i.test(a)
          ? await llm('The owner wants to go ahead: settle the remaining open points yourself (list what you chose in the spec) and give the complete draft with ready: true.', false)
          : await llm(`Owner: ${a}`, false);
    }
  } finally {
    rl.close();
  }
}
