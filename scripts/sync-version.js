/**
 * @fileoverview The `npm version` preversion hook, which runs before npm
 * writes the new version into package.json and package-lock.json, and
 * takes that version from npm_new_version. When RELEASE_LOG.md has no
 * section for it, it writes nothing and exits with an error, which stops
 * `npm version` with package.json and package-lock.json unchanged.
 * Otherwise it writes the version into Cargo.toml and Cargo.lock, and into
 * README.md's "Current version" heading and download links, for the
 * version hook to stage for npm's version commit.
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
 * A README.md with the given version in its "Current version" heading and
 * in every release download link.
 * @param {string} readme
 * @param {string} version
 * @returns {string}
 */
export function readmeWithVersion(readme, version) {
  return readme
    .replace(/^## Current version: v.*$/m, `## Current version: v${version}`)
    .replace(/\/releases\/download\/v[^/]+\//g, `/releases/download/v${version}/`);
}

/**
 * Whether a RELEASE_LOG.md has a `## v<version>` section for the given
 * version.
 * @param {string} log
 * @param {string} version
 * @returns {boolean}
 */
export function releaseLogHasVersion(log, version) {
  return log.split(`\n`).includes(`## v${version}`);
}

/**
 * Writes npm_new_version into Cargo.toml, Cargo.lock and README.md, or
 * exits with an error when RELEASE_LOG.md has no section for it.
 */
function syncVersion() {
  const version = process.env.npm_new_version ?? ``;
  const releaseLog = readFileSync(join(root, `RELEASE_LOG.md`), `utf-8`);
  if (!releaseLogHasVersion(releaseLog, version)) {
    console.error(`RELEASE_LOG.md has no "## v${version}" section yet.\n`);
    process.exit(1);
  }
  const manifest = join(root, `Cargo.toml`);
  const lock = join(root, `Cargo.lock`);
  writeFileSync(manifest, manifestWithVersion(readFileSync(manifest, `utf-8`), version));
  writeFileSync(lock, lockWithVersion(readFileSync(lock, `utf-8`), version));
  const readme = join(root, `README.md`);
  writeFileSync(readme, readmeWithVersion(readFileSync(readme, `utf-8`), version));
}

if (process.argv[1] === thisFile) {
  syncVersion();
}
