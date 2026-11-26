/**
 * @fileoverview Integration tests for view-mode switching behaviour.
 * Verifies scroll position, cursor preservation, and other concerns
 * that arise when switching between writing and source2 views.
 */

import { expect, test } from '@playwright/test';
import {
  clickSourceViewBetween,
  closeApp,
  launchApp,
  loadContent,
  setSource2View,
  setWritingView,
  writingViewTextAroundCaret,
} from '../../test-utils.js';

/** A document long enough that its end is far out of view at its start. */
const longDocument = [
  ...Array.from({ length: 150 }, (_, i) => `Paragraph number ${i + 1} of the long document.`),
  `> > A nested quote near the end`,
  `The last paragraph.`,
].join(`\n\n`);

/**
 * Whether the element the writing view's caret is in lies inside the
 * visible part of the editor's scroll container.
 * @returns {Promise<boolean>}
 */
async function caretIsInView() {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const scroller = document.getElementById(`editor-container`);
    if (!selection || selection.rangeCount === 0 || !scroller) return false;
    const node = selection.getRangeAt(0).startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return false;
    const caret = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return caret.top >= view.top && caret.bottom <= view.bottom;
  });
}

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

test(`switching to source2 does not scroll a short document`, async () => {
  await loadContent(page, ``);
  await setWritingView(page);

  const editor = page.locator(`#editor`);
  await editor.click();
  await page.waitForTimeout(100);

  // Type text containing an inline element, so the cursor ends up
  // after a closing tag.
  const text = `this is <em>a test</em>.`;
  for (const ch of text) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100);

  const scrollTopBefore = await page.evaluate(() => {
    return document.getElementById(`editor-container`)?.scrollTop ?? 0;
  });

  await setSource2View(page);

  const scrollTopAfter = await page.evaluate(() => {
    return document.getElementById(`editor-container`)?.scrollTop ?? 0;
  });

  expect(scrollTopAfter, `switching to source2 should not change scroll position`).toBe(
    scrollTopBefore,
  );
});

test(`switching from source2 to writing keeps the caret in view`, async () => {
  await loadContent(page, longDocument);
  await setSource2View(page);
  await clickSourceViewBetween(page, `The last`, ` paragraph.`);
  await setWritingView(page);

  expect((await writingViewTextAroundCaret(page, 8, 11))?.before).toBe(`The last`);
  expect(await caretIsInView()).toBe(true);
});

test(`switching from source2 to writing keeps a caret in a nested quote in view`, async () => {
  await loadContent(page, longDocument);
  await setSource2View(page);
  await clickSourceViewBetween(page, `A nested`, ` quote near`);
  await setWritingView(page);

  expect((await writingViewTextAroundCaret(page, 8, 6))?.before).toBe(`A nested`);
  expect(await caretIsInView()).toBe(true);
});
