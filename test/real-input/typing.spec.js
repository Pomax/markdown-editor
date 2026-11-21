/**
 * @fileoverview Real input reaches the app: the Windows runner brings the
 * test app's window to the front, clicks into the editor with the mouse
 * and types on the keyboard, and the editor holds what was typed.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent } from '../integration/test-utils.js';
import { clientPoint, runner } from './runner.js';

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

test(`a click and typing on the real mouse and keyboard reach the editor`, async () => {
  await loadContent(page, `start`);
  runner(`focus`, app.pid);
  const point = await clientPoint(page.locator(`#editor [data-node-id]`).first());
  runner(`click`, app.pid, point.x, point.y);
  runner(`keys`, app.pid, `End`);
  runner(`type`, app.pid, ` typed`);
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent() ?? ``))
    .toBe(`start typed`);
});
