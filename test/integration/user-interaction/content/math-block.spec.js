/**
 * @fileoverview Integration tests for math blocks in the writing view.
 *
 * A `\[` line and a `\]` line around LaTeX source make a math block.  While
 * the cursor is on the block it shows that source; otherwise it shows the
 * math KaTeX makes of it, in the page text colour, and a placeholder for
 * source KaTeX cannot render.
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
 * The HTML KaTeX made for a math block.
 * @param {import('@playwright/test').Locator} math
 * @returns {Promise<string>}
 */
async function htmlOf(math) {
  return math.evaluate((el) => el.innerHTML);
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

  test(`a math block the cursor is not on shows the math KaTeX makes of it`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\n\\frac{\\pi}{2}\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    await expect(editor.locator(`.md-math-block .katex .mfrac`)).toBeVisible();
    await expect(editor.locator(`.md-math-block code`)).toHaveCount(0);
  });

  test(`math is drawn in KaTeX's own fonts, at their own weights`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\n\\text{CatmullRom}(t) = 1\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    const drawn = await editor.locator(`.md-math-block .katex-html`).evaluate(async (html) => {
      await document.fonts.ready;
      const main = [...document.fonts].find(
        (font) => font.family.includes(`KaTeX_Main`) && font.weight === `400` && font.style === `normal`,
      );
      const leaves = [...html.querySelectorAll(`span`)].filter(
        (span) => span.children.length === 0 && span.textContent?.trim(),
      );
      return {
        main: main?.status,
        leaves: leaves.map((span) => {
          const style = getComputedStyle(span);
          return `${span.textContent}: ${style.fontFamily.split(`,`)[0]} ${style.fontWeight}`;
        }),
      };
    });

    expect(drawn.main).toBe(`loaded`);
    expect(drawn.leaves).toEqual([
      `CatmullRom: KaTeX_Main 400`,
      `(: KaTeX_Main 400`,
      `t: KaTeX_Math 400`,
      `): KaTeX_Main 400`,
      `=: KaTeX_Main 400`,
      `1: KaTeX_Main 400`,
    ]);
  });

  test(`math is drawn from the left of its block`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\nx\n\\]\n\nafter`);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    const offset = await editor.locator(`.md-math-block .md-math`).evaluate((math) => {
      const base = math.querySelector(`.katex-html > *`);
      return Math.round((base?.getBoundingClientRect().left ?? -1) - math.getBoundingClientRect().left);
    });
    expect(offset).toBe(0);
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
    const rendered = editor.locator(`.md-math-block .katex`);
    await expect(rendered).toBeVisible();
    await clickInEditor(page, rendered);

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

  test(`LaTeX that KaTeX cannot render shows the invalid Math LaTeX placeholder`, async () => {
    await setWritingView(page);
    await loadContent(
      page,
      `\\[\n\\frac{1}{\n\\]\n\n\\[\n\\text{invalid Math LaTeX}\n\\]\n\n\\[\nx\n\\]\n\nafter`,
    );

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor.locator(`.md-paragraph`, { hasText: `after` }));

    const maths = editor.locator(`.md-math-block .md-math`);
    await expect(maths).toHaveCount(3);

    const [invalid, placeholder, valid] = [
      await htmlOf(maths.nth(0)),
      await htmlOf(maths.nth(1)),
      await htmlOf(maths.nth(2)),
    ];
    expect(invalid).toBe(placeholder);
    expect(valid).not.toBe(placeholder);
  });

  test(`a math block at the end of the document has a paragraph after it to move to`, async () => {
    await setWritingView(page);
    await loadContent(page, `\\[\nx\n\\]`);

    await expect(page.locator(`#editor [data-is-phantom]`)).toHaveCount(1);
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
