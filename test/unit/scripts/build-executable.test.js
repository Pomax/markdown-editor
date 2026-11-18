/**
 * @fileoverview Unit tests for scripts/build-executable.js: for each of
 * --win, --mac and --linux, the arguments Tauri's build gets, the
 * environment it gets (on Windows, Rust flags that link the C runtime
 * statically), the folder and file it leaves its result in (Cargo's
 * target/ at the project root), and the name that result is copied to in
 * dist/; the flag each platform defaults to; and picking the built file
 * out of its folder.
 */

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { platformFlag, releaseTarget, sourceFile } from '../../../scripts/build-executable.js';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const release = join(root, `target`, `release`);

describe(`build-executable`, () => {
  it(`builds the Windows exe without a bundle and names it Markdown-Editor-<version>-win.exe`, () => {
    assert.deepStrictEqual(releaseTarget(`--win`, `2.2.1`), {
      args: [`build`, `--no-bundle`],
      env: { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: `-C target-feature=+crt-static` },
      sourceDir: release,
      sourceName: `markdown-editor.exe`,
      artifact: `Markdown-Editor-2.2.1-win.exe`,
    });
  });

  it(`builds the macOS dmg and names it Markdown-Editor-<version>-mac.dmg`, () => {
    assert.deepStrictEqual(releaseTarget(`--mac`, `2.2.1`), {
      args: [`build`, `--bundles`, `dmg`],
      env: {},
      sourceDir: join(release, `bundle`, `dmg`),
      sourceName: `*.dmg`,
      artifact: `Markdown-Editor-2.2.1-mac.dmg`,
    });
  });

  it(`builds the Linux AppImage and names it Markdown-Editor-<version>-linux.AppImage`, () => {
    assert.deepStrictEqual(releaseTarget(`--linux`, `2.2.1`), {
      args: [`build`, `--bundles`, `appimage`],
      env: {},
      sourceDir: join(release, `bundle`, `appimage`),
      sourceName: `*.AppImage`,
      artifact: `Markdown-Editor-2.2.1-linux.AppImage`,
    });
  });

  it(`defaults to the current platform's flag, and a given flag wins`, () => {
    assert.strictEqual(platformFlag([`node`, `build-executable.js`], `win32`), `--win`);
    assert.strictEqual(platformFlag([`node`, `build-executable.js`], `darwin`), `--mac`);
    assert.strictEqual(platformFlag([`node`, `build-executable.js`], `linux`), `--linux`);
    assert.strictEqual(
      platformFlag([`node`, `build-executable.js`, `--linux`], `win32`),
      `--linux`,
    );
    assert.strictEqual(platformFlag([`node`, `build-executable.js`], `aix`), undefined);
  });

  it(`picks the built file out of its folder`, () => {
    const win = releaseTarget(`--win`, `2.2.1`);
    assert.strictEqual(
      sourceFile(win, [`build`, `markdown-editor.exe`, `markdown-editor.pdb`]),
      join(win.sourceDir, `markdown-editor.exe`),
    );
    const mac = releaseTarget(`--mac`, `2.2.1`);
    assert.strictEqual(
      sourceFile(mac, [`bundle_dmg.sh`, `Markdown Editor_2.2.1_aarch64.dmg`]),
      join(mac.sourceDir, `Markdown Editor_2.2.1_aarch64.dmg`),
    );
    assert.strictEqual(sourceFile(mac, [`bundle_dmg.sh`]), undefined);
  });
});
