/**
 * @fileoverview Browser tests for the file-button group: the top row has
 * three file-operation buttons (New, Open, Save) with their labels and
 * icons in a group at its left, with the View switch at its right, and
 * both fit in it at the narrowest page the window allows.
 */

import { expect, test } from '@playwright/test';
import { VIEWPORT, openServedPage } from '../integration/test-utils.js';

/**
 * The narrowest page `fit_main_window` in main.rs allows.
 */
const MIN_PAGE_WIDTH = process.platform === `darwin` ? 1003 : 300;

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

test(`file-button group exists and contains three buttons`, async () => {
  const group = page.locator(`.toolbar-file-group`);
  await expect(group).toBeVisible();

  const buttons = group.locator(`.toolbar-button`);
  await expect(buttons).toHaveCount(3);
});

test(`file buttons have correct labels`, async () => {
  const newBtn = page.locator(`.toolbar-button[data-button-id="file-new"]`);
  const openBtn = page.locator(`.toolbar-button[data-button-id="file-open"]`);
  const saveBtn = page.locator(`.toolbar-button[data-button-id="file-save"]`);

  await expect(newBtn).toHaveAttribute(`aria-label`, `New File`);
  await expect(openBtn).toHaveAttribute(`aria-label`, `Open File`);
  await expect(saveBtn).toHaveAttribute(`aria-label`, `Save File`);
});

test(`file buttons contain SVG icons`, async () => {
  const group = page.locator(`.toolbar-file-group`);
  const svgs = group.locator(`.toolbar-button svg`);
  await expect(svgs).toHaveCount(3);
});

/**
 * Where the file buttons and the View switch are in the top row, in CSS
 * pixels, with the edges of the row's content and their own widths.
 * @returns {Promise<Record<string, number>>}
 */
function topRowLayout() {
  return page.evaluate(() => {
    /** @param {string} selector */
    const rect = (selector) =>
      /** @type {Element} */ (document.querySelector(selector)).getBoundingClientRect();
    const container = rect(`#toolbar-container`);
    const containerStyle = getComputedStyle(
      /** @type {Element} */ (document.querySelector(`#toolbar-container`)),
    );
    const fileGroup = rect(`.toolbar-file-group`);
    const viewGroup = rect(`.toolbar-view-mode-group`);
    return {
      contentLeft: container.left + Number.parseFloat(containerStyle.paddingLeft),
      contentRight: container.right - Number.parseFloat(containerStyle.paddingRight),
      fileGroupLeft: fileGroup.left,
      fileGroupRight: fileGroup.right,
      viewGroupLeft: viewGroup.left,
      viewGroupRight: viewGroup.right,
      neededWidth:
        Number.parseFloat(containerStyle.paddingLeft) +
        fileGroup.width +
        viewGroup.width +
        Number.parseFloat(containerStyle.paddingRight),
    };
  });
}

test(`the file buttons are at the left of the top row, and the View switch at its right`, async () => {
  const layout = await topRowLayout();
  expect(Math.round(layout.fileGroupLeft), JSON.stringify(layout)).toBe(
    Math.round(layout.contentLeft),
  );
  expect(Math.round(layout.viewGroupRight), JSON.stringify(layout)).toBe(
    Math.round(layout.contentRight),
  );
});

test(`at the minimum page width the file buttons and the View switch fit in the top row`, async () => {
  // WebKit lays the top row out from the margins it had at the previous
  // width, so the page narrows a pixel at a time, as dragging the window's
  // edge narrows it, until the layout has settled.
  for (let extra = 16; extra >= 0; extra -= 1) {
    await page.setViewportSize({ width: MIN_PAGE_WIDTH + extra, height: VIEWPORT.height });
  }
  try {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const layout = await topRowLayout();
    expect(layout.fileGroupLeft, JSON.stringify(layout)).toBeGreaterThanOrEqual(layout.contentLeft);
    expect(layout.viewGroupLeft, JSON.stringify(layout)).toBeGreaterThanOrEqual(
      layout.fileGroupRight,
    );
    expect(layout.viewGroupRight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.contentRight);
  } finally {
    await page.setViewportSize(VIEWPORT);
  }
});
