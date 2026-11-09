/**
 * @fileoverview Integration tests for the writing view rendering each
 * markdown block as the HTML element it stands for.
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

/** @type {import('@playwright/test').ElectronApplication} */
let electronApp;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

test(`headings render as h1 to h6 with the text directly inside`, async () => {
  await loadContent(
    page,
    `# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n`,
  );
  await setWritingView(page);

  const names = [`One`, `Two`, `Three`, `Four`, `Five`, `Six`];
  for (let level = 1; level <= 6; level++) {
    const heading = page.locator(`#editor > h${level}.md-heading${level}[data-node-id]`);
    await expect(heading).toHaveText(names[level - 1]);
    await expect(heading.locator(`.md-content`)).toHaveCount(0);
  }
});

test(`paragraph renders as p`, async () => {
  await loadContent(page, `Just a paragraph\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > p.md-paragraph[data-node-id]`)).toHaveText(
    `Just a paragraph`,
  );
});

test(`blockquote renders as blockquote containing a p`, async () => {
  await loadContent(page, `> Quoted text\n`);
  await setWritingView(page);

  const quote = page.locator(`#editor > blockquote.md-blockquote[data-node-id]`);
  await expect(quote).toHaveCount(1);
  await expect(quote.locator(`> p.md-content`)).toHaveText(`Quoted text`);
});

test(`image renders as p containing img`, async () => {
  await loadContent(page, `![Photo](image.png)\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > p.md-image[data-node-id] > img[alt="Photo"]`)).toHaveCount(
    1,
  );
});

test(`linked image renders as p containing a containing img`, async () => {
  await loadContent(page, `[![Photo](image.png)](https://example.com)\n`);
  await setWritingView(page);

  await expect(
    page.locator(`#editor > p.md-image[data-node-id] > a > img[alt="Photo"]`),
  ).toHaveCount(1);
});

test(`table renders as table without a wrapper`, async () => {
  await loadContent(page, `| Name | Age |\n|------|-----|\n| Alice | 30 |\n`);
  await setWritingView(page);

  const table = page.locator(`#editor > table.md-table[data-node-id]`);
  await expect(table).toHaveCount(1);
  await expect(table.locator(`> thead > tr > th`).first()).toHaveText(`Name`);
  await expect(table.locator(`> tbody > tr > td`).first()).toHaveText(`Alice`);
});

test(`code block renders as pre containing code`, async () => {
  await loadContent(page, `\`\`\`js\nconst x = 1;\n\`\`\`\n`);
  await setWritingView(page);

  const pre = page.locator(`#editor > pre.md-code-block[data-node-id]`);
  await expect(pre).toHaveCount(1);
  await expect(pre.locator(`> code.md-content`)).toHaveText(`const x = 1;`);
});

test(`horizontal rule renders as hr without a wrapper`, async () => {
  await loadContent(page, `Above\n\n---\n\nBelow\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > hr.md-horizontal-rule[data-node-id]`)).toHaveCount(1);
  await expect(page.locator(`#editor > p + hr + p`)).toHaveCount(1);
});

test(`bullet list renders as ul containing li without style attributes`, async () => {
  await loadContent(page, `- Alpha\n- Beta\n`);
  await setWritingView(page);

  const items = page.locator(`#editor > ul > li.md-list-item[data-node-id]`);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText(`Alpha`);
  await expect(items.nth(1)).toHaveText(`Beta`);
  await expect(page.locator(`#editor li[style]`)).toHaveCount(0);
  await expect(page.locator(`#editor > ul`)).toHaveCount(1);
});

test(`numbered list renders as ol containing li`, async () => {
  await loadContent(page, `1. Alpha\n2. Beta\n`);
  await setWritingView(page);

  const items = page.locator(`#editor > ol > li.md-list-item[data-node-id]`);
  await expect(items).toHaveCount(2);
  await expect(page.locator(`#editor ul`)).toHaveCount(0);
});

test(`indented list item renders as a nested ul inside the parent li`, async () => {
  await loadContent(page, `- Alpha\n  - Nested\n- Beta\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > ul > li`)).toHaveCount(2);
  const nested = page.locator(`#editor > ul > li:first-child > ul:last-child > li`);
  await expect(nested).toHaveText(`Nested`);
  await expect(page.locator(`#editor > ul > li:nth-child(2)`)).toHaveText(`Beta`);
});

test(`ordered item after a nested list is the second li of the ol`, async () => {
  await loadContent(page, `1. Alpha\n   1. Nested\n2. Beta\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > ol > li:first-child > ol > li`)).toHaveText(`Nested`);
  await expect(page.locator(`#editor > ol > li:nth-child(2)`)).toHaveText(`Beta`);
  await expect(page.locator(`#editor > ol > li`)).toHaveCount(2);
});

test(`changing list type at the same level starts a new list`, async () => {
  await loadContent(page, `- Alpha\n1. Beta\n`);
  await setWritingView(page);

  await expect(page.locator(`#editor > ul + ol`)).toHaveCount(1);
  await expect(page.locator(`#editor > ul > li`)).toHaveText(`Alpha`);
  await expect(page.locator(`#editor > ol > li`)).toHaveText(`Beta`);
});

test(`checklist item renders as li with a checkbox and no bullet`, async () => {
  await loadContent(page, `- [ ] Task\n`);
  await setWritingView(page);

  const item = page.locator(`#editor > ul > li.md-list-item.md-checklist-item[data-node-id]`);
  await expect(item).toHaveCount(1);
  await expect(item.locator(`input[type="checkbox"]`)).toHaveCount(1);
  await expect(item).not.toHaveAttribute(`style`, /./);
  const style = await item.evaluate((el) => window.getComputedStyle(el).listStyleType);
  expect(style).toBe(`none`);
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
