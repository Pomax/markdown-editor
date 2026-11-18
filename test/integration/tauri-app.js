/**
 * @fileoverview TauriApp: the test hook client for the Tauri app.
 *
 * TauriApp talks to the app's test hooks (compiled only with the
 * test-hooks feature) over the child process's stdin and stdout using
 * tagged JSON lines, outside the page: each request is one JSON line on
 * stdin, each reply is a line on stdout prefixed with a tag so the app's
 * own logging can be ignored. Replies are matched to requests by id, and
 * every pending call rejects if the app exits or its stdin fails.
 */

/**
 * Prefix marking a hook reply line on the child's stdout.
 * @type {string}
 */
const TAG = `__HOOK__`;

/**
 * @typedef {object} ChildLike
 * @property {{ write(data: string): unknown, on?: (event: string, listener: (...args: any[]) => void) => unknown }} stdin
 * @property {{ on(event: string, listener: (chunk: Buffer) => void): unknown }} stdout
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {() => unknown} kill
 * @property {number} [pid]
 */

/**
 * Hook client for a running Tauri test binary.
 */
export class TauriApp {
  /** @type {ChildLike} */
  #child;

  /** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} */
  #pending = new Map();

  /** @type {number} */
  #nextId = 1;

  /** @type {string} */
  #buffer = ``;

  /** @type {number} */
  #closeTimeoutMs;

  /** @type {boolean} */
  #exited = false;

  /**
   * @param {ChildLike} child - The spawned test binary (or a fake in tests).
   * @param {{ closeTimeoutMs?: number }} [options]
   */
  constructor(child, options = {}) {
    this.#child = child;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5000;

    child.stdout.on(`data`, (chunk) => this.#onData(chunk));
    child.on(`exit`, () => this.#onExit());
    // A write to an app that has just exited fails with EPIPE before the
    // exit event arrives; treat it the same way.
    child.stdin.on?.(`error`, () => this.#onExit());

    /** Clipboard hooks. */
    this.clipboard = {
      /** @param {string} text */
      writeText: (text) => this.#send(`clipboard.writeText`, { text }),
      /** @returns {Promise<string>} */
      readText: () => this.#send(`clipboard.readText`),
    };

    /** Menu hooks. */
    this.menu = {
      /** @param {string[]} labels */
      isEnabled: (labels) => this.#send(`menu.isEnabled`, { labels }),
      /** @param {string[]} labels */
      click: (labels) => this.#send(`menu.click`, { labels }),
      /** @returns {Promise<any>} The built menu tree. */
      items: () => this.#send(`menu.items`),
      /** @returns {Promise<number>} Native menu items built, changed or removed since the last call. */
      changes: () => this.#send(`menu.changes`),
    };

    /** Settings hooks. */
    this.settings = {
      /** @param {string} key */
      get: (key) => this.#send(`settings.get`, { key }),
      /**
       * @param {string} key
       * @param {unknown} value
       */
      set: (key, value) => this.#send(`settings.set`, { key, value }),
    };

    /** Context-menu hooks. */
    this.contextMenu = {
      /** @param {string} label */
      click: (label) => this.#send(`contextMenu.click`, { label }),
    };
  }

  /**
   * Accumulates stdout and dispatches complete lines.
   * @param {Buffer} chunk
   */
  #onData(chunk) {
    this.#buffer += chunk.toString();
    let index = this.#buffer.indexOf(`\n`);
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#handleLine(line);
      index = this.#buffer.indexOf(`\n`);
    }
  }

  /**
   * Resolves the pending call named by a tagged reply line; ignores any
   * other output.
   * @param {string} line
   */
  #handleLine(line) {
    const at = line.indexOf(TAG);
    if (at === -1) return;
    let message;
    try {
      message = JSON.parse(line.slice(at + TAG.length));
    } catch {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result);
  }

