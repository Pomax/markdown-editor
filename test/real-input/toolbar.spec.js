/**
 * @fileoverview The toolbar, used with the real mouse and keyboard through
 * the Windows runner. Its preferences are set in the preferences dialog,
 * opened with Ctrl+, and filled in with real clicks and keys. At every
 * position a real click on the Bold button bolds the selected word, and
 * dragging the window's corner in with the real mouse stops where the
 * toolbar still fits. With the toolbar hidden the corner drags in further,
 * and dragging the edge of the table of contents out stops where the
 * toolbar still fits.
 */

import { expect, test } from '@playwright/test';
import { closeApp, expectToolbarToFit, launchApp, loadContent } from '../integration/test-utils.js';
import { clickElement, clientPoint, runner } from './runner.js';

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

/** The edges the toolbar can be at. */
const POSITIONS = /** @type {ToolbarPosition[]} */ ([`top`, `right`, `bottom`, `left`]);

/** The key that picks each position in the Bar position list. */
const POSITION_KEYS = { top: `T`, right: `R`, bottom: `B`, left: `L` };

/**
 * Opens the preferences with Ctrl+, on the real keyboard, sets the toolbar
 * preferences in them with the real mouse and keyboard, saves them, and
 * waits for the toolbar to show them.
 * @param {{ visible?: boolean, position?: ToolbarPosition }} settings
 */
async function setToolbarPreferences({ visible, position }) {
  runner(`focus`, app.pid);
  runner(`keys`, app.pid, `Control+,`);
  const dialog = page.locator(`dialog.preferences-dialog`);
  await expect(dialog).toBeVisible();
  await clickElement(app, page.locator(`.preferences-nav-link[data-section="pref-toolbar"]`));
  const checkbox = page.locator(`#toolbar-visible`);
  if (visible !== undefined && (await checkbox.isChecked()) !== visible) {
    await clickElement(app, checkbox);
    await expect(checkbox).toBeChecked({ checked: visible });
  }
  if (position) {
    const select = page.locator(`#toolbar-position-select`);
    await clickElement(app, select);
    await expect(select).toBeFocused();
    runner(`keys`, app.pid, POSITION_KEYS[position], `Enter`);
    await expect(select).toHaveValue(position);
  }
  await clickElement(app, dialog.locator(`.preferences-btn--save`));
  await expect(dialog).toBeHidden();
  const bar = page.locator(`.toolbar`);
  if (position) await expect(bar).toHaveAttribute(`data-position`, position);
  if (visible === true) await expect(bar).toBeVisible();
  if (visible === false) await expect(bar).toBeHidden();
}

/**
 * Drags the window's bottom right corner with the real mouse up and to
 * the left, past where the window can go, and waits for the window to
 * have got narrower than it was.
 * @returns {Promise<{ width: number, height: number }>} The window's client
 * area after the drag, in physical pixels.
 */
async function dragCornerIn() {
  const before = runner(`focus`, app.pid).client;
  runner(`drag`, app.pid, before.width + 3, before.height + 3, 100, 100);
  await expect.poll(() => runner(`window`, app.pid).client.width).toBeLessThan(before.width);
  return runner(`window`, app.pid).client;
}

/**
 * @returns {Promise<string>} The active document's markdown.
 */
function content() {
  return page.evaluate(() => window.editorAPI?.getContent() ?? ``);
}

for (const position of POSITIONS) {
  test(`with the toolbar at the ${position}, a real click on the Bold button bolds the selected word`, async () => {
    await setToolbarPreferences({ visible: true, position });
    await loadContent(page, `word`);
    await clickElement(app, page.locator(`#editor [data-node-id]`).first());
    runner(`keys`, app.pid, `Home`, `Shift+End`);
    await clickElement(app, page.locator(`[data-button-id="bold"]`));
    await expect.poll(async () => (await content()).trimEnd()).toBe(`**word**`);
  });

  test(`with the toolbar at the ${position}, dragging the window's corner in with the real mouse stops where the toolbar still fits`, async () => {
    const start = await app.windowState();
    await setToolbarPreferences({ visible: true, position });
    try {
      await dragCornerIn();
      await expectToolbarToFit(page);
    } finally {
      await app.setWindowBounds({ width: start.width, height: start.height });
    }
  });
}

test(`with Show content button bar unticked, the window's corner drags in further than the toolbar lets it`, async () => {
  const start = await app.windowState();
  await setToolbarPreferences({ visible: true, position: `bottom` });
  try {
    const shown = await dragCornerIn();
    await expectToolbarToFit(page);
    await setToolbarPreferences({ visible: false });
    const hidden = await dragCornerIn();
    expect(hidden.width).toBeLessThan(shown.width);
  } finally {
    await setToolbarPreferences({ visible: true });
    await app.setWindowBounds({ width: start.width, height: start.height });
  }
});

test(`dragging the edge of the table of contents out with the real mouse stops where the toolbar still fits`, async () => {
  const start = await app.windowState();
  await setToolbarPreferences({ visible: true, position: `bottom` });
  const handle = page.locator(`.toc-resize-handle`);
  const first = await clientPoint(handle);
  try {
    const narrowest = await dragCornerIn();
    await expectToolbarToFit(page);
    const corner = { x: narrowest.width + 3, y: narrowest.height + 3 };
    runner(`drag`, app.pid, corner.x, corner.y, corner.x + 100, corner.y);
    await expect
      .poll(() => runner(`window`, app.pid).client.width)
      .toBeGreaterThan(narrowest.width);
    const room = runner(`window`, app.pid).client;
    const grip = await clientPoint(handle);
    runner(`drag`, app.pid, grip.x, grip.y, grip.x + 1000, grip.y);
    await expect.poll(async () => (await clientPoint(handle)).x).toBeGreaterThan(grip.x);
    await expectToolbarToFit(page);
    expect((await clientPoint(handle)).x - grip.x).toBeLessThanOrEqual(
      room.width - narrowest.width + 1,
    );
    const after = runner(`window`, app.pid).client;
    expect({ width: after.width, height: after.height }).toEqual({
      width: room.width,
      height: room.height,
    });
  } finally {
    await app.setWindowBounds({ width: start.width, height: start.height });
    const grip = await clientPoint(handle);
    runner(`drag`, app.pid, grip.x, grip.y, first.x, first.y);
  }
});
