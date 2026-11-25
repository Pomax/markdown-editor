/**
 * @fileoverview An image put in through the image dialog with the real
 * mouse and keyboard is shown: Ctrl+Shift+I opens the dialog, a click on
 * Browse picks the image (the test build answers the file dialog from
 * its stub), a click on Insert puts it in the document, and the image
 * the editor shows has loaded. The line of an image that does not load,
 * reached with the right arrow key from the end of the line above it and
 * selected with Shift+Home, is an empty paragraph after Delete.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closeApp,
  launchApp,
  loadContent,
  projectRoot,
  setSource2View,
  setWritingView,
} from '../integration/test-utils.js';
import { clientPoint, runner } from './runner.js';

test.skip(process.platform !== `win32`, `the Windows runner sends input on Windows only`);

/** @type {import('../integration/tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp([], { visible: true }));
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * Brings the app to the front and clicks the middle of an element with
 * the real mouse.
 * @param {import('@playwright/test').Locator} locator
 */
async function click(locator) {
  runner(`focus`, app.pid);
  const point = await clientPoint(locator);
  runner(`click`, app.pid, point.x, point.y);
}

test(`an image picked with Browse and put in with Insert is shown`, async ({}, testInfo) => {
  const imagePath = testInfo.outputPath(`picture.png`);
  fs.copyFileSync(path.join(projectRoot, `test`, `fixtures`, `image.png`), imagePath);
  await app.setFileDialogResult(imagePath);
  await loadContent(page, `picture`);
  await click(page.locator(`#editor [data-node-id]`).first());
  runner(`keys`, app.pid, `End`, `Control+Shift+I`);
  await expect(page.locator(`.image-dialog[open]`)).toHaveCount(1);
  await click(page.locator(`.image-browse-btn`));
  await expect(page.locator(`#image-src`)).toHaveValue(imagePath);
  await click(page.locator(`.image-btn--insert`));
  await expect(page.locator(`.image-dialog[open]`)).toHaveCount(0);
  const image = page.locator(`#editor img`);
  await expect(image).toHaveCount(1);
  await expect
    .poll(() => image.evaluate((/** @type {HTMLImageElement} */ img) => img.naturalWidth))
    .toBeGreaterThan(0);
});

test(`the line of an image that does not load, selected with Shift+Home, is an empty paragraph after Delete`, async () => {
  await setSource2View(page);
  await loadContent(page, `text\n\n![A screenshot of the editor](./nonsensefilename12345.png)\n\n`);
  await setWritingView(page);
  await page.evaluate(() => {
    const text = /** @type {any} */ (window).__editor.syntaxTree.children[0];
    window.editorAPI?.placeCursorAtNode(text.id, text.content.length);
  });
  runner(`focus`, app.pid);
  runner(`keys`, app.pid, `ArrowRight`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const line = document.querySelector(`#editor .md-image`);
        const selection = window.getSelection();
        return !!line && !!selection?.isCollapsed && line.contains(selection.anchorNode);
      }),
    )
    .toBe(true);
  runner(`keys`, app.pid, `Shift+Home`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const line = document.querySelector(`#editor .md-image`);
        const img = line?.querySelector(`img`);
        const selection = window.getSelection();
        if (!line || !img || !selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        return (
          line.contains(range.startContainer) &&
          line.contains(range.endContainer) &&
          selection.containsNode(img)
        );
      }),
    )
    .toBe(true);
  runner(`keys`, app.pid, `Delete`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const line = /** @type {any} */ (window).__editor.syntaxTree.children[1];
        return { type: line?.type, content: line?.content };
      }),
    )
    .toEqual({ type: `paragraph`, content: `` });
});
