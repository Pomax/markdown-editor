/**
 * @fileoverview Integration tests for Enter and Backspace at the start of
 * a paragraph, and for removing an empty paragraph above a block with
 * Delete or Backspace, in the writing view.
 */

import { expect, test } from '@playwright/test';
import {
  END,
  FIXTURE_IMAGE,
  HOME,
  clickWritingViewBetween,
  closeApp,
  launchApp,
  loadContent,
  setWritingView,
} from '../../test-utils.js';

/**
 * Every kind of block, as markdown, with the text to click between to put
 * the caret in it for the Backspace tests, and the markdown after typing
 * `x` at its start.
 * @type {{ name: string, markdown: string, click?: [string, string], typed?: string }[]}
 */
const blocks = [
  { name: `heading`, markdown: `# Title`, typed: `# xTitle` },
  { name: `list item`, markdown: `- item`, click: [`it`, `em`], typed: `- xitem` },
  { name: `paragraph`, markdown: `text`, click: [`te`, `xt`], typed: `xtext` },
  {
    name: `code block`,
    markdown: `\`\`\`\ncode\n\`\`\``,
    click: [`co`, `de`],
    typed: `\`\`\`\nxcode\n\`\`\``,
  },
  { name: `quote`, markdown: `> quoted`, click: [`quo`, `ted`], typed: `> xquoted` },
  {
    name: `html block`,
    markdown: `<div>\n\ninside\n\n</div>`,
    click: [`ins`, `ide`],
    typed: `<div>\n\nxinside\n\n</div>`,
  },
  {
    name: `table`,
    markdown: `| head | two |\n| --- | --- |\n| c | d |`,
    typed: `| xhead | two |\n| --- | --- |\n| c | d |`,
  },
  { name: `horizontal rule`, markdown: `---` },
  { name: `image`, markdown: `![alt](${FIXTURE_IMAGE})` },
];

/**
 * The editor's markdown.
 * @returns {Promise<string | undefined>}
 */
function content() {
  return page.evaluate(() => window.editorAPI?.getContent());
}

/**
 * The markdown of a document with the given block between a paragraph
 * `before` and a paragraph `after`.
 * @param {string} markdown
 * @returns {string}
 */
function around(markdown) {
  return `before\n\n${markdown}\n\nafter`;
}

/**
 * Loads the given block between `before` and `after`, and puts an empty
 * paragraph above the block with Enter at the end of `before`, leaving
 * the caret in that empty paragraph.
 *
 * It clicks in `after` before clicking in `before`. On Linux the clicks
 * are real X11 clicks, and WebKitGTK counts a click at the same point as
 * the click just before it as a double or triple click. Without the
 * click in `after`, the click in `before` in one test after another would
 * select the word or the whole paragraph instead of putting the caret
 * there.
 * @param {string} markdown
 */
async function loadWithEmptyParagraphAbove(markdown) {
  await loadContent(page, around(markdown));
  expect(await content()).toBe(around(markdown));
  await clickWritingViewBetween(page, `aft`, `er`);
  await clickWritingViewBetween(page, `befor`, `e`);
  await page.keyboard.press(END);
  await page.keyboard.press(`Enter`);
  await expect.poll(content).toBe(around(`\n\n${markdown}`));
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

test.beforeEach(async () => {
  await setWritingView(page);
});

test(`Enter at the start of a paragraph puts an empty paragraph above it and keeps the paragraph`, async () => {
  await loadContent(page, `before\n\ntext`);
  await clickWritingViewBetween(page, `te`, `xt`);
  const id = await page
    .locator(`#editor [data-node-id]`, { hasText: `text` })
    .first()
    .getAttribute(`data-node-id`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`x`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`before\n\n\n\nxtext`);
  await expect(page.locator(`#editor [data-node-id="${id}"]`)).toHaveText(`xtext`);
});

test(`Backspace at the start of a paragraph with an empty list item above it removes that item and keeps the paragraph`, async () => {
  await loadContent(page, `- one\n\ntext`);
  await clickWritingViewBetween(page, `one`, `text`);
  await page.keyboard.press(`Enter`);
  await clickWritingViewBetween(page, `te`, `xt`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);
  await page.keyboard.type(`x`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`- one\n\nxtext`);
});

for (const { name, markdown, typed } of blocks) {
  test(`Delete in an empty paragraph above a ${name} removes that paragraph and keeps the ${name}`, async () => {
    await loadWithEmptyParagraphAbove(markdown);
    await page.keyboard.press(`Delete`);

    await expect.poll(content).toBe(around(markdown));
    if (typed === undefined) return;
    await page.keyboard.type(`x`);
    await expect.poll(content).toBe(around(typed));
  });
}

for (const { name, markdown, click, typed } of blocks) {
  if (click === undefined || typed === undefined) continue;
  test(`Backspace at the start of a ${name} with an empty paragraph above it removes that paragraph and keeps the ${name}`, async () => {
    await loadWithEmptyParagraphAbove(markdown);
    await clickWritingViewBetween(page, ...click);
    await page.keyboard.press(HOME);
    await page.keyboard.press(`Backspace`);
    await page.keyboard.type(`x`);

    await expect.poll(content).toBe(around(typed));
  });
}

test(`Delete in an empty list item above a heading removes that item and keeps the heading`, async () => {
  await loadContent(page, `- one\n\n# Title`);
  await clickWritingViewBetween(page, `on`, `e`);
  await page.keyboard.press(END);
  await page.keyboard.press(`Enter`);
  await expect.poll(content).toBe(`- one\n- \n\n# Title`);
  await page.keyboard.press(`Delete`);
  await page.keyboard.type(`x`);

  await expect.poll(content).toBe(`- one\n\n# xTitle`);
});
