// Runs the whole suite. The browser tests need a server on :8899 and Playwright;
// they are skipped with a notice when either is missing.
//
//   cd test && npm install && node run-all.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const NODE_TESTS = ['test-core.mjs', 'test-lut.mjs', 'test-luts-all.mjs', 'test-pdf-preview.mjs'];
const BROWSER_TESTS = [
  'test-ui.py',
  'test-registry.py',
  'test-image-pipeline.py',
  'test-image-ui.py',
  'test-image-live.py',
];

let failures = 0;

for (const test of NODE_TESTS) {
  process.stdout.write(`\n=== ${test}\n`);
  try {
    execFileSync('node', [join(here, test)], { stdio: 'inherit' });
  } catch {
    failures++;
  }
}

const serverUp = await fetch('http://localhost:8899/index.html')
  .then((r) => r.ok)
  .catch(() => false);

if (!serverUp) {
  console.log('\nSkipping browser tests: no server on :8899 (run `python3 -m http.server 8899`).');
} else {
  for (const test of BROWSER_TESTS) {
    process.stdout.write(`\n=== ${test}\n`);
    try {
      execFileSync('python3', [join(here, test)], { stdio: 'inherit' });
    } catch {
      failures++;
    }
  }
}

console.log(failures ? `\n${failures} suite(s) failed.` : '\nAll suites passed.');
process.exit(failures ? 1 : 0);
