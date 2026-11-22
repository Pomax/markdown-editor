/**
 * @fileoverview Integration tests for the application menu.
 *
 * Compares the built menu tree with the expected template with no file open, with a file open, and
 * with two files open and recent files present; checks that only the six
 * Edit shortcuts the page handles itself are left unregistered; checks
 * that typing changes nothing in the native menu and that opening or
 * closing a tab changes only the entries that differ; and checks the
 * effect of choosing each item.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  launchApp,
  loadContent,
  projectRoot,
  setWritingView,
} from '../../test-utils.js';

const loremPath = path.join(projectRoot, `test`, `fixtures`, `lorem.md`);
const readmePath = path.join(projectRoot, `README.md`);

/**
 * The Edit shortcuts the page handles itself, which the menu
 * order lets the page see first on Windows and Linux.
 * @type {string[]}
 */
const PAGE_HANDLED = [
  `CmdOrCtrl+Z`,
  `CmdOrCtrl+Y`,
  `CmdOrCtrl+X`,
  `CmdOrCtrl+C`,
  `CmdOrCtrl+V`,
  `CmdOrCtrl+A`,
];

/**
 * @typedef {object} MenuEntry
 * @property {string} [label]
 * @property {string} [accelerator]
 * @property {boolean} [registered]
 * @property {boolean} [enabled]
 * @property {boolean} [checked]
 * @property {string} [type]
 * @property {MenuEntry[]} [submenu]
 */

/** @type {MenuEntry} */
const SEPARATOR = { type: `separator` };

/** The Edit menu's preferences item (`PREFERENCES_LABEL` in menu_builder.rs). */
const PREFERENCES = process.platform === `darwin` ? `Settings…` : `Preferences`;

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
 * An enabled item, with or without an accelerator.
 * @param {string} label
 * @param {string} [accelerator]
 * @returns {MenuEntry}
 */
function item(label, accelerator) {
  return accelerator ? { label, accelerator, enabled: true } : { label, enabled: true };
}

/**
 * An enabled submenu.
 * @param {string} label
 * @param {MenuEntry[]} entries
 * @returns {MenuEntry}
 */
function submenu(label, entries) {
  return { label, enabled: true, submenu: entries };
}

/**
 * The menu expected for the given state.
 * @param {{ filePath?: string, recentFiles: string[], openFiles: { label: string, active: boolean }[] }} state
 * @returns {MenuEntry[]}
 */
function expectedMenuTemplate({ filePath, recentFiles, openFiles }) {
  const recent =
    recentFiles.length === 0
      ? [{ label: `No Recent Files`, enabled: false }]
      : [...recentFiles.map((file) => item(file)), SEPARATOR, item(`Clear Recent`)];
  const view = [item(`Writing View`, `CmdOrCtrl+1`), item(`Source View`, `CmdOrCtrl+2`)];
  if (openFiles.length > 0) {
    view.push(SEPARATOR);
    for (const file of openFiles) {
      view.push({ label: file.label, type: `checkbox`, checked: file.active, enabled: true });
    }
  }
  return [
    submenu(`File`, [
      item(`New`, `CmdOrCtrl+N`),
      item(`Load...`, `CmdOrCtrl+O`),
      submenu(`Open Recent`, recent),
      SEPARATOR,
      item(`Save`, `CmdOrCtrl+S`),
      item(`Save As...`, `CmdOrCtrl+Shift+S`),
      submenu(`Export`, [item(`HTML`)]),
      SEPARATOR,
      item(`Close`, `CmdOrCtrl+W`),
      SEPARATOR,
      submenu(`Restructure`, [item(`Headings`)]),
      submenu(`Utilities`, [item(`Word Count`), { label: `Copy File Path`, enabled: !!filePath }]),
      SEPARATOR,
      item(`Exit`, process.platform === `darwin` ? `Cmd+Q` : `Alt+F4`),
    ]),
    submenu(`Edit`, [
      item(`Undo`, `CmdOrCtrl+Z`),
      item(`Redo`, `CmdOrCtrl+Y`),
      SEPARATOR,
      item(`Cut`, `CmdOrCtrl+X`),
      item(`Copy`, `CmdOrCtrl+C`),
      item(`Paste`, `CmdOrCtrl+V`),
      SEPARATOR,
      item(`Select All`, `CmdOrCtrl+A`),
      SEPARATOR,
      submenu(`Images`, [item(`Gather`)]),
      SEPARATOR,
      item(PREFERENCES, `CmdOrCtrl+,`),
    ]),
    submenu(`View`, view),
    submenu(`Help`, [
      item(`Reload`, `CmdOrCtrl+Shift+R`),
      SEPARATOR,
      item(`Debug`, `F12`),
      SEPARATOR,
      item(`About`),
    ]),
  ];
}

