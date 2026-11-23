/**
 * @fileoverview Integration tests for Enter and Backspace at the start of
 * a paragraph in the writing view.
 */

import { expect, test } from '@playwright/test';
import {
  HOME,
  clickWritingViewBetween,
  closeApp,
  launchApp,
  loadContent,
  setWritingView,
} from '../../test-utils.js';

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

test.beforeEach(async () => {
  await setWritingView(page);
});

test(`Enter at the start of a paragraph puts an empty paragraph above it and keeps the paragraph`, async () => {
  await loadContent(page, `before\n\ntext`);
  await clickWritingViewBetween(page, `te`, `xt`);
  const id = await page
    .locator(`#editor [data-node-id]`, { hasText: `text` })
    .first()
    .getAttribute(`data-node-id`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`x`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`before\n\n\n\nxtext`);
  await expect(page.locator(`#editor [data-node-id="${id}"]`)).toHaveText(`xtext`);
});

test(`Backspace at the start of a paragraph with an empty list item above it removes that item and keeps the paragraph`, async () => {
  await loadContent(page, `- one\n\ntext`);
  await clickWritingViewBetween(page, `one`, `text`);
  await page.keyboard.press(`Enter`);
  await clickWritingViewBetween(page, `te`, `xt`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);
  await page.keyboard.type(`x`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`- one\n\nxtext`);
});
