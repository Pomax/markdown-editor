/**
 * @fileoverview The page object of the Linux test harness. WebKitGTK has
 * no Chrome DevTools Protocol for Playwright to attach to, so LinuxPage
 * gives the specs the part of Playwright's Page that they use, over
 * WebKitGTK's own inspector protocol (WebKitInspector): evaluating script
 * in the page, waiting, locators, and keyboard and mouse input.
 *
 * Input is real X11 input, sent through the X11 runner (X11Input) to the
 * app's window on its virtual display, so the page gets trusted events as
 * it would from a user. Each input call waits until the page has seen the
 * events it sent, or for at most INPUT_WAIT_MS when some never reach the
 * page, such as the release of a key that opened the menu bar.
 *
 * Locators query the page again on every call, as Playwright's do, with
 * Playwright's rules for visibility, element text and text matching, and
 * its strictness: an action or an element assertion on more than one
 * element fails. They carry what Playwright's `expect` looks for
 * (`_apiName` and `_expect`), so the specs' locator assertions work
 * unchanged.
 */

import { writeFileSync } from 'node:fs';

/**
 * How long an action or an element read waits for its element, in
 * milliseconds; the test's own timeout usually ends it first.
 * @type {number}
 */
const ACTION_TIMEOUT_MS = 30_000;

/**
 * How long an input call waits for the page to see the events it sent.
 * @type {number}
 */
const INPUT_WAIT_MS = 1_000;

/**
 * How often waits poll the page, in milliseconds.
 * @type {number}
 */
const POLL_MS = 25;

/**
 * Resolves after the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an error came from the page being replaced while a call was in
 * flight, as on a reload; a poll tries again in the new page, as
 * Playwright's do.
 * @param {unknown} error
 * @returns {boolean}
 */
function isNavigationError(error) {
  return /Missing injected script|Cannot find context/.test(String(error));
}

/**
 * A value written as JavaScript source for an expression evaluated in the
 * page: JSON, or `undefined`.
 * @param {unknown} value
 * @returns {string}
 */
function source(value) {
  return value === undefined ? `undefined` : JSON.stringify(value);
}

/**
 * A text to match, in the form the page's matcher takes: a string, or a
 * regular expression's source and flags.
 * @param {string | RegExp} text
 * @returns {{ string?: string, regexSource?: string, regexFlags?: string }}
 */
function textPattern(text) {
  return text instanceof RegExp
    ? { regexSource: text.source, regexFlags: text.flags }
    : { string: String(text) };
}

/**
 * The steps of a selector: each `>>` part is a CSS selector, scoped to
 * the elements before it, or `nth=N`; a CSS selector that ends in
 * `:visible` keeps only visible elements. As in Playwright, a scoped
 * selector that starts with `>`, `+` or `~` is relative to each element
 * it is scoped to.
 * @param {string} selector
 * @returns {any[]}
 */
export function selectorSteps(selector) {
  /** @type {any[]} */
  const steps = [];
  for (const part of selector.split(`>>`).map((text) => text.trim())) {
    const nth = part.match(/^nth=(-?\d+)$/);
    if (nth) {
      steps.push({ kind: `nth`, index: Number(nth[1]) });
      continue;
    }
    const css = part.startsWith(`css=`) ? part.slice(4) : part;
    if (css.endsWith(`:visible`)) {
      steps.push({ kind: `css`, selector: css.slice(0, -`:visible`.length) });
      steps.push({ kind: `visible` });
    } else if (css.includes(`:visible`)) {
      throw new Error(`:visible is supported only at the end of a selector: ${selector}`);
    } else {
      steps.push({ kind: `css`, selector: css });
    }
  }
  return steps;
}

/**
 * The steps of a locator's `hasText` and `hasNotText` options.
 * @param {{ hasText?: string | RegExp, hasNotText?: string | RegExp }} [options]
 * @returns {any[]}
 */
export function optionSteps(options = {}) {
  /** @type {any[]} */
  const steps = [];
  if (options.hasText !== undefined) {
    steps.push({ kind: `hasText`, text: textPattern(options.hasText), negate: false });
  }
  if (options.hasNotText !== undefined) {
    steps.push({ kind: `hasText`, text: textPattern(options.hasNotText), negate: true });
  }
  return steps;
}

/**
 * The script the page runs to set up the harness's helpers, once per page
 * load: element queries for locator steps; Playwright's rules for
 * visibility, element text and text matching; the expectations; the
 * point an action clicks; and counters of the input events the page has
 * seen. It must not refer to anything outside itself.
 * @returns {any}
 */
