// Runs the squat self-tests in a terminal:  node squat/selftest-node.mjs
// Exits with code 1 if any test fails.
import { runSelfTests } from './selftest.js';

const results = runSelfTests();
for (const r of results) {
  console.log((r.passed ? 'PASS  ' : 'FAIL  ') + r.name + (r.error ? '\n      ' + r.error : ''));
}
const failed = results.filter(r => !r.passed).length;
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' tests passed');
process.exitCode = failed ? 1 : 0;
