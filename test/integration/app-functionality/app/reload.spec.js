/**
 * @fileoverview Integration test for the reload functionality.
 * Verifies that Help → Reload reloads the front-end and restores
 * open files from the database (same as a normal app launch).
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';
import { parser } from '../../../../src/parsers/old/dfa-parser.js';

const readmePath = path.join(projectRoot, `README.md`);
const readmeContent = fs.readFileSync(readmePath, `utf-8`);

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

test(`reload restores a saved file from disk`, async () => {
  // Persist the README as the open file in the settings DB so that
  // reload has something to restore.
  await app.settings.set(`openFiles`, [
    {
      filePath: readmePath,
      active: true,
      cursorOffset: 0,
      contentHash: 0,
      scrollTop: 0,
      cursorPath: undefined,
      tocHeadingPath: undefined,
    },
  ]);

  // Trigger reload via the IPC API
  await page.evaluate(() => window.pageToBackendBridge?.reload());

  // Wait for the page to fully reload and the editor to re-initialise
  await page.waitForFunction(
    () => {
      return document.readyState === `complete` && !!window.editorAPI;
    },
    { timeout: 10000 },
  );

  // Wait for the content to be restored from disk
  const [readmeNode] = (await parser.parse(readmeContent)).children;
  const nodeMarkdown = readmeNode.toMarkdown();
  await page.waitForFunction(
    (markdown) => {
      const content = window.editorAPI?.getContent() ?? ``;
      return content.includes(markdown);
    },
    nodeMarkdown,
    { timeout: 10000 },
  );

  // Verify the content matches the on-disk file
  const contentAfter = await page.evaluate(() => window.editorAPI?.getContent() ?? ``);
  expect(contentAfter).toContain(nodeMarkdown);
});