export function pageHarness() {
  const page = /** @type {any} */ (window);
  if (page.__linuxHarness) return page.__linuxHarness;

  /** @type {Record<string, number>} */
  const seen = { keyup: 0, mousedown: 0, mouseup: 0, mousemove: 0 };
  for (const type of Object.keys(seen)) {
    window.addEventListener(
      type,
      () => {
        seen[type] += 1;
      },
      true,
    );
  }

  /** @param {string} text */
  const normalizeWhiteSpace = (text) => text.replace(/[​­]/g, ``).trim().replace(/\s+/g, ` `);

  /** @param {Node} node */
  const isVisibleText = (node) => {
    const range = document.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /** @param {any} element @returns {boolean} */
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === `contents`) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isVisible(child)) return true;
        if (child.nodeType === 3 && isVisibleText(child)) return true;
      }
      return false;
    }
    if (!element.checkVisibility() || style.visibility !== `visible`) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /** @param {any} element @returns {string} */
  const elementText = (element) => {
    if (
      [`SCRIPT`, `NOSCRIPT`, `STYLE`].includes(element.nodeName) ||
      document.head?.contains(element)
    ) {
      return ``;
    }
    if (
      element instanceof HTMLInputElement &&
      [`submit`, `button`, `reset`].includes(element.type)
    ) {
      return element.value;
    }
    let text = ``;
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? ``;
      else if (child.nodeType === Node.ELEMENT_NODE) text += elementText(child);
    }
    return text;
  };

  /**
   * Playwright's matcher for an expected text.
   * @param {any} expected
   * @returns {(text: string) => boolean}
   */
  const textMatcher = (expected) => {
    /** @param {string} text */
    const normalize = (text) => {
      if (!text) return text;
      let result = expected.normalizeWhiteSpace ? normalizeWhiteSpace(text) : text;
      if (expected.ignoreCase) result = result.toLocaleLowerCase();
      return result;
    };
    if (expected.regexSource !== undefined) {
      const flags = new Set(String(expected.regexFlags ?? ``).split(``));
      if (expected.ignoreCase === false) flags.delete(`i`);
      if (expected.ignoreCase === true) flags.add(`i`);
      const regex = new RegExp(expected.regexSource, [...flags].join(``));
      return (text) => {
        regex.lastIndex = 0;
        return regex.test(text);
      };
    }
    const wanted = normalize(expected.string);
    return (text) =>
      expected.matchSubstring ? normalize(text).includes(wanted) : normalize(text) === wanted;
  };

  /**
   * Playwright's matcher for a locator's `hasText`: a string matches a
   * case-insensitive substring of the normalized text.
   * @param {any} text
   * @returns {(element: Element) => boolean}
   */
  const hasTextMatcher = (text) => {
    const matches =
      text.regexSource !== undefined
        ? textMatcher(text)
        : textMatcher({
            string: text.string,
            matchSubstring: true,
            normalizeWhiteSpace: true,
            ignoreCase: true,
          });
    return (element) => matches(normalizeWhiteSpace(elementText(element)));
  };

  /**
   * The elements a locator's steps select, in document order.
   * @param {any[]} steps
   * @returns {Element[]}
   */
  const query = (steps) => {
    /** @type {Element[]} */
    let elements = [];
    let scoped = false;
    for (const step of steps) {
      if (step.kind === `css`) {
        const relative = /^[>+~]/.test(step.selector) ? `:scope ${step.selector}` : step.selector;
        const found = new Set(
          scoped
            ? elements.flatMap((scope) => [...scope.querySelectorAll(relative)])
            : [...document.querySelectorAll(step.selector)],
        );
        elements = [...found].sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
        scoped = true;
      } else if (step.kind === `visible`) {
        elements = elements.filter(isVisible);
      } else if (step.kind === `hasText`) {
        const matches = hasTextMatcher(step.text);
        elements = elements.filter((element) => matches(element) !== step.negate);
      } else if (step.kind === `nth`) {
        const element = elements.at(step.index);
        elements = element ? [element] : [];
      }
    }
    return elements;
  };

  /**
   * The one element a locator's steps select, or undefined when there is
   * none; more than one is Playwright's strict mode violation.
   * @param {any[]} steps
   * @returns {any}
   */
  const single = (steps) => {
    const elements = query(steps);
    if (elements.length > 1) {
      throw new Error(`strict mode violation: the locator resolved to ${elements.length} elements`);
    }
    return elements[0];
  };

  /** @param {any} element @returns {boolean} */
  const isDisabled = (element) =>
    element.matches(`:disabled`) || element.closest(`[aria-disabled="true"]`) !== null;

  /**
   * Whether an expectation holds now, and what was received.
   * @param {any[]} steps
   * @param {string} expression
   * @param {any} options
   * @returns {{ matches: boolean, received: any }}
   */
  const expect = (steps, expression, options) => {
    if (expression === `to.have.count`) {
      const count = query(steps).length;
      return { matches: count === options.expectedNumber, received: count };
    }
    if (expression === `to.have.text.array` || expression === `to.contain.text.array`) {
      const texts = query(steps).map((element) =>
        options.useInnerText ? /** @type {any} */ (element).innerText : elementText(element),
      );
      /** @type {((text: string) => boolean)[]} */
      const matchers = options.expectedText.map(textMatcher);
      if (expression === `to.have.text.array`) {
        const matches =
          texts.length === matchers.length && matchers.every((match, index) => match(texts[index]));
        return { matches, received: texts };
      }
      let next = 0;
      for (const text of texts) {
        if (next < matchers.length && matchers[next](text)) next += 1;
      }
      return { matches: next === matchers.length, received: texts };
    }
    const element = single(steps);
    if (expression === `to.be.attached`)
      return { matches: !!element, received: element ? `attached` : `detached` };
    if (expression === `to.be.detached`)
      return { matches: !element, received: element ? `attached` : `detached` };
    if (expression === `to.be.hidden`) {
      const hidden = !element || !isVisible(element);
      return { matches: hidden, received: hidden ? `hidden` : `visible` };
    }
    if (!element) return { matches: false, received: `<element(s) not found>` };
    /** @param {unknown} value */
    const matchesText = (value) =>
      typeof value === `string` && textMatcher(options.expectedText[0])(value);
    switch (expression) {
      case `to.be.visible`: {
        const visible = isVisible(element);
        return { matches: visible, received: visible ? `visible` : `hidden` };
      }
      case `to.be.enabled`:
      case `to.be.disabled`: {
        const disabled = isDisabled(element);
        return {
          matches: disabled === (expression === `to.be.disabled`),
          received: disabled ? `disabled` : `enabled`,
        };
      }
      case `to.be.checked`: {
        const checked = !!element.checked;
        return {
          matches: checked === (options.expectedValue?.checked ?? true),
          received: checked ? `checked` : `unchecked`,
        };
      }
      case `to.be.focused`: {
        const focused = document.activeElement === element;
        return { matches: focused, received: focused ? `focused` : `inactive` };
      }
      case `to.have.attribute`: {
        const has = element.hasAttribute(options.expressionArg);
        return { matches: has, received: has ? `attribute present` : `attribute not present` };
      }
      case `to.have.attribute.value`: {
        const value = element.getAttribute(options.expressionArg);
        return { matches: matchesText(value), received: value };
      }
      case `to.have.class`: {
        const value = element.classList.toString();
        return { matches: matchesText(value), received: value };
      }
      case `to.have.text`: {
        const value = options.useInnerText ? element.innerText : elementText(element);
        return { matches: matchesText(value), received: value };
      }
      case `to.have.value`: {
        if (!(`value` in element)) throw new Error(`Not an input element`);
        return { matches: matchesText(element.value), received: element.value };
      }
    }
    throw new Error(`the Linux harness does not support ${expression}`);
  };

  /**
   * Resolves after two animation frames, once layout has settled.
   * @returns {Promise<void>}
   */
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  /**
   * The point an action on the locator's element clicks, after scrolling
   * the element into view, or why the action has to wait: Playwright's
   * checks that the element is visible and enabled and is the one that
   * would get the click, which `force` skips. The point is the middle of
   * the element's first box, or `position` from its top left corner.
   * @param {any[]} steps
   * @param {{ force?: boolean, position?: { x: number, y: number } }} options
   * @returns {Promise<{ x?: number, y?: number, wait?: string }>}
   */
  const actionPoint = async (steps, options) => {
    const element = single(steps);
    if (!element) return { wait: `no element matches` };
    if (!options.force) {
      if (!isVisible(element)) return { wait: `the element is not visible` };
      if (isDisabled(element)) return { wait: `the element is disabled` };
    }
    if (element.scrollIntoViewIfNeeded) element.scrollIntoViewIfNeeded(true);
    else element.scrollIntoView({ block: `center`, inline: `center` });
    await frames();
    const boxes = [...element.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    const box = boxes[0] ?? element.getBoundingClientRect();
    const x = options.position ? box.left + options.position.x : box.left + box.width / 2;
    const y = options.position ? box.top + options.position.y : box.top + box.height / 2;
    if (!options.force) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== element && !element.contains(hit))) {
        return { wait: `another element would receive the click` };
      }
    }
    return { x, y };
  };

  /**
   * Playwright's fill: focuses the element, selects its content, and
   * inserts the value in its place, or deletes the content for an empty
   * value.
   * @param {any} element
   * @param {string} value
   */
  const fill = (element, value) => {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
    } else if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = /** @type {Selection} */ (getSelection());
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      throw new Error(`the element is not an <input>, <textarea> or [contenteditable] element`);
    }
    const done = value
      ? document.execCommand(`insertText`, false, value)
      : document.execCommand(`delete`, false);
    if (!done && `value` in element) {
      element.value = value;
      element.dispatchEvent(new Event(`input`, { bubbles: true }));
    }
  };

  /**
   * Dispatches an event of the type Playwright would create for its
   * name.
   * @param {any} element
   * @param {string} type
   * @param {Record<string, unknown>} init
   */
  const dispatch = (element, type, init) => {
    const options = { bubbles: true, cancelable: true, composed: true, ...init };
    let event;
    if (/^(click|dblclick|mouse|pointer|contextmenu)/.test(type))
      event = new MouseEvent(type, options);
    else if (/^key/.test(type)) event = new KeyboardEvent(type, options);
    else if (/^(focus|blur)/.test(type)) event = new FocusEvent(type, options);
    else event = new Event(type, options);
    element.dispatchEvent(event);
  };

  /**
   * Resolves once the page has seen `wanted` events of a counted type, or
   * `timeoutMs` has passed, and then after the tasks already queued, so
   * the work the events queued has run.
   * @param {string} counter
   * @param {number} wanted
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  const settle = (counter, wanted, timeoutMs) =>
    new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (seen[counter] >= wanted || Date.now() >= deadline) {
          setTimeout(() => resolve(true), 0);
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });

  page.__linuxHarness = {
    seen,
    query,
    single,
    isVisible,
    expect,
    actionPoint,
    fill,
    dispatch,
    settle,
  };
  return page.__linuxHarness;
}

/**
 * The expression that runs `body` with `harness` bound to the page's
 * harness helpers, when the page has them, and answers with what `body`
 * returns, or with `harnessMissing` when it does not have them.
 * @param {string} body
 * @returns {string}
 */
