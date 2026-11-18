/**
 * @fileoverview Integration tests for File → Copy File Path.
 *
 * Verifies that the menu item copies the active file's path to the
 * system clipboard, and that it is disabled when no file path exists.
 */

import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

const readmePath = path.join(projectRoot, `README.md`);

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

test(`Copy File Path is disabled when no file is open`, async () => {
  const enabled = await app.menu.isEnabled([`File`, `Utilities`, `Copy File Path`]);

  expect(enabled).toBe(false);
});

test(`Copy File Path copies the active file path to the clipboard`, async () => {
  // Tell the main process that a file with a real path is active,
  // which sets fileManager.currentFilePath via the IPC handler. The
  // promise is returned so the backend has handled it before the menu
  // is used.
  await page.evaluate((fp) => {
    return window.pageToBackendBridge?.notifyOpenFiles([
      { id: `tab-1`, filePath: fp, label: `README.md`, active: true },
    ]);
  }, readmePath);

  // The menu is rebuilt when openFilesChanged fires, so the item
  // should now be enabled.  Click it via the Menu API.
  await app.menu.click([`File`, `Utilities`, `Copy File Path`]);

  const clipboardText = await app.clipboard.readText();

  expect(clipboardText).toBe(readmePath);
});
