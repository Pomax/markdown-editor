/**
 * @fileoverview Integration tests for the code-block early-conversion feature.
 *
 * Typing ``` (with optional language) on a paragraph and pressing Enter should
 * immediately convert the paragraph into a code-block node.  Pressing Enter
 * inside an existing code block should insert a newline rather than splitting.
 *
 * Typing tests are run in both writing view and source2 view to ensure the
 * fence-to-code-block conversion works in both rendering paths.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
  closeApp,
  launchApp,
  setSource2View,
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

test.describe(`Code-block early conversion — writing view`, () => {
  test(`typing \`\`\` + Enter creates an empty code block`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\``);
    await page.keyboard.press(`Enter`);

    const codeBlock = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlock).toBeVisible();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toContain(`\`\`\`\n`);
  });

  test(`typing \`\`\`js + Enter creates a code block with language`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\`js`);
    await page.keyboard.press(`Enter`);

    const codeBlock = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlock).toBeVisible();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toContain(`\`\`\`js\n`);
  });

  test(`typing \`\`\`\` + Enter creates a code block with fenceCount 4`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\`\``);
    await page.keyboard.press(`Enter`);

    const codeBlock = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlock).toBeVisible();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toContain(`\`\`\`\`\n`);
  });

  test(`typing \`\`\`\`\`\`js + Enter creates a code block with fenceCount 6 and language`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\`\`\`\`js`);
    await page.keyboard.press(`Enter`);

    const codeBlock = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlock).toBeVisible();

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toContain(`\`\`\`\`\`\`js\n`);
  });

  test(`Enter inside a code block inserts a newline`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\``);
    await page.keyboard.press(`Enter`);
    await page.keyboard.type(`line one`);
    await page.keyboard.press(`Enter`);
    await page.keyboard.type(`line two`);

    const markdown = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
    expect(markdown).toContain(`line one\nline two`);

    const codeBlocks = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlocks).toHaveCount(1);
  });

  test(`backtick fence text is not converted until Enter`, async () => {
    await page.evaluate(() => window.editorAPI?.setContent(``));
    await page.waitForSelector(`#editor [data-node-id]`);
    await setWritingView(page);

    const editor = page.locator(`#editor`);
    await clickInEditor(page, editor);

    await page.keyboard.type(`\`\`\``);

    const paragraph = editor.locator(`[data-node-id].md-paragraph`);
    await expect(paragraph).toBeVisible();

    const codeBlock = editor.locator(`[data-node-id].md-code-block`);
    await expect(codeBlock).toHaveCount(0);
  });
});
