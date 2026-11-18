/**
 * @fileoverview Smoke tests for the release executable `npm run build`
 * leaves in dist/, started with TESTING=1, so it shows no window, and
 * with its settings and WebView2 folders in its own output folder, so
 * nothing outside test-results is touched. With STARTUP_TIMING naming a
 * file in that folder, it must load its page, write the time it did so,
 * and exit with code 0; prints the executable's size. Started with a
 * markdown file, it must open that file, which its window title, read
 * through the Windows runner, names.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWinRunner } from '../../scripts/build-win-runner.js';
import { runner } from '../real-input/runner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`);
const { version } = JSON.parse(readFileSync(join(root, `package.json`), `utf-8`));
const executable = join(root, `dist`, `Markdown-Editor-${version}-win.exe`);
const output = join(root, `test-results`, `release-smoke`);

/**
 * Reads a process's window title until it is the expected one or the
 * time is up.
 * @param {number} pid
 * @param {string} expected
 * @param {number} timeout - Milliseconds.
 * @returns {Promise<string | null>} The last title read; null when the
 * process had no window.
 */
async function windowTitle(pid, expected, timeout) {
  const end = Date.now() + timeout;
  /** @type {string | null} */
  let title = null;
  while (Date.now() < end) {
    try {
      title = runner(`window`, pid).title;
    } catch {
      title = null;
    }
    if (title === expected) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return title;
}

describe(`release executable`, () => {
  it(`starts without a window, loads its page, writes the time and exits with code 0`, async () => {
    assert.ok(existsSync(executable), `${executable} exists`);
    console.log(`${executable}: ${statSync(executable).size} bytes`);

    mkdirSync(output, { recursive: true });
    const timingFile = join(output, `startup-time.txt`);
    rmSync(timingFile, { force: true });

    const child = spawn(executable, [], {
      env: {
        ...process.env,
        TESTING: `1`,
        TESTING_WEBVIEW_DIR: join(output, `webview`),
        TESTING_SETTINGS_DIR: join(output, `settings`),
        STARTUP_TIMING: timingFile,
      },
      stdio: `ignore`,
      windowsHide: true,
    });
    // An executable that does not exit by itself is killed, so none is
    // left running.
    const timer = setTimeout(() => child.kill(), 20_000);
    const code = await new Promise((resolve) => child.on(`exit`, resolve));
    clearTimeout(timer);

    assert.strictEqual(code, 0);
    assert.match(readFileSync(timingFile, `utf-8`), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it(`opens a markdown file named on its command line`, async () => {
    assert.ok(existsSync(executable), `${executable} exists`);
    buildWinRunner();

    const folder = join(output, `open-file`);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `opened.md`);
    writeFileSync(file, `# Opened\n`);

    const child = spawn(executable, [file], {
      env: {
        ...process.env,
        TESTING: `1`,
        TESTING_WEBVIEW_DIR: join(folder, `webview`),
        TESTING_SETTINGS_DIR: join(folder, `settings`),
      },
      stdio: `ignore`,
      windowsHide: true,
    });
    const exited = new Promise((resolve) => child.on(`exit`, resolve));
    try {
      const title = await windowTitle(Number(child.pid), `opened.md - Markdown Editor`, 20_000);
      assert.strictEqual(title, `opened.md - Markdown Editor`);
    } finally {
      child.kill();
      await exited;
    }
  });
});
