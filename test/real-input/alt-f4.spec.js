/**
 * @fileoverview Alt+F4, pressed on the real keyboard through the Windows
 * runner, closes the app's window and so ends the app.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent } from '../integration/test-utils.js';
import { runner } from './runner.js';

test.skip(process.platform !== `win32`, `the Windows runner sends input on Windows only`);

/** @type {import('../integration/tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp([], { visible: true }));
});

test.afterAll(async () => {
  await closeApp(app);
});

test(`Alt+F4 closes the window and the app`, async () => {
  await loadContent(page, `closing`);
  runner(`focus`, app.pid);
  runner(`keys`, app.pid, `Alt+F4`);
  await expect.poll(() => app.windowCount().catch(() => 0), { timeout: 10_000 }).toBe(0);
});
