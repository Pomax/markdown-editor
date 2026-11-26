/**
 * @fileoverview Integration tests for HTML block container support.
 * Loads test/fixtures/nested.md which contains headings both inside and
 * outside an HTML `<div>` element, then verifies that clicking a heading
 * inside or after the HTML block container marks the toolbar's heading
 * button for that heading's level as active.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clickInEditor, closeApp, launchApp, loadContent, projectRoot } from '../../test-utils.js';

const fixturePath = path.join(projectRoot, `test`, `fixtures`, `nested.md`);
const fixtureContent = fs.readFileSync(fixturePath, `utf-8`);

/** @type {import('../../tauri-app.js').TauriApp} */
let app;

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());

  // Load the nested fixture content into the editor.
  await loadContent(page, fixtureContent);
});

test.afterAll(async () => {
  await closeApp(app);
});

test(`toolbar flags heading inside HTML block as h2`, async () => {
  // Click on the heading inside the <div>.
  const nestedHeading = page.locator(`#editor .md-heading2`, {
    hasText: `and this an h2`,
  });
  await clickInEditor(page, nestedHeading);
  await page.waitForTimeout(200);

  // The h2 toolbar button should be active (not greyed out).
  const h2Button = page.locator(`[data-button-id="heading2"]`);
  await expect(h2Button).not.toBeDisabled();
  await expect(h2Button).toHaveClass(/active/);
});

test(`toolbar flags heading after HTML block as h2`, async () => {
  // Click on the heading that comes after the </div>.
  const trailingHeading = page.locator(`#editor .md-heading2`, {
    hasText: `with another heading`,
  });
  await clickInEditor(page, trailingHeading);
  await page.waitForTimeout(200);

  // The h2 toolbar button should be active (not greyed out).
  const h2Button = page.locator(`[data-button-id="heading2"]`);
  await expect(h2Button).not.toBeDisabled();
  await expect(h2Button).toHaveClass(/active/);
});
