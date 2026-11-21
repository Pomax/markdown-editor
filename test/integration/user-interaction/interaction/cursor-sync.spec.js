/**
 * @fileoverview Integration tests for the caret after editing, in a
 * normal markdown document: after an edit in one view and a switch to
 * the other, the caret is exactly where the edit left it, in every kind
 * of block the edit is made in.
 *
 * The syntax tree is the single source of truth for cursor state, so
 * after an edit in the source view the tests check the tree cursor.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickSourceViewBetween,
  clickWritingViewBetween,
  closeApp,
  defocusEditor,
  FIXTURE_DOCUMENT,
  HOME,
  launchApp,
  loadContent,
  setSource2View,
  setWritingView,
  sourceViewTextAroundCaret,
  treeCursorTextAround,
} from '../../test-utils.js';

const FIXTURE_TEXT = readFileSync(FIXTURE_DOCUMENT, `utf8`);

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

/**
 * Edits made in the source view, as what the edit is, the markdown
 * around the place it is made with `|` at the caret, the edit itself,
 * and the type of the block and the content around the tree cursor
 * afterwards, with `|` at the tree cursor.
 * @type {[string, string, () => Promise<void>, string, string][]}
 */
const SOURCE_VIEW_EDITS = [
  [
    `typing text in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.type(` the entry`),
    `paragraph`,
    `Selecting the entry| "properties"`,
  ],
  [
    `Backspace in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.press(`Backspace`),
    `paragraph`,
    `Selectin| "properties"`,
  ],
  [
    `Delete in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.press(`Delete`),
    `paragraph`,
    `Selecting|"properties"`,
  ],
  [
    `two Enters splitting a paragraph`,
    `Selecting |"properties"`,
    async () => {
      await page.keyboard.press(`Enter`);
      await page.keyboard.press(`Enter`);
    },
    `paragraph`,
    `|"properties" should`,
  ],
  [
    `typing a heading prefix at the start of a paragraph`,
    `Closing| notes go`,
    async () => {
      await page.keyboard.press(HOME);
      await page.keyboard.type(`## `);
    },
    `heading2`,
    `|Closing notes go`,
  ],
  [
    `typing at the end of a line of a code block`,
    `Serial.begin(9600);|\n}`,
    () => page.keyboard.type(` // start`),
    `code-block`,
    `Serial.begin(9600); // start|\n}`,
  ],
  [
    `Enter and typing in a code block`,
    `Serial.begin(9600);|\n}`,
    async () => {
      await page.keyboard.press(`Enter`);
      await page.keyboard.type(`pinMode(A0, INPUT);`);
    },
    `code-block`,
    `pinMode(A0, INPUT);|\n}`,
  ],
  [
    `typing a new list item after the last item of a list`,
    `a small enclosure.|\n1.`,
    async () => {
      await page.keyboard.press(`Enter`);
      await page.keyboard.type(`- a power cable`);
    },
    `list-item`,
    `a power cable|`,
  ],
];

/**
 * Edits made in the writing view, as what the edit is, the text around
 * the place it is made with `|` at the caret, the edit itself, and the
 * markdown around the caret afterwards in the source view, with `|` at
 * the caret.
 * @type {[string, string, () => Promise<void>, string][]}
 */
const WRITING_VIEW_EDITS = [
  [
    `typing text in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.type(` the entry`),
    `Selecting the entry| "properties"`,
  ],
  [
    `Backspace in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.press(`Backspace`),
    `Selectin| "properties"`,
  ],
  [
    `Delete in a paragraph`,
    `Selecting| "properties"`,
    () => page.keyboard.press(`Delete`),
    `Selecting|"properties"`,
  ],
  [
    `Enter splitting a paragraph`,
    `Selecting |"properties"`,
    () => page.keyboard.press(`Enter`),
    `\n\n|"properties" should`,
  ],
  [
    `typing in the last item of a list`,
    `a small| enclosure`,
    () => page.keyboard.type(` plastic`),
    `a small plastic| enclosure`,
  ],
  [
    `typing in a list item nested two deep`,
    `Deepest| wiring step`,
    () => page.keyboard.type(` final`),
    `Deepest final| wiring step`,
  ],
  [
    `typing in the second line of a blockquote`,
    `connect| the power`,
    () => page.keyboard.type(` up`),
    `connect up| the power`,
  ],
  [
    `typing in a code block`,
    `Serial.begin|(9600)`,
    () => page.keyboard.type(`Fast`),
    `Serial.beginFast|(9600)`,
  ],
  [`typing in a table cell`, `Rudder| trim`, () => page.keyboard.type(`s`), `Rudders| trim`],
  [
    `typing in a level 4 heading`,
    `Testing| the device`,
    () => page.keyboard.type(` out`),
    `Testing out| the device`,
  ],
];

