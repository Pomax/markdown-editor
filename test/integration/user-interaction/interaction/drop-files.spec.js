/**
 * @fileoverview Integration tests for dropping files on the window.
 *
 * `app.dropFiles` emits the drag-drop event Tauri sends when files are
 * dropped on the window, at a point given in physical pixels as Tauri
 * reports it. These tests check what the page does with it: a dropped
 * image is inserted into the document, and a dropped markdown file opens
 * in a tab.
 */

import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clickInEditor, closeApp, launchApp, loadContent, projectRoot } from '../../test-utils.js';

const imagePath = path.join(projectRoot, `test`, `fixtures`, `image.png`);
const loremPath = path.join(projectRoot, `test`, `fixtures`, `lorem.md`);

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
 * The middle of the editor's first block, in physical pixels.
 * @returns {Promise<{ x: number, y: number }>}
 */
async function dropPoint() {
  const box = await page.locator(`#editor [data-node-id]`).first().boundingBox();
  if (!box) throw new Error(`editor not laid out`);
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  return { x: (box.x + box.width / 2) * ratio, y: (box.y + box.height / 2) * ratio };
}

test(`a dropped image is inserted into the document`, async () => {
  await loadContent(page, `A paragraph to drop an image after.`);
  await clickInEditor(page, page.locator(`#editor [data-node-id]`).first());
  await app.dropFiles([imagePath], await dropPoint());
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent() ?? ``))
    .toMatch(/!\[image\]\([^)]*image\.png\)/);
});

test(`a dropped markdown file opens in a tab`, async () => {
  await app.dropFiles([loremPath], await dropPoint());
  await expect(page.locator(`#tab-bar .tab-button.active .tab-label`)).toHaveText(`lorem.md`);
});
