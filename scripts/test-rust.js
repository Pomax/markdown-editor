/**
 * @fileoverview Runs the Rust tests (`cargo test`, with any arguments
 * given, such as a test name filter): the app's, and then the runners',
 * which are built only with the test-hooks feature. Then deletes what the
 * builds left behind, and exits with the status of the first run that
 * failed.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { removeBuildLeftovers } from './build-leftovers.js';

const args = process.argv.slice(2);
let status = 0;
for (const run of [
  [`test`, ...args],
  [`test`, `--features`, `test-hooks`, `--bin`, `win-runner`, `--bin`, `x11-runner`, ...args],
]) {
  const result = spawnSync(`cargo`, run, { stdio: `inherit` });
  if (status === 0) status = result.status ?? 1;
}
removeBuildLeftovers();
process.exit(status);
