/**
 * @fileoverview Browser test for the phantom trailing paragraph when a
 * document ends with a fenced code block: the editor appends a DOM-only,
 * empty "phantom" paragraph after it that is not part of the syntax tree
 * and leaves the serialised markdown unchanged.
 */

import { expect, test } from '@playwright/test';
import { loadContent, openServedPage, setWritingView } from '../integration/test-utils.js';

/** A tiny document that ends with a fenced code block. */
const markdownEndingInCodeBlock = `# Title\n\n\`\`\`js\nconsole.log("hi");\n\`\`\``;

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

test(`loading a document that ends in a code block appends a phantom paragraph in the DOM`, async () => {
  await loadContent(page, markdownEndingInCodeBlock);
  await setWritingView(page);

  // A phantom paragraph should exist in the DOM after the code block.
  const phantom = page.locator(`#editor > [data-is-phantom]`);
  await expect(phantom).toBeVisible();

  // The phantom should be empty (no visible text).
  const text = await phantom.innerText();
  expect(text.trim()).toBe(``);

  // The phantom must NOT affect the serialised markdown.
  const content = await page.evaluate(() => window.editorAPI?.getContent());
  expect(content).toBe(markdownEndingInCodeBlock);
});
