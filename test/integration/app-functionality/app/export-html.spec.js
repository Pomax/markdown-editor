/**
 * @fileoverview Integration test for File > Export > HTML.
 *
 * Exporting writes `<name>.html` and `default.css` next to the loaded
 * markdown file, asking nothing when there is no such HTML file yet. The
 * HTML declares utf-8, uses the document's first heading as its title,
 * and links the stylesheet. An image written with a relative path keeps
 * that path in the export, whatever URL the page loaded it through. When
 * the HTML file exists, a box asks whether to replace it: Cancel writes
 * nothing, Replace writes both files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

const fixturesDir = path.join(projectRoot, `test`, `fixtures`);
const markdownFile = path.join(fixturesDir, `lorem.md`);
const htmlFile = path.join(fixturesDir, `lorem.html`);
const cssFile = path.join(fixturesDir, `default.css`);
const imagesFile = path.join(fixturesDir, `images.md`);
const imagesHtmlFile = path.join(fixturesDir, `images.html`);

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  await fs.rm(htmlFile, { force: true });
  ({ app, page } = await launchApp([markdownFile]));
  await page.waitForSelector(`#editor [data-node-id]`);
});

test.afterAll(async () => {
  await closeApp(app);
  await fs.rm(htmlFile, { force: true });
  await fs.rm(cssFile, { force: true });
  await fs.rm(imagesHtmlFile, { force: true });
});

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a markdown file in a tab of its own, as File > Load does.
 * @param {string} file
 */
async function openFile(file) {
  await page.evaluate(async (filePath) => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    const result = await api.loadFilePath(filePath);
    if (result?.success) document.dispatchEvent(new CustomEvent(`file:loaded`, { detail: result }));
  }, file);
  await expect(page.locator(`#tab-bar .tab-button.active .tab-label`)).toHaveText(
    path.basename(file),
  );
}

/**
 * @returns {Promise<number>} How many message boxes have been shown.
 */
async function messageBoxCount() {
  return (await app.messageBoxes()).length;
}

/** The content of an HTML file that was there before the export. */
const OLD_EXPORT = `<p>an earlier export</p>`;

/**
 * A markdown file in the test's output folder, with an HTML file of the
 * same name already next to it.
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} name - The file name without its extension.
 */
async function documentWithExport(testInfo, name) {
  const markdown = testInfo.outputPath(`${name}.md`);
  const html = testInfo.outputPath(`${name}.html`);
  const css = testInfo.outputPath(`default.css`);
  await fs.copyFile(markdownFile, markdown);
  await fs.writeFile(html, OLD_EXPORT);
  return { markdown, html, css };
}

/**
 * The box that asks whether to replace an HTML file.
 * @param {string} fileName
 */
function replaceBox(fileName) {
  return {
    type: `warning`,
    title: `Export HTML`,
    message: `${fileName} already exists. Do you want to replace it?`,
    buttons: [`Replace`, `Cancel`],
    defaultId: 0,
    cancelId: 1,
  };
}

test(`export writes the HTML and default.css next to the markdown file`, async () => {
  // Record the path handed to the OS file browser instead of opening it.
  await app.recordRevealedItems();
  const shownBefore = await messageBoxCount();

  await app.sendMenuAction(`file:exportHtml`);

  await expect.poll(() => exists(htmlFile), { timeout: 5000 }).toBe(true);
  await expect.poll(() => exists(cssFile), { timeout: 5000 }).toBe(true);
  expect(await messageBoxCount()).toBe(shownBefore);

  const html = await fs.readFile(htmlFile, `utf-8`);
  expect(html.startsWith(`<!DOCTYPE html>`)).toBe(true);
  expect(html).toContain(`<meta charset="utf-8">`);
  expect(html).toContain(`<title>Lorem Ipsum</title>`);
  expect(html).toContain(`<link rel="stylesheet" href="default.css">`);
  expect(html).toContain(`class="editor writing-view"`);
  expect(html).toContain(`class="md-heading2"`);
  expect(html).toContain(`Main text`);
  expect(html).not.toContain(`contenteditable="true"`);

  const css = await fs.readFile(cssFile, `utf-8`);
  expect(css).toContain(`.editor {`);
  expect(css).toContain(`.writing-view {`);
  expect(css).toContain(`--page-max-width`);

  const shownItem = await app.revealedItem();
  expect(shownItem).toBe(htmlFile);
});

test(`export keeps the relative src of images`, async () => {
  await fs.rm(imagesHtmlFile, { force: true });
  await openFile(imagesFile);

  await app.sendMenuAction(`file:exportHtml`);

  await expect.poll(() => exists(imagesHtmlFile), { timeout: 5000 }).toBe(true);
  const html = await fs.readFile(imagesHtmlFile, `utf-8`);
  const sources = [...html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((match) => match[1]);
  expect(sources).toEqual([`image.png`, `image.png`]);
});

test(`export asks before replacing an existing HTML file, and Cancel writes nothing`, async ({}, testInfo) => {
  const { markdown, html, css } = await documentWithExport(testInfo, `cancelled`);
  await openFile(markdown);
  const shownBefore = await messageBoxCount();
  await app.setMessageBoxResponse(1);

  await app.sendMenuAction(`file:exportHtml`);

  await expect.poll(messageBoxCount).toBe(shownBefore + 1);
  expect((await app.messageBoxes()).at(-1)).toMatchObject(replaceBox(`cancelled.html`));
  await page.waitForTimeout(500);
  expect(await fs.readFile(html, `utf-8`)).toBe(OLD_EXPORT);
  expect(await exists(css)).toBe(false);
});

test(`export replaces an existing HTML file when told to`, async ({}, testInfo) => {
  const { markdown, html, css } = await documentWithExport(testInfo, `replaced`);
  await openFile(markdown);
  const shownBefore = await messageBoxCount();
  await app.setMessageBoxResponse(0);

  await app.sendMenuAction(`file:exportHtml`);

  await expect.poll(messageBoxCount).toBe(shownBefore + 1);
  expect((await app.messageBoxes()).at(-1)).toMatchObject(replaceBox(`replaced.html`));
  await expect
    .poll(() => fs.readFile(html, `utf-8`), { timeout: 5000 })
    .toContain(`<title>Lorem Ipsum</title>`);
  expect(await exists(css)).toBe(true);
});
