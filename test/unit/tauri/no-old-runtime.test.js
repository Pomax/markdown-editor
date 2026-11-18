/**
 * @fileoverview Checks that the desktop runtime the app no longer uses is
 * not named in the repository, in a file's text or in a file's name, apart
 * from the files listed in ALLOWED.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);

/** The runtime's name, in parts so that this file does not contain it. */
const OLD_RUNTIME = new RegExp([`elec`, `tron`].join(``), `i`);

/** The folders that hold generated or downloaded files. */
const SKIPPED = new Set([
  `node_modules`,
  `target`,
  `build`,
  `gen`,
  `permissions`,
  `dist`,
  `test-results`,
  `.git`,
  `state`,
]);

/** The files that still name the runtime. */
const ALLOWED = new Set([`README.md`, join(`plans`, `plan.md`), join(`scripts`, `clean-dist.js`)]);

/**
 * Every file in a folder and the folders under it, skipped folders aside.
 * @param {string} dir
 * @returns {string[]}
 */
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

/**
 * Whether a text file's content, or any file's name, names the runtime.
 * @param {string} file
 * @returns {boolean}
 */
function namesOldRuntime(file) {
  if (ALLOWED.has(relative(root, file))) return false;
  if (OLD_RUNTIME.test(relative(root, file))) return true;
  const bytes = readFileSync(file);
  return !bytes.includes(0) && OLD_RUNTIME.test(bytes.toString(`utf-8`));
}

describe(`the old desktop runtime`, () => {
  it(`is named in no file and by no file name`, () => {
    const found = filesIn(root)
      .filter(namesOldRuntime)
      .map((file) => relative(root, file));
    assert.deepStrictEqual(found, []);
  });
});
