/**
 * @fileoverview Browser tests for the view-mode toggle in the top row: it
 * has a visible label and defaults to "Writing View".
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

test(`view mode toggle has a visible label`, async () => {
  const label = page.locator(`.toolbar-view-mode-label`);
  await expect(label).toBeVisible();
  await expect(label).toHaveText(`View:`);
});

test(`view mode toggle defaults to Writing View`, async () => {
  const toggle = page.locator(`.toolbar-view-mode-toggle`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText(`Writing View`);
});
