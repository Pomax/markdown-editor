/**
 * @fileoverview Asserts the page's Content-Security-Policy: the base
 * policy, with the Tauri IPC sources in connect-src and the media
 * protocol's sources in img-src and a new media-src, and every other
 * directive unchanged.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const html = readFileSync(join(root, `src`, `web`, `index.html`), `utf-8`);

/**
 * The base policy, directive by directive.
 * @type {Record<string, string[]>}
 */
const BASE_POLICY = {
  'default-src': [`'self'`],
  'script-src': [`'self'`, `https:`, `http:`],
  'style-src': [`'self'`, `'unsafe-inline'`],
  'img-src': [`'self'`, `file:`, `data:`, `https:`, `http:`],
  'frame-src': [`https:`, `http:`],
};

/**
 * The media protocol's sources: its scheme, and the address WebView2
 * serves it from.
 * @type {string[]}
 */
const MEDIA_SOURCES = [`media:`, `http://media.localhost`];

/**
 * Parses the page's CSP meta tag into directive name to token list.
 * @returns {Record<string, string[]>}
 */
function cspDirectives() {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  const policy = match ? match[1] : ``;
  /** @type {Record<string, string[]>} */
  const directives = {};
  for (const part of policy.split(`;`)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...values] = tokens;
    directives[name] = values;
  }
  return directives;
}

describe(`page CSP`, () => {
  it(`allows the Tauri IPC in connect-src`, () => {
    const directives = cspDirectives();
    assert.ok(directives[`connect-src`], `connect-src directive is present`);
    assert.ok(directives[`connect-src`].includes(`ipc:`), `connect-src allows ipc:`);
    assert.ok(
      directives[`connect-src`].includes(`http://ipc.localhost`),
      `connect-src allows http://ipc.localhost`,
    );
  });

  it(`adds the media sources to the base img-src`, () => {
    assert.deepStrictEqual(cspDirectives()[`img-src`], [
      ...BASE_POLICY[`img-src`],
      ...MEDIA_SOURCES,
    ]);
  });

  it(`allows the page's own and the media sources in media-src`, () => {
    assert.deepStrictEqual(cspDirectives()[`media-src`], [`'self'`, ...MEDIA_SOURCES]);
  });

  it(`leaves every other directive as the base policy has it`, () => {
    const directives = cspDirectives();
    const added = [`connect-src`, `img-src`, `media-src`];
    const others = Object.fromEntries(
      Object.entries(directives).filter(([name]) => !added.includes(name)),
    );
    const baseOthers = Object.fromEntries(
      Object.entries(BASE_POLICY).filter(([name]) => !added.includes(name)),
    );
    assert.deepStrictEqual(others, baseOthers);
  });
});