  /**
   * Rejects every pending call when the app exits or its stdin fails.
   */
  #onExit() {
    this.#exited = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`app exited with calls pending`));
    }
    this.#pending.clear();
  }

  /**
   * Sends one hook request and resolves with its reply.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  #send(method, params) {
    if (this.#exited) return Promise.reject(new Error(`app has exited`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params: params ?? null })}\n`);
    });
  }

  /**
   * Asks the app to close and kills the process if it does not within the
   * close timeout.
   */
  async close() {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      await Promise.race([
        this.#send(`close`),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`close timeout`)), this.#closeTimeoutMs);
        }),
      ]);
    } catch {
      try {
        this.#child.kill();
      } catch {
        /* already gone */
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @returns {Promise<number>} The number of open windows. */
  windowCount() {
    return this.#send(`windowCount`);
  }

  /**
   * Answers the next message box with a button index.
   * @param {number} response
   */
  setMessageBoxResponse(response) {
    return this.#send(`setMessageBoxResponse`, { response });
  }

  /** @returns {Promise<any[]>} Every message box shown so far. */
  messageBoxes() {
    return this.#send(`messageBoxes`);
  }

  /**
   * Answers the next file dialog with a path, or null to cancel.
   * @param {string|null} path
   */
  setFileDialogResult(path) {
    return this.#send(`setFileDialogResult`, { path });
  }

  /** @returns {Promise<any[]>} Every file dialog shown so far. */
  fileDialogs() {
    return this.#send(`fileDialogs`);
  }

  /**
   * Sends a menu action to the renderer.
   * @param {string} action
   * @param {...unknown} args
   */
  sendMenuAction(action, ...args) {
    return this.#send(`sendMenuAction`, { action, args });
  }

  /** Starts recording items revealed in the OS file browser. */
  recordRevealedItems() {
    return this.#send(`recordRevealedItems`);
  }

  /** @returns {Promise<string|undefined>} The last revealed item path. */
  revealedItem() {
    return this.#send(`revealedItem`);
  }

  /** Starts recording URLs that would open in the system browser. */
  recordOpenedUrls() {
    return this.#send(`recordOpenedUrls`);
  }

  /** @returns {Promise<string|undefined>} The last URL handed to the system browser. */
  openedUrl() {
    return this.#send(`openedUrl`);
  }

  /** Saves the current open files (as the main process did). */
  saveOpenFiles() {
    return this.#send(`saveOpenFiles`);
  }

  /**
   * Restores a set of open files.
   * @param {unknown[]} entries
   */
  restoreOpenFiles(entries) {
    return this.#send(`restoreOpenFiles`, { entries });
  }

  /**
   * Emits Tauri's native drag-drop event with the given paths at a point
   * of the page in physical pixels, as Tauri reports it.
   * @param {string[]} paths
   * @param {{ x: number, y: number }} [position]
   */
  dropFiles(paths, position) {
    return this.#send(`dropFiles`, { paths, position });
  }

  /** @returns {number} The app's process id. */
  get pid() {
    return this.#child.pid ?? 0;
  }

  /** @returns {Promise<any>} Whether the window is visible, where it is, and its title. */
  windowState() {
    return this.#send(`windowState`);
  }

  /** @returns {Promise<string[]>} Keystrokes the Windows Cut/Copy/Paste items would send. */
  sentKeystrokes() {
    return this.#send(`sentKeystrokes`);
  }

  /** @returns {Promise<any[]>} The context menus that would have popped up. */
  contextMenus() {
    return this.#send(`contextMenus`);
  }

  /** @returns {Promise<any>} The WebView2 settings and browser arguments in effect. */
  webviewSettings() {
    return this.#send(`webviewSettings`);
  }

  /**
   * Moves and resizes the window.
   * @param {{ x?: number, y?: number, width: number, height: number }} bounds
   */
  setWindowBounds(bounds) {
    return this.#send(`setWindowBounds`, { bounds });
  }

  /** Maximizes the window. */
  maximize() {
    return this.#send(`maximize`);
  }

  /**
   * Runs the app's normal close flow instead of TESTING's immediate destroy.
   * @param {{ testing?: boolean }} [options]
   */
  requestClose(options) {
    return this.#send(`requestClose`, options ?? { testing: false });
  }

  /**
   * @returns {Promise<{ x: number, y: number }[]>} The points of the page
   * WebView2's own Inspect command was run at.
   */
  inspections() {
    return this.#send(`inspections`);
  }

  /** @returns {Promise<boolean>} Whether DevTools are open. */
  isDevtoolsOpen() {
    return this.#send(`isDevtoolsOpen`);
  }
}
