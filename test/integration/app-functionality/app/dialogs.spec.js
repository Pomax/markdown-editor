/**
 * @fileoverview Integration tests for the backend file dialogs.
 *
 * In a test-hooks build the native Open and Save dialogs are recorded
 * with their options and answered from a stub set with
 * `setFileDialogResult`. These tests cover Save As (default name,
 * `.md` appended, the file written, a cancelled dialog changing
 * nothing), Save to the current file (no dialog), and Load (title,
 * filters, the chosen file opened, a cancelled dialog changing nothing).
 * Message boxes, the page's own `confirm` included, are recorded and
 * answered from a stub set with `setMessageBoxResponse`: the unsaved
 * changes box, About, `confirm`'s answer, and the box shown when
 * shrinking a table would drop data. The close tests each launch an app
 * of their own and close it through the normal close flow: the open files
 * are saved, and the unsaved-changes box's four answers have their
 * outcomes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  launchApp,
  loadContent,
  projectRoot,
  setWritingView,
} from '../../test-utils.js';

const TABLE_SHRINK_MESSAGE = `Reducing the table size will remove data from the deleted rows or columns. Continue?`;

const loremPath = path.join(projectRoot, `test`, `fixtures`, `lorem.md`);
const loremContent = fs.readFileSync(loremPath, `utf-8`);
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(projectRoot, `package.json`), `utf-8`),
).version;
const repository = `https://github.com/Pomax/Pomax-s-Markdown-Editor`;

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await page.waitForSelector(`#editor`);
  // The app answers the page's dialogs itself; with a listener present,
  // Playwright does not dismiss them before the app's answer arrives.
  page.on(`dialog`, () => {});
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * @param {string} content
 * @returns {Promise<{success: boolean, filePath?: string, message?: string}>}
 */
function saveAs(content) {
  return page.evaluate((text) => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    return api.saveFileAs(text);
  }, content);
}

/**
 * @param {string} content
 * @returns {Promise<{success: boolean, filePath?: string, message?: string}>}
 */
function save(content) {
  return page.evaluate((text) => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    return api.saveFile(text);
  }, content);
}

/**
 * @returns {Promise<{success: boolean, content?: string, filePath?: string, message?: string}>}
 */
function load() {
  return page.evaluate(async () => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    const result = await api.loadFile();
    if (result?.success && result.content !== undefined) {
      document.dispatchEvent(new CustomEvent(`file:loaded`, { detail: result }));
    }
    return result;
  });
}

/**
 * @returns {Promise<{success: boolean, files: string[]}>}
 */
function recentFiles() {
  return page.evaluate(() => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    return api.getRecentFiles();
  });
}

/**
 * @returns {Promise<{action: string}>}
 */
function confirmClose() {
  return page.evaluate(() => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    return api.confirmClose();
  });
}

/**
 * @returns {Promise<number>} How many message boxes have been shown.
 */
async function messageBoxCount() {
  return (await app.messageBoxes()).length;
}

/**
 * Loads a table of two rows with text in every cell, opens its edit
 * dialog and asks for one row, which would drop the second row's text.
 */
async function shrinkTableToOneRow() {
  await loadContent(
    page,
    `| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n| Cell 3 | Cell 4 |`,
  );
  await setWritingView(page);
  await clickInEditor(page, page.locator(`[data-node-id].md-table`));
  await page.locator(`[data-button-id="table"]`).click();
  await page.locator(`.table-dialog`).waitFor();
  await page.fill(`#table-rows`, `1`);
  await page.locator(`.table-btn--insert`).click();
}

/**
 * Whether the table dialog is open, and the document's markdown.
 * @returns {Promise<string>}
 */
async function tableState() {
  const dialogOpen = await page.locator(`.table-dialog`).isVisible();
  const content = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
  return JSON.stringify({ dialogOpen, content });
}

/**
 * The last message box shown.
 * @returns {Promise<any>}
 */
async function lastMessageBox() {
  const boxes = await app.messageBoxes();
  return boxes[boxes.length - 1];
}

/**
 * @param {boolean} value
 */
function setUnsaved(value) {
  return page.evaluate((modified) => {
    const editor = /** @type {any} */ (window).__editor;
    if (editor) editor.setUnsavedChanges(modified);
  }, value);
}

