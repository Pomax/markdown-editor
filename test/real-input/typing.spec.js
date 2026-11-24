/**
 * @fileoverview Real input reaches the app: the Windows runner brings the
 * test app's window to the front, clicks into the editor with the mouse
 * and types on the keyboard, and the editor holds what was typed. On a line
 * that is a link, the right arrow key at the end of the link moves the
 * cursor to the next line, and End then Enter starts a new paragraph after
 * the link.
 */

import { expect, test } from '@playwright/test';
import {
  closeApp,
  launchApp,
  loadContent,
  setSource2View,
  setWritingView,
} from '../integration/test-utils.js';
import { clientPoint, runner } from './runner.js';

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

test(`a click and typing on the real mouse and keyboard reach the editor`, async () => {
  await loadContent(page, `start`);
  runner(`focus`, app.pid);
  const point = await clientPoint(page.locator(`#editor [data-node-id]`).first());
  runner(`click`, app.pid, point.x, point.y);
  runner(`keys`, app.pid, `End`);
  runner(`type`, app.pid, ` typed`);
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent() ?? ``))
    .toBe(`start typed`);
});

/**
 * The text the writing view shows before the caret, or undefined when there
 * is no collapsed caret.
 * @returns {Promise<string | undefined>}
 */
function textBeforeCaret() {
  return page.evaluate(() => {
    const editor = document.querySelector(`#editor`);
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode || !selection.isCollapsed) return undefined;
    const range = document.createRange();
    range.setStart(editor, 0);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString();
  });
}

test(`the right arrow key at the end of a link moves the cursor to the next line`, async () => {
  await setSource2View(page);
  await loadContent(page, `[test](http://example.com)\n\nnext`);
  await setWritingView(page);
  const next = await page.evaluate(() => {
    const [first, second] = /** @type {any} */ (window).__editor.syntaxTree.children;
    window.editorAPI?.placeCursorAtNode(first.id, 0);
    return second?.id;
  });
  runner(`focus`, app.pid);
  await expect.poll(textBeforeCaret).toBe(``);
  runner(`keys`, app.pid, `ArrowRight`, `ArrowRight`, `ArrowRight`, `ArrowRight`);
  await expect.poll(textBeforeCaret).toBe(`test`);
  runner(`keys`, app.pid, `ArrowRight`);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const line = document.querySelector(`#editor [data-node-id="${id}"]`);
        const selection = window.getSelection();
        return !!line && !!selection?.isCollapsed && line.contains(selection.anchorNode);
      }, next),
    )
    .toBe(true);
});

test(`End and Enter on a line that is a link put an empty paragraph after the link`, async () => {
  await setSource2View(page);
  await loadContent(page, `[test](http://example.com)\n\ntext`);
  await setWritingView(page);
  await page.evaluate(() => {
    const first = /** @type {any} */ (window).__editor.syntaxTree.children[0];
    window.editorAPI?.placeCursorAtNode(first.id, 0);
  });
  runner(`focus`, app.pid);
  await expect.poll(textBeforeCaret).toBe(``);
  runner(`keys`, app.pid, `End`);
  await expect.poll(textBeforeCaret).toBe(`test`);
  runner(`keys`, app.pid, `Enter`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        /** @type {any} */ (window).__editor.syntaxTree.children.map(
          (/** @type {any} */ node) => ({ type: node.type, content: node.content }),
        ),
      ),
    )
    .toEqual([
      { type: `paragraph`, content: `[test](http://example.com)` },
      { type: `paragraph`, content: `` },
      { type: `paragraph`, content: `text` },
    ]);
});
