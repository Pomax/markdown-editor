/**
 * @fileoverview Asserts the port's npm scripts exist and that Biome,
 * ESLint, tsc and lint-comments all cover src (src/tauri included) and
 * skip the build output and Cargo's target directory.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);

/**
 * Reads a file from the project root.
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  return readFileSync(join(root, rel), `utf-8`);
}

const pkg = JSON.parse(read(`package.json`));
const biome = JSON.parse(read(`biome.json`));
const jsconfig = JSON.parse(read(`jsconfig.json`));
const backticks = read(`backticks.config.js`);
const lintComments = read(join(`scripts`, `lint-comments.js`));

describe(`tool coverage`, () => {
  it(`has the port npm scripts`, () => {
    assert.strictEqual(pkg.scripts.start, `tauri dev`);
    assert.strictEqual(pkg.scripts[`lint:rust`], `cargo fmt`);
    assert.strictEqual(pkg.scripts[`test:rust`], `node scripts/test-rust.js`);
    assert.strictEqual(pkg.scripts[`build:test-app`], `node scripts/build-test-app.js`);
    assert.strictEqual(
      pkg.scripts[`test:integration`],
      `node scripts/build-test-app.js && playwright test`,
    );
  });

  it(`runs lint:rust as part of lint`, () => {
    assert.match(pkg.scripts.lint, /lint:rust/);
  });

  it(`covers src and skips build and target in Biome`, () => {
    assert.ok(biome.files.include.includes(`src/**/*.js`));
    assert.ok(biome.files.ignore.includes(`build`));
    assert.ok(biome.files.ignore.includes(`target`));
  });

  it(`covers src and skips build and target in tsc`, () => {
    assert.ok(jsconfig.include.includes(`src/**/*.js`));
    assert.ok(jsconfig.exclude.includes(`build`));
    assert.ok(jsconfig.exclude.includes(`target`));
  });

  it(`skips build and target in ESLint`, () => {
    assert.match(backticks, /`build\/\*\*`/);
    assert.match(backticks, /`target\/\*\*`/);
  });

  it(`scans src in lint-comments`, () => {
    assert.match(lintComments, /SCAN_DIRS = \[`src`,/);
  });
});
