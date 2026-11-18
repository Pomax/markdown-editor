/**
 * @fileoverview Unit test for scripts/dev-server.js: it serves the
 * page and a parser module from src/ on the given port, with fullscreen
 * refused, as the app's own page is.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { stopServer } from '../../integration/test-http-server.js';
import { start } from '../../../scripts/dev-server.js';

describe(`dev-server`, () => {
  it(`serves the page and a parser module`, async () => {
    const { server, baseURL } = await start(0);
    try {
      const page = await fetch(`${baseURL}/web/index.html`);
      assert.strictEqual(page.status, 200);
      const parser = await fetch(`${baseURL}/parsers/old/dfa-parser.js`);
      assert.strictEqual(parser.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  it(`serves the page with fullscreen refused`, async () => {
    const { server, baseURL } = await start(0);
    try {
      const page = await fetch(`${baseURL}/web/index.html`);
      assert.strictEqual(page.headers.get(`permissions-policy`), `fullscreen=()`);
    } finally {
      await stopServer(server);
    }
  });
});
