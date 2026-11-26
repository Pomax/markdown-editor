/**
 * @fileoverview Browser tests for HTML <img> tag rendering: an HTML img tag
 * is parsed as an image node in writing mode, and its class is applied to
 * the rendered image.
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

test(`HTML img tag is parsed as an image node in writing mode`, async () => {
  await loadContent(page, HTML_IMG);
  await setWritingView(page);

  const imageNode = page.locator(`[data-node-id].md-image`);
  await expect(imageNode).toBeVisible();

  // The rendered <img> element should exist
  const img = page.locator(`.md-image img`);
  await expect(img).toBeVisible();
});

test(`HTML img class is applied to the rendered image in writing mode`, async () => {
  await loadContent(page, HTML_IMG_CLASS);
  await setWritingView(page);

  const img = page.locator(`.md-image img`);
  await expect(img).toBeVisible();
  await expect(img).toHaveClass(`wide framed`);
});
