#!/usr/bin/env node
// Silence node:sqlite's ExperimentalWarning however we're invoked; keep all other warnings.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
await import('../src/cli.ts');
