/**
 * @fileoverview Every shortcut of the user's key check, pressed on the
 * real keyboard through the Windows runner, in writing view and in source
 * view, fires exactly once: each test counts what the key does (tabs,
 * file dialogs, page loads, undo steps, pasted copies, code fences) where
 * a second firing would show, and checks the menu bar and the menus that
 * Alt, F10 and Alt plus a menu's letter open. The clipboard is put back
 * as it was afterwards. F12 opens DevTools in a window of its own, so its
 * test runs last.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent } from '../integration/test-utils.js';
import { clientPoint, runner } from './runner.js';

test.skip(process.platform !== `win32`, `the Windows runner sends input on Windows only`);

/** @type {import('../integration/tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

/** @type {string | null} */
let savedClipboard = null;

/** The views every page and menu shortcut is pressed in. */
const VIEWS = [`writing`, `source2`];

test.beforeAll(async () => {
  ({ app, page } = await launchApp([], { visible: true }));
  savedClipboard = await app.clipboard.readText();
});

test.afterAll(async () => {
  if (typeof savedClipboard === `string`) await app.clipboard.writeText(savedClipboard);
  await closeApp(app);
});

/**
 * @returns {Promise<string>} The active document's markdown: in source
 * view the textarea's text, which the syntax tree takes up only when the
 * view changes.
 */
function content() {
  return page.evaluate(() => {
    const source = [...document.querySelectorAll(`#editor textarea`)].find(
      (area) => area instanceof HTMLTextAreaElement && area.offsetParent !== null,
    );
    if (source instanceof HTMLTextAreaElement) return source.value;
    return window.editorAPI?.getContent() ?? ``;
  });
}

/**
 * Brings the app to the front and presses key combinations on the real
 * keyboard.
 * @param {...string} combos
 */
function press(...combos) {
  runner(`focus`, app.pid);
  runner(`keys`, app.pid, ...combos);
}

/**
 * Brings the app to the front and types text on the real keyboard.
 * @param {string} text
 */
function type(text) {
  runner(`focus`, app.pid);
  runner(`type`, app.pid, text);
}

/**
 * The element a view is typed into: the first block in writing view, the
 * textarea in source view.
 * @param {string} view
 */
function editTarget(view) {
  return view === `writing`
    ? page.locator(`#editor [data-node-id]:visible`).first()
    : page.locator(`#editor textarea:visible`);
}

/**
 * Loads a document in a view, clicks into it with the real mouse and puts
 * the caret at the end of its first line.
 * @param {string} view
 * @param {string} markdown
 */
async function start(view, markdown) {
  await loadContent(page, markdown);
  await page.evaluate((mode) => window.editorAPI?.setViewMode(mode), view);
  await page.locator(`#editor[data-view-mode="${view}"]:visible`).waitFor();
  const target = editTarget(view);
  await target.waitFor();
  runner(`focus`, app.pid);
  const point = await clientPoint(target);
  runner(`click`, app.pid, point.x, point.y);
  runner(`keys`, app.pid, `End`);
}

/**
 * The menu state the runner reads: whether the menu bar is active, and
 * the shown labels of the open popup menu's items.
 * @returns {{ active: boolean, items: string[] | null }}
 */
function menu() {
  const state = runner(`menu`, app.pid);
  const items = state.items?.map((/** @type {string} */ item) =>
    item.replace(/&/g, ``).split(`\t`)[0].trim(),
  );
  return { active: state.active, items: items ?? null };
}

/**
 * Waits a little longer than an action takes, so a second firing of a
 * key would have shown by the time a count is read again.
 */
function settle() {
  return page.waitForTimeout(500);
}

/**
 * Marks the page, so a reload shows as the marker being gone.
 */
async function setReloadMarker() {
  await page.evaluate(() => {
    /** @type {any} */ (window).__beforeReload = true;
  });
}

/**
 * @returns {Promise<boolean>} Whether the page still carries the marker;
 * true while the page is being replaced and cannot answer.
 */
function hasReloadMarker() {
  return page.evaluate(() => /** @type {any} */ (window).__beforeReload === true).catch(() => true);
}

/**
 * @returns {Promise<number>} How many tabs are open.
 */
function tabCount() {
  return page.locator(`#tab-bar .tab-button`).count();
}

/**
 * @returns {Promise<number>} How many file dialogs have been shown.
 */
async function fileDialogCount() {
  return (await app.fileDialogs()).length;
}

