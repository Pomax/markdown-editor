/**
 * @fileoverview Browser tests for how checklist items render in writing
 * view: with a checkbox, ticked for a checked item, and with no bullet.
 */

import { expect, test } from '@playwright/test';
import { loadContent, openServedPage, setWritingView } from '../integration/test-utils.js';

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

test(`writing view renders checkbox for checklist item`, async () => {
  await loadContent(page, `- [ ] My task\n`);
  await setWritingView(page);

  const checkbox = page.locator(`#editor .md-list-item input[type="checkbox"]`);
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
});

test(`writing view renders checked checkbox for checked checklist item`, async () => {
  await loadContent(page, `- [x] Done task\n`);
  await setWritingView(page);

  const checkbox = page.locator(`#editor .md-list-item input[type="checkbox"]`);
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeChecked();
});

test(`writing view does not show bullet marker for checklist items`, async () => {
  await loadContent(page, `- [ ] No bullet\n`);
  await setWritingView(page);

  const line = page.locator(`#editor [data-node-id]`).first();
  const style = await line.evaluate((el) => window.getComputedStyle(el).listStyleType);
  expect(style).toBe(`none`);
});