function withInstalledHarness(body) {
  return `(async () => { const harness = window.__linuxHarness; if (!harness) return { harnessMissing: true }; return { value: await (async () => { ${body} })() }; })()`;
}

/**
 * The expression that sets the harness helpers up in the page, runs
 * `body` with `harness` bound to them, and answers with what `body`
 * returns.
 * @param {string} body
 * @returns {string}
 */
function withNewHarness(body) {
  return `(async () => { const harness = (${pageHarness.toString()})(); return { value: await (async () => { ${body} })() }; })()`;
}

/**
 * Keyboard input to the app's window.
 */
class LinuxKeyboard {
  /** @type {LinuxPage} */
  #page;

  /** @param {LinuxPage} page */
  constructor(page) {
    this.#page = page;
  }

  /**
   * Presses a key combination, written as Playwright writes them.
   * @param {string} key
   */
  async press(key) {
    await this.#page.sendInput(`keyup`, `keys`, [key]);
  }

  /**
   * Types a text, one key per character.
   * @param {string} text
   */
  async type(text) {
    if (text) await this.#page.sendInput(`keyup`, `type`, [text]);
  }
}

/**
 * Mouse input to the app's window, at points of the page in CSS pixels.
 */
class LinuxMouse {
  /** @type {LinuxPage} */
  #page;