/**
 * The menu tree as it is shown, without the registration flags.
 * @param {MenuEntry[]} entries
 * @returns {MenuEntry[]}
 */
function shown(entries) {
  return entries.map((entry) => shownEntry(entry));
}

/**
 * One entry as it is shown, without its registration flag.
 * @param {MenuEntry} entry
 * @returns {MenuEntry}
 */
function shownEntry(entry) {
  const { registered, submenu: children, ...rest } = entry;
  return children ? { ...rest, submenu: shown(children) } : rest;
}

/**
 * Every item that has an accelerator, with whether it is registered.
 * @param {MenuEntry[]} entries
 * @param {{ accelerator: string, registered: boolean }[]} [found]
 * @returns {{ accelerator: string, registered: boolean }[]}
 */
function acceleratorsOf(entries, found = []) {
  for (const entry of entries) {
    if (entry.submenu) acceleratorsOf(entry.submenu, found);
    else if (entry.accelerator) {
      found.push({ accelerator: entry.accelerator, registered: entry.registered === true });
    }
  }
  return found;
}

/**
 * The open files as the tab bar shows them, which is what the renderer
 * reports for the View menu.
 * @returns {Promise<{ label: string, active: boolean }[]>}
 */
function openFilesFromTabBar() {
  return page.evaluate(() =>
    [...document.querySelectorAll(`#tab-bar .tab-button`)].map((button) => ({
      label: button.querySelector(`.tab-label`)?.textContent ?? ``,
      active: button.classList.contains(`active`),
    })),
  );
}

/**
 * Has the renderer report its open files now and waits until the
 * backend has handled the report.
 */
async function flushOpenFiles() {
  await page.evaluate(() => /** @type {any} */ (window).__flushOpenFiles?.());
}

/**
 * Loads a file by path the way a dropped or recent file is loaded.
 * @param {string} filePath
 */
async function openFile(filePath) {
  await page.evaluate(async (file) => {
    const api = window.pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    const result = await api.loadFilePath(file);
    if (result?.success) document.dispatchEvent(new CustomEvent(`file:loaded`, { detail: result }));
  }, filePath);
}

/**
 * The label of the active tab.
 */
function activeTabLabel() {
  return page.locator(`#tab-bar .tab-button.active .tab-label`);
}

/**
 * @returns {Promise<string>} The document's markdown.
 */
function editorContent() {
  return page.evaluate(() => window.editorAPI?.getContent() ?? ``);
}

/**
 * @returns {Promise<string>} The current selection's text.
 */
function selectionText() {
  return page.evaluate(() => window.getSelection()?.toString() ?? ``);
}

/**
 * @returns {Promise<string[]>} The recent files list.
 */
async function recentFiles() {
  const result = await page.evaluate(() => window.pageToBackendBridge?.getRecentFiles());
  return result?.files ?? [];
}

/**
 * Whether the page still carries a marker set before a reload.
 * @returns {Promise<boolean>}
 */
function hasReloadMarker() {
  return page.evaluate(() => /** @type {any} */ (window).__beforeReload === true).catch(() => true);
}

/**
 * Longer than the 500 ms the renderer waits after a selection change
 * before it reports its open files.
 */
const CURSOR_REPORT_WAIT = 600;

/**
 * Waits until the renderer has reported its open files after the last
 * selection change and the backend has handled the report.
 */
async function settle() {
  await page.waitForTimeout(CURSOR_REPORT_WAIT);
  await flushOpenFiles();
}

/**
 * Loads a one-line document in writing view and puts the cursor at the
 * end of the line.
 */
async function cursorAtEnd() {
  await loadContent(page, `Start`);
  await setWritingView(page);
  await clickInEditor(page, page.locator(`#editor [data-node-id]`).first());
  await page.keyboard.press(`End`);
  await settle();
}

/**
 * How many entries differ between two menu trees, comparing the entries
 * at each position and looking inside submenus that kept their label.
 * @param {MenuEntry[]} before
 * @param {MenuEntry[]} after
 * @returns {number}
 */
