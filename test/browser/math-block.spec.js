/**
 * @fileoverview Browser tests for how math blocks render in the writing
 * view. A math block the cursor is not on shows the math KaTeX makes of it,
 * in KaTeX's own fonts, from the left of its block, and a placeholder for
 * source KaTeX cannot render; the one the cursor is on looks like a code
 * block labelled math; and a math block at the end of the document has a
 * paragraph after it.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  loadContent,
  openServedPage,
  setWritingView,
} from '../integration/test-utils.js';

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

/**
 * The HTML KaTeX made for a math block.
 * @param {import('@playwright/test').Locator} math
 * @returns {Promise<string>}
 */
async function htmlOf(math) {
  return math.evaluate((el) => el.innerHTML);
}

test.describe(`Math blocks in the writing view`, () => {
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
        (font) =>
          font.family.includes(`KaTeX_Main`) && font.weight === `400` && font.style === `normal`,
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
      return Math.round(
        (base?.getBoundingClientRect().left ?? -1) - math.getBoundingClientRect().left,
      );
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
});
