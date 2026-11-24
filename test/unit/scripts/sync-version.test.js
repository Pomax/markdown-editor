/**
 * @fileoverview Unit tests for scripts/sync-version.js: `npm version` runs
 * it before it writes package.json and stages what it synced, it fails for
 * a new version RELEASE_LOG.md has no section for, it changes the crate's
 * own version in Cargo.toml and Cargo.lock and no dependency's, and
 * README.md's current version heading and download links, and it finds
 * whether RELEASE_LOG.md has a section for a version.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  lockWithVersion,
  manifestWithVersion,
  readmeWithVersion,
  releaseLogHasVersion,
} from '../../../scripts/sync-version.js';

const script = fileURLToPath(new URL(`../../../scripts/sync-version.js`, import.meta.url));
const pkg = JSON.parse(readFileSync(new URL(`../../../package.json`, import.meta.url), `utf-8`));

describe(`sync-version`, () => {
  it(`syncs before npm version writes package.json, and stages what it synced for the version commit`, () => {
    assert.strictEqual(pkg.scripts.preversion, `node scripts/sync-version.js`);
    assert.strictEqual(
      pkg.scripts.version,
      `git add Cargo.toml Cargo.lock README.md RELEASE_LOG.md`,
    );
  });

  it(`fails for a new version that the release log has no section for`, () => {
    const { status } = spawnSync(process.execPath, [script], {
      env: { ...process.env, npm_new_version: `0.0.0` },
    });
    assert.strictEqual(status, 1);
  });

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

  it(`changes the readme's current version heading and no other version`, () => {
    const readme = `# App\n\n## Current version: v3.0.0\n\nNew since v2.0.0.\n`;
    assert.strictEqual(
      readmeWithVersion(readme, `3.1.0`),
      `# App\n\n## Current version: v3.1.0\n\nNew since v2.0.0.\n`,
    );
  });

  it(`changes the version in the readme's download links and no other link`, () => {
    const readme = `- [App.exe](https://example.com/releases/download/v3.0.0/App.exe)\n- [App.dmg](https://example.com/releases/download/v3.0.0/App.dmg)\n- [App.deb](https://example.com/releases/download/v3.0.0/App.deb)\n\n[Releases](https://example.com/releases/latest)\n`;
    assert.strictEqual(
      readmeWithVersion(readme, `3.1.0`),
      `- [App.exe](https://example.com/releases/download/v3.1.0/App.exe)\n- [App.dmg](https://example.com/releases/download/v3.1.0/App.dmg)\n- [App.deb](https://example.com/releases/download/v3.1.0/App.deb)\n\n[Releases](https://example.com/releases/latest)\n`,
    );
  });

  it(`finds the release log's section for a version it has`, () => {
    const log = `# Release Log\n\n## v3.1.0\n\nFixes.\n\n## v3.0.0\n\nFeatures.\n`;
    assert.strictEqual(releaseLogHasVersion(log, `3.0.0`), true);
  });

  it(`finds no release log section for a version it does not have`, () => {
    const log = `# Release Log\n\n## v3.1.0\n\nFixes since v3.0.0.\n\n### v3.2.0\n`;
    assert.strictEqual(releaseLogHasVersion(log, `3.2.0`), false);
    assert.strictEqual(releaseLogHasVersion(log, `3.0.0`), false);
    assert.strictEqual(releaseLogHasVersion(log, `3.1`), false);
  });
});