  /** @type {{ x: number, y: number }} */
  #position = { x: 0, y: 0 };

  /** @param {LinuxPage} page */
  constructor(page) {
    this.#page = page;
  }

  /**
   * Moves the pointer to a point of the page.
   * @param {number} x
   * @param {number} y
   */
  async move(x, y) {
    this.#position = { x, y };
    const point = await this.#page.clientPoint(x, y);
    await this.#page.sendInput(`mousemove`, `move`, [point.x, point.y], 1);
  }

  /**
   * Clicks a button, the left one unless `button` names another, at a
   * point of the page.
   * @param {number} x
   * @param {number} y
   * @param {{ clickCount?: number, button?: string }} [options]
   */
  async click(x, y, options = {}) {
    this.#position = { x, y };
    const count = options.clickCount ?? 1;
    const point = await this.#page.clientPoint(x, y);
    await this.#page.sendInput(
      `mouseup`,
      `click`,
      [point.x, point.y, count, options.button ?? `left`],
      count,
    );
  }

  /**
   * Double-clicks the left button at a point of the page.
   * @param {number} x
   * @param {number} y
   */
  async dblclick(x, y) {
    await this.click(x, y, { clickCount: 2 });
  }

  /**
   * Presses a button, the left one unless `button` names another, where
   * the pointer is.
   * @param {{ button?: string }} [options]
   */
  async down(options = {}) {
    const point = await this.#page.clientPoint(this.#position.x, this.#position.y);
    await this.#page.sendInput(
      `mousedown`,
      `down`,
      [point.x, point.y, options.button ?? `left`],
      1,
    );
  }

  /**
   * Releases a button, the left one unless `button` names another, where
   * the pointer is.
   * @param {{ button?: string }} [options]
   */
  async up(options = {}) {
    const point = await this.#page.clientPoint(this.#position.x, this.#position.y);
    await this.#page.sendInput(`mouseup`, `up`, [point.x, point.y, options.button ?? `left`], 1);
  }
}

/**
 * A lazy reference to elements of the page, as Playwright's Locator is.
 */
export class LinuxLocator {
  /** What Playwright's `expect` checks a locator by. */
  _apiName = `Locator`;

  /** @type {LinuxPage} */
  #page;

  /** @type {any[]} */
  #steps;

  /** @type {string} */
  #description;

