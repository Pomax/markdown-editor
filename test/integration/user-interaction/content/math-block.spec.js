/**
 * @fileoverview Integration tests for math blocks in the writing view.
 *
 * A `\[` line and a `\]` line around LaTeX source make a math block.  While
 * the cursor is on the block it shows that source; otherwise it shows the
 * SVG math-render makes of it, at the SVG's own size, in the page text
 * colour, and a placeholder SVG for source math-render cannot convert.
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
 * The SVG an image shows through its `data:image/svg+xml` URL.
 * @param {import('@playwright/test').Locator} img
 * @returns {Promise<string>}
 */
async function svgOf(img) {
  const src = (await img.getAttribute(`src`)) ?? ``;
  return decodeURIComponent(src.substring(src.indexOf(`,`) + 1));
}

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

  test(`the backend renders LaTeX to an SVG`, async () => {
    test.setTimeout(120_000);
    const result = await page.evaluate(() =>
      window.pageToBackendBridge?.renderMath(`\\frac{\\pi}{2}`, `#212529`),
    );
    expect(result?.success).toBe(true);
    expect(result?.svg?.startsWith(`<svg`)).toBe(true);
  });

  test(`a math block the cursor is not on shows its SVG`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\n\\frac{\\pi}{2}\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    const img = editor.locator(`.md-math-block img`);
    await expect(img).toBeVisible();
    await expect(editor.locator(`.md-math-block code`)).toHaveCount(0);

    expect(await svgOf(img)).toMatch(/^<svg/);
  });

  test(`a math block the cursor is on looks like a code block, labelled math`, async () => {
    await setWritingView(page);
    await loadContent(page, `\`\`\`\ncode\n\`\`\`\n\n\\[\nx\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    /** @param {import('@playwright/test').Locator} block */
    const look = (block) =>
      block.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, padding: style.padding };
      });

    await clickInEditor(page, editor.locator(`.md-code-block code`));
    const codeLook = await look(editor.locator(`.md-code-block[data-has-focus]`));

    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));
    const img = editor.locator(`.md-math-block img`);
    await expect(img).toBeVisible();
    await clickInEditor(page, img);

    const math = editor.locator(`.md-math-block[data-has-focus]`);
    await expect(math.locator(`[data-lang].top`)).toHaveText(`math`);
    expect(await look(math)).toEqual(codeLook);
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

  test(`clicking a math block's SVG shows its source`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\n\\frac{\\pi}{2}\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));
    const img = editor.locator(`.md-math-block img`);
    await expect(img).toBeVisible();

    await clickInEditor(page, img);

    await expect(editor.locator(`.md-math-block img`)).toHaveCount(0);
    expect(await mathSource(editor)).toBe(`\\frac{\\pi}{2}\n`);
  });

  test(`LaTeX that math-render cannot convert shows the invalid Math LaTeX placeholder`, async () => {
    await setWritingView(page);
    await loadContent(
      page,
      `\\[\n\\textcolor{red}{x}\n\\]\n\n\\[\n\\text{invalid Math LaTeX}\n\\]\n\n\\[\nx\n\\]\n\nafter`,
    );

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    const imgs = editor.locator(`.md-math-block img`);
    await expect(imgs).toHaveCount(3);

    const [invalid, placeholder, valid] = [
      await svgOf(imgs.nth(0)),
      await svgOf(imgs.nth(1)),
      await svgOf(imgs.nth(2)),
    ];
    expect(invalid).toBe(placeholder);
    expect(valid).not.toBe(placeholder);
  });

  test(`a math block at the end of the document has a paragraph after it to move to`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\nx\n\\]`);

    await expect(page.locator(`#editor [data-is-phantom]`)).toHaveCount(1);
  });

  test(`changing the text colour renders all math again in that colour, in every tab`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\nx\n\\]\n\nafter`);
    const first = page.locator(`#editor`);
    await clickInEditor(page, first.locator(`.md-paragraph`, { hasText: `after` }));
    const firstImg = first.locator(`.md-math-block img`);
    await expect(firstImg).toBeVisible();
    expect(await svgOf(firstImg)).toContain(`#212529`);

    await app.sendMenuAction(`file:new`);
    const second = page.locator(`.editor:not(#editor)`);
    await expect(second).toBeVisible();
    await page.evaluate((content) => window.editorAPI?.setContent(content), `\\[\ny\n\\]\n\nafter`);
    await clickInEditor(page, second.locator(`.md-paragraph`, { hasText: `after` }));
    const secondImg = second.locator(`.md-math-block img`);
    await expect(secondImg).toBeVisible();

    await setTextColor(`#ff0000`);

    await expect.poll(() => svgOf(secondImg)).toContain(`#ff0000`);
    await expect.poll(() => svgOf(firstImg)).toContain(`#ff0000`);

    await setTextColor(`#212529`);
  });
});
