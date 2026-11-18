/**
 * @fileoverview Shared helpers for the Tauri integration tests.
 *
 * Every test file that launches the app calls {@link launchApp} in its
 * `beforeAll` hook. It spawns the debug test binary (built by
 * build-test-app.js) with a per-launch DevTools port and webview
 * directory and the spec file's own settings directory, attaches
 * Playwright over the Chrome DevTools Protocol, and returns a
 * {@link TauriApp} for the main-process hooks plus the page.
 *
 * WebKitGTK has no DevTools Protocol, so on Linux each launch gets a
 * virtual X display of its own instead, and the page is a LinuxPage: the
 * part of Playwright's Page that the specs use, over WebKitGTK's own
 * inspector, with real X11 input.
 *
 * The standard viewport is 1920 × 1280 so layout-sensitive tests behave
 * the same regardless of the runner's physical screen.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, test } from '@playwright/test';
import { TEST_APP_BINARY } from '../../scripts/build-test-app.js';
import { LinuxPage } from './linux-page.js';
import { TauriApp } from './tauri-app.js';
import { WebKitInspector } from './webkit-inspector.js';
import { X11Input, startVirtualDisplay } from './x11-display.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.join(__dirname, `..`, `..`);

/**
 * The fixture image as a file URL, for documents whose images must load
 * in every webview: WebKitGTK can lay out an image that fails to load
 * with no width.
 */
export const FIXTURE_IMAGE = pathToFileURL(
  path.join(projectRoot, `test`, `fixtures`, `image.png`),
).href;

/** Standard viewport: 1920×1280 (typical desktop). */
export const VIEWPORT = { width: 1920, height: 1280 };

/**
 * Platform-aware modifier key: Meta on macOS, Control everywhere else.
 * Use this for shortcuts like copy/paste/undo (Ctrl+C on Windows → Meta+C on macOS).
 */
const isMac = process.platform === `darwin`;
export const MOD = isMac ? `Meta` : `Control`;

/**
 * Platform-aware modifier label for tooltip assertions.
 * Matches the display text produced by `formatShortcut()` in the renderer.
 */
export const MOD_LABEL = isMac ? `⌘` : `Ctrl`;

/**
 * Platform-aware Home key: Meta+ArrowLeft on macOS, Home everywhere else.
 * Moves the cursor to the beginning of the current line.
 */
export const HOME = isMac ? `Meta+ArrowLeft` : `Home`;

/**
 * Platform-aware End key: Meta+ArrowRight on macOS, End everywhere else.
 * Moves the cursor to the end of the current line.
 */
export const END = isMac ? `Meta+ArrowRight` : `End`;

/**
 * What {@link closeApp} undoes for each returned TauriApp: `detach` before
 * the app closes (the Playwright browser attached to its process, or on
 * Linux the inspector connection), and `release` after (on Linux, the
 * app, killed when it has not exited a second after closing, as when its
 * close was cancelled, and then its X11 runner and virtual display).
 * @type {WeakMap<TauriApp, { detach: () => Promise<unknown>, release: () => Promise<void> }>}
 */
const attachments = new WeakMap();

/**
 * What every launch started that must not outlive this worker process:
 * the apps and, on Linux, their virtual displays. A test that times out
 * never reaches its closeApp, so whatever is still running when the
 * worker exits is stopped then.
 * @type {Set<{ kill: () => unknown }>}
 */
const started = new Set();

process.on(`exit`, () => {
  for (const entry of started) {
    try {
      entry.kill();
    } catch {
      /* already gone */
    }
  }
});

/**
 * What one attempt at a launch gets: the app's arguments, whether its
 * window shows, whether the page keeps the window's own size, its webview
 * and settings directories, and a list to push what undoes each step
 * onto, for a failed attempt.
 * @typedef {object} LaunchAttempt
 * @property {string[]} extraArgs
 * @property {boolean} visible
 * @property {boolean} keepWindowSize
 * @property {string} webviewDir
 * @property {string} settingsDir
 * @property {(() => void)[]} cleanup
 */