  /**
   * @param {LinuxPage} page
   * @param {any[]} steps
   * @param {string} description
   */
  constructor(page, steps, description) {
    this.#page = page;
    this.#steps = steps;
    this.#description = description;
  }

  /** @returns {string} How Playwright would print the locator. */
  toString() {
    return this.#description;
  }

  /** @returns {LinuxPage} */
  page() {
    return this.#page;
  }

  /**
   * The elements matching a selector inside this locator's elements.
   * @param {string} selector
   * @param {{ hasText?: string | RegExp, hasNotText?: string | RegExp }} [options]
   * @returns {LinuxLocator}
   */
  locator(selector, options) {
    return new LinuxLocator(
      this.#page,
      [...this.#steps, ...selectorSteps(selector), ...optionSteps(options)],
      `${this.#description}.locator(${JSON.stringify(selector)})`,
    );
  }

  /**
   * This locator's elements that pass the options.
   * @param {{ hasText?: string | RegExp, hasNotText?: string | RegExp }} options
   * @returns {LinuxLocator}
   */
  filter(options) {
    return new LinuxLocator(
      this.#page,
      [...this.#steps, ...optionSteps(options)],
      `${this.#description}.filter(...)`,
    );
  }

  /**
   * The element at an index, counted from the end when it is negative.
   * @param {number} index
   * @returns {LinuxLocator}
   */
  nth(index) {
    return new LinuxLocator(
      this.#page,
      [...this.#steps, { kind: `nth`, index }],
      `${this.#description}.nth(${index})`,
    );
  }

  /** @returns {LinuxLocator} */
  first() {
    return this.nth(0);
  }

  /** @returns {LinuxLocator} */
  last() {
    return this.nth(-1);
  }

  /**
   * Polls an expectation until it gives the outcome Playwright's matcher
   * wants or the timeout runs out, as Playwright's own `_expect` does.
   * @param {string} expression
   * @param {any} options
   * @returns {Promise<any>}
   */
  async _expect(expression, options) {
    const { expectedText, expectedNumber, expectedValue, expressionArg, useInnerText } = options;
    const pageOptions = {
      expectedText,
      expectedNumber,
      expectedValue,
      expressionArg,
      useInnerText,
    };
    const deadline = Date.now() + (options.timeout || 5_000);
    while (true) {
      let outcome;
      try {
        outcome = await this.#page.evaluateWithHarness(
          `return harness.expect(${source(this.#steps)}, ${source(expression)}, ${source(pageOptions)});`,
        );
      } catch (error) {
        if (!isNavigationError(error)) {
          return { matches: options.isNot, log: [], timedOut: false, errorMessage: String(error) };
        }
        outcome = { matches: options.isNot, received: `<the page is loading>` };
      }
      const received = { value: outcome.received };
      if (outcome.matches !== options.isNot) {
        return { matches: outcome.matches, received, log: [], timedOut: false };
      }
      if (Date.now() >= deadline) {
        return { matches: outcome.matches, received, log: [], timedOut: true };
      }
      await delay(POLL_MS);
    }
  }

  /**
   * Runs `body` in the page with `element` bound to the locator's one
   * element, once there is one, and resolves with what it returns.
   * @param {string} body
   * @returns {Promise<any>}
   */
  async #withElement(body) {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    while (true) {
      const outcome = await this.#page
        .evaluateWithHarness(
          `const element = harness.single(${source(this.#steps)}); if (!element) return { missing: true }; return { value: await (async () => { ${body} })() };`,
        )
        .catch((error) => {
          if (isNavigationError(error)) return { missing: true };
          throw error;
        });
      if (!outcome.missing) return outcome.value;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${this.#description}`);
      await delay(POLL_MS);
    }
  }

  /** @returns {Promise<number>} How many elements match now. */
  count() {
    return this.#page.evaluateWithHarness(`return harness.query(${source(this.#steps)}).length;`);
  }

  /** @returns {Promise<boolean>} Whether the one matching element is visible now. */
  isVisible() {
    return this.#page.evaluateWithHarness(
      `const element = harness.single(${source(this.#steps)}); return !!element && harness.isVisible(element);`,
    );
  }

  /** @returns {Promise<string | null>} */
  textContent() {
    return this.#withElement(`return element.textContent;`);
  }

  /** @returns {Promise<string>} */
  innerText() {
    return this.#withElement(`return element.innerText;`);
  }

