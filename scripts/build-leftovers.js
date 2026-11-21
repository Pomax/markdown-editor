/**
 * @fileoverview Deletes what a build leaves behind that nothing needs once
 * it is done: the staged frontend (build/), and the schemas (gen/) and
 * command permissions (permissions/) Tauri's build script writes at the
 * project root on every Cargo build. Cargo's own target/ is its build
 * cache and stays.
 */

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstage } from './stage-frontend.js';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`);

/**
 * Deletes build/, gen/ and permissions/ at the project root.
 */
export function removeBuildLeftovers() {
  unstage();
  for (const dir of [`gen`, `permissions`]) {
    rmSync(join(root, dir), { recursive: true, force: true });
  }
}