test(`Save As records the dialog, appends .md and writes the file`, async ({}, testInfo) => {
  const target = testInfo.outputPath(`saved-doc`);
  await app.setFileDialogResult(target);

  const result = await saveAs(`Saved through the dialog.`);
  expect(result.success).toBe(true);
  expect(result.filePath).toBe(`${target}.md`);
  expect(fs.readFileSync(`${target}.md`, `utf-8`)).toBe(`Saved through the dialog.`);

  const dialogs = await app.fileDialogs();
  const last = dialogs[dialogs.length - 1];
  expect(last.type).toBe(`save`);
  expect(last.title).toBe(`Save Markdown File`);
  expect(last.defaultPath).toBe(`untitled.md`);
  expect(last.filters).toEqual([
    { name: `Markdown Files`, extensions: [`md`] },
    { name: `All Files`, extensions: [`*`] },
  ]);
});

test(`a cancelled Save As writes nothing`, async ({}, testInfo) => {
  const target = testInfo.outputPath(`not-written`);
  await app.setFileDialogResult(null);

  const before = (await app.fileDialogs()).length;
  const result = await saveAs(`Should not be written.`);
  expect(result.success).toBe(false);
  expect(result.message).toBe(`Save canceled`);
  expect(fs.existsSync(`${target}.md`)).toBe(false);

  const after = (await app.fileDialogs()).length;
  expect(after).toBe(before + 1);
});

test(`Save writes to the current file without a dialog`, async ({}, testInfo) => {
  const target = testInfo.outputPath(`current-doc`);
  await app.setFileDialogResult(target);
  const saved = await saveAs(`First version.`);
  expect(saved.success).toBe(true);
  const currentPath = `${target}.md`;

  const before = (await app.fileDialogs()).length;
  const result = await save(`Second version.`);
  expect(result.success).toBe(true);
  expect(result.filePath).toBe(currentPath);
  expect(fs.readFileSync(currentPath, `utf-8`)).toBe(`Second version.`);

  const after = (await app.fileDialogs()).length;
  expect(after).toBe(before);
});

test(`Load records the dialog and opens the chosen file`, async () => {
  await app.setFileDialogResult(loremPath);

  const result = await load();
  expect(result.success).toBe(true);
  expect(result.filePath).toBe(loremPath);
  expect(result.content).toBe(loremContent);

  const dialogs = await app.fileDialogs();
  const last = dialogs[dialogs.length - 1];
  expect(last.type).toBe(`open`);
  expect(last.title).toBe(`Load Markdown File`);
  expect(last.filters).toEqual([
    { name: `Markdown Files`, extensions: [`md`, `markdown`] },
    { name: `All Files`, extensions: [`*`] },
  ]);
  expect(last.properties).toEqual([`openFile`]);

  const recent = await recentFiles();
  expect(recent.files).toContain(loremPath);
});

test(`a cancelled Load changes nothing`, async () => {
  await app.setFileDialogResult(loremPath);
  await load();
  const recentBefore = await recentFiles();

  await app.setFileDialogResult(null);
  const result = await load();
  expect(result.success).toBe(false);
  expect(result.message).toBe(`Load canceled`);

  const recentAfter = await recentFiles();
  expect(recentAfter.files).toEqual(recentBefore.files);
});

test(`Browse for image records the dialog and returns the chosen path`, async ({}, testInfo) => {
  const imagePath = testInfo.outputPath(`picture.png`);
  await app.setFileDialogResult(imagePath);

  const result = await page.evaluate(() => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    return api.browseForImage();
  });
  expect(result.success).toBe(true);
  expect(result.filePath).toBe(imagePath);

  const dialogs = await app.fileDialogs();
  const last = dialogs[dialogs.length - 1];
  expect(last.type).toBe(`open`);
  expect(last.title).toBe(`Select Image`);
  expect(last.filters).toEqual([
    { name: `Images`, extensions: [`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`, `ico`] },
    { name: `All Files`, extensions: [`*`] },
  ]);
  expect(last.properties).toEqual([`openFile`]);
});

test(`confirmClose records the unsaved-changes box with its options`, async () => {
  await app.setMessageBoxResponse(3);
  const result = await confirmClose();
  expect(result.action).toBe(`cancel`);

  const boxes = await app.messageBoxes();
  const last = boxes[boxes.length - 1];
  expect(last.type).toBe(`warning`);
  expect(last.title).toBe(`Unsaved Changes`);
  expect(last.message).toBe(`You have unsaved changes. What would you like to do?`);
  expect(last.buttons).toEqual([`Save`, `Save As...`, `Discard`, `Cancel`]);
  expect(last.defaultId).toBe(0);
  expect(last.cancelId).toBe(3);
});

