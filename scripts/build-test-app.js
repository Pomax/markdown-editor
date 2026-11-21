/**
 * @fileoverview Builds the debug test binary with the test-hooks feature.
 *
 * Uses @tauri-apps/cli's Node API so no .cmd shim is spawned, and a cargo
 * target directory of its own (target/test, inside Cargo's target/, which
 * the lint and ignore rules already skip) so dev and test builds do not
 * recompile over each other. What the build leaves behind is deleted once
 * it is done.
 */

import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '@tauri-apps/cli';
import { removeBuildLeftovers } from './build-leftovers.js';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);

/**
 * Directory the test binary is built into.
 * @type {string}
 */
export const TEST_TARGET_DIR = join(root, `target`, `test`);

/**
 * The built test executable's path for the current platform.
 * @type {string}
 */
export const TEST_APP_BINARY = join(
  TEST_TARGET_DIR,
  `debug`,
  process.platform === `win32` ? `markdown-editor.exe` : `markdown-editor`,
);

/**
 * The X11 runner's path: the crate's `x11-runner` binary, which the same
 * build builds, and through which the Linux tests send real input.
 * @type {string}
 */
export const X11_RUNNER_BINARY = join(TEST_TARGET_DIR, `debug`, `x11-runner`);

/**
 * Builds the debug test binary into its own target directory.
 * @returns {Promise<void>}
 */
export async function buildTestApp() {
  process.env.CARGO_TARGET_DIR = TEST_TARGET_DIR;
  try {
    await run([`build`, `--debug`, `--no-bundle`, `--features`, `test-hooks`], `build-test-app`);
  } finally {
    removeBuildLeftovers();
  }
}

if (process.argv[1] === thisFile) {
  await buildTestApp();
}
