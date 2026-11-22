/**
 * @fileoverview The macOS side of the WebKit test harness. WKWebView has
 * no inspector server to connect to and macOS has no virtual display, so
 * both of what WebviewPage needs go through the app's test hooks: MacInspector
 * evaluates script in the page, and MacInput sends key and mouse events to
 * the app's window inside its own process, which leaves the real pointer
 * and keyboard alone.
 */

/**
 * Evaluates script in the app's page through the test hooks.
 */
export class MacInspector {
  /** @type {import('./tauri-app.js').TauriApp} */
  #app;

  /** @type {() => void} */
  #markClosed = () => {};

  /**
   * How much init script the app has been given.
   * @type {number}
   */
  #initScriptLength = 0;

  /** @type {Promise<void>} */
  closed;

  /** @param {import('./tauri-app.js').TauriApp} app */
  constructor(app) {
    this.#app = app;
    this.closed = new Promise((resolve) => {
      this.#markClosed = resolve;
    });
  }

  /**
   * Evaluates an expression in the page, waits for it if it is a promise,
   * and resolves with its value. A page that unloads meanwhile fails the
   * call with the error WebviewPage retries on.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    try {
      return await this.#app.evaluate(expression);
    } catch (error) {
      if (String(error).includes(`page unloaded`)) {
        throw new Error(`Cannot find context: the page unloaded`);
      }
      throw error;
    }
  }

  /**
   * Runs the inspector commands WebviewPage sends that have a macOS form.
   * WebviewPage sends every init script so far each time, and WebKit keeps
   * the ones it was given, so only the new part is added.
   * @param {string} method
   * @param {{ source?: string }} [params]
   * @returns {Promise<any>}
   */
  async send(method, params = {}) {
    if (method === `Page.enable`) return {};
    if (method === `Page.reload`) return this.evaluate(`void location.reload()`);
    if (method === `Page.setBootstrapScript`) {
      const source = params.source ?? ``;
      const added = source.slice(this.#initScriptLength);
      this.#initScriptLength = source.length;
      return this.#app.input(`initScript`, [added]);
    }
    throw new Error(`the macOS harness does not support ${method}`);
  }

  /** Marks the connection closed. */
  close() {
    this.#markClosed();
  }
}

/**
 * What the specs' Home and End mean, moving the caret along its line, as
 * macOS writes it: the Home and End keys only scroll there.
 * @type {Record<string, string>}
 */
const LINE_KEYS = { Home: `Meta+ArrowLeft`, End: `Meta+ArrowRight` };

/**
 * The shortcuts the Edit menu runs on a text field, which AppKit does not
 * send to the menu of an app that is not active.
 * @type {RegExp}
 */
const EDIT_KEY = /^Meta\+([acvx])$/;

/**
 * Whether the page's focus is in a text field, where the page leaves those
 * shortcuts to the Edit menu. Paste is left to the menu everywhere.
 * @type {string}
 */
const IN_TEXT_FIELD = `document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement`;

/**
 * Sends input to the app's window through the test hooks.
 */
export class MacInput {
  /** @type {import('./tauri-app.js').TauriApp} */
  #app;

  /** @param {import('./tauri-app.js').TauriApp} app */
  constructor(app) {
    this.#app = app;
  }

  /**
   * Runs one input command and resolves with its answer.
   * @param {string} command
   * @param {...(string | number)} args
   * @returns {Promise<any>}
   */
  async run(command, ...args) {
    const letter = command === `keys` && args.length === 1 && EDIT_KEY.exec(String(args[0]))?.[1];
    if (letter && (letter === `v` || (await this.#app.evaluate(IN_TEXT_FIELD)))) {
      return this.#app.input(`edit`, [letter]);
    }
    const sent = args.map((arg) => (command === `keys` && LINE_KEYS[arg]) || String(arg));
    return this.#app.input(command, sent);
  }
}