test(`confirmClose maps each button to its action`, async () => {
  const cases = [
    [0, `save`],
    [1, `saveAs`],
    [2, `discard`],
    [3, `cancel`],
  ];
  for (const [response, action] of cases) {
    await app.setMessageBoxResponse(/** @type {number} */ (response));
    const result = await confirmClose();
    expect(result.action).toBe(action);
  }
});

test(`an unsaved tab stays on Cancel and closes on Discard`, async () => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent(`file:new`)));
  await page.waitForTimeout(300);
  const tabs = page.locator(`#tab-bar .tab-button`);
  const countBefore = await tabs.count();

  await setUnsaved(true);
  await app.setMessageBoxResponse(3);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent(`file:close`)));
  await page.waitForTimeout(300);
  expect(await tabs.count()).toBe(countBefore);

  await setUnsaved(true);
  await app.setMessageBoxResponse(2);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent(`file:close`)));
  await page.waitForTimeout(300);
  expect(await tabs.count()).toBe(countBefore - 1);
});

test(`About shows its texts and Visit GitHub opens the repository`, async () => {
  await app.recordOpenedUrls();
  await app.setMessageBoxResponse(0);
  await app.menu.click([`Help`, `About`]);
  await expect.poll(() => app.openedUrl()).toBe(repository);

  const boxes = await app.messageBoxes();
  const about = boxes[boxes.length - 1];
  expect(about.type).toBe(`info`);
  expect(about.title).toBe(`About Markdown Editor`);
  expect(about.message).toBe(`Pomax's Markdown Editor v${packageVersion}`);
  expect(about.detail).toBe(
    `This is a free, public domain open source markdown editor.\n\nVisit ${repository} for more information`,
  );
  expect(about.buttons).toEqual([`Visit GitHub`, `OK`]);
  expect(about.defaultId).toBe(1);
  expect(about.cancelId).toBe(1);

  await app.recordOpenedUrls();
  const shownBefore = await messageBoxCount();
  await app.setMessageBoxResponse(1);
  await app.menu.click([`Help`, `About`]);
  await expect.poll(() => messageBoxCount()).toBe(shownBefore + 1);
  expect(await app.openedUrl()).toBeNull();
});

test(`a page's confirm shows the app's message box and returns its answer`, async () => {
  const shownBefore = await messageBoxCount();
  await app.setMessageBoxResponse(1);
  const cancelled = await page.evaluate(() => window.confirm(`Continue?`));
  await app.setMessageBoxResponse(0);
  const accepted = await page.evaluate(() => window.confirm(`Continue?`));
  const boxes = (await messageBoxCount()) - shownBefore;
  expect({ cancelled, accepted, boxes }).toEqual({ cancelled: false, accepted: true, boxes: 2 });
});

test(`shrinking a table asks with OK and Cancel, and OK shrinks it`, async () => {
  await app.setMessageBoxResponse(0);
  const shownBefore = await messageBoxCount();
  await shrinkTableToOneRow();
  const state = await tableState();
  await expect.poll(() => messageBoxCount(), { message: state }).toBe(shownBefore + 1);

  const box = await lastMessageBox();
  expect(box.message).toBe(TABLE_SHRINK_MESSAGE);
  expect(box.buttons).toEqual([`OK`, `Cancel`]);
  expect(box.defaultId).toBe(0);
  expect(box.cancelId).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent() ?? ``))
    .not.toContain(`Cell 3`);
});

test(`shrinking a table and choosing Cancel keeps the table`, async () => {
  await app.setMessageBoxResponse(1);
  const shownBefore = await messageBoxCount();
  await shrinkTableToOneRow();
  const state = await tableState();
  await expect.poll(() => messageBoxCount(), { message: state }).toBe(shownBefore + 1);

  const box = await lastMessageBox();
  expect(box.message).toBe(TABLE_SHRINK_MESSAGE);
  expect(box.buttons).toEqual([`OK`, `Cancel`]);
  expect(await page.evaluate(() => window.editorAPI?.getContent() ?? ``)).toContain(`Cell 3`);
  await page.locator(`.table-btn--cancel`).click();
});

