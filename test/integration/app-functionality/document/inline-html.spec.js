/**
 * @fileoverview Integration tests for clicking and moving the caret in
 * text with inline HTML tags: clicking a <strong> or <em> element keeps
 * the line's content, and a caret placed before text after inline HTML
 * is at the same offset in source view.
 */

import { expect, test } from '@playwright/test';
import {
  END,
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

test(`clicking <strong> text does not destroy the content`, async () => {
  const markdown = `HTML <strong>bold</strong> text\n\nSecond paragraph`;
  await loadContent(page, markdown);

  await setWritingView(page);
  await page.waitForTimeout(200);

  // Defocus first: click the second paragraph.
  const secondLine = page.locator(`#editor [data-node-id]`).nth(1);
  await clickInEditor(page, secondLine);
  await page.waitForTimeout(200);

  // Now click directly on the <strong> element in the first line,
  // using discrete mouse steps so selectionchange can interleave.
  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const strong = firstLine.locator(`strong`);
  await expect(strong).toBeVisible();
  const box = await strong.boundingBox();
  if (!box) throw new Error(`strong element not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // The first line must still contain the <strong> element and its text.
  await expect(firstLine.locator(`strong`)).toBeVisible();
  const text = await firstLine.innerText();
  expect(text).toContain(`bold`);
  expect(text).toContain(`HTML`);
  expect(text).toContain(`text`);
});

test(`clicking <em> text does not destroy the content`, async () => {
  const markdown = `HTML <em>italic</em> text\n\nSecond paragraph`;
  await loadContent(page, markdown);

  await setWritingView(page);
  await page.waitForTimeout(200);

  const secondLine = page.locator(`#editor [data-node-id]`).nth(1);
  await clickInEditor(page, secondLine);
  await page.waitForTimeout(200);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const em = firstLine.locator(`em`);
  await expect(em).toBeVisible();
  const emBox = await em.boundingBox();
  if (!emBox) throw new Error(`em element not visible`);
  await page.mouse.move(emBox.x + emBox.width / 2, emBox.y + emBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(firstLine.locator(`em`)).toBeVisible();
  const text = await firstLine.innerText();
  expect(text).toContain(`italic`);
  expect(text).toContain(`HTML`);
  expect(text).toContain(`text`);
});

test(`cursor offset is correct after view-mode switch with inline HTML`, async () => {
  const markdown = `# test document\n\nIt also tests <strong>strong</strong> and <em>emphasis</em> text.`;

  await loadContent(page, markdown);

  await setWritingView(page);

  // Click on the last paragraph
  const lastLine = page.locator(`#editor [data-node-id]`).last();
  await clickInEditor(page, lastLine);
  await page.waitForTimeout(200);

  // Place cursor before "text." — End then Left×5
  await page.keyboard.press(END);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(`ArrowLeft`);
  }
  await page.waitForTimeout(100);

  // Switch to source view via toolbar toggle
  await setSource2View(page);
  await page.waitForTimeout(200);

  // Raw offset should point at "text." (index 60)
  const content = `It also tests <strong>strong</strong> and <em>emphasis</em> text.`;
  const expected = content.indexOf(`text.`);
  const actual = await page.evaluate(() => /** @type {any} */ (window).__editorCursorOffset);
  expect(actual).toBe(expected);
});
