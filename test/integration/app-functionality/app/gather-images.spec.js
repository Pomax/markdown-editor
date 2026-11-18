/**
 * @fileoverview Integration tests for Edit > Images > Gather.
 *
 * Each test works in its own folders inside the test's output folder: an
 * unsaved document is asked to be saved first; an image outside the
 * document's folder is copied in and its reference rewritten; a name
 * already taken by a different file gets the `-2` suffix; and a document
 * whose images are already relative gets the nothing-to-gather box.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent } from '../../test-utils.js';

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await page.waitForSelector(`#editor`);
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * Saves the active document to a path through File > Save As....
 * @param {string} filePath
 */
async function saveDocumentAs(filePath) {
  await app.setFileDialogResult(filePath);
  await app.menu.click([`File`, `Save As...`]);
  await expect.poll(() => fs.existsSync(filePath)).toBe(true);
}

/**
 * @returns {Promise<any>} The last message box shown.
 */
async function lastMessageBox() {
  const boxes = await app.messageBoxes();
  return boxes[boxes.length - 1];
}

/**
 * @returns {Promise<string | undefined>} The last message box's message.
 */
async function lastMessage() {
  return (await lastMessageBox())?.message;
}

/**
 * @returns {Promise<string>} The document's markdown.
 */
function editorContent() {
  return page.evaluate(() => window.editorAPI?.getContent() ?? ``);
}

/**
 * Chooses Edit > Images > Gather, confirming the gather.
 */
async function gather() {
  await app.setMessageBoxResponse(1);
  await app.menu.click([`Edit`, `Images`, `Gather`]);
}

test(`asks to save an unsaved document first`, async () => {
  await loadContent(page, `![pic](pic.png)\n`);
  await app.setMessageBoxResponse(0);
  await app.menu.click([`Edit`, `Images`, `Gather`]);

  await expect.poll(() => lastMessage()).toBe(`Please save your document first`);
  const box = await lastMessageBox();
  expect(box.type).toBe(`info`);
  expect(box.title).toBe(`Gather Images`);
  expect(box.buttons).toEqual([`Cancel`, `Save`]);
  expect(box.defaultId).toBe(1);
  expect(box.cancelId).toBe(0);
});

test(`copies an outside image into the document folder and rewrites it`, async ({}, testInfo) => {
  const docDir = testInfo.outputPath(`doc`);
  const outsideDir = testInfo.outputPath(`outside`);
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideImage = path.join(outsideDir, `pic.png`);
  fs.writeFileSync(outsideImage, `image bytes`);

  await loadContent(page, `![pic](${pathToFileURL(outsideImage).href})\n`);
  await saveDocumentAs(path.join(docDir, `doc.md`));
  await gather();

  await expect.poll(() => lastMessage()).toBe(`Gathered 1 image`);
  expect(fs.readFileSync(path.join(docDir, `pic.png`), `utf-8`)).toBe(`image bytes`);
  await expect.poll(() => editorContent()).toContain(`![pic](pic.png)`);
});

test(`names the copy -2 when the name is taken by a different file`, async ({}, testInfo) => {
  const docDir = testInfo.outputPath(`doc`);
  const outsideDir = testInfo.outputPath(`outside`);
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, `pic.png`), `x`);
  const outsideImage = path.join(outsideDir, `pic.png`);
  fs.writeFileSync(outsideImage, `a different, longer image`);

  await loadContent(page, `![pic](${pathToFileURL(outsideImage).href})\n`);
  await saveDocumentAs(path.join(docDir, `doc.md`));
  await gather();

  await expect.poll(() => lastMessage()).toBe(`Gathered 1 image`);
  expect(fs.readFileSync(path.join(docDir, `pic-2.png`), `utf-8`)).toBe(
    `a different, longer image`,
  );
  expect(fs.readFileSync(path.join(docDir, `pic.png`), `utf-8`)).toBe(`x`);
  await expect.poll(() => editorContent()).toContain(`![pic](pic-2.png)`);
});

test(`shows the nothing-to-gather box when every image is relative`, async ({}, testInfo) => {
  const docDir = testInfo.outputPath(`doc`);
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, `pic.png`), `image bytes`);

  await loadContent(page, `![pic](pic.png)\n`);
  await saveDocumentAs(path.join(docDir, `doc.md`));
  await gather();

  await expect.poll(() => lastMessage()).toBe(`Nothing to gather`);
  const box = await lastMessageBox();
  expect(box.detail).toBe(`All images are already relative to the document.`);
  expect(box.buttons).toEqual([`OK`]);
});
