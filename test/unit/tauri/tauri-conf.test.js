/**
 * @fileoverview Asserts tauri.conf.json carries the port's
 * configuration: identifier, product name, version source, frontend
 * staging and dev server, disabled global Tauri, injected CSP and asset
 * protocol, fullscreen refused, no startup window, and the bundle
 * category.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const config = JSON.parse(readFileSync(join(root, `tauri.conf.json`), `utf-8`));

describe(`tauri.conf.json`, () => {
  it(`identifies the app`, () => {
    assert.strictEqual(config.identifier, `com.pomax.markdown-editor`);
    assert.strictEqual(config.productName, `Markdown Editor`);
  });

  it(`reads the version from package.json`, () => {
    assert.strictEqual(config.version, `./package.json`);
  });

  it(`stages the frontend and serves the dev server`, () => {
    assert.strictEqual(config.build.frontendDist, `./build/frontend`);
    assert.strictEqual(config.build.devUrl, `http://localhost:1420`);
    assert.strictEqual(config.build.beforeDevCommand, `node scripts/dev-server.js`);
    assert.strictEqual(config.build.beforeBuildCommand, `node scripts/stage-frontend.js`);
  });

  it(`disables global Tauri and leaves the CSP to the page`, () => {
    assert.strictEqual(config.app.withGlobalTauri, false);
    assert.strictEqual(config.app.security.csp, null);
  });

  it(`leaves the asset protocol off`, () => {
    assert.notStrictEqual(config.app.security.assetProtocol?.enable, true);
  });

  it(`refuses fullscreen to the page and every frame in it`, () => {
    assert.strictEqual(config.app.security.headers?.[`Permissions-Policy`], `fullscreen=()`);
  });

  it(`creates no window at startup`, () => {
    assert.deepStrictEqual(config.app.windows, []);
  });

  it(`sets the bundle category`, () => {
    assert.strictEqual(config.bundle.category, `Productivity`);
  });
});
