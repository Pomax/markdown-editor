/**
 * @fileoverview Browser test for the trailing-paragraph invariant: when a
 * document ends with a `</details>` html-block, the editor appends an
 * empty paragraph after it.
 */

import { expect, test } from '@playwright/test';
import { loadContent, openServedPage, setWritingView } from '../integration/test-utils.js';

/** A tiny document that ends with </details>. */
const markdownEndingInDetails = `# Title\n\n<details>\n\n<summary>Summary</summary>\n\nbody\n\n</details>`;

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

test(`loading a document that ends in </details> appends an empty paragraph`, async () => {
  await loadContent(page, markdownEndingInDetails);
  await setWritingView(page);

  // The tree should have an extra empty paragraph after the details block.
  // We can't rely on getContent() because an empty paragraph serialises
  // to nothing, so instead check the DOM: the last top-level [data-node-id]
  // should be an empty paragraph, not the html-block.
  const lastLine = page.locator(`#editor > [data-node-id]`).last();
  const classList = await lastLine.evaluate((el) => [...el.classList]);
  expect(classList).not.toContain(`html-element`);

  // And it should be empty (no visible text).
  const text = await lastLine.innerText();
  expect(text.trim()).toBe(``);
});
