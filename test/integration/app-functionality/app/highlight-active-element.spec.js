/**
 * @fileoverview The "Highlight active element" preference: the first
 * option of the Preferences dialog's Content section, ticked by default.
 * While it is ticked the body has the `with-highlight` class and the
 * block the cursor is in has the highlight background in writing view.
 * Unticked and saved, the class is gone and nothing about the block the
 * cursor is in changes: no background, and a list item keeps the margins
 * and padding of the others. The choice is kept for the next start.
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent, projectRoot, setWritingView } from '../../test-utils.js';

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

/** The highlight background of the block the cursor is in. */
const HIGHLIGHT = `rgba(13, 110, 253, 0.05)`;

test.beforeAll(async () => {
  rmSync(path.join(projectRoot, `test-results`, `settings`, path.basename(test.info().file)), {
    recursive: true,
    force: true,
  });
  ({ app, page } = await launchApp());
  await loadContent(page, `first paragraph\n\nsecond paragraph\n\n- item one\n- item two`);
  await setWritingView(page);
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * Opens Preferences on its Content section.
 */
async function openContentPreferences() {
  await app.sendMenuAction(`edit:preferences`);
  await page.locator(`.preferences-nav-link[data-section="pref-content"]`).click();
}

/**
 * @returns {Promise<boolean>} Whether the body has the `with-highlight` class.
 */
function bodyHighlights() {
  return page.evaluate(() => document.body.classList.contains(`with-highlight`));
}

/**
 * Puts the cursor in a block by clicking it, and returns the computed
 * background of that block once it has the focus.
 * @param {string} text - The block's text.
 * @returns {Promise<string>}
 */
async function backgroundWithCursorIn(text) {
  const block = page.locator(`#editor [data-node-id]`, { hasText: text }).last();
  await block.click();
  await expect(block).toHaveAttribute(`data-has-focus`, ``);
  return block.evaluate((element) => getComputedStyle(element).backgroundColor);
}

/**
 * The margins and padding of each list item, the one with the cursor
 * included.
 * @returns {Promise<string[]>}
 */
function listItemSpacing() {
  return page.locator(`#editor .md-list-item`).evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item);
      return `${style.marginLeft} ${style.paddingLeft} ${style.marginRight} ${style.paddingRight}`;
    }),
  );
}

test(`the Content section starts with Highlight active element, ticked, with its description`, async () => {
  await openContentPreferences();
  const row = page.locator(`#pref-content .content-settings-row`).first();
  const first = row.locator(`.content-toggle`);
  await expect(first).toHaveText(`Highlight active element`);
  await expect(first.locator(`input[type="checkbox"]`)).toBeChecked();
  await expect(row.locator(`.preferences-hint`)).toHaveText(
    `When enabled, the block element that the cursor is in gets highlighted as a visual aid. When disabled, no special styling is applied.`,
  );
  await page.locator(`.preferences-btn--cancel`).click();
});

test(`while it is ticked, the block with the cursor is highlighted`, async () => {
  expect(await bodyHighlights()).toBe(true);
  expect(await backgroundWithCursorIn(`second paragraph`)).toBe(HIGHLIGHT);
});

test(`unticked, nothing changes for the block with the cursor`, async () => {
  await openContentPreferences();
  await page.locator(`#highlight-active-element`).uncheck();
  await page.locator(`.preferences-btn--save`).click();

  await expect.poll(bodyHighlights).toBe(false);
  expect(await backgroundWithCursorIn(`second paragraph`)).toBe(`rgba(0, 0, 0, 0)`);
  await backgroundWithCursorIn(`item two`);
  const [unfocused, focused] = await listItemSpacing();
  expect(focused).toBe(unfocused);
});

test(`the choice is kept for the next start`, async () => {
  test.setTimeout(30_000);
  await page.evaluate(() =>
    window.pageToBackendBridge?.setSetting(`highlightActiveElement`, false),
  );
  const next = await launchApp();
  try {
    await expect
      .poll(() => next.page.evaluate(() => document.body.classList.contains(`with-highlight`)))
      .toBe(false);
  } finally {
    await closeApp(next.app);
  }
});
