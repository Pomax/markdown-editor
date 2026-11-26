/**
 * @fileoverview Integration tests for the caret staying in view when the
 * view switches from the writing view to the source view and back, with
 * the caret deep in a long document: in plain text, and just after bold
 * text.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickWritingViewBetween,
  closeApp,
  launchApp,
  loadContent,
  projectRoot,
  setWritingView,
  writingViewTextAroundCaret,
} from '../../test-utils.js';

const LOREM = readFileSync(path.join(projectRoot, `test`, `fixtures`, `lorem.md`), `utf8`);

const DOCUMENT = `${LOREM.trimEnd()}\n\nThe last words are **in bold** and then plain.\n`;

/**
 * The places a caret is put, as what the place is in, and the text around
 * the place with `|` at the caret.  The text around each place is in the
 * document once.
 */
const CARETS = [
  [`plain text near the end of the document`, `Generated 50| paragraphs`],
  [`the end of bold text at the end of the document`, `in bold| and then`],
];

/**
 * What is measured of the caret: the scroll container's scrollTop and the
 * part of the viewport it shows, whether the editor has the focus, whether
 * the caret is in the editor, the height of the caret's own collapsed
 * range, and the top and bottom of the character just before the caret,
 * in viewport pixels, when there is one; whether the webview supports
 * `field-sizing: content`, and in the source view the textarea's inline
 * height.
 * @typedef {object} CaretMeasurement
 * @property {number} scrollTop
 * @property {number} viewTop
 * @property {number} viewBottom
 * @property {boolean} focused
 * @property {boolean} caretInEditor
 * @property {number} caretHeight
 * @property {number} [top]
 * @property {number} [bottom]
 * @property {boolean} fieldSizing
 * @property {string} [textareaHeight]
 * @property {number} scrollHeight
 * @property {number} clientHeight
 * @property {number} documentScrollTop
 */

/**
 * Measures the caret, after switching to the given view mode in the same
 * task when one is given.  In the source view the caret is found in the
 * mirror behind the textarea.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {string} [mode]
 * @returns {Promise<CaretMeasurement>}
 */
async function measureCaret(pg, mode) {
  return pg.evaluate(async (mode) => {
    if (mode) await window.editorAPI?.setViewMode(mode);
    const editor = /** @type {HTMLElement} */ (document.querySelector(`#editor`));
    const scroller = /** @type {HTMLElement} */ (editor.parentElement);
    const view = scroller.getBoundingClientRect();
    /** @type {CaretMeasurement} */
    const measured = {
      scrollTop: Math.round(scroller.scrollTop),
      viewTop: Math.round(view.top),
      viewBottom: Math.round(view.bottom),
      focused: editor.contains(document.activeElement),
      caretInEditor: false,
      caretHeight: 0,
      fieldSizing: CSS.supports(`field-sizing`, `content`),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
    };
    const previous = document.createRange();
    const textarea = editor.querySelector(`textarea`);
    if (textarea) {
      measured.textareaHeight = textarea.style.height;
      const mirror = textarea.parentElement?.querySelector(`pre`)?.firstChild;
      if (!mirror) return measured;
      measured.caretInEditor = true;
      const caret = document.createRange();
      caret.setStart(mirror, textarea.selectionStart);
      measured.caretHeight = caret.getBoundingClientRect().height;
      if (textarea.selectionStart === 0) return measured;
      previous.setStart(mirror, textarea.selectionStart - 1);
      previous.setEnd(mirror, textarea.selectionStart);
    } else {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return measured;
      const caret = selection.getRangeAt(0);
      measured.caretInEditor = editor.contains(caret.startContainer);
      measured.caretHeight = caret.getBoundingClientRect().height;
      /** @type {Text | undefined} */
      let holder;
      let end = 0;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = /** @type {Text} */ (node);
        if (text === caret.startContainer) {
          if (caret.startOffset > 0) {
            holder = text;
            end = caret.startOffset;
          }
          break;
        }
        if (caret.comparePoint(text, text.length) > 0) break;
        if (text.length > 0) {
          holder = text;
          end = text.length;
        }
      }
      if (!holder) return measured;
      previous.setStart(holder, end - 1);
      previous.setEnd(holder, end);
    }
    const rect = previous.getBoundingClientRect();
    measured.top = Math.round(rect.top);
    measured.bottom = Math.round(rect.bottom);
    return measured;
  }, mode);
}

/**
 * `in view` when the character before the caret is inside what the scroll
 * container shows, and otherwise where it is, where the view is, and how
 * far the scroll container is scrolled.
 *
 * @param {CaretMeasurement} measured
 * @returns {string}
 */
