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
 * inspector, with real X11 input. WKWebView has neither, so on macOS the
 * page is a LinuxPage over the app's test hooks, with key and mouse events
 * sent to the app's unseen window inside its own process.
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
import { MacInput, MacInspector } from './mac-webview.js';
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
 * Waits until pointer input reaches a page that has just started, which
 * WebKit drops after launch until the pointer has moved over the page, by
 * moving the pointer until the page reports seeing it, for at most a
 * second.
 * @param {TauriApp} app
 * @param {LinuxPage} page
 * @returns {Promise<void>}
 */
async function waitForPageInput(app, page) {
  const moves = () => page.evaluateWithHarness(`return harness.seen.mousemove;`);
  const before = await moves();
  const deadline = Date.now() + 1_000;
  for (let x = 1; Date.now() < deadline; x += 1) {
    await app.input(`move`, [String(x), `1`]);
    await delay(25);
    if ((await moves()) > before) return;
  }
}

/**
 * Starts the test binary on macOS, attaches a LinuxPage to its page over
 * the test hooks, and gives the window the input focus.
 * @param {LaunchAttempt} attempt
 * @returns {Promise<{ app: TauriApp, page: import('@playwright/test').Page }>}
 */
async function startOnMac({ extraArgs, keepWindowSize, settingsDir, cleanup }) {
  const child = spawn(TEST_APP_BINARY, extraArgs, {
    env: { ...process.env, TESTING: `1`, TESTING_SETTINGS_DIR: settingsDir },
    stdio: [`pipe`, `pipe`, `inherit`],
  });
  started.add(child);
  cleanup.push(() => child.kill());
  const exited = new Promise((resolve) => child.once(`exit`, resolve));
  const app = new TauriApp(/** @type {any} */ (child));
  const inspector = new MacInspector(app);
  exited.then(() => inspector.close());
  const page = new LinuxPage(
    /** @type {any} */ (inspector),
    /** @type {any} */ (new MacInput(app)),
    {
      url: `tauri://localhost/web/index.html`,
      resizeWindow: ({ width, height }) => app.input(`resize`, [String(width), String(height)]),
      inputWaitMs: 4_000,
    },
  );
  await page.waitForFunction(() => document.readyState === `complete`);
  await page.focusWindow();
  if (!keepWindowSize) await page.setViewportSize(VIEWPORT);
  await waitForPageInput(app, page);
  attachments.set(app, {
    detach: async () => page.disconnect(),
    release: async () => {
      await Promise.race([exited, delay(1000)]);
      child.kill();
    },
  });
  return { app, page: /** @type {any} */ (page) };
}

/**
 * The way the test binary is started on this platform.
 * @type {(attempt: LaunchAttempt) => Promise<{ app: TauriApp, page: import('@playwright/test').Page }>}
 */
const startApp =
  process.platform === `linux`
    ? startOnLinux
    : process.platform === `darwin`
      ? startOnMac
      : startOverDevtools;

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
      return await startApp({
        extraArgs,
        visible,
        keepWindowSize,
        webviewDir,
        settingsDir,
        cleanup,
      });
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
 * Navigate the page to about:blank to clean up browser state between tests,
 * and have its browser context close without throwing, so that a test that
 * passed is never failed by Firefox throwing a "browserContext.close"
 * protocol error while Playwright closes the context after the test.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function resetPage(page) {
  const context = page.context();
  const close = context.close.bind(context);
  context.close = async (options) => {
    try {
      await close(options);
    } catch {
      /* Firefox teardown glitch, after the test has finished */
    }
  };
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

/**
 * The fixture that is a normal markdown document, with every kind of
 * block and inline markup in it.
 */
export const FIXTURE_DOCUMENT = path.join(
  projectRoot,
  `test`,
  `fixtures`,
  `document-with-every-markdown-feature.md`,
);

/**
 * Clicks in the writing view just inside the right edge of the last
 * character of `before`, where the writing view shows `before` followed
 * by `after`, so that the caret lands between the two.  Fails when the
 * writing view does not show that text exactly once.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {string} before - The text just before the place, at least one character.
 * @param {string} after - The text just after the place.
 */
export async function clickWritingViewBetween(pg, before, after) {
  const point = await pg.evaluate(
    ({ before, after }) => {
      const editor = /** @type {HTMLElement} */ (document.querySelector(`#editor`));
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      /** @type {{ node: Text, start: number }[]} */
      const texts = [];
      let text = ``;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push({ node: /** @type {Text} */ (node), start: text.length });
        text += node.textContent ?? ``;
      }
      const index = text.indexOf(before + after);
      if (index === -1 || text.indexOf(before + after, index + 1) !== -1) return undefined;
      const last = index + before.length - 1;
      const holder = texts.find((t) => t.start <= last && last < t.start + t.node.length);
      if (!holder) return undefined;
      holder.node.parentElement?.scrollIntoView({ block: `center`, behavior: `instant` });
      const range = document.createRange();
      range.setStart(holder.node, last - holder.start);
      range.setEnd(holder.node, last - holder.start + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.right - 1, y: rect.top + rect.height / 2 };
    },
    { before, after },
  );
  if (!point) {
    throw new Error(
      `clickWritingViewBetween: the writing view does not show "${before}${after}" once`,
    );
  }
  await pg.mouse.click(point.x, point.y);
}

