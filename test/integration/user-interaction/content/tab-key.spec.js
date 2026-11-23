/**
 * @fileoverview Integration tests for Tab and Shift+Tab in the writing
 * view: they indent and undent the block the caret is in, by the block's
 * type, and never move the focus out of the document.
 */

import { expect, test } from '@playwright/test';
import {
  clickWritingViewBetween,
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

test.beforeEach(async () => {
  await setWritingView(page);
});

test.describe(`Tab`, () => {
  test(`in a paragraph puts it in a quote and keeps the focus in the document`, async () => {
    await loadContent(page, `plain\n\nafter`);
    await clickWritingViewBetween(page, `pl`, `ain`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> plain\n\nafter`);
    expect(await page.evaluate(() => !!document.activeElement?.closest(`#editor`))).toBe(true);
  });

  test(`in a paragraph between two quotes makes one quote of all three`, async () => {
    await loadContent(page, `> first\n\nmiddle\n\n> last`);
    await clickWritingViewBetween(page, `mid`, `dle`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> first\n>\n> middle\n>\n> last`);
  });

  test(`in a quoted paragraph puts it one quote deeper`, async () => {
    await loadContent(page, `> quoted\n\nafter`);
    await clickWritingViewBetween(page, `quo`, `ted`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> > quoted\n\nafter`);
  });

  test(`in a heading makes it one level smaller`, async () => {
    await loadContent(page, `## Title\n\nafter`);
    await clickWritingViewBetween(page, `Ti`, `tle`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`### Title\n\nafter`);
  });

  test(`in a level 6 heading changes nothing and keeps the focus in the document`, async () => {
    await loadContent(page, `###### Six\n\nafter`);
    await clickWritingViewBetween(page, `Si`, `x`);
    await page.keyboard.press(`Tab`);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.editorAPI?.getContent())).toBe(`###### Six\n\nafter`);
    expect(await page.evaluate(() => !!document.activeElement?.closest(`#editor`))).toBe(true);
  });

  test(`in a list item indents it together with its sub-items`, async () => {
    await loadContent(page, `- one\n- two\n  - three\n- four`);
    await clickWritingViewBetween(page, `tw`, `o`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`- one\n  - two\n    - three\n- four`);
  });

  test(`in a code block types a tab character`, async () => {
    await loadContent(page, `\`\`\`\ncode\n\`\`\`\n\nafter`);
    await clickWritingViewBetween(page, `co`, `de`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`\`\`\`\nco\tde\n\`\`\`\n\nafter`);
  });

  test(`with several blocks selected puts each in a quote, as one quote`, async () => {
    await loadContent(page, `one\n\ntwo\n\nafter`);
    await clickWritingViewBetween(page, `o`, `ne`);
    await page.keyboard.press(`Shift+ArrowDown`);
    await page.keyboard.press(`Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> one\n>\n> two\n\nafter`);
  });
});

test.describe(`Shift+Tab`, () => {
  test(`in a quoted paragraph takes it out of the quote, which stays around the rest`, async () => {
    await loadContent(page, `> first\n>\n> middle\n>\n> last`);
    await clickWritingViewBetween(page, `mid`, `dle`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> first\n\nmiddle\n\n> last`);
  });

  test(`in a paragraph in a nested quote takes it out of one quote`, async () => {
    await loadContent(page, `> > deep\n\nafter`);
    await clickWritingViewBetween(page, `de`, `ep`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`> deep\n\nafter`);
  });

  test(`in a paragraph outside any quote changes nothing and keeps the focus in the document`, async () => {
    await loadContent(page, `plain\n\nafter`);
    await clickWritingViewBetween(page, `pl`, `ain`);
    await page.keyboard.press(`Shift+Tab`);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.editorAPI?.getContent())).toBe(`plain\n\nafter`);
    expect(await page.evaluate(() => !!document.activeElement?.closest(`#editor`))).toBe(true);
  });

  test(`in a heading makes it one level larger`, async () => {
    await loadContent(page, `### Title\n\nafter`);
    await clickWritingViewBetween(page, `Ti`, `tle`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`## Title\n\nafter`);
  });

  test(`in a level 1 heading changes nothing`, async () => {
    await loadContent(page, `# Title\n\nafter`);
    await clickWritingViewBetween(page, `Ti`, `tle`);
    await page.keyboard.press(`Shift+Tab`);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.editorAPI?.getContent())).toBe(`# Title\n\nafter`);
  });

  test(`in a level 1 heading in a quote takes it out of the quote`, async () => {
    await loadContent(page, `> # Title\n\nafter`);
    await clickWritingViewBetween(page, `Ti`, `tle`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`# Title\n\nafter`);
  });

  test(`in a list item undents it together with its sub-items`, async () => {
    await loadContent(page, `- one\n  - two\n    - three\n- four`);
    await clickWritingViewBetween(page, `tw`, `o`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`- one\n- two\n  - three\n- four`);
  });

  test(`in an unindented list item in a quote takes it out of the quote`, async () => {
    await loadContent(page, `> - item\n\nafter`);
    await clickWritingViewBetween(page, `it`, `em`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`- item\n\nafter`);
  });

  test(`in a code block outside any quote changes nothing`, async () => {
    await loadContent(page, `\`\`\`\ncode\n\`\`\`\n\nafter`);
    await clickWritingViewBetween(page, `co`, `de`);
    await page.keyboard.press(`Shift+Tab`);
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.editorAPI?.getContent())).toBe(
      `\`\`\`\ncode\n\`\`\`\n\nafter`,
    );
  });

  test(`in a code block in a quote takes it out of the quote`, async () => {
    await loadContent(page, `> \`\`\`\n> code\n> \`\`\`\n\nafter`);
    await clickWritingViewBetween(page, `co`, `de`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`\`\`\`\ncode\n\`\`\`\n\nafter`);
  });

  test(`with several quoted blocks selected takes each out of the quote`, async () => {
    await loadContent(page, `> one\n>\n> two\n\nafter`);
    await clickWritingViewBetween(page, `o`, `ne`);
    await page.keyboard.press(`Shift+ArrowDown`);
    await page.keyboard.press(`Shift+Tab`);

    await expect
      .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
      .toBe(`one\n\ntwo\n\nafter`);
  });
});