function wherePlaced(measured) {
  const { top, bottom, viewTop, viewBottom, scrollTop, fieldSizing, textareaHeight } = measured;
  if (top === undefined || bottom === undefined) return `no character before the caret`;
  if (top >= viewTop && bottom <= viewBottom) return `in view`;
  const sizing = `field-sizing ${fieldSizing ? `supported` : `not supported`}`;
  const height = textareaHeight === undefined ? `` : `, textarea height "${textareaHeight}"`;
  return `at ${top} to ${bottom}, with the view at ${viewTop} to ${viewBottom} and scrollTop ${scrollTop}, ${sizing}${height}`;
}

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

test.beforeEach(async () => {
  await setWritingView(page);
  await loadContent(page, DOCUMENT);
});

for (const [place, around] of CARETS) {
  const [before, after] = around.split(`|`);

  test(`a caret in ${place} is in view after switching to the source view and back`, async () => {
    await clickWritingViewBetween(page, before, after);
    await expect
      .poll(() => writingViewTextAroundCaret(page, before.length, after.length), {
        message: `the click put the caret after "${before}" in the writing view`,
        timeout: 2_000,
      })
      .toEqual({ before, after, focused: true });

    const inWriting = await measureCaret(page);
    console.log(`MEASURE in writing ${JSON.stringify(inWriting)}`);
    expect
      .soft(inWriting.caretHeight, `the caret's rect has a height in the writing view`)
      .toBeGreaterThan(0);
    expect.soft(wherePlaced(inWriting), `the caret is in view in the writing view`).toBe(`in view`);

    await page.evaluate(() => {
      const editor = /** @type {HTMLElement} */ (document.querySelector(`#editor`));
      const scroller = /** @type {HTMLElement} */ (editor.parentElement);
      /** @type {{ what: string, scrollTop: number }[]} */
      const log = [];
      /** @type {any} */ (window).__scrollLog = log;
      scroller.addEventListener(`scroll`, () =>
        log.push({ what: `scroll`, scrollTop: Math.round(scroller.scrollTop) }),
      );
      new MutationObserver((records) => {
        for (const record of records) {
          const height = /** @type {HTMLElement} */ (record.target).style.height;
          log.push({ what: `style height "${height}"`, scrollTop: Math.round(scroller.scrollTop) });
        }
      }).observe(editor, { attributes: true, attributeFilter: [`style`], subtree: true });
      const scrollHeight = /** @type {PropertyDescriptor} */ (
        Object.getOwnPropertyDescriptor(Element.prototype, `scrollHeight`)
      );
      Object.defineProperty(HTMLTextAreaElement.prototype, `scrollHeight`, {
        configurable: true,
        get() {
          const before = Math.round(scroller.scrollTop);
          const value = scrollHeight.get?.call(this);
          log.push({
            what: `textarea scrollHeight read with height "${this.style.height}", scrollTop before ${before}`,
            scrollTop: Math.round(scroller.scrollTop),
          });
          return value;
        },
      });
      let frames = 0;
      const frame = () => {
        log.push({ what: `frame ${frames}`, scrollTop: Math.round(scroller.scrollTop) });
        frames++;
        if (frames < 20) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    const enteringSource = await measureCaret(page, `source2`);
    console.log(`MEASURE entering source ${JSON.stringify(enteringSource)}`);
    expect
      .soft(enteringSource.focused, `the editor has the focus as the source view comes up`)
      .toBe(true);
    expect
      .soft(enteringSource.caretHeight, `the caret's rect has a height as the source view comes up`)
      .toBeGreaterThan(0);
    expect
      .soft(wherePlaced(enteringSource), `the caret is in view as the source view comes up`)
      .toBe(`in view`);
    await page.waitForTimeout(500);
    const inSource = await measureCaret(page);
    console.log(`MEASURE in source ${JSON.stringify(inSource)}`);
    expect.soft(wherePlaced(inSource), `the caret is in view in the source view`).toBe(`in view`);
    const scrollLog = JSON.stringify(
      await page.evaluate(() => /** @type {any} */ (window).__scrollLog),
    );
    console.log(`MEASURE log ${scrollLog}`);
    expect
      .soft(scrollLog, `the source view is not scrolled to the top while it comes up`)
      .not.toContain(`"scrollTop":0}`);

    const enteringWriting = await measureCaret(page, `writing`);
    console.log(`MEASURE entering writing ${JSON.stringify(enteringWriting)}`);
    expect
      .soft(enteringWriting.focused, `the editor has the focus as the writing view comes back`)
      .toBe(true);
    expect
      .soft(
        enteringWriting.caretInEditor,
        `the selection is in the editor as the writing view comes back`,
      )
      .toBe(true);
    expect
      .soft(
        enteringWriting.caretHeight,
        `the caret's rect has a height as the writing view comes back`,
      )
      .toBeGreaterThan(0);
    expect
      .soft(wherePlaced(enteringWriting), `the caret is in view as the writing view comes back`)
      .toBe(`in view`);
    await page.waitForTimeout(500);
    expect(
      wherePlaced(await measureCaret(page)),
      `the caret is in view in the writing view after the switch back`,
    ).toBe(`in view`);
  });
}
