/**
 * @fileoverview Integration test for the phantom trailing paragraph
 * when a document ends with a fenced code block.
 *
 * In both writing and source mode, the user has no way to place the cursor
 * after a trailing code block.  The editor appends a DOM-only "phantom"
 * paragraph that is not part of the syntax tree.  When the user interacts
 * with it (clicks, types), the phantom is promoted to a real SyntaxNode.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  launchApp,
  loadContent,
  setWritingView,
} from '../../test-utils.js';

/** A tiny document that ends with a fenced code block. */
const markdownEndingInCodeBlock = `# Title\n\n\`\`\`js\nconsole.log("hi");\n\`\`\``;

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

test(`typing in the phantom paragraph promotes it to a real tree node`, async () => {
  await loadContent(page, markdownEndingInCodeBlock);
  await setWritingView(page);

  // Click the phantom to place the cursor there.
  const phantom = page.locator(`#editor > [data-is-phantom]`);
  await clickInEditor(page, phantom);
  await page.waitForTimeout(200);

  await page.keyboard.type(`New content after code block`);
  await page.waitForTimeout(200);

  // The phantom should no longer exist — it was promoted to a real node.
  await expect(page.locator(`#editor > [data-is-phantom]`)).toHaveCount(0);

  const content = await page.evaluate(() => window.editorAPI?.getContent());
  expect(content).toContain(`New content after code block`);

  // The new text should be after the closing fence in the serialised markdown.
  const fenceEnd = content?.lastIndexOf(`\`\`\``) ?? -1;
  const newText = content?.indexOf(`New content after code block`) ?? -1;
  expect(fenceEnd).toBeGreaterThan(-1);
  expect(newText).toBeGreaterThan(fenceEnd);
});
