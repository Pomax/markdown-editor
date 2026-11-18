/**
 * @fileoverview Checks the Security decisions from the page's side.
 *
 * This file holds the Phase 2 limits (no global Tauri, capability-gated
 * IPC, navigation, new-window and permission limits), the sandbox on a
 * document's same-origin iframes, and the media protocol's refusal of
 * files that are not images, audio or video.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, loadContent, projectRoot } from '../../test-utils.js';

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

test(`window.__TAURI__ is not exposed`, async () => {
  const hasGlobalTauri = await page.evaluate(
    () => typeof (/** @type {any} */ (window).__TAURI__) !== `undefined`,
  );
  expect(hasGlobalTauri).toBe(false);
});

test(`a core command outside the capability rejects`, async () => {
  const rejected = await page.evaluate(async () => {
    try {
      await /** @type {any} */ (window).__TAURI_INTERNALS__.invoke(`plugin:event|emit`, {
        event: `probe`,
        payload: null,
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
});

test(`the page has no scripting API`, async () => {
  const outcome = await page.evaluate(async () => {
    const api = /** @type {any} */ (window).pageToBackendBridge;
    if (!api) throw new Error(`pageToBackendBridge missing`);
    /**
     * @param {string} command
     * @param {Record<string, unknown>} args
     */
    const refused = async (command, args) => {
      try {
        await /** @type {any} */ (window).__TAURI_INTERNALS__.invoke(command, args);
        return false;
      } catch {
        return true;
      }
    };
    return {
      members: [`executeCommand`, `getAvailableCommands`, `onExternalAPI`].filter(
        (name) => name in api,
      ),
      executeRefused: await refused(`api_execute`, { command: `view.getMode`, params: {} }),
      commandsRefused: await refused(`api_commands`, {}),
    };
  });
  expect(outcome).toEqual({ members: [], executeRefused: true, commandsRefused: true });
});

test(`navigating the main frame to a remote URL is blocked`, async () => {
  await page.evaluate(() => {
    try {
      location.href = `https://example.com/`;
    } catch {
      /* navigation blocked */
    }
  });
  await page.waitForTimeout(500);
  expect(page.url().endsWith(`web/index.html`)).toBe(true);
});

test(`window.open of an https URL opens no window and reaches the system browser`, async () => {
  await app.recordOpenedUrls();
  await page.evaluate(() => window.open(`https://example.com/`, `_blank`));
  await page.waitForTimeout(300);
  expect(await app.windowCount()).toBe(1);
  expect(await app.openedUrl()).toBe(`https://example.com/`);
});

test(`an iframe srcdoc in a document is sandboxed away from the page`, async () => {
  await loadContent(page, `<iframe srcdoc="&lt;p&gt;inside&lt;/p&gt;">\n</iframe>`);
  const frame = page.locator(`#editor iframe`).first();
  await expect(frame).toBeAttached();
  const sandbox = await frame.getAttribute(`sandbox`);
  expect(sandbox).not.toBeNull();
  expect(sandbox?.split(/\s+/)).not.toContain(`allow-same-origin`);
  const reachable = await frame.evaluate(
    (/** @type {HTMLIFrameElement} */ element) => element.contentDocument !== null,
  );
  expect(reachable).toBe(false);
});

test(`a media URL for a file that is not an image, audio or video does not load`, async () => {
  // The same image, once with its own extension and once named as text.
  const dir = path.join(projectRoot, `test-results`, `security-media`);
  await fs.mkdir(dir, { recursive: true });
  const image = path.join(projectRoot, `test`, `fixtures`, `image.png`);
  const pngFile = path.join(dir, `image.png`);
  const textFile = path.join(dir, `image.txt`);
  await fs.copyFile(image, pngFile);
  await fs.copyFile(image, textFile);

  const widths = await page.evaluate(
    async (files) => {
      const api = window.pageToBackendBridge;
      if (!api) throw new Error(`pageToBackendBridge missing`);
      /** @param {string} file */
      const width = (file) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
          img.src = api.toDisplayUrl(file);
        });
      return { png: await width(files.png), text: await width(files.text) };
    },
    { png: pngFile, text: textFile },
  );

  expect(widths.png).toBeGreaterThan(0);
  expect(widths.text).toBe(0);
});

test(`a location permission request is denied`, async () => {
  const denied = await page.evaluate(
    () =>
      new Promise((resolve) => {
        if (!navigator.geolocation) {
          resolve(true);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          () => resolve(false),
          () => resolve(true),
          { timeout: 1000 },
        );
      }),
  );
  expect(denied).toBe(true);
});
