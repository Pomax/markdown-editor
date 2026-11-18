/**
 * @fileoverview WebKitInspector: a client for WebKitGTK's remote
 * inspector, which the app opens on a port of its own when it is started
 * with WEBKIT_INSPECTOR_HTTP_SERVER. The server lists its pages over HTTP
 * and speaks WebKit's inspector protocol over one WebSocket per page.
 * Every command for the page goes inside Target.sendMessageToTarget,
 * addressed to the page's target, and its reply and the page's events
 * come back inside Target.dispatchMessageFromTarget. When a navigation
 * commits a new target for the page, the client follows it.
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
 * The URL and WebSocket path of the page whose URL ends in `urlSuffix`,
 * from the inspector server's HTML list of pages, or undefined while it
 * is not listed.
 * @param {string} listing - The HTML the server answers `/` with.
 * @param {string} urlSuffix
 * @returns {{ url: string, path: string } | undefined}
 */
export function listedPage(listing, urlSuffix) {
  const rows = listing.matchAll(
    /<div class="targeturl">([^<]*)<\/div>.*?'(\/socket\/\d+\/\d+\/WebPage)'/gs,
  );
  for (const [, url, path] of rows) {
    if (url.endsWith(urlSuffix)) return { url, path };
  }
  return undefined;
}

/**
 * The text of a value the page threw, as a remote object.
 * @param {any} thrown
 * @returns {string}
 */
function thrownText(thrown) {
  return String(thrown?.value ?? thrown?.description ?? `the page threw`);
}

/**
 * Client for one page of a WebKitGTK remote inspector.
 */
export class WebKitInspector {
  /** @type {WebSocket} */
  #socket;

  /** @type {string} */
  #targetId = ``;

  /** @type {Promise<void>} */
  #targetReady;

  /** @type {() => void} */
  #announceTarget = () => {};

  /** @type {number} */
  #nextId = 1;

  /** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} */
  #pending = new Map();

  /** @type {Set<(method: string, params: any) => void>} */
  #listeners = new Set();

  /** @type {boolean} */
  #closed = false;

  /** @type {Promise<void>} */
  closed;

  /** @type {string} */
  url;

  /**
   * @param {WebSocket} socket - An open socket to the page.
   * @param {string} url - The page's URL, as the server listed it.
   */
  constructor(socket, url) {
    this.#socket = socket;
    this.url = url;
    this.#targetReady = new Promise((resolve) => {
      this.#announceTarget = resolve;
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener(`close`, () => {
        this.#onClose();
        resolve();
      });
    });
    socket.addEventListener(`message`, (event) => this.#onMessage(String(event.data)));
  }

  /**
   * Connects to the page whose URL ends in `urlSuffix`, polling the
   * inspector server on the port until it lists that page.
   * @param {number} port
   * @param {string} urlSuffix
   * @param {number} timeoutMs
   * @returns {Promise<WebKitInspector>}
   */
  static async connect(port, urlSuffix, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listing = await fetch(`http://127.0.0.1:${port}/`)
        .then((response) => response.text())
        .catch(() => ``);
      const page = listedPage(listing, urlSuffix);
      if (page) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${page.path}`);
        await new Promise((resolve, reject) => {
          socket.addEventListener(`open`, resolve, { once: true });
          socket.addEventListener(`error`, () => reject(new Error(`inspector socket failed`)), {
            once: true,
          });
        });
        const inspector = new WebKitInspector(socket, page.url);
        await Promise.race([
          inspector.#targetReady,
          delay(Math.max(deadline - Date.now(), 0)).then(() => {
            throw new Error(`the inspector announced no page target`);
          }),
        ]);
        return inspector;
      }
      await delay(100);
    }
    throw new Error(`the inspector on port ${port} did not list a page ending in ${urlSuffix}`);
  }

  /**
   * Handles one message from the server: target changes, replies to
   * commands, and the page's events.
   * @param {string} data
   */
  #onMessage(data) {
    const message = JSON.parse(data);
    const params = message.params ?? {};
    switch (message.method) {
      case `Target.targetCreated`:
        if (params.targetInfo?.type === `page` && !params.targetInfo.isProvisional) {
          this.#targetId = params.targetInfo.targetId;
          this.#announceTarget();
        }
        return;
      case `Target.didCommitProvisionalTarget`:
        if (params.oldTargetId === this.#targetId) this.#targetId = params.newTargetId;
        return;
      case `Target.dispatchMessageFromTarget`:
        this.#onTargetMessage(JSON.parse(params.message));
        return;
    }
    if (message.id !== undefined && message.error) {
      this.#settle(message.id, undefined, message.error);
    }
  }

  /**
   * Handles a message from the page's target: a reply or an event.
   * @param {any} message
   */
  #onTargetMessage(message) {
    if (message.id !== undefined) {
      this.#settle(message.id, message.result, message.error);
      return;
    }
    for (const listener of this.#listeners) listener(message.method, message.params);
  }

  /**
   * Resolves or rejects the pending command with the given id.
   * @param {number} id
   * @param {any} result
   * @param {any} error
   */
  #settle(id, result, error) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (error) pending.reject(new Error(String(error.message ?? error)));
    else pending.resolve(result);
  }

  /**
   * Rejects every pending command once the socket has closed.
   */
  #onClose() {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`the inspector connection closed`));
    }
    this.#pending.clear();
  }

  /**
   * Sends a command to the page's target and resolves with its result.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async send(method, params = {}) {
    if (this.#closed) throw new Error(`the inspector connection closed`);
    await this.#targetReady;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(
        JSON.stringify({
          id,
          method: `Target.sendMessageToTarget`,
          params: { targetId: this.#targetId, message: JSON.stringify({ id, method, params }) },
        }),
      );
    });
  }

  /**
   * Evaluates an expression in the page as a user gesture, as Playwright's
   * evaluate does, waits for it if it is a promise, and resolves with its
   * value, or rejects with the text of what it threw. The expression runs
   * during the call itself, where the gesture holds. The value comes back
   * as JSON, as `returnByValue` gives it.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const settled = `(() => { try { return Promise.resolve((${expression})); } catch (error) { return Promise.reject(error); } })().catch((error) => { throw String(error && error.stack ? error.stack : error); })`;
    const evaluated = await this.send(`Runtime.evaluate`, {
      expression: settled,
      returnByValue: false,
      emulateUserGesture: true,
      doNotPauseOnExceptionsAndMuteConsole: true,
    });
    if (evaluated.wasThrown) throw new Error(thrownText(evaluated.result));
    const promiseObjectId = evaluated.result.objectId;
    const awaited = await this.send(`Runtime.awaitPromise`, {
      promiseObjectId,
      returnByValue: true,
    });
    this.send(`Runtime.releaseObject`, { objectId: promiseObjectId }).catch(() => {});
    if (awaited.wasThrown) throw new Error(thrownText(awaited.result));
    return awaited.result.value;
  }

  /**
   * Calls `listener` with the method and parameters of each event the
   * page sends, until the returned function is called.
   * @param {(method: string, params: any) => void} listener
   * @returns {() => void}
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Closes the connection. */
  close() {
    this.#socket.close();
  }
}
