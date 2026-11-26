/**
 * @fileoverview Makes the app's icon images from src/tauri/icons/icon.svg
 * with build-icons.js, in a process of its own, then builds the release
 * app with Tauri and copies the result to
 * Markdown-Editor.<ext> in its platform's folder under
 * dist/, touching nothing else there: on Windows the release .exe itself
 * in dist/windows (the frontend is embedded, so there is no bundle), on
 * macOS the .dmg in dist/macos, on Linux the .deb in dist/ubuntu, which
 * has apt install WebKitGTK and the other libraries the app uses. Each
 * platform's file is built on that platform. The platform is given as
 * --win, --mac or --linux and defaults to the one the script runs on.
 * The Tauri CLI is called through its Node API, so no .cmd shim is
 * spawned. On Windows the C runtime is linked statically, so the .exe
 * runs without the Visual C++ runtime installed. What the build leaves
 * behind is deleted once it is done; Cargo's target/ stays.
 * Run with: npm run build, or npm run dist:win / dist:mac / dist:linux
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '@tauri-apps/cli';
import { removeBuildLeftovers } from './build-leftovers.js';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);
const dist = join(root, `dist`);
const release = join(root, `target`, `release`);

/**
 * What a platform's build runs and where its result goes: Tauri's build
 * arguments, the environment variables the build gets, the folder the
 * result is left in, the result's file name there (`*.<ext>` for a bundle,
 * whose name Tauri derives), the platform's folder under dist/, and the
 * result's name in that folder.
 * @typedef {object} ReleaseTarget
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {string} sourceDir
 * @property {string} sourceName
 * @property {string} distDir
 * @property {string} artifact
 */

/**
 * The flag each platform builds for when none is given.
 * @type {Record<string, string>}
 */
const PLATFORM_FLAGS = {
  win32: `--win`,
  darwin: `--mac`,
  linux: `--linux`,
};

/**
 * The flag a run builds for: the one given on the command line, or the
 * current platform's.
 * @param {string[]} argv
 * @param {string} platform
 * @returns {string | undefined}
 */
export function platformFlag(argv, platform) {
  return (
    argv.find((arg) => Object.values(PLATFORM_FLAGS).includes(arg)) ?? PLATFORM_FLAGS[platform]
  );
}

/**
 * What the build for a flag runs and where its result goes.
 * @param {string} flag
 * @returns {ReleaseTarget}
 */
export function releaseTarget(flag) {
  switch (flag) {
    case `--win`:
      return {
        args: [`build`, `--no-bundle`],
        env: { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: `-C target-feature=+crt-static` },
        sourceDir: release,
        sourceName: `markdown-editor.exe`,
        distDir: join(dist, `windows`),
        artifact: `Markdown-Editor.exe`,
      };
    case `--mac`:
      return {
        args: [`build`, `--bundles`, `dmg`],
        env: {},
        sourceDir: join(release, `bundle`, `dmg`),
        sourceName: `*.dmg`,
        distDir: join(dist, `macos`),
        artifact: `Markdown-Editor.dmg`,
      };
    case `--linux`:
      return {
        args: [`build`, `--bundles`, `deb`],
        env: {},
        sourceDir: join(release, `bundle`, `deb`),
        sourceName: `*.deb`,
        distDir: join(dist, `ubuntu`),
        artifact: `Markdown-Editor.deb`,
      };
    default:
      throw new Error(`No release target for ${flag}`);
  }
}

/**
 * The built file among the names in its folder: the one with the
 * target's file name, or for a bundle the one with its extension.
 * @param {ReleaseTarget} target
 * @param {string[]} names
 * @returns {string | undefined}
 */
export function sourceFile(target, names) {
  const extension = target.sourceName.startsWith(`*`) ? target.sourceName.slice(1) : null;
  const name = names.find((entry) =>
    extension ? entry.endsWith(extension) : entry === target.sourceName,
  );
  return name === undefined ? undefined : join(target.sourceDir, name);
}

/**
 * Builds the release app for the given or current platform and copies it
 * to that platform's folder under dist/.
 * @returns {Promise<void>}
 */
async function buildExecutable() {
  process.chdir(root);
  const flag = platformFlag(process.argv, process.platform);
  if (!flag) {
    console.error(`No release target for platform ${process.platform}`);
    process.exit(1);
  }
  const target = releaseTarget(flag);
  const icons = spawnSync(process.execPath, [join(root, `scripts`, `build-icons.js`)], {
    stdio: `inherit`,
  });
  if (icons.status !== 0) {
    console.error(`Making the icon images failed`);
    process.exit(1);
  }
  Object.assign(process.env, target.env);
  try {
    await run(target.args, `build-executable`);
  } finally {
    removeBuildLeftovers();
  }
  const source = sourceFile(target, readdirSync(target.sourceDir));
  if (!source) {
    console.error(`No ${target.sourceName} in ${target.sourceDir}`);
    process.exit(1);
  }
  mkdirSync(target.distDir, { recursive: true });
  const destination = join(target.distDir, target.artifact);
  copyFileSync(source, destination);
  console.log(`  ${target.artifact}: ${statSync(destination).size} bytes`);
}

if (process.argv[1] === thisFile) {
  await buildExecutable();
}
