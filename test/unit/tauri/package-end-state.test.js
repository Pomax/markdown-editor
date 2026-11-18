/**
 * @fileoverview Checks package.json's end state after the port: the
 * Tauri CLI and the
 * Node types are in, the scripts run the Tauri app and its tests, and
 * everything else is as it was.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const pkg = JSON.parse(readFileSync(join(root, `package.json`), `utf-8`));

describe(`package.json end state`, () => {
  it(`has exactly the expected development packages`, () => {
    assert.deepStrictEqual(pkg.devDependencies, {
      '@biomejs/biome': `^1.5.0`,
      '@playwright/test': `^1.64.1`,
      '@tauri-apps/cli': `^2`,
      '@types/node': `^22`,
      eslint: `^10.0.3`,
      jsdom: `^28.1.0`,
      'lucide-static': `^0.563.0`,
      typescript: `^5.3.0`,
    });
  });

  it(`has no dependencies`, () => {
    assert.deepStrictEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  it(`has no main, build section or docs script`, () => {
    assert.strictEqual(pkg.main, undefined);
    assert.strictEqual(pkg.build, undefined);
    assert.strictEqual(pkg.scripts.docs, undefined);
  });

  it(`keeps the overrides and engines`, () => {
    assert.deepStrictEqual(pkg.overrides, {
      ajv: `^6.14.0`,
      minimatch: `^10.2.4`,
      tar: `^7.5.8`,
      yauzl: `^3.4.0`,
    });
    assert.deepStrictEqual(pkg.engines, { node: `>=22` });
  });

  it(`runs the Tauri app, its build and its tests`, () => {
    assert.strictEqual(pkg.scripts.start, `tauri dev`);
    assert.strictEqual(pkg.scripts.setup, `playwright install firefox --with-deps`);
    assert.strictEqual(pkg.scripts.build, `npm run lint && node scripts/build-executable.js`);
    assert.strictEqual(pkg.scripts[`dist:linux`], `node scripts/build-executable.js --linux`);
    assert.strictEqual(pkg.scripts[`dist:mac`], `node scripts/build-executable.js --mac`);
    assert.strictEqual(pkg.scripts[`dist:win`], `node scripts/build-executable.js --win`);
    assert.ok(pkg.scripts.lint.includes(`npm run lint:rust`), `lint runs lint:rust`);
    assert.strictEqual(
      pkg.scripts.test,
      `npm run lint && npm run test:unit && npm run test:rust && npm run test:integration && npm run test:cleanup`,
    );
    assert.strictEqual(pkg.scripts[`test:rust`], `node scripts/test-rust.js`);
    assert.strictEqual(
      pkg.scripts[`test:integration`],
      `node scripts/build-test-app.js && playwright test`,
    );
    assert.strictEqual(pkg.scripts.cleanup, `rm -rf test-results`);
    assert.strictEqual(pkg.scripts[`test:cleanup`], `rm -rf test-results`);
  });

  it(`names tauri among its keywords`, () => {
    assert.deepStrictEqual(pkg.keywords, [`markdown`, `editor`, `tauri`, `wysiwyg`]);
  });
});
