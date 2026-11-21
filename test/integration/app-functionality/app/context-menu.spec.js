/**
 * @fileoverview Integration tests for the right-click context menu.
 *
 * The app pops up Copy, Cut, Paste, a separator and Inspect Element
 * on a right-click in the document that the page did not prevent, and no
 * menu at all, not even the webview's own, on a right-click anywhere in
 * its UI: the toolbar, the table of contents, the tab bar beside the
 * tabs, and the margin beside the page. The test build records the menu
 * with the pointer position instead of popping it up, so these tests
 * check what was recorded, that nothing is recorded where the page
 * prevented the event or over the UI, that Copy, Cut and Paste send the
 * same keystrokes as the Edit items, and that Inspect Element opens
 * DevTools: on the element under the pointer on Windows, where WebView2
 * can inspect a point, and with no element chosen elsewhere.
 */

import process from 'node:process';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent } from '../../test-utils.js';

/**
 * The items of the context menu, as the test hooks describe them.
 * @type {{ label?: string, enabled?: boolean, type?: string }[]}
 */
const CONTEXT_MENU_ITEMS = [
  { label: `Copy`, enabled: true },
  { label: `Cut`, enabled: true },
  { label: `Paste`, enabled: true },
  { type: `separator` },
  { label: `Inspect Element`, enabled: true },
];

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await loadContent(page, `# Heading\n\nSome text to right-click on.`);
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * @returns {Promise<number>} How many context menus have been recorded.
 */
async function recordedCount() {
  return (await app.contextMenus()).length;
}

/**
 * The middle of the paragraph, in whole CSS pixels. The editor replaces a
 * block's element when the caret moves into or out of it, as a right-click
 * does, so an element that is gone by the time it is measured is looked
 * up and measured again.
 * @returns {Promise<{ x: number, y: number }>}
 */
async function paragraphPoint() {
  const paragraph = page.locator(`#editor [data-node-id]`).nth(1);
  let box = await paragraph.boundingBox();
  while (!box) box = await paragraph.boundingBox();
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * Right-clicks the paragraph and waits for the menu to be recorded.
 */
async function openContextMenu() {
  const count = await recordedCount();
  const { x, y } = await paragraphPoint();
  await page.mouse.click(x, y, { button: `right` });
  await expect.poll(recordedCount).toBe(count + 1);
}

/**
 * The middle of an element, in whole CSS pixels.
 * @param {string} selector
 * @returns {Promise<{ x: number, y: number }>}
 */
async function middleOf(selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} not laid out`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * Right-clicks a point and reports how many menus that recorded, and
 * whether the right-click's default was prevented, which is what keeps
 * the webview's own menu from showing.
 * @param {{ x: number, y: number }} point
 * @returns {Promise<{ recorded: number, prevented: boolean }>}
 */
async function rightClickAt({ x, y }) {
  const count = await recordedCount();
  await page.evaluate(() => {
    const own = /** @type {any} */ (window);
    own.__contextMenuPrevented = undefined;
    window.addEventListener(
      `contextmenu`,
      (event) => {
        own.__contextMenuPrevented = event.defaultPrevented;
      },
      { once: true },
    );
  });
  await page.mouse.click(x, y, { button: `right` });
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).__contextMenuPrevented))
    .toBeDefined();
  await page.waitForTimeout(300);
  return {
    recorded: (await recordedCount()) - count,
    prevented: await page.evaluate(() => /** @type {any} */ (window).__contextMenuPrevented),
  };
}

test(`no menu shows for a right-click on the toolbar`, async () => {
  expect(await rightClickAt(await middleOf(`#toolbar-container`))).toEqual({
    recorded: 0,
    prevented: true,
  });
});

test(`no menu shows for a right-click on the table of contents`, async () => {
  expect(await rightClickAt(await middleOf(`#toc-sidebar`))).toEqual({
    recorded: 0,
    prevented: true,
  });
});

