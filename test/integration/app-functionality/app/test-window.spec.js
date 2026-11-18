/**
 * @fileoverview Checks the test harness itself: the window is not visible
 * on screen, yet the page still renders (visibilityState, requestAnimationFrame)
 * and timers fire, so hidden-window throttling does not break the specs.
 * On Linux the window shows, as WebKitGTK stops rendering the page of a
 * hidden window, but on a virtual display of its own, not on the screen.
 * Also checks that the window title follows the page's `document.title`.
 */

import path from 'node:path';
import process from 'node:process';
import { expect, test } from '@playwright/test';
import { clickInEditor, closeApp, launchApp, projectRoot } from '../../test-utils.js';
import { runCommand } from '../../x11-display.js';

const readmePath = path.join(projectRoot, `README.md`);

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(app);
});

test(`the test window is not visible on screen`, async () => {
  test.skip(process.platform === `linux`, `on Linux the window shows on a virtual display`);
  const state = await app.windowState();
  expect(state.visible).toBe(false);
});

test(`on Linux the test window shows on a virtual display, not on the screen`, async () => {
  test.skip(process.platform !== `linux`, `Linux only`);
  const state = await app.windowState();
  expect(state.visible).toBe(true);
  await expect(runCommand(process.env.DISPLAY, app.pid, `window`, [])).rejects.toThrow(
    /no app window|cannot open the X display/,
  );
});

test(`the page renders while the window is hidden`, async () => {
  const visibility = await page.evaluate(() => document.visibilityState);
  expect(visibility).toBe(`visible`);

  const painted = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
  );
  expect(painted).toBe(true);
});

test(`timers fire while the window is hidden`, async () => {
  const elapsed = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = Date.now();
        setTimeout(() => resolve(Date.now() - start), 500);
      }),
  );
  expect(elapsed).toBeLessThan(700);
});

test(`the window title follows document.title`, async () => {
  /** @returns {Promise<string>} */
  const windowTitle = async () => (await app.windowState()).title;

  await page.evaluate(async (file) => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    const result = await api.loadFilePath(file);
    if (result?.success) document.dispatchEvent(new CustomEvent(`file:loaded`, { detail: result }));
  }, readmePath);
  await expect.poll(windowTitle).toBe(`README.md - Markdown Editor`);

  await clickInEditor(page, page.locator(`#editor [data-node-id]:visible`).first());
  await page.keyboard.type(`x`);
  await expect.poll(windowTitle).toBe(`README.md • - Markdown Editor`);
});
