/**
 * @fileoverview Browser tests for inline HTML tag rendering. Inline HTML
 * tags (<sub>, <sup>, <mark>, <u>, <b>, <i>, <s>, <strong>, <em>, <del>)
 * render as their elements in writing mode, on the line with the cursor
 * and on the others.
 */

import { expect, test } from '@playwright/test';
import {
  clickInEditor,
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

/**
 * Helper: load markdown, switch to writing mode, focus on the second
 * paragraph so the first line is unfocused (rendered with formatting).
 *
 * @param {string} markdown - The markdown content to load.
 */
async function loadAndDefocusFirstLine(markdown) {
  await loadContent(page, markdown);

  await setWritingView(page);
  await page.waitForTimeout(200);

  // Click the second paragraph to defocus the first line.
  const secondLine = page.locator(`#editor [data-node-id]`).nth(1);
  await clickInEditor(page, secondLine);
  await page.waitForTimeout(200);
}

test(`<sub> renders as subscript when unfocused`, async () => {
  const markdown = `H<sub>2</sub>O is water\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`H`);
  expect(text).toContain(`2`);
  expect(text).not.toContain(`<sub>`);
  expect(text).not.toContain(`</sub>`);

  const sub = firstLine.locator(`sub`);
  await expect(sub).toBeVisible();
  expect(await sub.textContent()).toBe(`2`);
});

test(`<sup> renders as superscript when unfocused`, async () => {
  const markdown = `x<sup>2</sup> + y<sup>2</sup>\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).not.toContain(`<sup>`);
  expect(text).not.toContain(`</sup>`);

  const sups = firstLine.locator(`sup`);
  expect(await sups.count()).toBe(2);
  expect(await sups.first().textContent()).toBe(`2`);
  expect(await sups.last().textContent()).toBe(`2`);
});

test(`<mark> renders as highlighted text when unfocused`, async () => {
  const markdown = `This is <mark>highlighted</mark> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`highlighted`);
  expect(text).not.toContain(`<mark>`);
  expect(text).not.toContain(`</mark>`);

  const mark = firstLine.locator(`mark`);
  await expect(mark).toBeVisible();
  expect(await mark.textContent()).toBe(`highlighted`);
});

test(`<u> renders as underlined text when unfocused`, async () => {
  const markdown = `This is <u>underlined</u> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`underlined`);
  expect(text).not.toContain(`<u>`);
  expect(text).not.toContain(`</u>`);

  const u = firstLine.locator(`u`);
  await expect(u).toBeVisible();
  expect(await u.textContent()).toBe(`underlined`);
});

test(`<s> renders as strikethrough when unfocused`, async () => {
  const markdown = `This is <s>struck</s> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`struck`);
  expect(text).not.toContain(`<s>`);
  expect(text).not.toContain(`</s>`);

  const s = firstLine.locator(`s`);
  await expect(s).toBeVisible();
  expect(await s.textContent()).toBe(`struck`);
});

test(`HTML <strong> renders like markdown bold when unfocused`, async () => {
  const markdown = `HTML <strong>bold</strong> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`bold`);
  expect(text).not.toContain(`<strong>`);
  expect(text).not.toContain(`</strong>`);

  const strong = firstLine.locator(`strong`);
  await expect(strong).toBeVisible();
  expect(await strong.textContent()).toBe(`bold`);
});

test(`HTML <em> renders like markdown italic when unfocused`, async () => {
  const markdown = `HTML <em>italic</em> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`italic`);
  expect(text).not.toContain(`<em>`);
  expect(text).not.toContain(`</em>`);

  const em = firstLine.locator(`em`);
  await expect(em).toBeVisible();
  expect(await em.textContent()).toBe(`italic`);
});

test(`HTML <del> renders like markdown strikethrough when unfocused`, async () => {
  const markdown = `HTML <del>deleted</del> text\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).toContain(`deleted`);
  expect(text).not.toContain(`<del>`);
  expect(text).not.toContain(`</del>`);

  const del = firstLine.locator(`del`);
  await expect(del).toBeVisible();
  expect(await del.textContent()).toBe(`deleted`);
});

test(`<b> and <i> render correctly when unfocused`, async () => {
  const markdown = `Use <b>bold</b> and <i>italic</i> tags\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const text = await firstLine.innerText();
  expect(text).not.toContain(`<b>`);
  expect(text).not.toContain(`<i>`);

  const b = firstLine.locator(`b`);
  await expect(b).toBeVisible();
  expect(await b.textContent()).toBe(`bold`);

  const i = firstLine.locator(`i`);
  await expect(i).toBeVisible();
  expect(await i.textContent()).toBe(`italic`);
});

test(`nested markdown inside HTML tag renders correctly`, async () => {
  const markdown = `Text <mark>**bold** inside</mark> here\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();
  const mark = firstLine.locator(`mark`);
  await expect(mark).toBeVisible();

  const strong = mark.locator(`strong`);
  await expect(strong).toBeVisible();
  expect(await strong.textContent()).toBe(`bold`);

  const markText = await mark.textContent();
  expect(markText).toContain(`bold`);
  expect(markText).toContain(`inside`);
});

test(`focused line renders inline HTML as WYSIWYG elements`, async () => {
  const markdown = `H<sub>2</sub>O is water\n\nSecond paragraph`;
  await loadContent(page, markdown);

  await setWritingView(page);
  await page.waitForTimeout(200);

  // Click the first line so it is the focused line, which still renders
  // its inline HTML as elements.
  const firstLine = page.locator(`#editor [data-node-id]`).first();
  await clickInEditor(page, firstLine);
  await page.waitForTimeout(200);

  // Even on the active line, <sub> renders as a real subscript element.
  const sub = firstLine.locator(`sub`);
  await expect(sub).toBeVisible();
  expect(await sub.textContent()).toBe(`2`);
});

test(`mixed markdown and HTML inline tags render correctly`, async () => {
  const markdown = `Water is H<sub>2</sub>O and **bold** with \`code\`\n\nSecond paragraph`;
  await loadAndDefocusFirstLine(markdown);

  const firstLine = page.locator(`#editor [data-node-id]`).first();

  const sub = firstLine.locator(`sub`);
  await expect(sub).toBeVisible();
  expect(await sub.textContent()).toBe(`2`);

  const strong = firstLine.locator(`strong`);
  await expect(strong).toBeVisible();
  expect(await strong.textContent()).toBe(`bold`);

  const code = firstLine.locator(`code`);
  await expect(code).toBeVisible();
  expect(await code.textContent()).toBe(`code`);
});
