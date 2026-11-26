/**
 * @fileoverview Integration tests for the toolbar's preferences and the
 * room it needs. It is hidden while "Show content button bar" is unticked,
 * and the position stays changeable then. The window cannot get smaller,
 * and the table of contents cannot get wider, than leaves the document
 * area room for the toolbar with `--button-margin` on every side, and the
 * toolbar's position and whether it shows are kept for the next launch.
 */

import { expect, test } from '@playwright/test';
import { closeApp, expectToolbarToFit, launchApp } from '../../test-utils.js';

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp([], { keepWindowSize: true }));
});

test.afterAll(async () => {
  await closeApp(app);
});

/**
 * Sets the toolbar preferences through the preferences dialog.
 * @param {{ visible?: boolean, position?: ToolbarPosition }} settings
 */
async function setToolbarPreferences({ visible, position }) {
  await app.sendMenuAction(`edit:preferences`);
  const dialog = page.locator(`dialog.preferences-dialog`);
  await expect(dialog).toBeVisible();
  if (visible !== undefined) await page.locator(`#toolbar-visible`).setChecked(visible);
  if (position) await page.locator(`#toolbar-position-select`).selectOption(position);
  await dialog.locator(`.preferences-btn--save`).click();
  await expect(dialog).toBeHidden();
}

/**
 * Makes the window as small as it allows, and waits for it to have got
 * smaller than it was.
 * @param {{ innerWidth: number }} before - The window's state before.
 */
async function shrinkWindow(before) {
  await app.setWindowBounds({ width: 400, height: 300 });
  await expect
    .poll(async () => (await app.windowState()).innerWidth)
    .toBeLessThan(before.innerWidth);
}

test(`unticking Show content button bar hides the toolbar, and leaves the position changeable`, async () => {
  await setToolbarPreferences({ visible: false, position: `bottom` });
  await expect(page.locator(`.toolbar`)).toBeHidden();

  await app.sendMenuAction(`edit:preferences`);
  const dialog = page.locator(`dialog.preferences-dialog`);
  await expect(dialog).toBeVisible();
  await expect(page.locator(`#toolbar-visible`)).not.toBeChecked();
  await expect(page.locator(`#toolbar-position-select`)).toBeEnabled();
  await expect(page.locator(`#toolbar-position-select`)).toHaveValue(`bottom`);
  await dialog.locator(`.preferences-btn--cancel`).click();
  await expect(dialog).toBeHidden();

  await setToolbarPreferences({ visible: true });
  await expect(page.locator(`.toolbar`)).toBeVisible();
});

for (const position of /** @type {ToolbarPosition[]} */ ([`top`, `right`, `bottom`, `left`])) {
  test(`the window cannot get too small for the toolbar at the ${position}`, async () => {
    const before = await app.windowState();
    await setToolbarPreferences({ position });
    try {
      await shrinkWindow(before);
      await expectToolbarToFit(page);
    } finally {
      await setToolbarPreferences({ position: `bottom` });
      await app.setWindowBounds({ width: before.width, height: before.height });
    }
  });
}

test(`with the toolbar hidden the window can get narrower than the toolbar needs`, async () => {
  const before = await app.windowState();
  try {
    await shrinkWindow(before);
    await expectToolbarToFit(page);
    const shown = await app.windowState();
    await setToolbarPreferences({ visible: false });
    await app.setWindowBounds({ width: 400, height: 300 });
    await expect
      .poll(async () => (await app.windowState()).innerWidth)
      .toBeLessThan(shown.innerWidth);
  } finally {
    await setToolbarPreferences({ visible: true });
    await app.setWindowBounds({ width: before.width, height: before.height });
  }
});

test(`moving the toolbar to a side of a window too short for it makes the window taller`, async () => {
  const before = await app.windowState();
  try {
    await shrinkWindow(before);
    await expectToolbarToFit(page);
    const shrunk = await app.windowState();
    await setToolbarPreferences({ position: `left` });
    await expect
      .poll(async () => (await app.windowState()).innerHeight)
      .toBeGreaterThan(shrunk.innerHeight);
    await expectToolbarToFit(page);
  } finally {
    await setToolbarPreferences({ position: `bottom` });
    await app.setWindowBounds({ width: before.width, height: before.height });
  }
});

test(`the toolbar's position and whether it shows are kept for the next launch`, async () => {
  test.slow();
  await setToolbarPreferences({ visible: false, position: `right` });
  await closeApp(app);
  ({ app, page } = await launchApp([], { keepWindowSize: true }));
  try {
    await expect(page.locator(`.toolbar`)).toBeHidden();
    await expect(page.locator(`.toolbar`)).toHaveAttribute(`data-position`, `right`);
  } finally {
    await setToolbarPreferences({ visible: true, position: `bottom` });
  }
});

test(`the table of contents cannot get wider than leaves room for the toolbar`, async () => {
  const before = await app.windowState();
  try {
    await shrinkWindow(before);
    await expectToolbarToFit(page);
    const handle = page.locator(`.toc-resize-handle`);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`.toc-resize-handle not laid out`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const shrunk = await app.windowState();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 400, y, { steps: 10 });
    await page.mouse.up();

    await expectToolbarToFit(page);
    const after = await app.windowState();
    expect({ width: after.innerWidth, height: after.innerHeight }).toEqual({
      width: shrunk.innerWidth,
      height: shrunk.innerHeight,
    });
  } finally {
    await page.evaluate(() => document.documentElement.style.removeProperty(`--toc-width`));
    await app.setWindowBounds({ width: before.width, height: before.height });
  }
});
