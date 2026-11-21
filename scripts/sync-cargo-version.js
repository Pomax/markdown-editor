/**
 * @fileoverview Gives the Rust crate the version package.json has, in
 * Cargo.toml and Cargo.lock. Cargo cannot read its version from another
 * file, so `npm version` runs this after it changes package.json.
 * Run with: npm version <version>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);

/**
 * A Cargo.toml with the package's version changed. The package's version
 * is the first line that starts with `version`.
 * @param {string} manifest
 * @param {string} version
 * @returns {string}
 */
export function manifestWithVersion(manifest, version) {
  return manifest.replace(/^version = "[^"]*"/m, `version = "${version}"`);
}

/**
 * A Cargo.lock with the crate's own entry at the given version.
 * @param {string} lock
 * @param {string} version
 * @returns {string}
 */
export function lockWithVersion(lock, version) {
  return lock.replace(
    /(name = "markdown-editor"\nversion = )"[^"]*"/,
    (_, entry) => `${entry}"${version}"`,
  );
}

/**
 * Writes package.json's version into Cargo.toml and Cargo.lock.
 */
function syncCargoVersion() {
  const { version } = JSON.parse(readFileSync(join(root, `package.json`), `utf-8`));
  const manifest = join(root, `Cargo.toml`);
  const lock = join(root, `Cargo.lock`);
  writeFileSync(manifest, manifestWithVersion(readFileSync(manifest, `utf-8`), version));
  writeFileSync(lock, lockWithVersion(readFileSync(lock, `utf-8`), version));
}

if (process.argv[1] === thisFile) {
  syncCargoVersion();
}
