/**
 * @fileoverview Integration tests for the toolbar link button in writing view.
 *
 * Selecting text and clicking the link button must open the link modal
 * with the selection as the link text and focus on the URL field, and
 * submitting must replace the selection with a markdown link.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  getSourceLineText,
  launchApp,
  loadContent,
  setSource2View,
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

/**
 * Selects the first `length` characters of the first line using the
 * keyboard, so the real selectionchange sequence fires.
 * @param {import('@playwright/test').Page} pg
 * @param {number} length
 */
async function selectLineStart(pg, length) {
  const line = pg.locator(`#editor [data-node-id]`).first();
  await clickInEditor(pg, line);
  await pg.keyboard.press(`Home`);
  for (let i = 0; i < length; i++) {
    await pg.keyboard.press(`Shift+ArrowRight`);
  }
  await pg.waitForTimeout(200);
}

test.describe(`Link button with a selection in writing view`, () => {
  test(`selected text becomes the link text and the URL field gets focus`, async () => {
    await loadContent(page, `docs are here`);
    await setWritingView(page);
    await selectLineStart(page, 4);

    await page.locator(`[data-button-id="link"]`).click();

    await expect(page.locator(`dialog.link-dialog`)).toBeVisible();
    await expect(page.locator(`#link-text`)).toHaveValue(`docs`);
    await expect(page.locator(`#link-url`)).toBeFocused();

    await page.keyboard.type(`https://example.com`);
    await page.keyboard.press(`Enter`);
    await page.waitForTimeout(200);

    await setSource2View(page);
    const line = await getSourceLineText(page, 0);
    expect(line).toBe(`[docs](https://example.com) are here`);
  });
});
