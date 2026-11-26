/**
 * @fileoverview Integration tests for page resize handles.
 *
 * Verifies that dragging a handle changes the page width and persists the
 * new value to settings.
 *
 * Drag tests dispatch real DOM MouseEvents via page.evaluate() rather
 * than using Playwright's mouse abstraction, which does not reliably
 * trigger the handle's event listeners.
 */

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, setWritingView } from '../../test-utils.js';

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

/**
 * Simulate a drag on a resize handle by dispatching real DOM MouseEvents.
 * @param {import('@playwright/test').Page} pg
 * @param {'left'|'right'} side
 * @param {number} dx - Horizontal pixel distance to drag (positive = rightward)
 */
async function simulateDrag(pg, side, dx) {
  await pg.evaluate(
    ([s, delta]) => {
      const d = /** @type {number} */ (delta);
      const handle = document.querySelector(`.editor-resize-handle--${s}`);
      if (!handle) throw new Error(`Handle .editor-resize-handle--${s} not found`);
      const rect = handle.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;

      /** @param {EventTarget} target @param {string} type @param {number} x @param {number} y */
      const fire = (target, type, x, y) =>
        target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

      fire(handle, `mousedown`, startX, startY);
      // Several intermediate moves for realism
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        fire(document, `mousemove`, startX + (d * i) / steps, startY);
      }
      fire(document, `mouseup`, startX + d, startY);
    },
    [side, dx],
  );
  // Let rAF and persist settle
  await pg.waitForTimeout(200);
}

test(`dragging the right handle increases page width`, async () => {
  await setWritingView(page);

  // Reset to a known narrow max-width so the drag has room to grow.
  await page.evaluate(() => {
    document.documentElement.style.setProperty(`--page-max-width`, `400px`);
  });

  const initialMaxWidth = await page.evaluate(() =>
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(`--page-max-width`),
    ),
  );

  await simulateDrag(page, `right`, 50);

  const newMaxWidth = await page.evaluate(() =>
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(`--page-max-width`),
    ),
  );
  expect(newMaxWidth).toBeGreaterThan(initialMaxWidth);
});

test(`dragging the left handle increases page width`, async () => {
  await setWritingView(page);

  // Reset to a known narrow max-width so the drag has room to grow.
  await page.evaluate(() => {
    document.documentElement.style.setProperty(`--page-max-width`, `400px`);
  });

  const initialMaxWidth = await page.evaluate(() =>
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(`--page-max-width`),
    ),
  );

  await simulateDrag(page, `left`, -50);

  const newMaxWidth = await page.evaluate(() =>
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(`--page-max-width`),
    ),
  );
  expect(newMaxWidth).toBeGreaterThan(initialMaxWidth);
});

test(`page width is persisted to settings after drag`, async () => {
  await setWritingView(page);

  await simulateDrag(page, `right`, 30);

  const setting = await page.evaluate(async () => {
    const result = await window.pageToBackendBridge?.getSetting(`pageWidth`);
    return result?.value;
  });

  expect(setting).toBeTruthy();
  expect(setting.useFixed).toBe(false);
  expect(setting.unit).toBe(`px`);
  expect(setting.width).toBeGreaterThan(0);
});
