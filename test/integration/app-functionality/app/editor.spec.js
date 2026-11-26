/**
 * @fileoverview Integration tests for the editor application.
 */

import { expect, test } from '@playwright/test';
import {
  END,
  MOD,
  clickInEditor,
  closeApp,
  launchApp,
  loadContent,
  setSource2View,
  setWritingView,
} from '../../test-utils.js';

/**
 * Longer than the undo manager's 300 ms batch timeout, so the next edit
 * starts a new undo entry.
 */
const UNDO_BATCH_GAP = 400;

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
 * Returns the editor's markdown.
 * @returns {Promise<string>}
 */
async function getEditorContent() {
  return page.evaluate(() => window.editorAPI?.getContent() ?? ``);
}

/**
 * Returns the centre, on screen, of the first occurrence of a word in the
 * editor's text.
 * @param {string} word
 * @returns {Promise<{x: number, y: number}>}
 */
async function wordCentre(word) {
  return page.evaluate((target) => {
    const editor = /** @type {HTMLElement} */ (document.getElementById(`editor`));
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const index = text.textContent?.indexOf(target) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + target.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`no text holds ${target}`);
  }, word);
}

test.describe(`Application Launch`, () => {
  test(`should create a window`, async () => {
    const windowCount = await app.windowCount();

    expect(windowCount).toBe(1);
  });
});

test.describe(`Text Input`, () => {
  test(`should allow typing in the editor`, async () => {
    const editor = await page.locator(`#editor`);
    await clickInEditor(page, editor);
    await page.keyboard.type(`Hello, World!`);

    const content = await editor.innerText();
    expect(content).toContain(`Hello, World!`);
  });
});

test.describe(`Keyboard Shortcuts`, () => {
  test(`should handle Ctrl+Z for undo`, async () => {
    const editor = await page.locator(`#editor`);
    await clickInEditor(page, editor);
    await page.keyboard.type(`Test`);
    await page.keyboard.press(`${MOD}+z`);

    // Note: Actual undo behavior depends on implementation
    // This test verifies the shortcut is captured
  });
});

test.describe(`Undo`, () => {
  test(`after undo, redo, more typing and undo, the caret stays at the end of the remaining text`, async () => {
    await loadContent(page, `it`);
    await clickInEditor(page, page.locator(`#editor [data-node-id]`).first());
    await page.keyboard.press(END);
    await page.keyboard.type(` blah`);
    await expect.poll(getEditorContent).toBe(`it blah`);
    await page.waitForTimeout(UNDO_BATCH_GAP);
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(getEditorContent).toBe(`it`);
    await page.keyboard.press(`${MOD}+y`);
    await expect.poll(getEditorContent).toBe(`it blah`);
    await page.keyboard.type(` blah`);
    await expect.poll(getEditorContent).toBe(`it blah blah`);
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(getEditorContent).toBe(`it blah`);
    await page.keyboard.type(`X`);

    await expect.poll(getEditorContent).toBe(`it blahX`);
  });
});

test.describe(`Double-click selection`, () => {
  test(`double-clicking a word in writing view selects the word without the space after it`, async () => {
    await setWritingView(page);
    await loadContent(page, `it better work`);
    const { x, y } = await wordCentre(`better`);
    await page.mouse.dblclick(x, y);

    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(`better`);
  });

  test(`double-clicking a word in source view selects the word without the space after it`, async () => {
    await setWritingView(page);
    await loadContent(page, `it better work`);
    await setSource2View(page);
    const { x, y } = await wordCentre(`better`);
    await page.mouse.dblclick(x, y);

    const textarea = page.locator(`#editor.source-view-v2 textarea`);
    await expect
      .poll(() =>
        textarea.evaluate((/** @type {HTMLTextAreaElement} */ el) =>
          el.value.slice(el.selectionStart, el.selectionEnd),
        ),
      )
      .toBe(`better`);
    await setWritingView(page);
  });
});
