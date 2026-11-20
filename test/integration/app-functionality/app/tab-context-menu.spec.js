/**
 * @fileoverview Integration tests for the tab context menu: a right-click
 * on a tab in the tab bar shows Copy File Path, which copies that tab's
 * file path to the system clipboard, active tab or not, and which is
 * disabled for a tab that has no file. The test build records the menu
 * with the pointer position instead of popping it up.
 */

import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

const readmePath = path.join(projectRoot, `README.md`);
const detailsPath = path.join(projectRoot, `test`, `fixtures`, `details.md`);

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp([readmePath]));
  await expect(tab(`README.md`)).toBeVisible();
  await app.sendMenuAction(`file:loaded`, {
    success: true,
    content: `# Details\n`,
    filePath: detailsPath,
  });
  await expect(tab(`details.md`)).toBeVisible();
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * The tab whose label holds the given text.
 * @param {string} label
 */
function tab(label) {
  return page.locator(`#tab-bar .tab-button`, { hasText: label });
}

/**
 * Right-clicks a tab and waits for its menu to be recorded.
 * @param {string} label
 * @returns {Promise<{ x: number, y: number, items: any[] }>} The recorded menu.
 */
async function rightClickTab(label) {
  const count = (await app.contextMenus()).length;
  const box = await tab(label).boundingBox();
  if (!box) throw new Error(`tab ${label} not laid out`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.click(x, y, { button: `right` });
  await expect.poll(async () => (await app.contextMenus()).length).toBe(count + 1);
  const menu = (await app.contextMenus()).at(-1);
  expect({ x: menu.x, y: menu.y }).toEqual({ x, y });
  return menu;
}

test(`a right-click on a tab shows Copy File Path at the pointer, and only that`, async () => {
  const menu = await rightClickTab(`README.md`);
  expect(menu.items).toEqual([{ label: `Copy File Path`, enabled: true }]);
});

test(`Copy File Path copies the path of the tab that was right-clicked`, async () => {
  await expect(tab(`details.md`)).toHaveClass(/active/);
  await rightClickTab(`README.md`);
  expect(await app.contextMenu.click(`Copy File Path`)).toBe(true);
  await expect.poll(() => app.clipboard.readText()).toBe(readmePath);

  await rightClickTab(`details.md`);
  expect(await app.contextMenu.click(`Copy File Path`)).toBe(true);
  await expect.poll(() => app.clipboard.readText()).toBe(detailsPath);
});

test(`a tab with no file shows Copy File Path disabled, and it cannot be chosen`, async () => {
  await app.sendMenuAction(`file:new`);
  await expect(tab(`Untitled`)).toBeVisible();
  const menu = await rightClickTab(`Untitled`);
  expect(menu.items).toEqual([{ label: `Copy File Path`, enabled: false }]);
  expect(await app.contextMenu.click(`Copy File Path`)).toBe(false);
});
