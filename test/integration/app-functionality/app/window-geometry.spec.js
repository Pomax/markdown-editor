/**
 * @fileoverview Integration tests for the window's size and position: the
 * starting size with no saved bounds, the bounds saved for a window closed
 * where it started, the minimum size, the bounds saved after a move and a
 * resize, and the bounds and maximized state restored on the next launch.
 * The window stays hidden throughout, except on Linux, where it shows on a
 * virtual display of its own, so a maximized window there fills the work
 * area while the bounds it restores to stay saved. The page keeps the
 * window's own size; the hooks report its outer bounds, its page size and
 * its monitor's work area in logical pixels. For a shown window they
 * report the position and the maximized state the app last heard from the
 * window manager, which reach it some time after the window shows, so the
 * bounds a launch restores are read until they are the restored ones. The
 * tests run in order, each launch seeing the settings the previous one
 * saved.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

/** Whether the test window shows: on Linux only, on a virtual display of its own. */
const SHOWN = process.platform === `linux`;

/**
 * Launches the app with the page at the window's own size, so the window
 * is measured as it is.
 * @returns {ReturnType<typeof launchApp>}
 */
function launchMeasured() {
  return launchApp([], { keepWindowSize: true });
}

/** The page width the window starts with (`PAGE_WIDTH` in main.rs). */
const PAGE_WIDTH = 1216;

/** The whole window's starting height (main.rs). */
const WINDOW_HEIGHT = 1131;

/** The narrowest page (`MIN_PAGE_WIDTH` in main.rs). */
const MIN_PAGE_WIDTH = process.platform === `darwin` ? 1003 : 998;

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
 * The bounds the app gives a window that it keeps inside the work area:
 * no larger than the work area, and moved inside it.
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {WindowState['workArea']} workArea
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function keptInWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, Math.round(workArea.width));
  const height = Math.min(bounds.height, Math.round(workArea.height));
  const right = Math.round(workArea.x + workArea.width) - width;
  const bottom = Math.round(workArea.y + workArea.height) - height;
  return {
    x: Math.min(Math.max(Math.round(bounds.x), Math.round(workArea.x)), right),
    y: Math.min(Math.max(Math.round(bounds.y), Math.round(workArea.y)), bottom),
    width,
    height,
  };
}

/**
 * The bounds the move and resize test gives the window, kept inside the
 * work area.
 * @param {WindowState['workArea']} workArea
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function movedInWorkArea(workArea) {
  return keptInWorkArea(
    {
      x: workArea.x + MOVED.dx,
      y: workArea.y + MOVED.dy,
      width: MOVED.width,
      height: MOVED.height,
    },
    workArea,
  );
}

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

/** launchApp's settings folder for this spec. */
const SETTINGS_DIR = path.join(
  projectRoot,
  `test-results`,
  `settings`,
  path.basename(import.meta.filename),
);

/**
 * Deletes the saved settings, so the next launch has no saved bounds. An
 * app that is still exiting keeps its settings database open, which
 * Windows refuses to delete, so the deletion is retried until it has.
 * @returns {Promise<void>}
 */
async function clearSettings() {
  await expect(() => {
    fs.rmSync(SETTINGS_DIR, { recursive: true, force: true });
  }).toPass({ timeout: 3_000 });
}

test.beforeAll(clearSettings);

test(`with no saved bounds the window starts with a 1216 wide page, 1131 high, kept inside the work area`, async () => {
  const { app } = await launchMeasured();
  try {
    const state = await windowState(app);
    const frameWidth = state.width - state.innerWidth;
    expect(state.visible).toBe(SHOWN);
    expect(state.innerWidth).toBe(
      Math.min(PAGE_WIDTH, Math.round(state.workArea.width) - frameWidth),
    );
    expect(state.height).toBe(Math.min(WINDOW_HEIGHT, Math.round(state.workArea.height)));
    expect(state.maximized).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test(`a window closed where it started saves the bounds it started with`, async () => {
  await clearSettings();
  const first = await launchMeasured();
  const { workArea } = await windowState(first.app);
  await closeApp(first.app);
  const second = await launchMeasured();
  try {
    const saved = await second.app.settings.get(`windowBounds`);
    expect(saved.width).toBeGreaterThanOrEqual(Math.min(PAGE_WIDTH, Math.round(workArea.width)));
    expect(saved.height).toBe(Math.min(WINDOW_HEIGHT, Math.round(workArea.height)));
  } finally {
    await closeApp(second.app);
  }
});

test(`at its starting size the page shows everything without running past the right edge`, async ({}, testInfo) => {
  const { app, page } = await launchMeasured();
  try {
    const state = await windowState(app);
    await page.setViewportSize({ width: state.innerWidth, height: state.innerHeight });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    if (process.platform !== `darwin`) {
      await page.screenshot({ path: testInfo.outputPath(`starting-size.png`) });
    }
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
  const { app } = await launchMeasured();
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
  const { app } = await launchMeasured();
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
  const { app } = await launchMeasured();
  try {
    const { workArea } = await windowState(app);
    await expect
      .poll(async () => {
        const state = await windowState(app);
        return { x: state.x, y: state.y, width: state.width, height: state.height };
      })
      .toEqual(movedInWorkArea(workArea));
    expect((await windowState(app)).maximized).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test(`a maximized window is restored maximized, with the bounds it restores to`, async () => {
  const first = await launchMeasured();
  const { workArea } = await windowState(first.app);
  const moved = movedInWorkArea(workArea);
  try {
    await first.app.maximize();
    await expect
      .poll(async () => (await first.app.settings.get(`windowBounds`))?.isMaximized)
      .toBe(true);
    const saved = await first.app.settings.get(`windowBounds`);
    expect({ width: saved.width, height: saved.height }).toEqual({
      width: moved.width,
      height: moved.height,
    });
  } finally {
    await closeApp(first.app);
  }

  const second = await launchMeasured();
  try {
    if (SHOWN) {
      await expect
        .poll(async () => {
          const { maximized, width, height } = await windowState(second.app);
          return { maximized, width, height };
        })
        .toEqual({
          maximized: true,
          width: Math.round(workArea.width),
          height: Math.round(workArea.height),
        });
    }
    const state = await windowState(second.app);
    expect(state.maximized).toBe(true);
    expect(state.visible).toBe(SHOWN);
    const restoresTo = SHOWN ? await second.app.settings.get(`windowBounds`) : state;
    expect({ width: restoresTo.width, height: restoresTo.height }).toEqual({
      width: moved.width,
      height: moved.height,
    });
    if (SHOWN) {
      expect({ width: state.width, height: state.height }).toEqual({
        width: Math.round(state.workArea.width),
        height: Math.round(state.workArea.height),
      });
    }
  } finally {
    await closeApp(second.app);
  }
});
