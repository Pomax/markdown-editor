/**
 * @fileoverview Stages the frontend for a Tauri build.
 *
 * Copies src/web and src/parsers/old into build/frontend as siblings,
 * matching the layout the page's relative imports expect, and drops type
 * declarations and node_modules so they never reach the embedded assets.
 * The build/frontend directory is cleared first. Tauri runs this before
 * each build; once the build has embedded the staged copy, the build
 * scripts delete it, and the build folder with it, through `unstage`.
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);
const buildDir = join(root, `build`);
const dest = join(buildDir, `frontend`);

/**
 * Whether a source path should be copied: everything except type
 * declarations and anything inside a node_modules directory.
 *
 * @param {string} src - Absolute source path offered by cpSync.
 * @returns {boolean}
 */
function include(src) {
  if (src.endsWith(`.d.ts`)) return false;
  if (src.split(/[\\/]/).includes(`node_modules`)) return false;
  return true;
}

/**
 * Clears build/frontend and copies src/web and src/parsers/old into it.
 */
export function stage() {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(root, `src`, `web`), join(dest, `web`), { recursive: true, filter: include });
  cpSync(join(root, `src`, `parsers`, `old`), join(dest, `parsers`, `old`), {
    recursive: true,
    filter: include,
  });
}

/**
 * Deletes the staged copy and the build folder that holds it.
 */
export function unstage() {
  rmSync(buildDir, { recursive: true, force: true });
}

if (process.argv[1] === thisFile) {
  stage();
}
