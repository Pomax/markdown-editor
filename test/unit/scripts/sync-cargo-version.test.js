/**
 * @fileoverview Unit tests for scripts/sync-cargo-version.js: it changes
 * the crate's own version in Cargo.toml and Cargo.lock and no dependency's.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { lockWithVersion, manifestWithVersion } from '../../../scripts/sync-cargo-version.js';

describe(`sync-cargo-version`, () => {
  it(`changes the package's version in the manifest and no dependency's`, () => {
    const manifest = `[package]\nname = "markdown-editor"\nversion = "0.1.0"\n\n[dependencies]\ntauri = { version = "2.1" }\n`;
    assert.strictEqual(
      manifestWithVersion(manifest, `3.0.0`),
      `[package]\nname = "markdown-editor"\nversion = "3.0.0"\n\n[dependencies]\ntauri = { version = "2.1" }\n`,
    );
  });

  it(`changes only the crate's own entry in the lock file`, () => {
    const lock = `[[package]]\nname = "libc"\nversion = "0.1.0"\n\n[[package]]\nname = "markdown-editor"\nversion = "0.1.0"\n`;
    assert.strictEqual(
      lockWithVersion(lock, `3.0.0`),
      `[[package]]\nname = "libc"\nversion = "0.1.0"\n\n[[package]]\nname = "markdown-editor"\nversion = "3.0.0"\n`,
    );
  });
});
