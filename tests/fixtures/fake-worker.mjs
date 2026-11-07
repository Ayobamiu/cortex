// Fake worker: obeys "WRITE <file> <content>" in its brief.
// "FLAKY" tasks write the wrong content until they receive retry feedback.
// "FROM_ANSWER" takes the content from the human answer passed via deps.
import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const m = prompt.match(/WRITE (\S+) (\S+)/);
if (!m) {
  console.log('nothing to do');
  process.exit(0);
}
let [, file, content] = m;
// "LIMITED": the first call hits a (fake) Claude usage limit that resets in ~1s.
if (prompt.includes('LIMITED') && process.env.CORTEX_TEST_MARK) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(process.env.CORTEX_TEST_MARK)) {
    writeFileSync(process.env.CORTEX_TEST_MARK, 'x');
    console.log(`Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 1}`);
    process.exit(1);
  }
}
// "RESUMABLE": first attempt saves progress and crashes; a retry only succeeds if that progress survived.
if (prompt.includes('RESUMABLE')) {
  const { existsSync } = await import('node:fs');
  if (!existsSync('progress.txt')) {
    writeFileSync('progress.txt', 'half done\n');
    console.error('crashed halfway');
    process.exit(1);
  }
}
if (content === 'FROM_ANSWER') content = prompt.match(/Human answer: (\S+)/)?.[1] ?? 'unknown';
const retrying = prompt.includes('earlier work failed');
if (prompt.includes('FLAKY') && !retrying) content = 'wrong';
writeFileSync(file, content + '\n');
console.log(`wrote ${file} = ${content}`);
