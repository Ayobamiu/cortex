// Fake planner: emits a fixed plan on the first call, no changes afterwards.
// CORTEX_TEST_PLAN selects the scenario.
import { readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const scenario = process.env.CORTEX_TEST_PLAN ?? 'basic';
const first = prompt.includes('(no tasks yet)');

const plans = {
  basic: {
    tasks: [
      { key: 'a', title: 'Write a', kind: 'code', brief: 'WRITE a.txt hello', deps: [],
        evals: [{ kind: 'command', run: 'grep -q hello a.txt' }, { kind: 'judge', criterion: 'a.txt says hello' }] },
      { key: 'b', title: 'Write b', kind: 'research', brief: 'FLAKY WRITE b.txt world', deps: ['a'],
        evals: [{ kind: 'command', run: 'grep -q world b.txt' }] },
      { key: 'r', title: 'Resumable job', kind: 'code', brief: 'RESUMABLE WRITE r.txt resumed', deps: [],
        evals: [{ kind: 'command', run: 'grep -q resumed r.txt' }] },
    ],
    cancel: [], notes: 'two tasks',
  },
  limited: {
    tasks: [
      { key: 'l', title: 'Hit a usage limit', kind: 'code', brief: 'LIMITED WRITE l.txt ok', deps: [],
        evals: [{ kind: 'command', run: 'grep -q ok l.txt' }] },
      { key: 'rt', title: 'Attack it', kind: 'redteam', brief: 'WRITE attack.txt tried', deps: ['l'],
        evals: [{ kind: 'command', run: 'test -f attack.txt' }] },
    ],
    cancel: [], notes: 'limit + redteam',
  },
  human: {
    tasks: [
      { key: 'q', title: 'Pick a word', kind: 'human', brief: 'Which word should c.txt contain?', deps: [], evals: [] },
      { key: 'c', title: 'Write c', kind: 'code', brief: 'WRITE c.txt FROM_ANSWER', deps: ['q'],
        evals: [{ kind: 'command', run: 'grep -q banana c.txt' }] },
      { key: 'd', title: 'Write d', kind: 'code', brief: 'WRITE d.txt independent', deps: [],
        evals: [{ kind: 'command', run: 'test -f d.txt' }] },
    ],
    cancel: [], notes: 'needs a human',
  },
};

const out = first ? plans[scenario] : { tasks: [], cancel: [], notes: 'no changes' };
process.stdout.write('```json\n' + JSON.stringify(out) + '\n```\nCORTEX_COST_USD=0.01\n');