for (const view of VIEWS) {
  test.describe(`in ${view} view`, () => {
    test(`Ctrl+Z undoes one edit and Ctrl+Y redoes one`, async () => {
      await start(view, `start`);
      type(` a`);
      await page.waitForTimeout(400);
      type(` b`);
      await expect.poll(content).toBe(`start a b`);
      await page.waitForTimeout(400);
      press(`Control+Z`);
      await expect.poll(content).toBe(`start a`);
      press(`Control+Z`);
      await expect.poll(content).toBe(`start`);
      press(`Control+Y`);
      await expect.poll(content).toBe(`start a`);
      await settle();
      expect(await content()).toBe(`start a`);
    });

    test(`Ctrl+A and Ctrl+C copy the block, Ctrl+V pastes it once, Ctrl+X cuts it`, async () => {
      await start(view, `alpha beta`);
      press(`Control+A`, `Control+C`);
      await expect.poll(() => app.clipboard.readText()).toBe(`alpha beta`);
      press(`End`, `Control+V`);
      await expect.poll(content).toBe(`alpha betaalpha beta`);
      await settle();
      expect(await content()).toBe(`alpha betaalpha beta`);
      press(`Control+A`, `Control+X`);
      await expect.poll(content).toBe(``);
      await expect.poll(() => app.clipboard.readText()).toBe(`alpha betaalpha beta`);
    });

    test(`Ctrl+Shift+C makes one code block`, async () => {
      await start(view, `code`);
      press(`Control+Shift+C`);
      await expect.poll(async () => (await content()).split(`\`\`\``).length - 1).toBe(2);
      await settle();
      expect((await content()).split(`\`\`\``).length - 1).toBe(2);
    });

    test(`Ctrl+F opens the search bar and Escape closes it`, async () => {
      await start(view, `find me`);
      press(`Control+F`);
      await expect(page.locator(`.search-bar:visible`)).toHaveCount(1);
      press(`Escape`);
      await expect(page.locator(`.search-bar:visible`)).toHaveCount(0);
    });

    test(`Ctrl+Shift+I opens the image dialog`, async () => {
      await start(view, `picture`);
      press(`Control+Shift+I`);
      await expect(page.locator(`.image-dialog[open]`)).toHaveCount(1);
      press(`Escape`);
      await expect(page.locator(`.image-dialog[open]`)).toHaveCount(0);
    });

    test(`Ctrl+comma opens Preferences`, async () => {
      await start(view, `settings`);
      press(`Control+Comma`);
      await expect(page.locator(`.preferences-dialog[open]`)).toHaveCount(1);
      press(`Escape`);
      await expect(page.locator(`.preferences-dialog[open]`)).toHaveCount(0);
    });

    test(`Ctrl+N opens one tab and Ctrl+W closes one`, async () => {
      await start(view, `tabs`);
      const before = await tabCount();
      press(`Control+N`);
      await expect.poll(tabCount).toBe(before + 1);
      await settle();
      expect(await tabCount()).toBe(before + 1);
      press(`Control+W`);
      await expect.poll(tabCount).toBe(before);
      await settle();
      expect(await tabCount()).toBe(before);
    });

    test(`Ctrl+O shows the Load dialog once`, async () => {
      await start(view, `load`);
      const before = await fileDialogCount();
      press(`Control+O`);
      await expect.poll(fileDialogCount).toBe(before + 1);
      await settle();
      expect(await fileDialogCount()).toBe(before + 1);
    });

    test(`Ctrl+S on a new document shows the Save As dialog once`, async () => {
      await start(view, `save`);
      const before = await fileDialogCount();
      press(`Control+S`);
      await expect.poll(fileDialogCount).toBe(before + 1);
      await settle();
      expect(await fileDialogCount()).toBe(before + 1);
    });

    test(`Ctrl+Shift+S shows the Save As dialog once`, async () => {
      await start(view, `save as`);
      const before = await fileDialogCount();
      press(`Control+Shift+S`);
      await expect.poll(fileDialogCount).toBe(before + 1);
      await settle();
      expect(await fileDialogCount()).toBe(before + 1);
    });

    test(`Ctrl+Shift+R reloads the page once`, async () => {
      await start(view, `reload`);
      await setReloadMarker();
      press(`Control+Shift+R`);
      await expect.poll(hasReloadMarker, { timeout: 10_000 }).toBe(false);
      await page.waitForFunction(() => window.editorAPI !== undefined);
      // A second reload would take this new marker away again.
      await setReloadMarker();
      await page.waitForTimeout(1000);
      expect(await hasReloadMarker()).toBe(true);
    });

    test(`Alt and F10 activate the menu bar, Escape leaves it`, async () => {
      await start(view, `menu bar`);
      for (const key of [`Alt`, `F10`]) {
        press(key);
        await expect.poll(() => menu().active).toBe(true);
        expect(menu().items).toBeNull();
        press(`Escape`);
        await expect.poll(() => menu().active).toBe(false);
      }
    });

    test(`Alt plus a menu's letter opens that menu`, async () => {
      await start(view, `menus`);
      for (const [key, first] of [
        [`Alt+F`, `New`],
        [`Alt+E`, `Undo`],
        [`Alt+V`, `Writing View`],
        [`Alt+H`, `Reload`],
      ]) {
        press(key);
        await expect.poll(() => menu().items?.[0] ?? null).toBe(first);
        press(`Escape`, `Escape`);
        await expect.poll(() => menu().active).toBe(false);
      }
    });
  });
}

test(`Ctrl+2 shows source view and Ctrl+1 writing view`, async () => {
  await start(`writing`, `views`);
  press(`Control+2`);
  await expect(page.locator(`#editor[data-view-mode="source2"]:visible`)).toHaveCount(1);
  press(`Control+1`);
  await expect(page.locator(`#editor[data-view-mode="writing"]:visible`)).toHaveCount(1);
});

test(`F12 opens DevTools`, async () => {
  await start(`writing`, `devtools`);
  expect(await app.isDevtoolsOpen()).toBe(false);
  press(`F12`);
  await expect.poll(() => app.isDevtoolsOpen()).toBe(true);
});
