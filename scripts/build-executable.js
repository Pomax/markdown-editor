/**
 * @fileoverview Builds the release app with Tauri and copies the result to
 * dist/ as Markdown-Editor-<version>-<os>.<ext>, touching nothing else
 * there: on Windows the release .exe itself (the frontend is embedded, so
 * there is no bundle), on macOS the .dmg, on Linux the .AppImage. Each
 * platform's file is built on that platform. The platform is given as
 * --win, --mac or --linux and defaults to the one the script runs on.
 * The Tauri CLI is called through its Node API, so no .cmd shim is
 * spawned. On Windows the C runtime is linked statically, so the .exe
 * runs without the Visual C++ runtime installed. What the build leaves
 * behind is deleted once it is done; Cargo's target/ stays.
 * Run with: npm run build, or npm run dist:win / dist:mac / dist:linux
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
 * whose name Tauri derives), and its name in dist/.
 * @typedef {object} ReleaseTarget
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {string} sourceDir
 * @property {string} sourceName
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
 * @param {string} version
 * @returns {ReleaseTarget}
 */
export function releaseTarget(flag, version) {
  switch (flag) {
    case `--win`:
      return {
        args: [`build`, `--no-bundle`],
        env: { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: `-C target-feature=+crt-static` },
        sourceDir: release,
        sourceName: `markdown-editor.exe`,
        artifact: `Markdown-Editor-${version}-win.exe`,
      };
    case `--mac`:
      return {
        args: [`build`, `--bundles`, `dmg`],
        env: {},
        sourceDir: join(release, `bundle`, `dmg`),
        sourceName: `*.dmg`,
        artifact: `Markdown-Editor-${version}-mac.dmg`,
      };
    case `--linux`:
      return {
        args: [`build`, `--bundles`, `appimage`],
        env: {},
        sourceDir: join(release, `bundle`, `appimage`),
        sourceName: `*.AppImage`,
        artifact: `Markdown-Editor-${version}-linux.AppImage`,
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
 * to dist/.
 * @returns {Promise<void>}
 */
async function buildExecutable() {
  process.chdir(root);
  const flag = platformFlag(process.argv, process.platform);
  if (!flag) {
    console.error(`No release target for platform ${process.platform}`);
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, `package.json`), `utf-8`));
  const target = releaseTarget(flag, version);
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
  mkdirSync(dist, { recursive: true });
  const destination = join(dist, target.artifact);
  copyFileSync(source, destination);
  console.log(`  ${target.artifact}: ${statSync(destination).size} bytes`);
}

if (process.argv[1] === thisFile) {
  await buildExecutable();
}
