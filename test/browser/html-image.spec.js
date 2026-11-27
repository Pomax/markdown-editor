/**
 * @fileoverview Browser tests for HTML <img> tag rendering: a line of HTML
 * img tags renders as one paragraph holding every image inline, with the
 * attributes each tag was written with, and a div of img and br tags
 * renders as that div holding those images and line breaks, followed by
 * what the markdown after an empty line in it renders as.
 */

import { expect, test } from '@playwright/test';
import {
  FIXTURE_IMAGE,
  loadContent,
  openServedPage,
  setWritingView,
} from '../integration/test-utils.js';

/** @type {import('@playwright/test').Page} */
let page;

/** @type {() => Promise<void>} */
let close;

const HTML_IMG = `<img src="${FIXTURE_IMAGE}" alt="HTML image" style="display: inline-block; zoom: 80%;" />`;
const HTML_IMG_CLASS = `<img src="${FIXTURE_IMAGE}" alt="HTML image" class="wide framed" />`;

test.beforeAll(async ({ browser }) => {
  ({ page, close } = await openServedPage(browser));
});

test.afterAll(async () => {
  await close();
});

test(`HTML img tag renders as an img inside a paragraph in writing mode`, async () => {
  await loadContent(page, HTML_IMG);
  await setWritingView(page);

  const img = page.locator(`#editor > p.md-paragraph[data-node-id] > img`);
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute(`src`, FIXTURE_IMAGE);
  await expect(img).toHaveAttribute(`alt`, `HTML image`);
  await expect(img).toHaveAttribute(`style`, `display: inline-block; zoom: 80%;`);
});

test(`HTML img class is applied to the rendered image in writing mode`, async () => {
  await loadContent(page, HTML_IMG_CLASS);
  await setWritingView(page);

  const img = page.locator(`#editor > p.md-paragraph > img`);
  await expect(img).toBeVisible();
  await expect(img).toHaveClass(`wide framed`);
});

test(`the images in a line of HTML img tags all sit on the same line`, async () => {
  const pixel = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;
  const line = [0, 1, 2].map((n) => `<img src="${pixel}" width="40" alt="tile ${n}">`).join(` `);
  await loadContent(page, line);
  await setWritingView(page);

  const imgs = page.locator(`#editor > p.md-paragraph > img`);
  await expect(imgs).toHaveCount(3);
  const measured = await imgs.evaluateAll((elements) =>
    elements.map((img) => ({
      bottom: img.getBoundingClientRect().bottom,
      marginBottom: getComputedStyle(img).marginBottom,
    })),
  );
  expect(measured).toEqual(measured.map(() => measured[0]));
});

test(`a div of HTML img and br tags renders as that div, holding the images and line breaks`, async () => {
  /** @param {number} n */
  const img = (n) => `<img src="${FIXTURE_IMAGE}" style="border: 1px solid grey" alt="tile ${n}">`;
  await loadContent(page, `<div>${img(0)}\n${img(1)}<br>\n${img(2)}\n</div>`);
  await setWritingView(page);

  const div = page.locator(`#editor > div[data-node-id]`);
  await expect(div).toHaveCount(1);
  expect(await div.evaluate((el) => [...el.children].map((child) => child.tagName))).toEqual([
    `IMG`,
    `IMG`,
    `BR`,
    `IMG`,
  ]);
  await expect(div).toHaveCSS(`white-space`, `normal`);
  const imgs = div.locator(`> img`);
  for (let n = 0; n < 3; n++) {
    await expect(imgs.nth(n)).toHaveAttribute(`src`, FIXTURE_IMAGE);
    await expect(imgs.nth(n)).toHaveAttribute(`alt`, `tile ${n}`);
    await expect(imgs.nth(n)).toHaveAttribute(`style`, `border: 1px solid grey`);
  }
});

test(`a div of HTML img tags with markdown after an empty line renders as that div, holding the images and then the markdown`, async () => {
  const img = `<img src="${FIXTURE_IMAGE}" style="border: 1px solid grey" alt="tile">`;
  await loadContent(page, `<div>${img}<br>\n${img}\n\n# Title\n\nParagraph\n\n</div>`);
  await setWritingView(page);

  const div = page.locator(`#editor > div[data-node-id]`);
  await expect(div).toHaveCount(1);
  expect(await div.evaluate((el) => [...el.children].map((child) => child.tagName))).toEqual([
    `IMG`,
    `BR`,
    `IMG`,
    `H1`,
    `P`,
  ]);
  await expect(div.locator(`> img`).first()).toHaveAttribute(`src`, FIXTURE_IMAGE);
  await expect(div.locator(`> img`).first()).toHaveAttribute(`style`, `border: 1px solid grey`);
  await expect(div.locator(`> h1`)).toHaveText(`Title`);
  await expect(div.locator(`> p`)).toHaveText(`Paragraph`);
});

test(`a line of HTML img tags renders as one paragraph with every image inline`, async () => {
  const line = [0, 1, 2]
    .map((n) => `<img style="border: 1px solid grey" src="${FIXTURE_IMAGE}" alt="tile ${n}">`)
    .join(` `);
  await loadContent(page, line);
  await setWritingView(page);

  const paragraph = page.locator(`#editor > p.md-paragraph[data-node-id]`);
  await expect(paragraph).toHaveCount(1);
  const imgs = paragraph.locator(`> img`);
  await expect(imgs).toHaveCount(3);
  for (let n = 0; n < 3; n++) {
    const img = imgs.nth(n);
    await expect(img).toHaveAttribute(`src`, FIXTURE_IMAGE);
    await expect(img).toHaveAttribute(`alt`, `tile ${n}`);
    await expect(img).toHaveAttribute(`style`, `border: 1px solid grey`);
    await expect(img).toHaveCSS(`display`, `inline`);
  }
});
