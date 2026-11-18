/**
 * @fileoverview Unit tests for the Tauri bridge (src/tauri/preload.js),
 * run in a Node VM against a fake window.__TAURI_INTERNALS__.
 *
 * The bridge must expose window.pageToBackendBridge with exactly the
 * expected members, subscribe to no scripting API event, install only on the app's own origin, pass a
 * command's rejection through to its caller, and turn Tauri's drag-drop
 * event into a DOM drop event at the drop point, carrying files whose
 * paths getPathForFile returns (an empty string for any other file), and
 * turn local file references into media protocol URLs and back.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const source = readFileSync(join(root, `src`, `tauri`, `preload.js`), `utf-8`);

const APP_ORIGIN = `http://tauri.localhost`;
const FOREIGN_ORIGIN = `https://example.com`;

/**
 * The media protocol's origin on Windows, which the backend writes into
 * the bridge in place of its placeholder.
 */
const MEDIA_ORIGIN = `http://media.localhost`;

/**
 * The members the bridge exposes on window.pageToBackendBridge.
 * @type {string[]}
 */
const EXPECTED_MEMBERS = [
  `toDisplayUrl`,
  `fromDisplayUrl`,
  `version`,
  `newDocument`,
  `loadFile`,
  `loadFilePath`,
  `saveFile`,
  `saveFileAs`,
  `exportHtml`,
  `setUnsavedChanges`,
  `confirmClose`,
  `undo`,
  `redo`,
  `setWritingView`,
  `setSource2View`,
  `notifyOpenFiles`,
  `confirmDialog`,
  `reload`,
  `getRecentFiles`,
  `getSettings`,
  `getSetting`,
  `setSetting`,
  `browseForImage`,
  `getPathForFile`,
  `renameImage`,
  `toRelativeImagePath`,
  `changeElementType`,
  `applyFormat`,
  `onMenuAction`,
];

/** A stand-in for the page's File: a name and no content. */
class FakeFile {
  /**
   * @param {unknown[]} _parts
   * @param {string} name
   */
  constructor(_parts, name) {
    this.name = name;
  }
}

/** A stand-in for the page's DataTransfer: the files added to it. */
class FakeDataTransfer {
  constructor() {
    /** @type {FakeFile[]} */
    this.files = [];
    this.items = { add: (/** @type {FakeFile} */ file) => this.files.push(file) };
  }
}

/** A stand-in for the page's DragEvent: its type and the fields it was made with. */
class FakeDragEvent {
  /**
   * @param {string} type
   * @param {Record<string, unknown>} init
   */
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
}

/**
 * Runs the bridge in a VM with a fake Tauri internals object and a page
 * whose every point holds one drop target.
 * @param {string} origin
 * @param {(command: string, args: unknown) => Promise<unknown>} [invoke]
 * @param {number} [devicePixelRatio]
 * @returns {{ window: any, invokeCalls: { command: string, args: any }[], callbacks: Function[], points: { x: number, y: number }[], dispatched: any[] }}
 */