function changedEntries(before, after) {
  let count = 0;
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const old = before[index];
    const entry = after[index];
    if (old?.submenu && entry?.submenu && old.label === entry.label) {
      count += old.enabled === entry.enabled ? 0 : 1;
      count += changedEntries(old.submenu, entry.submenu);
    } else if (!isDeepStrictEqual(old, entry)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Asserts the built menu matches the expected template for the state,
 * waiting for the menu to be rebuilt, and showing how they differ when
 * it never matches.
 * @param {string | undefined} filePath
 * @param {string[]} files
 */
async function expectMenuToMatch(filePath, files) {
  await flushOpenFiles();
  await expect(async () => {
    const openFiles = await openFilesFromTabBar();
    expect(shown(await app.menu.items())).toEqual(
      expectedMenuTemplate({ filePath, recentFiles: files, openFiles }),
    );
  }).toPass({ timeout: 5_000 });
}

test(`the menu matches the expected template with no file open`, async () => {
  await expectMenuToMatch(undefined, []);
});

test(`only the six page-handled Edit shortcuts are left unregistered`, async () => {
  const accelerators = acceleratorsOf(await app.menu.items());
  const unregistered = accelerators
    .filter((entry) => !entry.registered)
    .map((entry) => entry.accelerator);
  const expected = process.platform === `darwin` ? [] : PAGE_HANDLED;
  expect(unregistered.sort()).toEqual([...expected].sort());
  expect(accelerators.filter((entry) => entry.registered).length).toBe(
    accelerators.length - expected.length,
  );
});

test(`New adds a tab and Close removes it`, async () => {
  const tabs = page.locator(`#tab-bar .tab-button`);
  const before = await tabs.count();
  await app.menu.click([`File`, `New`]);
  await expect(tabs).toHaveCount(before + 1);
  await app.menu.click([`File`, `Close`]);
  await expect(tabs).toHaveCount(before);
});

test(`Writing View and Source View switch the view mode`, async () => {
  const editor = page.locator(`#editor`);
  await app.menu.click([`View`, `Source View`]);
  await expect(editor).toHaveAttribute(`data-view-mode`, `source2`);
  await app.menu.click([`View`, `Writing View`]);
  await expect(editor).toHaveAttribute(`data-view-mode`, `writing`);
});

test(`Preferences and Word Count open their dialogs`, async () => {
  await app.menu.click([`Edit`, PREFERENCES]);
  await expect(page.locator(`dialog.preferences-dialog`)).toBeVisible();
  await page.keyboard.press(`Escape`);
  await expect(page.locator(`dialog.preferences-dialog`)).toBeHidden();

  await app.menu.click([`File`, `Utilities`, `Word Count`]);
  await expect(page.locator(`dialog.word-count-dialog`)).toBeVisible();
  await page.keyboard.press(`Escape`);
  await expect(page.locator(`dialog.word-count-dialog`)).toBeHidden();
});

test(`Restructure Headings renumbers the headings`, async () => {
  await loadContent(page, `## Second\n\nSome text\n\n### Third`);
  await setWritingView(page);
  await app.menu.click([`File`, `Restructure`, `Headings`]);
  await expect.poll(() => editorContent()).toMatch(/^# Second$/m);
  expect(await editorContent()).toMatch(/^## Third$/m);
});

test(`Undo and Redo undo and redo an edit`, async () => {
  await loadContent(page, `Start`);
  await setWritingView(page);
  await clickInEditor(page, page.locator(`#editor [data-node-id]`).first());
  await page.keyboard.press(`End`);
  await page.keyboard.type(` more`);
  await expect.poll(() => editorContent()).toContain(`Start more`);
  const edited = await editorContent();

  await app.menu.click([`Edit`, `Undo`]);
  await expect.poll(() => editorContent()).not.toBe(edited);
  await app.menu.click([`Edit`, `Redo`]);
  await expect.poll(() => editorContent()).toBe(edited);
});

test(`Select All selects the editor's content`, async () => {
  await loadContent(page, `Alpha beta gamma`);
  await setWritingView(page);
  await clickInEditor(page, page.locator(`#editor [data-node-id]`).first());
  await app.menu.click([`Edit`, `Select All`]);
  await expect.poll(() => selectionText()).toContain(`Alpha beta gamma`);
});

test(`Cut, Copy and Paste send their keystrokes`, async () => {
  await app.menu.click([`Edit`, `Cut`]);
  await app.menu.click([`Edit`, `Copy`]);
  await app.menu.click([`Edit`, `Paste`]);
  const sent = await app.sentKeystrokes();
  expect(sent.slice(-3)).toEqual([`Ctrl+X`, `Ctrl+C`, `Ctrl+V`]);
});

test(`typing a letter changes nothing in the menu`, async () => {
  await cursorAtEnd();
  await app.menu.changes();
  await page.keyboard.type(`a`);
  await expect.poll(() => editorContent()).toContain(`Starta`);
  await settle();
  expect(await app.menu.changes()).toBe(0);
});

test(`opening and closing a tab changes only the menu entries that differ`, async () => {
  const tabs = page.locator(`#tab-bar .tab-button`);
  const before = await tabs.count();
  await settle();
  /** @type {MenuEntry[]} */
  const withoutTab = await app.menu.items();
  await app.menu.changes();
  await app.menu.click([`File`, `New`]);
  await expect(tabs).toHaveCount(before + 1);
  await settle();
  /** @type {MenuEntry[]} */
  const withTab = await app.menu.items();
  const opened = changedEntries(withoutTab, withTab);
  expect(opened).toBeGreaterThan(0);
  expect(await app.menu.changes()).toBe(opened);

  await app.menu.click([`File`, `Close`]);
  await expect(tabs).toHaveCount(before);
  await settle();
  const closed = changedEntries(withTab, await app.menu.items());
  expect(closed).toBeGreaterThan(0);
  expect(await app.menu.changes()).toBe(closed);
});

test(`Debug opens DevTools`, async () => {
  await app.menu.click([`Help`, `Debug`]);
  await expect.poll(() => app.isDevtoolsOpen()).toBe(true);
});

test(`the menu matches the expected template with a file open`, async () => {
  await openFile(loremPath);
  await expect(activeTabLabel()).toHaveText(`lorem.md`);
  await expectMenuToMatch(loremPath, [loremPath]);
});

test(`the menu matches the expected template with two files and recent files`, async () => {
  await openFile(readmePath);
  await expect(activeTabLabel()).toHaveText(`README.md`);
  await expectMenuToMatch(readmePath, [readmePath, loremPath]);

  /** @type {MenuEntry[]} */
  const items = await app.menu.items();
  const view = items.find((entry) => entry.label === `View`)?.submenu ?? [];
  const checked = view.filter((entry) => entry.type === `checkbox` && entry.checked);
  expect(checked.map((entry) => entry.label)).toEqual([`README.md`]);
});

test(`a View file entry switches tab`, async () => {
  await app.menu.click([`View`, `lorem.md`]);
  await expect(activeTabLabel()).toHaveText(`lorem.md`);
});

test(`an Open Recent entry opens its file`, async () => {
  await app.menu.click([`File`, `Open Recent`, readmePath]);
  await expect(activeTabLabel()).toHaveText(`README.md`);
});

test(`Clear Recent empties the recent files list`, async () => {
  await app.menu.click([`File`, `Open Recent`, `Clear Recent`]);
  await expect.poll(() => recentFiles()).toEqual([]);
  /** @type {MenuEntry[]} */
  const items = await app.menu.items();
  const file = items.find((entry) => entry.label === `File`)?.submenu ?? [];
  const recent = file.find((entry) => entry.label === `Open Recent`)?.submenu;
  expect(recent).toEqual([{ label: `No Recent Files`, enabled: false }]);
});

test(`Export writes the HTML next to the document`, async ({}, testInfo) => {
  const target = testInfo.outputPath(`exported`);
  await app.setFileDialogResult(target);
  await app.menu.click([`File`, `Save As...`]);
  await expect.poll(() => fs.existsSync(`${target}.md`)).toBe(true);

  await app.menu.click([`File`, `Export`, `HTML`]);
  await expect.poll(() => fs.existsSync(`${target}.html`)).toBe(true);
});

test(`Reload reloads the page`, async () => {
  await page.evaluate(() => {
    /** @type {any} */ (window).__beforeReload = true;
  });
  await app.menu.click([`Help`, `Reload`]);
  await expect.poll(() => hasReloadMarker()).toBe(false);
  await page.waitForFunction(() => !!window.editorAPI);
});

test(`Exit closes the window`, async () => {
  const closed = page.waitForEvent(`close`);
  await app.menu.click([`File`, `Exit`]).catch(() => {});
  await closed;
});
