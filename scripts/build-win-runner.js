/**
 * @fileoverview Builds the Windows runner for the real-input tests, the
 * crate's `win-runner` binary, into the test build's target directory
 * with the test build's features, so it shares that build's compiled
 * dependencies and neither build undoes the other. What the build leaves
 * behind is deleted once it is done.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { removeBuildLeftovers } from './build-leftovers.js';
import { TEST_TARGET_DIR } from './build-test-app.js';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);

/**
 * The built runner's path.
 * @type {string}
 */
export const WIN_RUNNER_BINARY = join(TEST_TARGET_DIR, `debug`, `win-runner.exe`);

/**
 * Builds the runner.
 */
export function buildWinRunner() {
  const manifest = join(root, `Cargo.toml`);
  const result = spawnSync(
    `cargo`,
    [`build`, `--manifest-path`, manifest, `--bin`, `win-runner`, `--features`, `test-hooks`],
    { stdio: `inherit`, env: { ...process.env, CARGO_TARGET_DIR: TEST_TARGET_DIR } },
  );
  removeBuildLeftovers();
  if (result.status !== 0) {
    throw new Error(`building win-runner failed`);
  }
}

if (process.argv[1] === thisFile) {
  buildWinRunner();
}
