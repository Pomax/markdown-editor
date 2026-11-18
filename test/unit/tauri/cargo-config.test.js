/**
 * @fileoverview Asserts the root Cargo.toml takes its source from
 * src/tauri (both binaries and the build script), pulls in the dialog,
 * clipboard and opener plugins, enables the devtools feature but not the
 * asset protocol, defines the test-hooks feature, pins tauri on the 2.x
 * line, and has the version package.json has, which `npm version` keeps
 * in step.
 */

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const cargo = readFileSync(join(root, `Cargo.toml`), `utf-8`);
const lock = readFileSync(join(root, `Cargo.lock`), `utf-8`);
const pkg = JSON.parse(readFileSync(join(root, `package.json`), `utf-8`));

describe(`Cargo configuration`, () => {
  it(`has the version package.json has`, () => {
    assert.strictEqual(cargo.match(/^version = "([^"]*)"/m)?.[1], pkg.version);
  });

  it(`locks the crate at the version package.json has`, () => {
    assert.strictEqual(
      lock.match(/name = "markdown-editor"\nversion = "([^"]*)"/)?.[1],
      pkg.version,
    );
  });

  it(`follows package.json when npm version changes it`, () => {
    assert.strictEqual(pkg.scripts.version, `node scripts/sync-cargo-version.js`);
  });

  it(`takes the binaries and the build script from src/tauri`, () => {
    assert.match(cargo, /build = "src\/tauri\/build\.rs"/);
    assert.match(cargo, /name = "markdown-editor"\npath = "src\/tauri\/main\.rs"/);
    assert.match(cargo, /name = "win-runner"\npath = "src\/tauri\/bin\/win-runner\.rs"/);
    for (const file of [`build.rs`, `main.rs`, join(`bin`, `win-runner.rs`)]) {
      assert.ok(existsSync(join(root, `src`, `tauri`, file)), file);
    }
  });

  it(`depends on the dialog, clipboard and opener plugins`, () => {
    assert.match(cargo, /tauri-plugin-dialog/);
    assert.match(cargo, /tauri-plugin-clipboard-manager/);
    assert.match(cargo, /tauri-plugin-opener/);
  });

  it(`enables the devtools feature and not the asset protocol`, () => {
    assert.match(cargo, /features\s*=\s*\[[^\]]*"devtools"/);
    assert.doesNotMatch(cargo, /protocol-asset/);
  });

  it(`defines the test-hooks feature`, () => {
    assert.match(cargo, /\[features\]/);
    assert.match(cargo, /test-hooks\s*=/);
  });

  it(`pins tauri on the 2.x line`, () => {
    assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"2\./);
  });
});
