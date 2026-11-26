/**
 * @fileoverview Browser tests for the code-block language tags in writing
 * view. Every code block shows two small language-tag spans ([data-lang])
 * at the top-right and bottom-right. When a language is set they display
 * it; otherwise they show a placeholder ("lang") with an --empty modifier.
 * The bottom one shows on tall code blocks only, and source view has none.
 */

import { expect, test } from '@playwright/test';
import {
  loadContent,
  openServedPage,
  setSource2View,
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

test.beforeEach(async () => {
  await loadContent(page, ``);
  await setWritingView(page);
});

test.describe(`Writing-view code-block language tag spans`, () => {
  test(`code block with language shows language text in top tag`, async () => {
    await loadContent(page, `\`\`\`js\nconsole.log("hi");\n\`\`\``);
    const topTag = page.locator(`#editor [data-lang].top`);
    await expect(topTag).toHaveText(`js`);
  });

  test(`code block without language shows placeholder with --empty modifier`, async () => {
    await loadContent(page, `\`\`\`\nplain code\n\`\`\``);
    const topTag = page.locator(`#editor [data-lang].top`);
    await expect(topTag).toHaveText(`lang`);
    await expect(topTag).toHaveClass(/empty/);
  });

  test(`bottom tag is hidden on short code blocks (< 20 lines)`, async () => {
    await loadContent(page, `\`\`\`js\nshort\n\`\`\``);
    const bottomTag = page.locator(`#editor [data-lang].bottom`);
    await expect(bottomTag).toBeHidden();
  });

  test(`bottom tag is visible on tall code blocks (>= 20 lines)`, async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join(`\n`);
    await loadContent(page, `\`\`\`js\n${lines}\n\`\`\``);
    const bottomTag = page.locator(`#editor [data-lang].bottom`);
    await expect(bottomTag).toBeVisible();
    await expect(bottomTag).toHaveText(`js`);
  });

  test(`top tag is positioned absolutely with pointer cursor`, async () => {
    await loadContent(page, `\`\`\`python\nprint("hello")\n\`\`\``);
    const topTag = page.locator(`#editor [data-lang].top`);
    await expect(topTag).toBeVisible();
    const topStyle = await topTag.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return { position: s.position, cursor: s.cursor };
    });
    expect(topStyle.position).toBe(`absolute`);
    expect(topStyle.cursor).toBe(`pointer`);
  });

  test(`source2 view does not render language tag spans`, async () => {
    await loadContent(page, `\`\`\`js\ncode\n\`\`\``);
    await setSource2View(page);
    const tags = page.locator(`#editor .md-code-block [data-lang]`);
    await expect(tags).toHaveCount(0);
  });
});
