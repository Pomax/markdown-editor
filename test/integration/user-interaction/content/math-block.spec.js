/**
 * @fileoverview Integration tests for math blocks in the writing view.
 *
 * Typing a `\[` line and Enter makes a math block, as do the Math Block
 * button and Ctrl+Shift+M. Clicking the rendered math shows its source,
 * and the math is drawn in the page text colour after that colour changes
 * in the preferences.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
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
 * The text of the focused math block's source element.
 * @param {import('@playwright/test').Locator} editor
 * @returns {Promise<string>}
 */
async function mathSource(editor) {
  return editor.locator(`.md-math-block code.md-content`).evaluate((el) => el.textContent ?? ``);
}

/**
 * Sets the page text colour through the preferences dialog.
 * @param {string} color
 */
async function setTextColor(color) {
  await app.sendMenuAction(`edit:preferences`);
  const dialog = page.locator(`dialog.preferences-dialog`);
  await expect(dialog).toBeVisible();
  await page.locator(`#color-page-text`).fill(color);
  await dialog.locator(`.preferences-btn--save`).click();
  await expect(dialog).toBeHidden();
}

test.describe(`Math blocks in the writing view`, () => {
  test(`typing \\[ + Enter creates an empty math block`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\\[`);
    await page.keyboard.press(`Enter`);

    await expect(editor.locator(`[data-node-id].md-math-block`)).toBeVisible();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(`\\[\n\n\\]`);
  });

  test(`\\[ is not converted until Enter`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\\[`);

    await expect(editor.locator(`[data-node-id].md-paragraph`)).toBeVisible();
    await expect(editor.locator(`[data-node-id].md-math-block`)).toHaveCount(0);
  });

  test(`Enter inside a math block inserts a newline, and the block shows its source`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\\[`);
    await page.keyboard.press(`Enter`);
    await page.keyboard.type(`a = b`);
    await page.keyboard.press(`Enter`);
    await page.keyboard.type(`c = d`);

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(`\\[\na = b\nc = d\n\\]`);

    await expect(editor.locator(`[data-node-id].md-math-block`)).toHaveCount(1);
    expect(await mathSource(editor)).toBe(`a = b\nc = d\n`);
  });

  test(`the Math Block button turns a paragraph into a math block, and shows when the cursor is in one`, async () => {
    await setWritingView(page);
    await loadContent(page, `x^2`);

    const editor = page.locator(`#editor`);
    const button = page.locator(`[data-button-id="math-block"]`);
    await clickInEditor(page, editor.locator(`.md-paragraph`));
    await expect(button).not.toHaveClass(/active/);

    await button.click();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(`\\[\nx^2\n\\]`);
    await expect(button).toHaveClass(/active/);
  });

  test(`Ctrl+Shift+M turns a paragraph into a math block`, async () => {
    await setWritingView(page);
    await loadContent(page, `x^2`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`));
    await page.keyboard.press(`Control+Shift+M`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent() ?? ``))
      .toBe(`\\[\nx^2\n\\]`);
  });

  test(`the Math Block button puts \\[ and \\] lines around the line in source view, and takes them off again`, async () => {
    await setWritingView(page);
    await loadContent(page, `x^2`);
    await setSource2View(page);

    const textarea = page.locator(`#editor.source-view-v2 textarea`);
    const button = page.locator(`[data-button-id="math-block"]`);
    await textarea.focus();
    await textarea.evaluate((/** @type {HTMLTextAreaElement} */ el) => el.setSelectionRange(1, 1));

    await button.click();
    await expect(textarea).toHaveValue(`\\[\nx^2\n\\]`);

    await button.click();
    await expect(textarea).toHaveValue(`x^2`);

    await setWritingView(page);
  });

  test(`clicking a math block's rendered math shows its source`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\n\\frac{\\pi}{2}\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));
    const rendered = editor.locator(`.md-math-block .katex`);
    await expect(rendered).toBeVisible();

    await clickInEditor(page, rendered);

    await expect(editor.locator(`.md-math-block .katex`)).toHaveCount(0);
    expect(await mathSource(editor)).toBe(`\\frac{\\pi}{2}\n`);
  });

  test(`math is drawn in the page text colour, in every tab, after that colour changes`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\nx\n\\]\n\nafter`);
    const first = page.locator(`#editor`);
    await clickInEditor(page, first.locator(`.md-paragraph`, { hasText: `after` }));
    const firstMath = first.locator(`.md-math-block .katex`);
    await expect(firstMath).toBeVisible();

    await app.sendMenuAction(`file:new`);
    const second = page.locator(`.editor:not(#editor)`);
    await expect(second).toBeVisible();
    await page.evaluate((content) => window.editorAPI?.setContent(content), `\\[\ny\n\\]\n\nafter`);
    await clickInEditor(page, second.locator(`.md-paragraph`, { hasText: `after` }));
    const secondMath = second.locator(`.md-math-block .katex`);
    await expect(secondMath).toBeVisible();

    await setTextColor(`#ff0000`);

    await expect(secondMath).toHaveCSS(`color`, `rgb(255, 0, 0)`);
    await expect(firstMath).toHaveCSS(`color`, `rgb(255, 0, 0)`);

    await setTextColor(`#212529`);
  });
});
