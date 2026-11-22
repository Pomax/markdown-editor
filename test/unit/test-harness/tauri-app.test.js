/**
 * @fileoverview Unit tests for the TauriApp hook-protocol client, run
 * against a fake child process: replies are matched to requests by id,
 * tagged lines are found among other output, pending calls reject when
 * the child exits or its stdin fails, and close kills the child after
 * its timeout.
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { TauriApp } from '../../integration/tauri-app.js';

const TAG = `__HOOK__`;

/**
 * A stand-in for a spawned child process: records what is written to
 * stdin, lets a test push stdout data, and tracks kill().
 */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    /** @type {string[]} */
    this.written = [];
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stdin = Object.assign(new EventEmitter(), {
      write: (/** @type {string} */ s) => {
        this.written.push(s);
        return true;
      },
    });
  }

  kill() {
    this.killed = true;
  }

  /**
   * Emits one line of stdout.
   * @param {string} line
   */
  push(line) {
    this.stdout.emit(`data`, Buffer.from(`${line}\n`));
  }

  /**
   * Emits a tagged reply for a request id.
   * @param {number} id
   * @param {unknown} result
   */
  reply(id, result) {
    this.push(`${TAG}${JSON.stringify({ id, result })}`);
  }

  /** @returns {{ id: number, method: string, params: unknown }[]} */
  requests() {
    return this.written.map((s) => JSON.parse(s));
  }
}

describe(`TauriApp hook protocol`, () => {
  it(`matches replies to requests by id`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child);
    const p1 = app.windowCount();
    const p2 = app.clipboard.readText();
    const [r1, r2] = child.requests();
    child.reply(r2.id, `clip`);
    child.reply(r1.id, 3);
    assert.strictEqual(await p1, 3);
    assert.strictEqual(await p2, `clip`);
  });

  it(`finds tagged replies among other output`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child);
    const p = app.windowCount();
    child.push(`[app] starting up`);
    child.push(`a stray log line`);
    const [r] = child.requests();
    child.reply(r.id, 1);
    assert.strictEqual(await p, 1);
  });

  it(`rejects pending calls when the child exits`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child);
    const p = app.windowCount();
    child.emit(`exit`, 0);
    await assert.rejects(p);
  });

  it(`rejects calls instead of throwing when the child's stdin fails`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child);
    const p = app.windowCount();
    child.stdin.emit(`error`, new Error(`write EPIPE`));
    await assert.rejects(p);
    await assert.rejects(app.windowCount());
  });

  it(`kills the child when close times out`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child, { closeTimeoutMs: 20 });
    await app.close();
    assert.strictEqual(child.killed, true);
  });

  it(`does not kill the child when close responds in time`, async () => {
    const child = new FakeChild();
    const app = new TauriApp(child, { closeTimeoutMs: 1000 });
    const done = app.close();
    const close = child.requests().find((r) => r.method === `close`);
    assert.ok(close, `close request sent`);
    child.reply(close.id, true);
    await done;
    assert.strictEqual(child.killed, false);
  });
});