  /** @returns {Promise<string>} */
  inputValue() {
    return this.#withElement(
      `if (!('value' in element)) throw new Error('Not an input element'); return element.value;`,
    );
  }

  /**
   * @param {string} name
   * @returns {Promise<string | null>}
   */
  getAttribute(name) {
    return this.#withElement(`return element.getAttribute(${source(name)});`);
  }

  /**
   * The element's box in CSS pixels from the top left of the page's
   * viewport, or null when it is not visible.
   * @returns {Promise<{ x: number, y: number, width: number, height: number } | null>}
   */
  boundingBox() {
    return this.#withElement(
      `const box = element.getBoundingClientRect(); return box.width === 0 && box.height === 0 ? null : { x: box.x, y: box.y, width: box.width, height: box.height };`,
    );
  }

  /**
   * Calls a function in the page with the element and an argument.
   * @param {Function} pageFunction
   * @param {unknown} [arg]
   * @returns {Promise<any>}
   */
  evaluate(pageFunction, arg) {
    return this.#withElement(`return (${pageFunction.toString()})(element, ${source(arg)});`);
  }

  /**
   * Calls a function in the page with every matching element and an
   * argument.
   * @param {Function} pageFunction
   * @param {unknown} [arg]
   * @returns {Promise<any>}
   */
  evaluateAll(pageFunction, arg) {
    return this.#page.evaluateWithHarness(
      `return (${pageFunction.toString()})(harness.query(${source(this.#steps)}), ${source(arg)});`,
    );
  }

  /** @returns {Promise<string[]>} The inner text of every matching element. */
  allInnerTexts() {
    return this.#page.evaluateWithHarness(
      `return harness.query(${source(this.#steps)}).map((element) => element.innerText);`,
    );
  }

  /** @returns {Promise<string[]>} The text content of every matching element. */
  allTextContents() {
    return this.#page.evaluateWithHarness(
      `return harness.query(${source(this.#steps)}).map((element) => element.textContent ?? '');`,
    );
  }

  /**
   * Waits until the locator's element is in a state: `visible` (the
   * default), `hidden`, `attached` or `detached`.
   * @param {{ state?: string, timeout?: number }} [options]
   */
  async waitFor(options = {}) {
    const state = options.state ?? `visible`;
    const expression = {
      visible: `to.be.visible`,
      hidden: `to.be.hidden`,
      attached: `to.be.attached`,
      detached: `to.be.detached`,
    }[state];
    if (!expression) throw new Error(`unknown state ${state}`);
    const outcome = await this._expect(expression, {
      isNot: false,
      timeout: options.timeout ?? ACTION_TIMEOUT_MS,
    });
    if (outcome.errorMessage) throw new Error(outcome.errorMessage);
    if (!outcome.matches)
      throw new Error(`timed out waiting for ${this.#description} to be ${state}`);
  }

  /**
   * The point of the page an action clicks, once Playwright's checks
   * pass.
   * @param {{ force?: boolean, position?: { x: number, y: number } }} options
   * @returns {Promise<{ x: number, y: number }>}
   */
  async #actionPoint(options) {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    const pageOptions = { force: options.force, position: options.position };
    while (true) {
      const outcome = await this.#page
        .evaluateWithHarness(
          `return harness.actionPoint(${source(this.#steps)}, ${source(pageOptions)});`,
        )
        .catch((error) => {
          if (isNavigationError(error)) return { wait: `the page is loading` };
          throw error;
        });
      if (!outcome.wait) return outcome;
      if (Date.now() >= deadline) {
        throw new Error(`timed out clicking ${this.#description}: ${outcome.wait}`);
      }
      await delay(POLL_MS);
    }
  }

  /**
   * Clicks the element with the real mouse.
   * @param {{ force?: boolean, position?: { x: number, y: number }, clickCount?: number, button?: string }} [options]
   */
  async click(options = {}) {
    const point = await this.#actionPoint(options);
    await this.#page.mouse.click(point.x, point.y, {
      clickCount: options.clickCount,
      button: options.button,
    });
  }

  /**
   * Double-clicks the element with the real mouse.
   * @param {{ force?: boolean, position?: { x: number, y: number } }} [options]
   */
  async dblclick(options = {}) {
    await this.click({ ...options, clickCount: 2 });
  }

  /**
   * Moves the real pointer over the element.
   * @param {{ force?: boolean, position?: { x: number, y: number } }} [options]
   */
  async hover(options = {}) {
    const point = await this.#actionPoint(options);
    await this.#page.mouse.move(point.x, point.y);
  }

  /** Focuses the element. */
  async focus() {
    await this.#withElement(`element.focus();`);
  }

  /**
   * Replaces the element's content with a value, as Playwright's fill
   * does.
   * @param {string} value
   */
  async fill(value) {
    await this.#withElement(`harness.fill(element, ${source(value)});`);
  }

  /**
   * Focuses the element and presses a key combination.
   * @param {string} key
   */
  async press(key) {
    await this.focus();
    await this.#page.keyboard.press(key);
  }

  /**
   * Clicks a checkbox or radio button until it has the given state.
   * @param {boolean} checked
   */
  async #setChecked(checked) {
    if ((await this.#withElement(`return !!element.checked;`)) === checked) return;
    await this.click();
    if ((await this.#withElement(`return !!element.checked;`)) !== checked) {
      throw new Error(`clicking ${this.#description} did not change its state`);
    }
  }

  /** Checks a checkbox or radio button. */
  async check() {
    await this.#setChecked(true);
  }

  /** Unchecks a checkbox. */
  async uncheck() {
    await this.#setChecked(false);
  }

  /**
   * Dispatches an event on the element.
   * @param {string} type
   * @param {Record<string, unknown>} [init]
   */
  async dispatchEvent(type, init = {}) {
    await this.#withElement(`harness.dispatch(element, ${source(type)}, ${source(init)});`);
  }

  /** Scrolls the element into view. */
  async scrollIntoViewIfNeeded() {
    await this.#withElement(
      `if (element.scrollIntoViewIfNeeded) element.scrollIntoViewIfNeeded(true); else element.scrollIntoView();`,
    );
  }
}

