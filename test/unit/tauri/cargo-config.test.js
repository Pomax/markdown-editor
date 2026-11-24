/**
 * @fileoverview Asserts the root Cargo.toml takes its source from
 * src/tauri (the binaries and the build script), pulls in the dialog,
 * clipboard and opener plugins, enables the devtools feature but not the
 * asset protocol, defines the test-hooks feature and builds the runners
 * only with it, builds the release for size, pins tauri on the 2.x
 * line, depends on x11rb's XTEST support on Linux only, names its author
 * and describes the app, and has the version package.json has, which
 * `npm version` keeps in step.
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
  it(`names Pomax as the author and describes the app as Pomax's markdown editor`, () => {
    assert.match(cargo, /^authors = \["Pomax"\]$/m);
    assert.match(cargo, /^description = "Pomax's markdown editor"$/m);
  });

  it(`has the version package.json has`, () => {
    assert.strictEqual(cargo.match(/^version = "([^"]*)"/m)?.[1], pkg.version);
  });

  it(`locks the crate at the version package.json has`, () => {
    assert.strictEqual(
      lock.match(/name = "markdown-editor"\nversion = "([^"]*)"/)?.[1],
      pkg.version,
    );
  });

  it(`takes the binaries and the build script from src/tauri`, () => {
    assert.match(cargo, /build = "src\/tauri\/build\.rs"/);
    assert.match(cargo, /name = "markdown-editor"\npath = "src\/tauri\/main\.rs"/);
    assert.match(cargo, /name = "win-runner"\npath = "src\/tauri\/bin\/win-runner\.rs"/);
    assert.match(cargo, /name = "x11-runner"\npath = "src\/tauri\/bin\/x11-runner\.rs"/);
    for (const file of [
      `build.rs`,
      `main.rs`,
      join(`bin`, `win-runner.rs`),
      join(`bin`, `x11-runner.rs`),
    ]) {
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

  it(`builds the runners only with the test-hooks feature, so no release bundle has them`, () => {
    for (const runner of [`win-runner`, `x11-runner`]) {
      assert.match(
        cargo,
        new RegExp(`name = "${runner}"\\npath = "[^"]*"\\nrequired-features = \\["test-hooks"\\]`),
        runner,
      );
    }
  });

  it(`builds the release for size: stripped, link-time optimized, aborting on panic`, () => {
    const profile = cargo.match(/\[profile\.release\]\n((?:[^[\n].*\n)*)/)?.[1] ?? ``;
    assert.match(profile, /^strip = "symbols"$/m);
    assert.match(profile, /^lto = true$/m);
    assert.match(profile, /^codegen-units = 1$/m);
    assert.match(profile, /^opt-level = "s"$/m);
    assert.match(profile, /^panic = "abort"$/m);
  });

  it(`pins tauri on the 2.x line`, () => {
    assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"2\./);
  });

  it(`depends on x11rb's XTEST support on Linux only`, () => {
    assert.match(
      cargo,
      /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\nx11rb = \{ version = "0\.13", features = \["xtest"\] \}/,
    );
  });
});
