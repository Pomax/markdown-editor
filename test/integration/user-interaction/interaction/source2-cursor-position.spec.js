/**
 * @fileoverview Integration tests for the caret's place across source2
 * and writing view switches, in a normal markdown document: a caret put
 * after a word with a click in one view is after that word in the other
 * view, in every kind of block, from the top of the document to the
 * bottom.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  clickSourceViewBetween,
  clickWritingViewBetween,
  closeApp,
  FIXTURE_DOCUMENT,
  launchApp,
  loadContent,
  setSource2View,
  setWritingView,
  sourceViewTextAroundCaret,
  writingViewTextAroundCaret,
} from '../../test-utils.js';

const FIXTURE_TEXT = readFileSync(FIXTURE_DOCUMENT, `utf8`);

/**
 * The places a caret is put, as what the place is in, and the text
 * around the place with `|` at the caret.  The text around each place is
 * on one line of one block, has no markdown syntax in it, and is in the
 * document once.
 */
const CARETS = [
  [`a level 1 heading`, `Building| a trim box`],
  [`bold text in a paragraph`, `small trim| controller`],
  [`a paragraph after its inline markup`, `carries| on with plain words`],
  [`a level 2 heading`, `What| you need`],
  [`the first item of a list`, `microcontroller| board`],
  [`the last item of a list`, `a small| enclosure`],
  [`an ordered list item`, `Connect| the encoders`],
  [`a checked list item`, `Order| the parts`],
  [`an unchecked list item`, `Print| the case`],
  [`a nested list item`, `Nested| wiring step`],
  [`a list item nested two deep`, `Deepest| wiring step`],
  [`a level 3 heading after the lists`, `Wiring| it up`],
  [`the first line of a blockquote`, `polarity| before you`],
  [`the second line of a blockquote`, `connect| the power`],
  [`a code block`, `Serial.begin|(9600)`],
  [`a table cell`, `Rudder| trim`],
  [`a paragraph after the images`, `assembled| enclosure`],
  [`a level 4 heading after a details block`, `Testing| the device`],
  [`a paragraph after a level 4 heading`, `Selecting| "properties"`],
  [`a level 5 heading`, `Notes| on the build`],
  [`a paragraph after a level 5 heading`, `Closing| notes go`],
  [`a level 6 heading`, `Credits| and thanks`],
  [`the last paragraph`, `Written| by the project`],
];

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

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

for (const [place, around] of CARETS) {
  const [before, after] = around.split(`|`);
  const expected = { before, after, focused: true };

  test(`a caret put after "${before}" in ${place} in the writing view is there in the source view`, async () => {
    await clickWritingViewBetween(page, before, after);
    await expect
      .poll(() => writingViewTextAroundCaret(page, before.length, after.length), {
        message: `the click put the caret after "${before}" in the writing view`,
        timeout: 2_000,
      })
      .toEqual(expected);
    await setSource2View(page);
    await expect
      .poll(() => sourceViewTextAroundCaret(page, before.length, after.length), {
        timeout: 2_000,
      })
      .toEqual(expected);
  });

  test(`a caret put after "${before}" in ${place} in the source view is there in the writing view`, async () => {
    await setSource2View(page);
    await clickSourceViewBetween(page, before, after);
    await expect
      .poll(() => sourceViewTextAroundCaret(page, before.length, after.length), {
        message: `the click put the caret after "${before}" in the source view`,
        timeout: 2_000,
      })
      .toEqual(expected);
    await setWritingView(page);
    await expect
      .poll(() => writingViewTextAroundCaret(page, before.length, after.length), {
        timeout: 2_000,
      })
      .toEqual(expected);
  });
}
