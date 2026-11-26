/**
 * @fileoverview Browser tests for where the toolbar is drawn: in the
 * document area, the area beside the table of contents, at the bottom by
 * default and at the edge its position names, centred along that edge and
 * `--button-margin` from it, and vertical at the left and the right.
 */

import { expect, test } from '@playwright/test';
import { openServedPage, setToolbarPosition, toolbarLayout } from '../integration/test-utils.js';

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

test(`the toolbar is at the bottom of the document area by default, centred, --button-margin from the bottom`, async () => {
  const layout = await toolbarLayout(page);
  expect(layout.bottom, JSON.stringify(layout)).toBe(layout.margin);
  expect(Math.abs(layout.left - layout.right), JSON.stringify(layout)).toBeLessThanOrEqual(1);
  expect(layout.width, JSON.stringify(layout)).toBeGreaterThan(layout.height);
});

test(`at the top the toolbar is centred, --button-margin from the top`, async () => {
  await setToolbarPosition(page, `top`);
  const layout = await toolbarLayout(page);
  expect(layout.top, JSON.stringify(layout)).toBe(layout.margin);
  expect(Math.abs(layout.left - layout.right), JSON.stringify(layout)).toBeLessThanOrEqual(1);
  expect(layout.width, JSON.stringify(layout)).toBeGreaterThan(layout.height);
});

test(`at the left the toolbar is vertical, centred, --button-margin from the left`, async () => {
  await setToolbarPosition(page, `left`);
  const layout = await toolbarLayout(page);
  expect(layout.left, JSON.stringify(layout)).toBe(layout.margin);
  expect(Math.abs(layout.top - layout.bottom), JSON.stringify(layout)).toBeLessThanOrEqual(1);
  expect(layout.height, JSON.stringify(layout)).toBeGreaterThan(layout.width);
});

test(`at the right the toolbar is vertical, centred, --button-margin from the right`, async () => {
  await setToolbarPosition(page, `right`);
  const layout = await toolbarLayout(page);
  expect(layout.right, JSON.stringify(layout)).toBe(layout.margin);
  expect(Math.abs(layout.top - layout.bottom), JSON.stringify(layout)).toBeLessThanOrEqual(1);
  expect(layout.height, JSON.stringify(layout)).toBeGreaterThan(layout.width);
});
