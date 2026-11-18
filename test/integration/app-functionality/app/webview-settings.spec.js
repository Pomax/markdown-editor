/**
 * @fileoverview Checks the WebView2 settings and browser arguments the
 * app gives the webview, read back through the
 * `webviewSettings` hook, and their effects as the page sees them: an
 * English locale, media allowed to play without a user gesture, and a
 * fullscreen request refused, with nothing going fullscreen.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from '../../test-utils.js';

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

test(`the WebView2 settings the app does not use are turned off`, async () => {
  const settings = await app.webviewSettings();
  expect(settings).toMatchObject({
    statusBar: false,
    browserAcceleratorKeys: false,
    zoomControl: false,
    pinchZoom: false,
    swipeNavigation: false,
    generalAutofill: false,
    passwordAutosave: false,
    defaultScriptDialogs: false,
    trackingPrevention: `none`,
  });
});

test(`WebView2 raises its context menu requests, which the app answers itself`, async () => {
  expect((await app.webviewSettings()).defaultContextMenus).toBe(true);
});

test(`the browser arguments keep Tauri's defaults in one --disable-features switch`, async () => {
  const { browserArguments } = await app.webviewSettings();
  /** @type {string[]} */
  const args = browserArguments.split(/\s+/);
  const features = args.filter((arg) => arg.startsWith(`--disable-features=`));
  expect(features).toHaveLength(1);
  expect(features[0].slice(`--disable-features=`.length).split(`,`)).toEqual(
    expect.arrayContaining([`msWebOOUI`, `msPdfOOUI`, `msSmartScreenProtection`]),
  );
  expect(args).toEqual(
    expect.arrayContaining([
      `--js-flags=--max-old-space-size=0`,
      `--lang=en-US`,
      `--autoplay-policy=no-user-gesture-required`,
    ]),
  );
});

test(`the page's language and number format are English`, async () => {
  const seen = await page.evaluate(() => ({
    language: navigator.language,
    count: (1234).toLocaleString(),
  }));
  expect(seen).toEqual({ language: `en-US`, count: `1,234` });
});

test(`media may play without a user gesture`, async () => {
  // An audio context made as the page loads, before any user gesture,
  // starts running only when media may play without one.
  await page.addInitScript(() => {
    /** @type {any} */ (window).autoplayProbe = new AudioContext();
  });
  await page.reload();
  await page.waitForFunction(() => document.readyState === `complete`);
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).autoplayProbe?.state))
    .toBe(`running`);
});

test(`a fullscreen request after a click does nothing`, async () => {
  await page.evaluate(() => {
    const button = document.createElement(`button`);
    button.id = `fullscreen-probe`;
    button.textContent = `Fullscreen`;
    button.style.cssText = `position: fixed; left: 0; top: 0; z-index: 99999;`;
    button.addEventListener(`click`, () => {
      document.documentElement.requestFullscreen().then(
        () => {
          /** @type {any} */ (window).fullscreenRequest = `granted`;
        },
        (error) => {
          /** @type {any} */ (window).fullscreenRequest = String(error);
        },
      );
    });
    document.body.append(button);
  });
  await page.click(`#fullscreen-probe`);
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).fullscreenRequest ?? ``))
    .toMatch(/^TypeError: /);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect((await app.windowState()).fullscreen).toBe(false);
});