function runBridge(origin, invoke, devicePixelRatio = 1) {
  /** @type {{ command: string, args: any }[]} */
  const invokeCalls = [];
  /** @type {Function[]} */
  const callbacks = [];
  /** @type {{ x: number, y: number }[]} */
  const points = [];
  /** @type {any[]} */
  const dispatched = [];
  const dropTarget = {
    dispatchEvent: (/** @type {unknown} */ event) => {
      dispatched.push(event);
      return true;
    },
  };
  const window = {
    location: { origin },
    devicePixelRatio,
    addEventListener() {},
    removeEventListener() {},
    __TAURI_INTERNALS__: {
      invoke: (/** @type {string} */ command, /** @type {unknown} */ args) => {
        invokeCalls.push({ command, args });
        return invoke ? invoke(command, args) : Promise.resolve(null);
      },
      transformCallback: (/** @type {Function} */ cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
    },
  };
  /** @type {any} */
  const context = {
    window,
    document: {
      addEventListener() {},
      title: ``,
      elementFromPoint: (/** @type {number} */ x, /** @type {number} */ y) => {
        points.push({ x, y });
        return dropTarget;
      },
    },
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    DragEvent: FakeDragEvent,
    console,
  };
  context.globalThis = context;
  createContext(context);
  runInContext(source.replace(`__MEDIA_ORIGIN__`, MEDIA_ORIGIN), context);
  return { window, invokeCalls, callbacks, points, dispatched };
}

/**
 * The callback the bridge registered for a backend event.
 * @param {{ command: string, args: any }[]} invokeCalls
 * @param {Function[]} callbacks
 * @param {string} event
 * @returns {Function | undefined}
 */
function listenerFor(invokeCalls, callbacks, event) {
  const call = invokeCalls.find(
    (entry) => entry.command === `plugin:event|listen` && entry.args?.event === event,
  );
  return call ? callbacks[call.args.handler - 1] : undefined;
}

/**
 * Tauri's drag-drop event for two files dropped at a point in physical
 * pixels.
 * @type {{ payload: { paths: string[], position: { x: number, y: number } } }}
 */
const DROP = {
  payload: { paths: [`C:\\images\\photo.png`, `/notes/todo.md`], position: { x: 300, y: 100 } },
};

describe(`Tauri bridge`, () => {
  it(`turns a file URL into a media URL of its decoded path`, () => {
    const { window } = runBridge(APP_ORIGIN);
    const { toDisplayUrl } = window.pageToBackendBridge;
    assert.strictEqual(
      toDisplayUrl(`file:///C:/images/my%20photo.png`),
      `${MEDIA_ORIGIN}/${encodeURIComponent(`C:/images/my photo.png`)}`,
    );
    assert.strictEqual(
      toDisplayUrl(`file:///home/user/photo.png`),
      `${MEDIA_ORIGIN}/${encodeURIComponent(`/home/user/photo.png`)}`,
    );
  });

  it(`turns a Windows drive path in either slash style into a media URL`, () => {
    const { window } = runBridge(APP_ORIGIN);
    const { toDisplayUrl } = window.pageToBackendBridge;
    assert.strictEqual(
      toDisplayUrl(`C:\\images\\photo.png`),
      `${MEDIA_ORIGIN}/${encodeURIComponent(`C:\\images\\photo.png`)}`,
    );
    assert.strictEqual(
      toDisplayUrl(`C:/images/photo.png`),
      `${MEDIA_ORIGIN}/${encodeURIComponent(`C:/images/photo.png`)}`,
    );
  });

  it(`turns an absolute POSIX path into a media URL`, () => {
    const { window } = runBridge(APP_ORIGIN);
    assert.strictEqual(
      window.pageToBackendBridge.toDisplayUrl(`/home/user/photo.png`),
      `${MEDIA_ORIGIN}/${encodeURIComponent(`/home/user/photo.png`)}`,
    );
  });

  it(`returns every other value unchanged`, () => {
    const { window } = runBridge(APP_ORIGIN);
    for (const value of [
      `https://example.com/photo.png`,
      `http://example.com/photo.png`,
      `data:image/png;base64,AAAA`,
      `blob:http://tauri.localhost/1234`,
      `images/photo.png`,
      `./photo.png`,
      `../photo.png`,
      `//example.com/photo.png`,
      ``,
    ]) {
      assert.strictEqual(window.pageToBackendBridge.toDisplayUrl(value), value);
    }
  });

  it(`returns the original of a converted URL from fromDisplayUrl`, () => {
    const { window } = runBridge(APP_ORIGIN);
    const { toDisplayUrl, fromDisplayUrl } = window.pageToBackendBridge;
    for (const original of [
      `file:///C:/images/my%20photo.png`,
      `C:\\images\\photo.png`,
      `C:/images/photo.png`,
      `/home/user/photo.png`,
    ]) {
      assert.strictEqual(fromDisplayUrl(toDisplayUrl(original)), original);
    }
    assert.strictEqual(fromDisplayUrl(`images/photo.png`), `images/photo.png`);
    assert.strictEqual(
      fromDisplayUrl(`${MEDIA_ORIGIN}/never-converted.png`),
      `${MEDIA_ORIGIN}/never-converted.png`,
    );
  });

  it(`exposes exactly the expected members`, () => {
    const { window } = runBridge(APP_ORIGIN);
    assert.ok(window.pageToBackendBridge, `pageToBackendBridge is installed`);
    assert.deepStrictEqual(
      Object.keys(window.pageToBackendBridge).sort(),
      [...EXPECTED_MEMBERS].sort(),
    );
  });

  it(`installs nothing on a foreign origin`, () => {
    const { window } = runBridge(FOREIGN_ORIGIN);
    assert.strictEqual(window.pageToBackendBridge, undefined);
  });

  it(`returns an empty string from getPathForFile for a file that was not dropped`, () => {
    const { window } = runBridge(APP_ORIGIN);
    assert.strictEqual(window.pageToBackendBridge.getPathForFile({}), ``);
  });

  it(`turns Tauri's drag-drop event into a drop event at the point in CSS pixels`, () => {
    const { invokeCalls, callbacks, points, dispatched } = runBridge(APP_ORIGIN, undefined, 2);
    const onDrop = listenerFor(invokeCalls, callbacks, `tauri://drag-drop`);
    assert.ok(onDrop, `the bridge listens for Tauri's drag-drop event`);
    onDrop(DROP);
    assert.deepStrictEqual(points, [{ x: 150, y: 50 }]);
    assert.strictEqual(dispatched.length, 1);
    const [event] = dispatched;
    assert.strictEqual(event.type, `drop`);
    assert.strictEqual(event.bubbles, true);
    assert.strictEqual(event.cancelable, true);
    assert.strictEqual(event.clientX, 150);
    assert.strictEqual(event.clientY, 50);
    assert.deepStrictEqual(
      event.dataTransfer.files.map((/** @type {FakeFile} */ file) => file.name),
      [`photo.png`, `todo.md`],
    );
  });

  it(`returns a dropped file's path from getPathForFile`, () => {
    const { window, invokeCalls, callbacks, dispatched } = runBridge(APP_ORIGIN);
    const onDrop = listenerFor(invokeCalls, callbacks, `tauri://drag-drop`);
    assert.ok(onDrop, `the bridge listens for Tauri's drag-drop event`);
    onDrop(DROP);
    const [image, notes] = dispatched[0].dataTransfer.files;
    assert.strictEqual(window.pageToBackendBridge.getPathForFile(image), `C:\\images\\photo.png`);
    assert.strictEqual(window.pageToBackendBridge.getPathForFile(notes), `/notes/todo.md`);
  });

  it(`invokes a command through the Tauri internals`, async () => {
    const { window, invokeCalls } = runBridge(APP_ORIGIN);
    await window.pageToBackendBridge.saveFile(`content`);
    assert.ok(invokeCalls.some((call) => typeof call.command === `string`));
  });

  it(`subscribes to no scripting API event`, () => {
    const { invokeCalls, callbacks } = runBridge(APP_ORIGIN);
    assert.strictEqual(listenerFor(invokeCalls, callbacks, `api:external`), undefined);
  });

  it(`passes a command's rejection through to the caller`, async () => {
    const { window } = runBridge(APP_ORIGIN, () => Promise.reject(new Error(`no such command`)));
    await assert.rejects(() => window.pageToBackendBridge.saveFile(`content`));
  });

  it(`queues menu actions until a handler is registered, then delivers them in order`, () => {
    const { window, invokeCalls, callbacks } = runBridge(APP_ORIGIN);
    const menuHandler = listenerFor(invokeCalls, callbacks, `menu:action`);
    assert.ok(menuHandler, `the bridge listens for menu actions`);
    menuHandler({ payload: { action: `first`, args: [1] } });
    menuHandler({ payload: { action: `second`, args: [] } });

    /** @type {[string, any[]][]} */
    const received = [];
    window.pageToBackendBridge.onMenuAction(
      (/** @type {string} */ action, /** @type {any[]} */ ...args) => received.push([action, args]),
    );
    assert.deepStrictEqual(received, [
      [`first`, [1]],
      [`second`, []],
    ]);

    // A later event goes straight through to the registered handler.
    menuHandler({ payload: { action: `third`, args: [`x`] } });
    assert.deepStrictEqual(received, [
      [`first`, [1]],
      [`second`, []],
      [`third`, [`x`]],
    ]);
  });
});
