/**
 * @fileoverview Integration test for heading creation via keyboard input.
 * Serves the renderer content over HTTP and tests in a real Firefox browser.
 */

import { expect, test } from '@playwright/test';
import { HOME, clickInEditor, resetPage } from '../../test-utils.js';
import { startServer, stopServer } from '../../test-http-server.js';

/** @type {import('node:http').Server} */
let server;

/** @type {string} */
let baseURL;

test.beforeAll(async () => {
  ({ server, baseURL } = await startServer());
});

test.afterAll(async () => {
  await stopServer(server);
});

test.afterEach(async ({ page }) => {
  await resetPage(page);
});

test(`typing "# main" letter by letter creates a heading with correct content`, async ({
  page,
}) => {
  await page.goto(baseURL);

  // Wait for the editor to initialize and render its first line
  await page.waitForSelector(`#editor [data-node-id]`);

  const editor = page.locator(`#editor`);
  await clickInEditor(page, editor);

  // Type each character individually to simulate real user input
  for (const char of [`#`, ` `, `m`, `a`, `i`, `n`]) {
    await page.keyboard.type(char);
  }

  // The editor should now contain a heading1 element
  const headingLine = editor.locator(`.md-heading1`);
  await expect(headingLine).toBeVisible();

  await expect(headingLine).toHaveText(`main`);
});

test(`Enter at the start of a heading puts an empty paragraph above it and keeps the caret in the heading`, async ({
  page,
}) => {
  await page.goto(baseURL);
  await page.waitForSelector(`#editor [data-node-id]`);

  const editor = page.locator(`#editor`);
  await clickInEditor(page, editor);
  await page.keyboard.type(`# Title`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`x`);

  const blocks = editor.locator(`> [data-node-id]`);
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toHaveClass(/md-paragraph/);
  await expect(blocks.nth(0)).toHaveText(``);
  await expect(blocks.nth(1)).toHaveClass(/md-heading1/);
  await expect(blocks.nth(1)).toHaveText(`xTitle`);
});

test(`Backspace at the start of a heading with an empty paragraph above it removes that paragraph and keeps the heading`, async ({
  page,
}) => {
  await page.goto(baseURL);
  await page.waitForSelector(`#editor [data-node-id]`);

  const editor = page.locator(`#editor`);
  await clickInEditor(page, editor);
  await page.keyboard.type(`# Title`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Enter`);
  await page.keyboard.press(`Backspace`);
  await page.keyboard.type(`x`);

  const blocks = editor.locator(`> [data-node-id]`);
  await expect(blocks).toHaveCount(1);
  await expect(blocks.nth(0)).toHaveClass(/md-heading1/);
  await expect(blocks.nth(0)).toHaveText(`xTitle`);
});

test(`Backspace at the start of a heading with text above it joins the heading's text to that text`, async ({
  page,
}) => {
  await page.goto(baseURL);
  await page.waitForSelector(`#editor [data-node-id]`);

  const editor = page.locator(`#editor`);
  await clickInEditor(page, editor);
  await page.keyboard.type(`before`);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`# Title`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);
  await page.keyboard.type(`x`);

  const blocks = editor.locator(`> [data-node-id]`);
  await expect(blocks).toHaveCount(1);
  await expect(blocks.nth(0)).toHaveClass(/md-paragraph/);
  await expect(blocks.nth(0)).toHaveText(`beforexTitle`);
});