/** The text the close tests change their document to. */
const CHANGED = `Changed before closing.`;

/**
 * Launches an app of its own with the given file, or a new document, and
 * changes its text without saving it.
 * @param {string} [filePath]
 */
async function launchUnsaved(filePath) {
  const launched = await launchApp(filePath ? [filePath] : []);
  if (filePath) {
    await launched.page.waitForFunction(() => (window.editorAPI?.getContent() ?? ``).length > 0);
  }
  await launched.page.evaluate(async (text) => {
    await window.editorAPI?.setContent(text);
    /** @type {any} */ (window).__editor?.setUnsavedChanges(true);
  }, CHANGED);
  return launched;
}

/**
 * Whether the app still has its window; an app that has exited has none.
 * @param {import('../../tauri-app.js').TauriApp} closing
 * @returns {Promise<boolean>}
 */
async function windowOpen(closing) {
  return (await closing.windowCount().catch(() => 0)) > 0;
}

test(`closing with no unsaved changes saves the open files and closes`, async ({}, testInfo) => {
  const filePath = testInfo.outputPath(`open-when-closed.md`);
  fs.writeFileSync(filePath, loremContent);
  const first = await launchApp([filePath]);
  await first.page.waitForFunction(() => (window.editorAPI?.getContent() ?? ``).length > 0);
  await first.app.requestClose({ testing: false });
  await expect.poll(() => windowOpen(first.app)).toBe(false);

  const second = await launchApp();
  try {
    const openFiles = await second.app.settings.get(`openFiles`);
    expect(openFiles.map((/** @type {any} */ entry) => entry.filePath)).toEqual([filePath]);
  } finally {
    await closeApp(second.app);
  }
});

test(`closing with unsaved changes and choosing Discard closes without saving`, async ({}, testInfo) => {
  const filePath = testInfo.outputPath(`discarded.md`);
  fs.writeFileSync(filePath, loremContent);
  const closing = await launchUnsaved(filePath);
  await closing.app.setMessageBoxResponse(2);
  await closing.app.requestClose({ testing: false });
  await expect.poll(() => windowOpen(closing.app)).toBe(false);
  expect(fs.readFileSync(filePath, `utf-8`)).toBe(loremContent);
});

test(`closing with unsaved changes and choosing Cancel keeps the window and the changes`, async ({}, testInfo) => {
  const filePath = testInfo.outputPath(`kept.md`);
  fs.writeFileSync(filePath, loremContent);
  const closing = await launchUnsaved(filePath);
  try {
    await closing.app.setMessageBoxResponse(3);
    await closing.app.requestClose({ testing: false });
    await expect.poll(async () => (await closing.app.messageBoxes()).length).toBe(1);
    const box = (await closing.app.messageBoxes())[0];
    expect(box.title).toBe(`Unsaved Changes`);
    expect(box.buttons).toEqual([`Save`, `Save As...`, `Discard`, `Cancel`]);
    expect(await windowOpen(closing.app)).toBe(true);
    expect(await closing.page.evaluate(() => window.editorAPI?.getContent())).toBe(CHANGED);
    expect(fs.readFileSync(filePath, `utf-8`)).toBe(loremContent);
  } finally {
    await closeApp(closing.app);
  }
});

test(`closing with unsaved changes and choosing Save writes the file and closes`, async ({}, testInfo) => {
  const filePath = testInfo.outputPath(`saved-on-close.md`);
  fs.writeFileSync(filePath, loremContent);
  const closing = await launchUnsaved(filePath);
  await closing.app.setMessageBoxResponse(0);
  await closing.app.requestClose({ testing: false });
  await expect.poll(() => windowOpen(closing.app)).toBe(false);
  expect(fs.readFileSync(filePath, `utf-8`)).toBe(CHANGED);
});

test(`closing a new document with unsaved changes and choosing Save As writes it where chosen and closes`, async ({}, testInfo) => {
  const target = testInfo.outputPath(`saved-as-on-close`);
  const closing = await launchUnsaved();
  await closing.app.setFileDialogResult(target);
  await closing.app.setMessageBoxResponse(1);
  await closing.app.requestClose({ testing: false });
  await expect.poll(() => windowOpen(closing.app)).toBe(false);
  expect(fs.readFileSync(`${target}.md`, `utf-8`)).toBe(CHANGED);
});
