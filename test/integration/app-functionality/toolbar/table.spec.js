/**
 * @fileoverview Integration tests for the table modal dialog: the table
 * toolbar button opens it, inserting from it creates a table node, and on
 * an existing table it opens pre-filled with that table's dimensions.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  launchApp,
  loadContent,
  setWritingView,
} from '../../test-utils.js';

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

test(`clicking table button opens the table modal`, async () => {
  const tableButton = page.locator(`[data-button-id="table"]`);
  await tableButton.click();

  const dialog = page.locator(`.table-dialog`);
  await expect(dialog).toBeVisible();

  // Verify the modal has the expected fields
  const colsInput = page.locator(`#table-columns`);
  const rowsInput = page.locator(`#table-rows`);

  await expect(colsInput).toBeVisible();
  await expect(rowsInput).toBeVisible();

  // Defaults should be 3 × 3
  await expect(colsInput).toHaveValue(`3`);
  await expect(rowsInput).toHaveValue(`3`);

  // Cancel the dialog
  const cancelBtn = page.locator(`.table-btn--cancel`);
  await cancelBtn.click();
  await expect(dialog).not.toBeVisible();
});

test(`inserting a table via the modal creates a table node`, async () => {
  const tableButton = page.locator(`[data-button-id="table"]`);
  await tableButton.click();

  const dialog = page.locator(`.table-dialog`);
  await expect(dialog).toBeVisible();

  // Set to 2 columns, 2 rows
  await page.fill(`#table-columns`, `2`);
  await page.fill(`#table-rows`, `2`);

  // Click Insert
  const insertBtn = page.locator(`.table-btn--insert`);
  await insertBtn.click();
  await expect(dialog).not.toBeVisible();

  const tableNode = page.locator(`[data-node-id].md-table`);
  await expect(tableNode).toBeVisible();

  // Verify the markdown content includes table syntax
  const content = await page.evaluate(() => window.editorAPI?.getContent());
  expect(content).toContain(`| Header 1 | Header 2 |`);
  expect(content).toContain(`---`);
});

test(`clicking table button on existing table opens edit modal with pre-filled dimensions`, async () => {
  // Set up: load a 2×2 table and switch to writing view.
  const tableMarkdown = `| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n| Cell 3 | Cell 4 |`;
  await loadContent(page, tableMarkdown);
  await setWritingView(page);

  // Click on the table node
  const tableNode = page.locator(`[data-node-id].md-table`);
  await clickInEditor(page, tableNode);

  // Now click the table button
  const tableButton = page.locator(`[data-button-id="table"]`);
  await tableButton.click();

  const dialog = page.locator(`.table-dialog`);
  await expect(dialog).toBeVisible();

  // Check that the heading says "Edit Table"
  const heading = page.locator(`.table-dialog-header h2`);
  await expect(heading).toHaveText(`Edit Table`);

  // Check that the fields are pre-filled (2 cols, 2 rows from previous test)
  const colsInput = page.locator(`#table-columns`);
  const rowsInput = page.locator(`#table-rows`);
  await expect(colsInput).toHaveValue(`2`);
  await expect(rowsInput).toHaveValue(`2`);

  // Check that the button says "Update"
  const updateBtn = page.locator(`.table-btn--insert`);
  await expect(updateBtn).toHaveText(`Update`);

  // Cancel the dialog
  const cancelBtn = page.locator(`.table-btn--cancel`);
  await cancelBtn.click();
  await expect(dialog).not.toBeVisible();
});