/**
 * The part of Playwright's Page that the specs use, for the app's page on
 * Linux.
 */
export class LinuxPage {
  /** @type {import('./webkit-inspector.js').WebKitInspector} */
  #inspector;

  /** @type {import('./x11-display.js').X11Input} */
  #input;

  /** @type {(bounds: { width: number, height: number }) => Promise<unknown>} */
  #resizeWindow;

  /** @type {string} */
  #url;

  /**
   * Where the page's top left corner is in the window's client area: the
   * menu bar above it.
   * @type {{ x: number, y: number } | undefined}
   */
  #offset;

  /** @type {Map<string, Function[]>} */
  #handlers = new Map();

  /**
   * The scripts every page load runs before the page's own.
   * @type {string[]}
   */
  #initScripts = [];

  /**
   * @param {import('./webkit-inspector.js').WebKitInspector} inspector
   * @param {import('./x11-display.js').X11Input} input
   * @param {{ url: string, resizeWindow: (bounds: { width: number, height: number }) => Promise<unknown> }} options
   */
  constructor(inspector, input, options) {
    this.#inspector = inspector;
    this.#input = input;
    this.#url = options.url;
    this.#resizeWindow = options.resizeWindow;
    this.keyboard = new LinuxKeyboard(this);
    this.mouse = new LinuxMouse(this);
  }

  /** @returns {string} The page's URL. */
  url() {
    return this.#url;
  }

