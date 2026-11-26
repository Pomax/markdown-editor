/**
 * @fileoverview Browser tests for the editor page: the editor has the A4
 * aspect ratio, is there and editable, and the toolbar is there with its
 * formatting buttons.
 */

import { expect, test } from '@playwright/test';
import { openServedPage } from '../integration/test-utils.js';

/** @type {import('@playwright/test').Page} */
let page;

/** @type {() => Promise<void>} */
let close;

test.beforeAll(async ({ browser }) => {
  ({ page, close } = await openServedPage(browser));
});

test.afterAll(async () => {
  await close();
});

test.describe(`Application Launch`, () => {
  test(`should have A4 aspect ratio on the editor element`, async () => {
    // Verify that the editor's CSS min-height enforces the A4 aspect
    // ratio relative to its max-width.  Both computed values resolve
    // to pixels, so the ratio is viewport-independent.
    const editor = page.locator(`#editor`);
    const ratio = await editor.evaluate((el) => {
      const style = getComputedStyle(el);
      const minHeight = Number.parseFloat(style.minHeight);
      const maxWidth = Number.parseFloat(style.maxWidth);
      return minHeight / maxWidth;
    });

    // A4 aspect ratio is approximately 1.414
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(1.5);
  });
});

test.describe(`Editor Container`, () => {
  test(`should have an editor element`, async () => {
    const editor = await page.locator(`#editor`);
    await expect(editor).toBeVisible();
  });

  test(`should have a toolbar`, async () => {
    const toolbar = await page.locator(`#toolbar-container`);
    await expect(toolbar).toBeVisible();
  });

  test(`editor should be editable`, async () => {
    const editor = await page.locator(`#editor`);
    const isEditable = await editor.getAttribute(`contenteditable`);
    expect(isEditable).toBe(`true`);
  });
});

test.describe(`Toolbar`, () => {
  test(`should have formatting buttons`, async () => {
    const toolbar = await page.locator(`.toolbar`);
    await expect(toolbar).toBeVisible();

    // Check for some essential buttons
    const boldButton = await page.locator(`[data-button-id="bold"]`);
    const italicButton = await page.locator(`[data-button-id="italic"]`);
    const heading1Button = await page.locator(`[data-button-id="heading1"]`);

    await expect(boldButton).toBeVisible();
    await expect(italicButton).toBeVisible();
    await expect(heading1Button).toBeVisible();
  });
});