/**
 * Resolves after the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds a free TCP port by binding port 0 and releasing it.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on(`error`, reject);
    server.listen(0, () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Whether the DevTools endpoint on the given port answers.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeDevtools(port) {
  return new Promise((resolve) => {
    const req = request({ host: `127.0.0.1`, port, path: `/json/version`, timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on(`error`, () => resolve(false));
    req.on(`timeout`, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Polls until the DevTools endpoint answers or the timeout elapses.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDevtools(port)) return;
    await delay(100);
  }
  throw new Error(`DevTools endpoint on port ${port} did not answer`);
}

/**
 * Returns the page whose URL ends in web/index.html, polling past any
 * transient blank page, or throws on timeout.
 * @param {import('@playwright/test').Browser} browser
 * @param {number} timeoutMs
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function findAppPage(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().endsWith(`web/index.html`)) return page;
      }
    }
    await delay(100);
  }
  throw new Error(`app page (web/index.html) did not appear`);
}

/**
 * Starts the test binary with a DevTools port, attaches Playwright over
 * CDP, and waits for the app page to be ready.
 * @param {LaunchAttempt} attempt
 * @returns {Promise<{ app: TauriApp, page: import('@playwright/test').Page }>}
 */
async function startOverDevtools({
  extraArgs,
  visible,
  keepWindowSize,
  webviewDir,
  settingsDir,
  cleanup,
}) {
  const port = await freePort();
  const child = spawn(TEST_APP_BINARY, extraArgs, {
    env: {
      ...process.env,
      TESTING: `1`,
      TESTING_WEBVIEW_DIR: webviewDir,
      TESTING_DEVTOOLS_PORT: String(port),
      TESTING_SETTINGS_DIR: settingsDir,
      ...(visible ? { TESTING_VISIBLE: `1` } : {}),
    },
    stdio: [`pipe`, `pipe`, `inherit`],
    windowsHide: true,
  });
  started.add(child);
  cleanup.push(() => child.kill());
  await waitForDevtools(port, 15000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await findAppPage(browser, 15000);
  await page.waitForFunction(() => document.readyState === `complete`);
  if (!keepWindowSize) await page.setViewportSize(VIEWPORT);
  const app = new TauriApp(/** @type {any} */ (child));
  attachments.set(app, { detach: () => browser.close(), release: async () => {} });
  return { app, page };
}

/**
 * Starts the test binary on Linux on a virtual X display of its own, which
 * has no GPU, so with software rendering and with Skia drawing on the CPU
 * (through software GL, Skia takes over a second to draw the page's first
 * two frames, and input sent meanwhile reaches the page late), with
 * WebKitGTK's inspector on a
 * port of its own and its webview data in the webview directory, attaches
 * a LinuxPage to its page, and gives the
 * window the input focus. The window is mapped on that display, since
 * WebKitGTK stops rendering the page of a hidden window, so the standard
 * viewport is set by resizing the window.
 * @param {LaunchAttempt} attempt
 * @returns {Promise<{ app: TauriApp, page: import('@playwright/test').Page }>}
 */
async function startOnLinux({ extraArgs, keepWindowSize, webviewDir, settingsDir, cleanup }) {
  const display = await startVirtualDisplay();
  started.add({ kill: display.stop });
  cleanup.push(() => display.stop());
  const port = await freePort();
  const environment = { ...process.env };
  delete environment.WAYLAND_DISPLAY;
  const child = spawn(TEST_APP_BINARY, extraArgs, {
    env: {
      ...environment,
      DISPLAY: display.name,
      GDK_BACKEND: `x11`,
      LIBGL_ALWAYS_SOFTWARE: `1`,
      WEBKIT_SKIA_ENABLE_CPU_RENDERING: `1`,
      NO_AT_BRIDGE: `1`,
      XDG_DATA_HOME: webviewDir,
      XDG_CACHE_HOME: webviewDir,
      WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}`,
      TESTING: `1`,
      TESTING_VISIBLE: `1`,
      TESTING_SETTINGS_DIR: settingsDir,
    },
    stdio: [`pipe`, `pipe`, `inherit`],
  });
  started.add(child);
  cleanup.push(() => child.kill());
  const exited = new Promise((resolve) => child.once(`exit`, resolve));
  const inspector = await WebKitInspector.connect(port, `web/index.html`, 15000);
  cleanup.push(() => inspector.close());
  const app = new TauriApp(/** @type {any} */ (child));
  const input = new X11Input(display.name, child.pid ?? 0);
  cleanup.push(() => input.close());
  const page = new LinuxPage(inspector, input, {
    url: inspector.url,
    resizeWindow: (bounds) => app.setWindowBounds(bounds),
  });
  await page.waitForFunction(() => document.readyState === `complete`);
  await page.focusWindow();
  if (!keepWindowSize) await page.setViewportSize(VIEWPORT);
  attachments.set(app, {
    detach: async () => page.disconnect(),
    release: async () => {
      await Promise.race([exited, delay(1000)]);
      child.kill();
      await Promise.race([exited, delay(1000)]);
      input.close();
      display.stop();
    },
  });
  return { app, page: /** @type {any} */ (page) };
}

/**
 * Launches the Tauri test binary, attaches to its page, waits for the app
 * page to be ready, and sets a predictable viewport.
 *
 * Each launch gets its own DevTools port (on Linux, its own inspector
 * port and virtual display) and webview directory; the settings directory
 * is shared per spec file so its launches see the same settings, all
 * under test-results/. Retries up to three times.
 *
 * With `visible`, the test build shows its window, for the real-input
 * specs, and the page keeps the window's own size, so a point on the page
 * is the same point in the window. With `keepWindowSize`, the page keeps
 * the window's own size without the window showing, for specs that
 * measure the window itself.
 *
 * @param {string[]} [extraArgs]  Additional CLI arguments (e.g. a file path).
 * @param {{ visible?: boolean, keepWindowSize?: boolean }} [options]
 * @returns {Promise<{ app: TauriApp, page: import('@playwright/test').Page }>}
 */
export async function launchApp(
  extraArgs = [],
  { visible = false, keepWindowSize = visible } = {},
) {
  const resultsDir = path.join(projectRoot, `test-results`);
  const settingsDir = path.join(resultsDir, `settings`, path.basename(test.info().file));
  const start = process.platform === `linux` ? startOnLinux : startOverDevtools;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    /** @type {(() => void)[]} */
    const cleanup = [];
    try {
      const webviewDir = path.join(
        resultsDir,
        `webview`,
        `${process.pid}-${Date.now()}-${attempt}`,
      );
      mkdirSync(webviewDir, { recursive: true });
      mkdirSync(settingsDir, { recursive: true });
      return await start({ extraArgs, visible, keepWindowSize, webviewDir, settingsDir, cleanup });
    } catch (err) {
      for (const undo of cleanup.reverse()) {
        try {
          undo();
        } catch {
          /* ignore */
        }
      }
      if (attempt === maxAttempts) throw err;
    }
  }
  // Unreachable, but satisfies the type checker.
  throw new Error(`launchApp: max attempts exceeded`);
}

/**
 * Load a fixture file's content into the editor via the IPC bridge, then
 * wait for the editor DOM to settle.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fixtureContent  Raw markdown string to load.
 */
export async function loadContent(page, fixtureContent) {
  await page.waitForFunction(() => window.editorAPI !== undefined);
  await page.evaluate(async (content) => {
    await window.editorAPI?.setContent(content);
  }, fixtureContent);
  // Wait for the editor to settle — the selector depends on the active view.
  const isSource2 = await page
    .locator(`#editor textarea`)
    .isVisible()
    .catch(() => false);
  if (isSource2) {
    await page.locator(`#editor textarea`).waitFor({ state: `visible` });
  } else {
    await page.waitForSelector(`#editor [data-node-id]`);
  }
}

/**
 * Move focus away from the editor so that no node is "focused" in the
 * writing renderer.  Useful after switching view modes when
 * you need to assert that heading syntax is hidden.
 *
 * Clicks a coordinate outside the editor (on the surrounding container
 * padding) so that the full blur event sequence fires naturally.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function defocusEditor(page) {
  // In Firefox, clicking on a non-focusable element (like the
  // editor-container padding) does NOT move focus away from a
  // contenteditable.  Use the native DOM blur() API instead —
  // this fires the full blur / focusout event chain.
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
  // Give the editor time to re-render.
  await page.waitForTimeout(200);
}

/**
 * Click on a locator inside the editor using real mouse coordinates.
 *
 * `locator.click()` dispatches a synthetic event that skips the real
 * browser event sequence (mousedown → selectionchange → mouseup → click).
 * This helper gets the bounding box and fires a real `page.mouse.click()`
 * at the centre of the part of the element inside the viewport, as
 * Playwright's own click does, so the full event chain fires.  An image
 * is first given time to finish loading (or fail), so its box is final.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} locator
 */
export async function clickInEditor(page, locator) {
  await locator.evaluate((el) =>
    el instanceof HTMLImageElement && !el.complete
      ? new Promise((resolve) => {
          el.addEventListener(`load`, resolve, { once: true });
          el.addEventListener(`error`, resolve, { once: true });
        })
      : undefined,
  );
  const box = await locator.boundingBox();
  if (!box) throw new Error(`clickInEditor: element not visible`);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, viewport.width);
  const bottom = Math.min(box.y + box.height, viewport.height);
  if (right <= left || bottom <= top) throw new Error(`clickInEditor: element not in view`);
  await page.mouse.click((left + right) / 2, (top + bottom) / 2);
}

/**
 * Wait for an element matching the given CSS selector, then click it
 * directly via page.evaluate (bypassing Playwright's coordinate-based
 * click, which can be intercepted by overlapping elements).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} qs  CSS selector
 */
export async function clickQuerySelector(page, qs) {
  await page.waitForSelector(qs);
  await page.evaluate(
    (selector) => /** @type {HTMLElement} */ (document.querySelector(selector))?.click(),
    qs,
  );
}

/**
 * Disconnects from the page and closes the Tauri app, killing the process
 * if it does not exit within the close timeout, then releases what the
 * launch held, such as the app's virtual display on Linux.
 *
 * @param {TauriApp} app
 */
export async function closeApp(app) {
  const attachment = attachments.get(app);
  if (attachment) {
    try {
      await attachment.detach();
    } catch {
      /* already disconnected */
    }
  }
  await app.close();
  await attachment?.release();
}

/**
 * Navigate the page to about:blank to clean up browser state between tests.
 * Wrapped in a try/catch because Firefox occasionally throws a
 * "browserContext.close" protocol error during teardown.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function resetPage(page) {
  try {
    await page.goto(`about:blank`);
    await page.waitForTimeout(100);
  } catch {
    /* Firefox teardown glitch — safe to ignore */
  }
}

/**
 * Switch the editor to writing view via the editor API.
 * If already in writing view, this is a no-op.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setWritingView(page) {
  const current = await page.locator(`#editor`).getAttribute(`data-view-mode`);
  if (current === `writing`) return;
  await page.evaluate(() => window.editorAPI?.setViewMode(`writing`));
  await page.locator(`#editor[data-view-mode="writing"]`).waitFor();
}

/**
 * Switch the editor to source2 view via the editor API.
 * If already in source2 view, this is a no-op.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setSource2View(page) {
  const current = await page.locator(`#editor`).getAttribute(`data-view-mode`);
  if (current === `source2`) return;
  await page.evaluate(() => window.editorAPI?.setViewMode(`source2`));
  await page.locator(`#editor[data-view-mode="source2"]`).waitFor();
}

/**
 * Returns the raw markdown text of a specific line in source2 view.
 * @param {import('@playwright/test').Page} pg
 * @param {number} index - 0-based line index.
 * @returns {Promise<string>}
 */
export async function getSourceLineText(pg, index) {
  const value = await pg.locator(`#editor textarea`).inputValue();
  return value.split(`\n`)[index] ?? ``;
}