/**
 * Clicks in the source view just inside the right edge of the last
 * character of `before`, where the markdown has `before` followed by
 * `after`, so that the caret lands between the two.  The character is
 * found in the mirror behind the textarea.  Fails when the markdown does
 * not have that text exactly once.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {string} before - The text just before the place, at least one character.
 * @param {string} after - The text just after the place.
 */
export async function clickSourceViewBetween(pg, before, after) {
  const point = await pg.evaluate(
    ({ before, after }) => {
      const textarea = /** @type {HTMLTextAreaElement} */ (
        document.querySelector(`#editor textarea`)
      );
      const mirror = textarea.parentElement?.querySelector(`pre`)?.firstChild;
      const scroller = document.querySelector(`#editor`)?.parentElement;
      const index = textarea.value.indexOf(before + after);
      if (!mirror || !scroller || index === -1) return undefined;
      if (textarea.value.indexOf(before + after, index + 1) !== -1) return undefined;
      const last = index + before.length - 1;
      const range = document.createRange();
      range.setStart(mirror, last);
      range.setEnd(mirror, last + 1);
      const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += top - scroller.clientHeight / 2;
      const rect = range.getBoundingClientRect();
      return { x: rect.right - 1, y: rect.top + rect.height / 2 };
    },
    { before, after },
  );
  if (!point) {
    throw new Error(`clickSourceViewBetween: the markdown does not have "${before}${after}" once`);
  }
  await pg.mouse.click(point.x, point.y);
}

/**
 * The text just before and just after the caret in the writing view, as
 * many characters of each as asked for, and whether the editor has the
 * focus, or undefined when there is no collapsed caret.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {number} beforeLength
 * @param {number} afterLength
 * @returns {Promise<{ before: string, after: string, focused: boolean } | undefined>}
 */
export async function writingViewTextAroundCaret(pg, beforeLength, afterLength) {
  return pg.evaluate(
    ({ beforeLength, afterLength }) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return undefined;
      const caret = selection.getRangeAt(0);
      const editor = /** @type {HTMLElement} */ (document.querySelector(`#editor`));
      const head = document.createRange();
      head.setStart(editor, 0);
      head.setEnd(caret.startContainer, caret.startOffset);
      const tail = document.createRange();
      tail.setStart(caret.startContainer, caret.startOffset);
      tail.setEnd(editor, editor.childNodes.length);
      const textBefore = head.toString();
      return {
        before: textBefore.slice(Math.max(0, textBefore.length - beforeLength)),
        after: tail.toString().slice(0, afterLength),
        focused: editor.contains(document.activeElement),
      };
    },
    { beforeLength, afterLength },
  );
}

/**
 * The markdown just before and just after the caret in the source view,
 * as many characters of each as asked for, and whether the textarea has
 * the focus, or undefined when there is no collapsed caret.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {number} beforeLength
 * @param {number} afterLength
 * @returns {Promise<{ before: string, after: string, focused: boolean } | undefined>}
 */
export async function sourceViewTextAroundCaret(pg, beforeLength, afterLength) {
  return pg.locator(`#editor textarea`).evaluate(
    (element, { beforeLength, afterLength }) => {
      const textarea = /** @type {HTMLTextAreaElement} */ (element);
      const { value, selectionStart, selectionEnd } = textarea;
      if (selectionStart !== selectionEnd) return undefined;
      return {
        before: value.slice(Math.max(0, selectionStart - beforeLength), selectionStart),
        after: value.slice(selectionStart, selectionStart + afterLength),
        focused: document.activeElement === textarea,
      };
    },
    { beforeLength, afterLength },
  );
}

/**
 * The type of the block the editor's tree cursor is in, and that block's
 * content, or the text of the table cell the tree cursor is in, just
 * before and just after the tree cursor's offset, as many characters of
 * each as asked for, or undefined when there is no tree cursor.
 *
 * @param {import('@playwright/test').Page} pg
 * @param {number} beforeLength
 * @param {number} afterLength
 * @returns {Promise<{ type: string, before: string, after: string } | undefined>}
 */
export async function treeCursorTextAround(pg, beforeLength, afterLength) {
  return pg.evaluate(
    ({ beforeLength, afterLength }) => {
      const editor = /** @type {any} */ (window).__editor;
      const cursor = editor?.syntaxTree?.treeCursor;
      const node = cursor && editor.syntaxTree.findNodeById(cursor.nodeId);
      if (!node) return undefined;
      const text =
        cursor.cellRow === undefined
          ? node.content
          : editor.tableManager.getTableCellText(node, cursor.cellRow, cursor.cellCol);
      return {
        type: node.type,
        before: text.slice(Math.max(0, cursor.offset - beforeLength), cursor.offset),
        after: text.slice(cursor.offset, cursor.offset + afterLength),
      };
    },
    { beforeLength, afterLength },
  );
}
