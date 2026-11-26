/**
 * @fileoverview Browser test for HTML block containers: with
 * test/fixtures/nested.md loaded, which has headings both inside and
 * outside an HTML `<div>` element, the Table of Contents includes the
 * headings nested inside the div.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { loadContent, openServedPage, projectRoot } from '../integration/test-utils.js';

const fixturePath = path.join(projectRoot, `test`, `fixtures`, `nested.md`);
const fixtureContent = fs.readFileSync(fixturePath, `utf-8`);

/** @type {import('@playwright/test').Page} */
let page;

/** @type {() => Promise<void>} */
let close;

test.beforeAll(async ({ browser }) => {
  ({ page, close } = await openServedPage(browser));
  await loadContent(page, fixtureContent);
});

test.afterAll(async () => {
  await close();
});

test(`ToC includes heading nested inside an HTML block`, async () => {
  // The TOC should list both h2 headings: the one inside the <div>
  // ("and this an h2") and the one outside ("with another heading").
  const tocLinks = page.locator(`#toc-sidebar .toc-link`);

  // There should be at least 3 TOC entries: the h1 title plus 2 h2s.
  await expect(tocLinks).toHaveCount(3);

  const texts = await tocLinks.allInnerTexts();
  expect(texts).toContain(`and this an h2`);
  expect(texts).toContain(`with another heading`);
});