test.beforeAll(async () => {
  ({ app, page } = await launchApp([FIXTURE_DOCUMENT]));
  await expect(
    page.locator(`#tab-bar .tab-button`, { hasText: path.basename(FIXTURE_DOCUMENT) }),
  ).toBeVisible();
});

test.afterAll(async () => {
  await closeApp(app);
});

test.beforeEach(async () => {
  await setWritingView(page);
  await loadContent(page, FIXTURE_TEXT);
});

for (const [edit, around, makeEdit, type, cursor] of SOURCE_VIEW_EDITS) {
  const [before, after] = around.split(`|`);
  const [cursorBefore, cursorAfter] = cursor.split(`|`);

  test(`after ${edit} in the source view, the tree cursor in the writing view is where the edit left the caret`, async () => {
    await setSource2View(page);
    await clickSourceViewBetween(page, before, after);
    await expect
      .poll(() => sourceViewTextAroundCaret(page, before.length, after.length), {
        message: `the click put the caret after "${before}" in the source view`,
        timeout: 2_000,
      })
      .toEqual({ before, after, focused: true });
    await makeEdit();
    await setWritingView(page);
    await expect
      .poll(
        () =>
          treeCursorTextAround(
            page,
            Math.max(1, cursorBefore.length),
            Math.max(1, cursorAfter.length),
          ),
        { timeout: 2_000 },
      )
      .toEqual({ type, before: cursorBefore, after: cursorAfter });
  });
}

for (const [edit, around, makeEdit, caret] of WRITING_VIEW_EDITS) {
  const [before, after] = around.split(`|`);
  const [caretBefore, caretAfter] = caret.split(`|`);

  test(`after ${edit} in the writing view, the caret in the source view is where the edit left it`, async () => {
    await clickWritingViewBetween(page, before, after);
    await expect
      .poll(() => treeCursorTextAround(page, before.length, after.length), {
        message: `the click put the tree cursor after "${before}" in the writing view`,
        timeout: 2_000,
      })
      .toMatchObject({ before, after });
    await makeEdit();
    await setSource2View(page);
    await expect
      .poll(() => sourceViewTextAroundCaret(page, caretBefore.length, caretAfter.length), {
        timeout: 2_000,
      })
      .toEqual({ before: caretBefore, after: caretAfter, focused: true });
  });
}

test(`the tree cursor stays where a click put it when the editor loses the focus`, async () => {
  const expected = { type: `paragraph`, before: `Selecting`, after: ` "properties"` };
  await clickWritingViewBetween(page, `Selecting`, ` "properties"`);
  await expect
    .poll(() => treeCursorTextAround(page, `Selecting`.length, ` "properties"`.length), {
      timeout: 2_000,
    })
    .toEqual(expected);
  await defocusEditor(page);
  expect(await treeCursorTextAround(page, `Selecting`.length, ` "properties"`.length)).toEqual(
    expected,
  );
});

test(`a caret inside inline html is in the same place after source → writing → source`, async () => {
  const expected = { before: `<kbd>Ct`, after: `rl</kbd>`, focused: true };
  await setSource2View(page);
  await clickSourceViewBetween(page, `<kbd>Ct`, `rl</kbd>`);
  await expect
    .poll(() => sourceViewTextAroundCaret(page, `<kbd>Ct`.length, `rl</kbd>`.length), {
      message: `the click put the caret inside <kbd>Ctrl</kbd> in the source view`,
      timeout: 2_000,
    })
    .toEqual(expected);
  await setWritingView(page);
  await setSource2View(page);
  await expect
    .poll(() => sourceViewTextAroundCaret(page, `<kbd>Ct`.length, `rl</kbd>`.length), {
      timeout: 2_000,
    })
    .toEqual(expected);
});
