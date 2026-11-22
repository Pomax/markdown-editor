/**
 * @fileoverview Integration test for `STARTUP_TIMING`: with it naming a
 * file, the app writes the local time of its first page load to that file
 * as `HH:MM:SS.mmm` and exits with code 0. The app runs with its own test settings and WebView2
 * folders, so nothing outside test-results is touched. On Linux the app
 * cannot start without a display, so it runs on a virtual display of its
 * own.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { expect, test } from '@playwright/test';
import { TEST_APP_BINARY } from '../../../../scripts/build-test-app.js';
import { displayEnvironment, startVirtualDisplay } from '../../x11-display.js';

/**
 * A local `HH:MM:SS.mmm` time today, as milliseconds since the epoch.
 * @param {string} text
 * @returns {number}
 */
function todayAt(text) {
  const [hours, minutes, rest] = text.split(`:`);
  const [seconds, millis] = rest.split(`.`);
  const time = new Date();
  time.setHours(Number(hours), Number(minutes), Number(seconds), Number(millis));
  return time.getTime();
}

test(`STARTUP_TIMING writes the time of the first page load and exits`, async ({}, testInfo) => {
  testInfo.setTimeout(30_000);
  const timingFile = testInfo.outputPath(`startup-time.txt`);
  const display = process.platform === `linux` ? await startVirtualDisplay() : undefined;
  const launched = Date.now();
  const child = spawn(TEST_APP_BINARY, [], {
    env: {
      ...(display ? displayEnvironment(display) : process.env),
      TESTING: `1`,
      TESTING_WEBVIEW_DIR: testInfo.outputPath(`webview`),
      TESTING_SETTINGS_DIR: testInfo.outputPath(`settings`),
      TESTING_DEVTOOLS_PORT: `0`,
      STARTUP_TIMING: timingFile,
    },
    stdio: `ignore`,
    windowsHide: true,
  });
  // An app that does not exit by itself is killed, so none is left running.
  const timer = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise((resolve) => child.on(`exit`, resolve));
  clearTimeout(timer);
  const exited = Date.now();
  display?.stop();

  expect(code).toBe(0);
  const text = fs.readFileSync(timingFile, `utf-8`);
  expect(text).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  const written = todayAt(text);
  expect(written).toBeGreaterThanOrEqual(launched - 1000);
  expect(written).toBeLessThanOrEqual(exited);
});
