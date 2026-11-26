/**
 * @fileoverview Browser tests for tables: the toolbar has a Table button
 * with its tooltip, and a table renders as an HTML table in writing view,
 * with the inline markdown and HTML formatting in its cells.
 */

import { expect, test } from '@playwright/test';
import {
  MOD_LABEL,
  loadContent,
  openServedPage,
  setWritingView,
} from '../integration/test-utils.js';

/** @type {import('@playwright/test').Page} */
let page;

/** @type {() => Promise<void>} */
let close;

test.beforeAll(async ({ browser }) => {
  ({ page, close } = await openServedPage(browser));
});

test.afterAll(async () => {
  await close();
});

test(`table button is visible in the toolbar`, async () => {
  const tableButton = page.locator(`[data-button-id="table"]`);
  await expect(tableButton).toBeVisible();
  await expect(tableButton).toHaveAttribute(`data-tooltip`, `Table (${MOD_LABEL}+Shift+T)`);
});

test(`table renders as an HTML table in writing mode`, async () => {
  // Set up: load content with a table and switch to writing view.
  const tableMarkdown = `| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |`;
  await loadContent(page, tableMarkdown);
  await setWritingView(page);

  // In WYSIWYG mode the table is always rendered as an HTML <table>.
  const tableElement = page.locator(`[data-node-id].md-table`);
  await expect(tableElement).toBeVisible();

  const content = await page.evaluate(() => window.editorAPI?.getContent());
  expect(content).toContain(`Header 1`);
  expect(content).toContain(`Header 2`);
});

test(`table cells render inline markdown formatting`, async () => {
  const markdown = [
    `| Feature | Status |`,
    `| --- | --- |`,
    `| **bold** cell | *italic* cell |`,
    `| \`code\` cell | ~~struck~~ cell |`,
  ].join(`\n`);

  await loadContent(page, markdown);
  await setWritingView(page);

  const table = page.locator(`table[data-node-id].md-table`);
  await expect(table).toBeVisible();

  // Bold cell
  const bold = table.locator(`td strong`);
  await expect(bold).toBeVisible();
  expect(await bold.textContent()).toBe(`bold`);

  // Italic cell
  const italic = table.locator(`td em`);
  await expect(italic).toBeVisible();
  expect(await italic.textContent()).toBe(`italic`);

  // Code cell
  const code = table.locator(`td code`);
  await expect(code).toBeVisible();
  expect(await code.textContent()).toBe(`code`);

  // Strikethrough cell
  const del = table.locator(`td del`);
  await expect(del).toBeVisible();
  expect(await del.textContent()).toBe(`struck`);
});

test(`table cells render inline HTML formatting`, async () => {
  const markdown = [
    `| A | B |`,
    `| --- | --- |`,
    `| this <i>is</i> text | <b>bold</b> text |`,
    `| <sub>sub</sub> text | <mark>marked</mark> text |`,
  ].join(`\n`);

  await loadContent(page, markdown);
  await setWritingView(page);

  const table = page.locator(`table[data-node-id].md-table`);
  await expect(table).toBeVisible();

  // Italic via <i>
  const italic = table.locator(`td i`);
  await expect(italic).toBeVisible();
  expect(await italic.textContent()).toBe(`is`);

  // Bold via <b>
  const bold = table.locator(`td b`);
  await expect(bold).toBeVisible();
  expect(await bold.textContent()).toBe(`bold`);

  // Subscript via <sub>
  const sub = table.locator(`td sub`);
  await expect(sub).toBeVisible();
  expect(await sub.textContent()).toBe(`sub`);

  // Mark via <mark>
  const mark = table.locator(`td mark`);
  await expect(mark).toBeVisible();
  expect(await mark.textContent()).toBe(`marked`);
});
