/**
 * @fileoverview Browser tests for parsing fenced code blocks: a fence of
 * more backticks than a sequence inside the block keeps that sequence as
 * literal text, and the markdown loaded is the markdown the editor gives
 * back.
 */

import { expect, test } from '@playwright/test';
import { openServedPage } from '../integration/test-utils.js';

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

test.describe(`Code-block parsing`, () => {
  test(`loading markdown with four-backtick fence preserves nested three-backtick fences`, async () => {
    const md = `\`\`\`\`\n\`\`\`\nnested\n\`\`\`\n\`\`\`\``;
    await page.evaluate((content) => window.editorAPI?.setContent(content), md);
    await page.waitForSelector(`#editor [data-node-id]`);

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(md);
  });

  test(`a four-backtick fence keeps three-backtick lines inside it as literal text`, async () => {
    const md = [
      `This is a paragraph of text.`,
      ``,
      `\`\`\`\``,
      `This is a code block, opened with four backticks rather than three, so any sequence of backticks up to but not including four is treated as just literal text, not active markdown:`,
      `\`\`\``,
      `This should just show literal backticks instead of getting parsed as a nested code block (which would be against markdown specs).`,
      `\`\`\``,
      `The codeblock only closes on the next sequence of four backticks, marking the opening sequence:`,
      `\`\`\`\``,
      ``,
      `And this is regular text again.`,
    ].join(`\n`);

    await page.evaluate((content) => window.editorAPI?.setContent(content), md);
    await page.waitForSelector(`#editor [data-node-id]`);

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(md);

    const nodes = await page.evaluate(() => {
      const e = /** @type {any} */ (window).__editor;
      return e?.syntaxTree?.children?.map((/** @type {any} */ n) => n.type) ?? [];
    });
    expect(nodes).toEqual([`paragraph`, `code-block`, `paragraph`]);
  });

  test(`a ten-backtick fence keeps nine backticks inside it as literal text`, async () => {
    const md = [
      `This is text`,
      ``,
      `\`\`\`\`\`\`\`\`\`\``,
      `This is code, with \`\`\`\`\`\`\`\`\` in it as plain inert text because it doesn't match the opening block`,
      `\`\`\`\`\`\`\`\`\`\``,
      ``,
      `But this is text again, because the preceding backticks was the same sequence as the opening code fence.`,
    ].join(`\n`);

    await page.evaluate((content) => window.editorAPI?.setContent(content), md);
    await page.waitForSelector(`#editor [data-node-id]`);

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toBe(md);

    const nodes = await page.evaluate(() => {
      const e = /** @type {any} */ (window).__editor;
      return e?.syntaxTree?.children?.map((/** @type {any} */ n) => n.type) ?? [];
    });
    expect(nodes).toEqual([`paragraph`, `code-block`, `paragraph`]);
  });
});
