/**
 * @fileoverview Integration tests for the margin link toggles in the
 * preferences dialog.
 *
 * Linking top/bottom and left/right at the same time must not turn on
 * "Link all": the two pairs keep their own values.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from '../../test-utils.js';

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

/**
 * Opens the preferences dialog through the menu action channel.
 */
async function openPreferences() {
  await app.sendMenuAction(`edit:preferences`);
  await expect(page.locator(`dialog.preferences-dialog`)).toBeVisible();
}

test.describe(`Margin link toggles`, () => {
  test.afterEach(async () => {
    await page.keyboard.press(`Escape`);
    await expect(page.locator(`dialog.preferences-dialog`)).toBeHidden();
  });

  test(`linking both pairs does not turn on link all`, async () => {
    await openPreferences();

    await page.locator(`#link-top-bottom`).check();
    await page.locator(`#link-left-right`).check();

    await expect(page.locator(`#link-all`)).not.toBeChecked();
    await expect(page.locator(`#margin-left`)).toBeEnabled();

    await page.locator(`#margin-top`).fill(`10`);
    await page.locator(`#margin-left`).fill(`30`);

    await expect(page.locator(`#margin-top`)).toHaveValue(`10`);
    await expect(page.locator(`#margin-bottom`)).toHaveValue(`10`);
    await expect(page.locator(`#margin-left`)).toHaveValue(`30`);
    await expect(page.locator(`#margin-right`)).toHaveValue(`30`);
  });
});
