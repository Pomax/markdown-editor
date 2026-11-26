/**
 * @fileoverview Integration tests for the HTML elements the writing view
 * renders after typing and toolbar clicks change list items, headings and
 * paragraphs.
 */

import { expect, test } from '@playwright/test';
import {
  MOD,
  closeApp,
  getSourceLineText,
  launchApp,
  loadContent,
  setSource2View,
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

test(`Enter at the end of a list item adds an li to the same ul`, async () => {
  await loadContent(page, `- Alpha\n`);
  await setWritingView(page);

  await page.locator(`#editor li`, { hasText: `Alpha` }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`End`);
  await page.keyboard.press(`Enter`);
  await page.keyboard.type(`Beta`);
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ul`)).toHaveCount(1);
  const items = page.locator(`#editor > ul > li`);
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveText(`Beta`);
});

test(`typing at the end of an item with a nested list writes to that item and keeps the nested list`, async () => {
  await loadContent(page, `- Alpha\n  - Nested\n- Beta\n`);
  await setWritingView(page);

  const parent = page.locator(`#editor > ul > li`).first();
  await parent.click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(200);
  await page.keyboard.press(`End`);
  await page.keyboard.type(`X`);
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ul > li:first-child > ul > li`)).toHaveText(`Nested`);

  await setSource2View(page);
  expect(await getSourceLineText(page, 0)).toBe(`- AlphaX`);
  expect(await getSourceLineText(page, 1)).toBe(`  - Nested`);
});

test(`removing a list item leaves one ul with the remaining items`, async () => {
  await loadContent(page, `- Alpha\n- Beta\n- Gamma\n`);
  await setWritingView(page);

  await page.locator(`#editor li`, { hasText: `Beta` }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`Backspace`);
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ul`)).toHaveCount(1);
  const items = page.locator(`#editor > ul > li`);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText(`Alpha`);
  await expect(items.nth(1)).toHaveText(`Gamma`);
});

test(`switching a bullet list to numbered via the toolbar renders an ol`, async () => {
  await loadContent(page, `- Alpha\n- Beta\n`);
  await setWritingView(page);

  await page.locator(`#editor li`, { hasText: `Alpha` }).click();
  await page.waitForTimeout(200);
  await page.locator(`.toolbar-button[data-button-id="ordered-list"]`).click();
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ol > li`)).toHaveCount(2);
  await expect(page.locator(`#editor ul`)).toHaveCount(0);
});

test(`converting a middle item to a heading splits the list in two`, async () => {
  await loadContent(page, `- Alpha\n- Beta\n- Gamma\n`);
  await setWritingView(page);

  await page.locator(`#editor li`, { hasText: `Beta` }).click();
  await page.waitForTimeout(200);
  await page.locator(`.toolbar-button[data-button-id="heading2"]`).click();
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ul`)).toHaveCount(2);
  await expect(page.locator(`#editor > ul + h2.md-heading2 + ul`)).toHaveCount(1);
  await expect(page.locator(`#editor > h2`)).toHaveText(`Beta`);
  await expect(page.locator(`#editor > ul > li`)).toHaveCount(2);
});

test(`converting a paragraph between two lists to a list item joins the lists`, async () => {
  await loadContent(page, `- Alpha\n\nMiddle\n\n- Gamma\n`);
  await setWritingView(page);

  await page.locator(`#editor p`, { hasText: `Middle` }).click();
  await page.waitForTimeout(200);
  await page.locator(`.toolbar-button[data-button-id="unordered-list"]`).click();
  await page.waitForTimeout(200);

  await expect(page.locator(`#editor > ul`)).toHaveCount(1);
  const items = page.locator(`#editor > ul > li`);
  await expect(items).toHaveCount(3);
  await expect(items.nth(1)).toHaveText(`Middle`);
});
