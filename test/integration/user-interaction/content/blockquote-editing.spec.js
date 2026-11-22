/**
 * @fileoverview Integration tests for editing quotes in the writing view:
 * typing `> `, Enter, Backspace and Delete in and around quotes, the
 * Quote button, and deleting a quote's only paragraph.
 */

import { expect, test } from '@playwright/test';
import {
  HOME,
  MOD,
  clickWritingViewBetween,
  closeApp,
  launchApp,
  loadContent,
  setWritingView,
  writingViewTextAroundCaret,
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

test(`typing "> " at the start of a paragraph puts the paragraph in a quote`, async () => {
  await loadContent(page, `Some text\n\nafter`);
  await clickWritingViewBetween(page, `S`, `ome text`);
  await page.keyboard.press(HOME);
  await page.keyboard.type(`> `);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> Some text\n\nafter`);
  await expect(page.locator(`#editor > blockquote.md-blockquote > p.md-paragraph`)).toHaveText(
    `Some text`,
  );
  expect((await writingViewTextAroundCaret(page, 0, 4))?.after).toBe(`Some`);
});

test(`typing "> " at the start of a quoted paragraph puts it in a quote one level deeper`, async () => {
  await loadContent(page, `> Some text\n\nafter`);
  await clickWritingViewBetween(page, `S`, `ome text`);
  await page.keyboard.press(HOME);
  await page.keyboard.type(`> `);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> > Some text\n\nafter`);
  await expect(
    page.locator(`#editor > blockquote.md-blockquote > blockquote.md-blockquote > p.md-paragraph`),
  ).toHaveText(`Some text`);
  expect((await writingViewTextAroundCaret(page, 0, 4))?.after).toBe(`Some`);
});

test(`Enter on an empty last paragraph of a quote moves that paragraph out of the quote`, async () => {
  await loadContent(page, `> quoted\n\nafter`);
  await clickWritingViewBetween(page, `quoted`, `after`);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`more`);
  await page.keyboard.press(`Enter`);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`out`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> quoted\n>\n> more\n\nout\n\nafter`);
  await expect(page.locator(`#editor > p.md-paragraph`).first()).toHaveText(`out`);
});

test(`Backspace at the start of a quote's first paragraph takes the paragraph out of the quote`, async () => {
  await loadContent(page, `before\n\n> quoted\n\nafter`);
  await clickWritingViewBetween(page, `q`, `uoted`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`before\n\nquoted\n\nafter`);
  await expect(page.locator(`#editor blockquote`)).toHaveCount(0);
  expect((await writingViewTextAroundCaret(page, 0, 6))?.after).toBe(`quoted`);
});

test(`Backspace at the start of a nested quote's paragraph takes it out of one quote`, async () => {
  await loadContent(page, `> > deep\n\nafter`);
  await clickWritingViewBetween(page, `d`, `eep`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> deep\n\nafter`);
  await expect(page.locator(`#editor > blockquote.md-blockquote > p.md-paragraph`)).toHaveText(
    `deep`,
  );
});

test(`Backspace at the start of a paragraph after a quote joins it to the quote's last paragraph`, async () => {
  await loadContent(page, `> quoted\n\nafter`);
  await clickWritingViewBetween(page, `a`, `fter`);
  await page.keyboard.press(HOME);
  await page.keyboard.press(`Backspace`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> quotedafter`);
  const caret = await writingViewTextAroundCaret(page, 6, 5);
  expect(caret?.before).toBe(`quoted`);
  expect(caret?.after).toBe(`after`);
});

test(`Delete at the end of a paragraph before a quote joins the quote's first paragraph to it`, async () => {
  await loadContent(page, `before\n\n> quoted\n\nafter`);
  await clickWritingViewBetween(page, `before`, `quoted`);
  await page.keyboard.press(`Delete`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`beforequoted\n\nafter`);
  await expect(page.locator(`#editor blockquote`)).toHaveCount(0);
});

test(`the Quote button puts a paragraph in a quote, and takes it out again`, async () => {
  await loadContent(page, `plain\n\nafter`);
  await clickWritingViewBetween(page, `pl`, `ain`);

  await page.locator(`[data-button-id="blockquote"]`).click();
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> plain\n\nafter`);

  await page.locator(`[data-button-id="blockquote"]`).click();
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`plain\n\nafter`);
});

test(`the Quote button on a paragraph in a nested quote takes it out of the innermost quote`, async () => {
  await loadContent(page, `> > deep\n\nafter`);
  await clickWritingViewBetween(page, `de`, `ep`);

  await page.locator(`[data-button-id="blockquote"]`).click();
  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`> deep\n\nafter`);
});

test(`deleting all of a quote's only paragraph removes the quote`, async () => {
  await loadContent(page, `before\n\n> quoted\n\nafter`);
  await clickWritingViewBetween(page, `quo`, `ted`);
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`Backspace`);

  await expect
    .poll(() => page.evaluate(() => window.editorAPI?.getContent()))
    .toBe(`before\n\nafter`);
  await expect(page.locator(`#editor blockquote`)).toHaveCount(0);
});
