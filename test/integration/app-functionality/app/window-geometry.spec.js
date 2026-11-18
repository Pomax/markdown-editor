/**
 * @fileoverview Integration tests for the window's size and position: the
 * starting size with no saved bounds, the minimum size, the bounds saved
 * after a move and a resize, and the bounds and maximized state restored
 * on the next launch. The window stays hidden throughout; the hooks report
 * its outer bounds, its page size and its monitor's work area in logical
 * pixels. The tests run in order, each launch seeing the settings the
 * previous one saved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

/** The page width the window starts with (`PAGE_WIDTH` in main.rs). */
const PAGE_WIDTH = 1216;

/** The whole window's starting height (main.rs). */
const WINDOW_HEIGHT = 1131;

/** The narrowest page (`MIN_PAGE_WIDTH` in main.rs). */
const MIN_PAGE_WIDTH = 998;

/** The whole window's minimum height (main.rs). */
const MIN_WINDOW_HEIGHT = 848;

/** The bounds the move and resize test gives the window, from the work area's corner. */
const MOVED = { dx: 100, dy: 50, width: 1300, height: 900 };

/**
 * @typedef {object} WindowState
 * @property {boolean} visible
 * @property {boolean} maximized
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} innerWidth
 * @property {number} innerHeight
 * @property {{ x: number, y: number, width: number, height: number }} workArea
 */

/**
 * The window's state, rounded to whole logical pixels.
 * @param {import('../../tauri-app.js').TauriApp} app
 * @returns {Promise<WindowState>}
 */
async function windowState(app) {
  const state = await app.windowState();
  for (const key of [`x`, `y`, `width`, `height`, `innerWidth`, `innerHeight`]) {
    state[key] = Math.round(state[key]);
  }
  return state;
}

test.beforeAll(() => {
  // launchApp's settings folder for this spec, so the first launch has no
  // saved bounds.
  const settingsDir = path.join(
    projectRoot,
    `test-results`,
    `settings`,
    path.basename(import.meta.filename),
  );
  fs.rmSync(settingsDir, { recursive: true, force: true });
});

test(`with no saved bounds the window starts with a 1216 wide page, 1131 high`, async () => {
  const { app } = await launchApp();
  try {
    const state = await windowState(app);
    expect(state.visible).toBe(false);
    expect(state.innerWidth).toBe(PAGE_WIDTH);
    expect(state.height).toBe(Math.min(WINDOW_HEIGHT, Math.round(state.workArea.height)));
    expect(state.maximized).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test(`at its starting size the page shows everything without running past the right edge`, async ({}, testInfo) => {
  const { app, page } = await launchApp();
  try {
    const state = await windowState(app);
    await page.setViewportSize({ width: state.innerWidth, height: state.innerHeight });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: testInfo.outputPath(`starting-size.png`) });
    const widths = await page.evaluate(() => ({
      page: window.innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.page);
  } finally {
    await closeApp(app);
  }
});

test(`the window keeps at least a 998 wide page and 848 high`, async () => {
  const { app } = await launchApp();
  try {
    await app.setWindowBounds({ width: 400, height: 300 });
    await expect
      .poll(async () => {
        const state = await windowState(app);
        return { innerWidth: state.innerWidth, height: state.height };
      })
      .toEqual({ innerWidth: MIN_PAGE_WIDTH, height: MIN_WINDOW_HEIGHT });
  } finally {
    await closeApp(app);
  }
});

test(`a move and a resize are saved as ratios of the work area`, async () => {
  const { app } = await launchApp();
  try {
    const { workArea } = await windowState(app);
    await app.setWindowBounds({
      x: workArea.x + MOVED.dx,
      y: workArea.y + MOVED.dy,
      width: MOVED.width,
      height: MOVED.height,
    });
    await expect
      .poll(async () => {
        const saved = await app.settings.get(`windowBounds`);
        return saved && saved.width === MOVED.width ? saved : null;
      })
      .not.toBeNull();
    const saved = await app.settings.get(`windowBounds`);
    expect(saved.xRatio).toBeCloseTo(MOVED.dx / workArea.width, 3);
    expect(saved.yRatio).toBeCloseTo(MOVED.dy / workArea.height, 3);
    expect(saved.height).toBe(MOVED.height);
    expect(saved.isMaximized).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test(`the saved bounds are restored on the next launch`, async () => {
  const { app } = await launchApp();
  try {
    const state = await windowState(app);
    expect({ x: state.x, y: state.y, width: state.width, height: state.height }).toEqual({
      x: Math.round(state.workArea.x + MOVED.dx),
      y: Math.round(state.workArea.y + MOVED.dy),
      width: MOVED.width,
      height: MOVED.height,
    });
    expect(state.maximized).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test(`a maximized window is restored maximized, with the bounds it restores to`, async () => {
  const first = await launchApp();
  try {
    await first.app.maximize();
    await expect
      .poll(async () => (await first.app.settings.get(`windowBounds`))?.isMaximized)
      .toBe(true);
    const saved = await first.app.settings.get(`windowBounds`);
    expect({ width: saved.width, height: saved.height }).toEqual({
      width: MOVED.width,
      height: MOVED.height,
    });
  } finally {
    await closeApp(first.app);
  }

  const second = await launchApp();
  try {
    const state = await windowState(second.app);
    expect(state.maximized).toBe(true);
    expect(state.visible).toBe(false);
    expect({ width: state.width, height: state.height }).toEqual({
      width: MOVED.width,
      height: MOVED.height,
    });
  } finally {
    await closeApp(second.app);
  }
});
