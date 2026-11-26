/**
 * @fileoverview Browser tests for the page resize handles: they are there
 * in writing view and in source view.
 */

import { expect, test } from '@playwright/test';
import { openServedPage, setSource2View, setWritingView } from '../integration/test-utils.js';

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

test(`resize handles are visible in writing mode`, async () => {
  await setWritingView(page);
  const left = page.locator(`.editor-resize-handle--left`);
  const right = page.locator(`.editor-resize-handle--right`);
  await expect(left).toBeAttached();
  await expect(right).toBeAttached();
});

test(`resize handles are visible in source2 mode`, async () => {
  await setSource2View(page);
  const left = page.locator(`.editor-resize-handle--left`);
  const right = page.locator(`.editor-resize-handle--right`);
  await expect(left).toBeAttached();
  await expect(right).toBeAttached();
  await setWritingView(page);
});