  /**
   * Runs `body` in the page with `harness` bound to the harness helpers,
   * and resolves with what it returns. The helpers' script is sent only
   * when the page does not have them yet, as after a load.
   * @param {string} body
   * @returns {Promise<any>}
   */
  async evaluateWithHarness(body) {
    const outcome = await this.#inspector.evaluate(withInstalledHarness(body));
    if (!outcome.harnessMissing) return outcome.value;
    return (await this.#inspector.evaluate(withNewHarness(body))).value;
  }

  /**
   * Evaluates a function, called with an argument, or an expression in
   * the page, and resolves with its value, or with undefined when the
   * page is replaced while it runs, as when it reloads the page.
   * @param {Function | string} pageFunction
   * @param {unknown} [arg]
   * @returns {Promise<any>}
   */
  async evaluate(pageFunction, arg) {
    const expression =
      typeof pageFunction === `function`
        ? `(${pageFunction.toString()})(${source(arg)})`
        : pageFunction;
    try {
      return await this.#inspector.evaluate(expression);
    } catch (error) {
      if (isNavigationError(error)) return undefined;
      throw error;
    }
  }

  /**
   * Polls a function in the page until it returns a truthy value, and
   * resolves with that value.
   * @param {Function | string} pageFunction
   * @param {unknown} [arg]
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<any>}
   */
  async waitForFunction(pageFunction, arg, options = {}) {
    const deadline = Date.now() + (options.timeout || ACTION_TIMEOUT_MS);
    while (true) {
      const value = await this.evaluate(pageFunction, arg).catch((error) => {
        if (isNavigationError(error)) return undefined;
        throw error;
      });
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for a function to be truthy`);
      await delay(POLL_MS);
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  waitForTimeout(ms) {
    return delay(ms);
  }

  /**
   * The elements matching a selector.
   * @param {string} selector
   * @param {{ hasText?: string | RegExp, hasNotText?: string | RegExp }} [options]
   * @returns {LinuxLocator}
   */
  locator(selector, options) {
    return new LinuxLocator(
      this,
      [...selectorSteps(selector), ...optionSteps(options)],
      `locator(${JSON.stringify(selector)})`,
    );
  }

  /**
   * Waits until the first element matching a selector is in a state:
   * `visible` (the default), `hidden`, `attached` or `detached`.
   * @param {string} selector
   * @param {{ state?: string, timeout?: number }} [options]
   * @returns {Promise<LinuxLocator>}
   */
  async waitForSelector(selector, options = {}) {
    const first = this.locator(selector).first();
    await first.waitFor(options);
    return first;
  }

  /**
   * Clicks the element matching a selector.
   * @param {string} selector
   * @param {{ force?: boolean, position?: { x: number, y: number } }} [options]
   */
  async click(selector, options) {
    await this.locator(selector).click(options);
  }

  /**
   * Fills the element matching a selector.
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    await this.locator(selector).fill(value);
  }

  /**
   * Where the page's top left corner is in the window's client area, in
   * physical pixels: the window's height less the page's is the menu bar
   * above the page.
   * @returns {Promise<{ x: number, y: number }>}
   */
  async #pageOffset() {
    if (!this.#offset) {
      const state = await this.#input.run(`window`);
      const inner = await this.evaluate(() => window.innerHeight * window.devicePixelRatio);
      this.#offset = { x: 0, y: state.client.height - inner };
    }
    return this.#offset;
  }

  /**
   * A point of the page, in CSS pixels, as a point of the window's client
   * area in physical pixels.
   * @param {number} x
   * @param {number} y
   * @returns {Promise<{ x: number, y: number }>}
   */
  async clientPoint(x, y) {
    const offset = await this.#pageOffset();
    const ratio = await this.evaluate(() => window.devicePixelRatio);
    return { x: Math.round(x * ratio) + offset.x, y: Math.round(y * ratio) + offset.y };
  }

  /**
   * Sends input through the runner, then waits until the page has seen
   * as many events of the counted type as were sent, or for at most
   * INPUT_WAIT_MS, and then for the tasks already queued, so the work
   * the events queued, such as the page's selection change handling, has
   * run. Key commands count the key releases the runner reports.
   * @param {string} counter - The event type the page counts.
   * @param {string} command - The runner command.
   * @param {(string | number)[]} args
   * @param {number} [expected] - How many events to wait for, when the
   *   runner's answer does not say.
   */
  async sendInput(counter, command, args, expected) {
    const before = await this.evaluateWithHarness(`return harness.seen[${source(counter)}];`).catch(
      (error) => {
        if (isNavigationError(error)) return 0;
        throw error;
      },
    );
    const answer = await this.#input.run(command, ...args);
    const wanted = before + (expected ?? Number(answer));
    await this.evaluateWithHarness(
      `return harness.settle(${source(counter)}, ${wanted}, ${INPUT_WAIT_MS});`,
    ).catch((error) => {
      if (!isNavigationError(error)) throw error;
    });
  }

  /** Gives the app's window the input focus. */
  async focusWindow() {
    await this.#input.run(`focus`);
  }

  /**
   * Resizes the window so the page has the given size.
   * @param {{ width: number, height: number }} size
   */
  async setViewportSize(size) {
    const offset = await this.#pageOffset();
    await this.#resizeWindow({ width: size.width + offset.x, height: size.height + offset.y });
    await this.waitForFunction(
      (/** @type {number[]} */ [width, height]) =>
        window.innerWidth === width && window.innerHeight === height,
      [size.width, size.height],
      { timeout: 5_000 },
    );
  }

  /**
   * Registers a handler for a page event. The Linux harness records it
   * and calls none.
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
  }

  /**
   * Resolves when the page fires an event; only `close`, which the page
   * fires when its inspector connection closes, is supported.
   * @param {string} event
   * @returns {Promise<void>}
   */
  waitForEvent(event) {
    if (event !== `close`) throw new Error(`the Linux harness supports waitForEvent('close') only`);
    return this.#inspector.closed;
  }

  /**
   * Adds a function, called with an argument, or a script, that every
   * page load from now on runs before the page's own scripts: WebKit's
   * bootstrap script, which holds them all, and which WebKit runs only
   * while its Page domain is enabled.
   * @param {Function | string} script
   * @param {unknown} [arg]
   */
  async addInitScript(script, arg) {
    this.#initScripts.push(
      typeof script === `function` ? `(${script.toString()})(${source(arg)});` : script,
    );
    await this.#inspector.send(`Page.enable`, {});
    await this.#inspector.send(`Page.setBootstrapScript`, {
      source: this.#initScripts.join(`\n`),
    });
  }

  /** Reloads the page and waits until the new page has loaded. */
  async reload() {
    await this.evaluate(() => {
      /** @type {any} */ (window).__linuxReloading = true;
    });
    await this.#inspector.send(`Page.reload`, {});
    await this.waitForFunction(
      () => !(/** @type {any} */ (window).__linuxReloading) && document.readyState === `complete`,
    );
  }

  /**
   * Writes a picture of the page's viewport to a PNG file.
   * @param {{ path?: string }} [options]
   * @returns {Promise<Buffer>}
   */
  async screenshot(options = {}) {
    const size = await this.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const { dataURL } = await this.#inspector.send(`Page.snapshotRect`, {
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      coordinateSystem: `Viewport`,
    });
    const png = Buffer.from(String(dataURL).replace(/^data:image\/png;base64,/, ``), `base64`);
    if (options.path) writeFileSync(options.path, png);
    return png;
  }

  /** Closes the inspector connection. */
  disconnect() {
    this.#inspector.close();
  }
}
