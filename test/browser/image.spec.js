/**
 * @fileoverview Browser test for the toolbar's Image button: it is there,
 * with its tooltip.
 */

import { expect, test } from '@playwright/test';
import { MOD_LABEL, openServedPage } from '../integration/test-utils.js';

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

test(`image button is visible in the toolbar`, async () => {
  const imageButton = page.locator(`[data-button-id="image"]`);
  await expect(imageButton).toBeVisible();
  await expect(imageButton).toHaveAttribute(`data-tooltip`, `Image (${MOD_LABEL}+Shift+I)`);
});
