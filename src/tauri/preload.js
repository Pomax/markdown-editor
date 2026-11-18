/// <reference path="../../src/types.d.ts" />

/**
 * @fileoverview Tauri bridge. Recreates window.pageToBackendBridge on the app's
 * own pages, using window.__TAURI_INTERNALS__ directly because
 * withGlobalTauri is off. Injected as an initialization script so it runs
 * before page scripts on every load, and only on the app's own origin.
 *
 * This is a classic script, not a module: initialization scripts cannot
 * be modules. It also provides
 * toDisplayUrl and fromDisplayUrl, which turn local file references into
 * media protocol URLs and back. It also mirrors `document.title` into the
 * window title, shows the app's context menu on a right-click, and turns
 * files dropped on the window into a DOM drop event.
 */

(() => {
  const internals = /** @type {any} */ (window).__TAURI_INTERNALS__;
  if (!internals) return;

  const appOrigins = [`http://tauri.localhost`, `https://tauri.localhost`, `http://localhost:1420`];
  if (!appOrigins.includes(window.location.origin)) return;

  /**
   * Invokes a backend command.
   * @param {string} command
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<any>}
   */
  const invoke = (command, args) => internals.invoke(command, args ?? {});

  /**
   * Per-channel delivery state: a queue for events that arrive before the
   * renderer registers its handler, and the handler once it does.
   * @type {Record<string, { queue: { action: string, args: any[] }[], callback: ((name: string, ...args: any[]) => void) | null }>}
   */
  const channels = {
    'menu:action': { queue: [], callback: null },
  };

  /**
   * Returns a backend-event handler that forwards to the channel's
   * registered callback, or queues the event until one is registered.
   * @param {string} channel
   * @returns {(raw: any) => void}
   */
  const deliver = (channel) => (raw) => {
    const payload = raw?.payload ?? {};
    const entry = { action: payload.action, args: payload.args ?? [] };
    const state = channels[channel];
    if (state.callback) state.callback(entry.action, ...entry.args);
    else state.queue.push(entry);
  };

  /**
   * Subscribes a handler to a backend event.
   * @param {string} event
   * @param {(raw: any) => void} handler
   * @returns {Promise<unknown>} resolves once the listener is registered.
   */
  const listen = (event, handler) =>
    invoke(`plugin:event|listen`, {
      event,
      target: { kind: `Any` },
      handler: internals.transformCallback(handler),
    });

  /**
   * Subscribes a channel to its backend event at injection time.
   * @param {string} channel
   * @returns {Promise<unknown>} resolves once the listener is registered.
   */
  const subscribe = (channel) => listen(channel, deliver(channel));

  /**
   * The media protocol's origin on this platform, written in by the
   * backend when it injects the bridge.
   */
  const mediaOrigin = `__MEDIA_ORIGIN__`;

  /**
   * The original of each display URL made, so it can be turned back.
   * @type {Map<string, string>}
   */
  const displayOriginals = new Map();

  /**
   * The local file a value names: a file URL's decoded path, a Windows
   * drive path in either slash style, or an absolute POSIX path; null for
   * anything else.
   * @param {string} value
   * @returns {string | null}
   */
  const localPath = (value) => {
    if (/^file:\/\//i.test(value)) {
      let path = value.slice(`file://`.length);
      try {
        path = decodeURIComponent(path);
      } catch {
        return null;
      }
      if (/^\/[A-Za-z]:[\\/]/.test(path)) return path.slice(1);
      return path.startsWith(`/`) ? path : null;
    }
    if (/^[A-Za-z]:[\\/]/.test(value)) return value;
    if (value.startsWith(`/`) && !value.startsWith(`//`)) return value;
    return null;
  };

  /**
   * The URL the page loads a local file through: a media protocol URL for
   * a value that names a local file, and the value itself otherwise.
   * @param {string} url
   * @returns {string}
   */
  const toDisplayUrl = (url) => {
    const path = typeof url === `string` ? localPath(url) : null;
    if (path === null) return url;
    const display = `${mediaOrigin}/${encodeURIComponent(path)}`;
    displayOriginals.set(display, url);
    return display;
  };

  /**
   * The value a display URL was made from, or the URL itself when it was
   * not made by toDisplayUrl.
   * @param {string} url
   * @returns {string}
   */
  const fromDisplayUrl = (url) => displayOriginals.get(url) ?? url;

  /**
   * The path of each file made for a drop, which getPathForFile returns.
   * @type {WeakMap<object, string>}
   */
  const droppedPaths = new WeakMap();

  /**
   * Turns Tauri's drag-drop event, whose position is in physical pixels,
   * into a DOM drop event at that point of the page, carrying a File for
   * each dropped path.
   * @param {any} raw
   */
  const dropFiles = (raw) => {
    /** @type {{ paths?: string[], position?: { x: number, y: number } }} */
    const { paths = [], position = { x: 0, y: 0 } } = raw?.payload ?? {};
    const x = position.x / window.devicePixelRatio;
    const y = position.y / window.devicePixelRatio;
    const dataTransfer = new DataTransfer();
    for (const path of paths) {
      const file = new File([], path.split(/[\\/]/).pop() ?? path);
      droppedPaths.set(file, path);
      dataTransfer.items.add(file);
    }
    document.elementFromPoint(x, y)?.dispatchEvent(
      new DragEvent(`drop`, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer,
      }),
    );
  };

  /**
   * Registers the renderer's handler for a channel, delivering any queued
   * events in order, and returns a cleanup function.
   * @param {string} channel
   * @param {(name: string, ...args: any[]) => void} callback
   * @returns {() => void}
   */
  const register = (channel, callback) => {
    const state = channels[channel];
    state.callback = callback;
    for (const entry of state.queue.splice(0)) callback(entry.action, ...entry.args);
    return () => {
      state.callback = null;
    };
  };

  const pageToBackendBridge = {
    version: `1.0.0`,
    toDisplayUrl,
    fromDisplayUrl,
    newDocument: () => invoke(`file_new`),
    loadFile: () => invoke(`file_load`),
    loadFilePath: (/** @type {string} */ filePath) => invoke(`file_load_path`, { filePath }),
    saveFile: (/** @type {string} */ content) => invoke(`file_save`, { content }),
    saveFileAs: (/** @type {string} */ content) => invoke(`file_save_as`, { content }),
    exportHtml: (/** @type {string} */ html, /** @type {string} */ extraCss) =>
      invoke(`file_export_html`, { html, extraCss }),
    setUnsavedChanges: (/** @type {boolean} */ hasChanges) =>
      invoke(`file_set_unsaved_changes`, { hasChanges }),
    confirmClose: () => invoke(`file_confirm_close`),
    undo: () => invoke(`document_undo`),
    redo: () => invoke(`document_redo`),
    setWritingView: () => invoke(`view_writing`),
    setSource2View: () => invoke(`view_source2`),
    notifyOpenFiles: (/** @type {unknown} */ files) => invoke(`view_open_files_changed`, { files }),
    confirmDialog: (/** @type {unknown} */ options) => invoke(`dialog_confirm`, { options }),
    reload: () => invoke(`app_reload`),
    getRecentFiles: () => invoke(`file_get_recent_files`),
    getSettings: () => invoke(`settings_get_all`),
    getSetting: (/** @type {string} */ key) => invoke(`settings_get`, { key }),
    setSetting: (/** @type {string} */ key, /** @type {unknown} */ value) =>
      invoke(`settings_set`, { key, value }),
    browseForImage: () => invoke(`image_browse`),
    getPathForFile: (/** @type {File} */ file) => droppedPaths.get(file) ?? ``,
    renameImage: (/** @type {string} */ oldPath, /** @type {string} */ newName) =>
      invoke(`image_rename`, { oldPath, newName }),
    toRelativeImagePath: (/** @type {string} */ imagePath, /** @type {string} */ documentPath) =>
      invoke(`path_to_relative`, { imagePath, documentPath }),
    changeElementType: (/** @type {string} */ elementType) =>
      invoke(`element_change_type`, { elementType }),
    applyFormat: (/** @type {string} */ format) => invoke(`element_format`, { format }),
    onMenuAction: (/** @type {(name: string, ...args: any[]) => void} */ callback) =>
      register(`menu:action`, callback),
  };

  Object.defineProperty(window, `pageToBackendBridge`, {
    value: Object.freeze(pageToBackendBridge),
    writable: false,
    configurable: false,
  });

  /**
   * Sets the window title to `document.title` now and whenever it
   * changes.
   */
  const mirrorTitle = () => {
    let shown = ``;
    const update = () => {
      if (document.title === shown) return;
      shown = document.title;
      invoke(`plugin:window|set_title`, {
        label: internals.metadata.currentWindow.label,
        value: shown,
      }).catch(() => {});
    };
    update();
    new MutationObserver(update).observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  document.addEventListener(`DOMContentLoaded`, mirrorTitle, { once: true });

  // A right-click the page did not prevent shows the app's context menu at
  // the pointer instead of the webview's own. The right-click the backend
  // sends for Inspect Element, announced by the flag, is let through to
  // the webview, which inspects the element under it.
  window.addEventListener(`contextmenu`, (event) => {
    if (event.defaultPrevented) return;
    const own = /** @type {any} */ (window);
    if (own.__inspectNextContextMenu) {
      own.__inspectNextContextMenu = false;
      return;
    }
    event.preventDefault();
    invoke(`context_menu`, { x: event.clientX, y: event.clientY }).catch(() => {});
  });

  // Subscribe to backend events, then tell the backend the bridge is ready
  // so it can flush anything queued for this page.
  Promise.all([subscribe(`menu:action`), listen(`tauri://drag-drop`, dropFiles)])
    .then(() => invoke(`bridge_ready`))
    .catch(() => {});
})();
