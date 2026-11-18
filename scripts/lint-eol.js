/**
 * @fileoverview Fails on any carriage return in the project's text files.
 *
 * Scans the project for CRLF or lone CR in files chosen by extension
 * (plus dot-files such as .gitignore), skipping binaries and the
 * dependency and generated folders. Unlike lint-comments.js, which only
 * reports, this exits with code 1 when any carriage return is found, so
 * the LF rule has a saved check that also covers generated files.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);

/**
 * File extensions scanned as text and checked for carriage returns.
 * @type {Set<string>}
 */
export const TEXT_EXTENSIONS = new Set([
  `.js`,
  `.cjs`,
  `.mjs`,
  `.ts`,
  `.json`,
  `.md`,
  `.css`,
  `.html`,
  `.svg`,
  `.rs`,
  `.toml`,
  `.bat`,
  `.sh`,
  `.yml`,
  `.txt`,
]);

/**
 * Directory names skipped during the scan.
 * @type {Set<string>}
 */
export const EXCLUDED_DIRS = new Set([
  `node_modules`,
  `build`,
  `target`,
  `gen`,
  `dist`,
  `test-results`,
]);

/**
 * Whether a file name is scanned as text: a known text extension, or a
 * dot-file with no extension such as .gitignore.
 *
 * @param {string} name - A file's base name.
 * @returns {boolean}
 */
export function isTextFile(name) {
  const ext = extname(name).toLowerCase();
  if (ext === `` && name.startsWith(`.`)) return true;
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Whether a directory name is excluded from the scan.
 *
 * @param {string} name - A directory's base name.
 * @returns {boolean}
 */
export function isExcludedDir(name) {
  return EXCLUDED_DIRS.has(name);
}

/**
 * Whether the given text contains a carriage return.
 *
 * @param {string} text - File contents.
 * @returns {boolean}
 */
export function hasCarriageReturn(text) {
  return text.includes(`\r`);
}

/**
 * The process exit code for a set of violations: 1 when any are found.
 *
 * @param {{ file: string, line: number }[]} violations
 * @returns {number}
 */
export function exitCodeFor(violations) {
  return violations.length > 0 ? 1 : 0;
}

/**
 * Recursively collects scanned text files that contain a carriage
 * return, appending `{ file, line }` entries to `violations`.
 *
 * @param {string} dir - Absolute path to the directory to scan.
 * @param {{ file: string, line: number }[]} violations
 */
function scan(dir, violations) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!isExcludedDir(entry)) scan(full, violations);
      continue;
    }
    if (!isTextFile(entry)) continue;
    const text = readFileSync(full, `utf-8`);
    if (!hasCarriageReturn(text)) continue;
    const line = text.slice(0, text.indexOf(`\r`)).split(`\n`).length;
    violations.push({ file: relative(root, full), line });
  }
}

/**
 * Scans the project root and exits non-zero if a carriage return is found.
 */
function main() {
  /** @type {{ file: string, line: number }[]} */
  const violations = [];
  scan(root, violations);
  if (violations.length > 0) {
    console.error(`\nCarriage returns found (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
    }
    console.error(`\nFiles must use LF line endings.\n`);
  }
  process.exit(exitCodeFor(violations));
}

if (process.argv[1] === thisFile) {
  main();
}