test(`no menu shows for a right-click on the tab bar beside the tabs`, async () => {
  const box = await page.locator(`#tab-bar`).boundingBox();
  if (!box) throw new Error(`#tab-bar not laid out`);
  const point = { x: Math.round(box.x + box.width - 10), y: Math.round(box.y + box.height / 2) };
  const onTab = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(`.tab-button`) !== null,
    point,
  );
  expect(onTab).toBe(false);
  expect(await rightClickAt(point)).toEqual({ recorded: 0, prevented: true });
});

test(`no menu shows for a right-click in the margin beside the page`, async () => {
  const box = await page.locator(`#editor-container`).boundingBox();
  if (!box) throw new Error(`#editor-container not laid out`);
  const point = { x: Math.round(box.x + 10), y: Math.round(box.y + box.height / 2) };
  const inDocument = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(`.editor`) !== null,
    point,
  );
  expect(inDocument).toBe(false);
  expect(await rightClickAt(point)).toEqual({ recorded: 0, prevented: true });
});

test(`a right-click in the document still shows the document's menu`, async () => {
  expect(await rightClickAt(await paragraphPoint())).toEqual({ recorded: 1, prevented: true });
});

test(`a right-click records the context menu at the pointer`, async () => {
  const count = await recordedCount();
  const { x, y } = await paragraphPoint();
  await page.mouse.click(x, y, { button: `right` });
  await expect.poll(recordedCount).toBe(count + 1);
  const menus = await app.contextMenus();
  expect(menus.at(-1)).toEqual({ x, y, items: CONTEXT_MENU_ITEMS });
});

test(`nothing is recorded where the page prevented the event`, async () => {
  await page.evaluate(() => {
    document.addEventListener(`contextmenu`, (event) => event.preventDefault(), { once: true });
  });
  const count = await recordedCount();
  const { x, y } = await paragraphPoint();
  await page.mouse.click(x, y, { button: `right` });
  // A right-click the page did not prevent is recorded after the one it
  // did, so a single new menu means the prevented one recorded nothing.
  await page.mouse.click(x, y, { button: `right` });
  await expect.poll(recordedCount).toBe(count + 1);
  await page.waitForTimeout(300);
  expect(await recordedCount()).toBe(count + 1);
});

test(`Copy, Cut and Paste send the same keystrokes as the Edit items`, async () => {
  await app.menu.click([`Edit`, `Copy`]);
  await app.menu.click([`Edit`, `Cut`]);
  await app.menu.click([`Edit`, `Paste`]);
  const edit = (await app.sentKeystrokes()).slice(-3);

  for (const label of [`Copy`, `Cut`, `Paste`]) {
    await openContextMenu();
    expect(await app.contextMenu.click(label)).toBe(true);
  }
  const context = (await app.sentKeystrokes()).slice(-3);

  expect(context).toEqual([`Ctrl+C`, `Ctrl+X`, `Ctrl+V`]);
  expect(context).toEqual(edit);
});

test(`Inspect Element opens DevTools on the element under the pointer`, async () => {
  test.skip(process.platform !== `win32`, `only WebView2 can inspect the element at a point`);
  expect(await app.isDevtoolsOpen()).toBe(false);
  await openContextMenu();
  const { x, y } = (await app.contextMenus()).at(-1);
  expect(await app.contextMenu.click(`Inspect Element`)).toBe(true);
  await expect.poll(() => app.inspections()).toEqual([{ x, y }]);
  await expect.poll(() => app.isDevtoolsOpen()).toBe(true);
});

test(`Inspect Element opens DevTools where the webview cannot inspect a point`, async () => {
  test.skip(process.platform === `win32`, `WebView2 inspects the element at the point`);
  expect(await app.isDevtoolsOpen()).toBe(false);
  await openContextMenu();
  expect(await app.contextMenu.click(`Inspect Element`)).toBe(true);
  await expect.poll(() => app.isDevtoolsOpen()).toBe(true);
});
