/**
 * @fileoverview Unit tests for the scripts/lint-eol.js helpers.
 *
 * The helpers are pure so they can be checked against string inputs:
 * a carriage return is found in sample text, binaries and excluded
 * folders are skipped, and a find maps to exit code 1.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  exitCodeFor,
  hasCarriageReturn,
  isExcludedDir,
  isTextFile,
} from '../../../scripts/lint-eol.js';

describe(`lint-eol helpers`, () => {
  it(`finds a carriage return in sample text`, () => {
    assert.strictEqual(hasCarriageReturn(`line one\r\nline two`), true);
    assert.strictEqual(hasCarriageReturn(`bare\rcr`), true);
  });

  it(`passes text that uses only LF`, () => {
    assert.strictEqual(hasCarriageReturn(`line one\nline two\n`), false);
    assert.strictEqual(hasCarriageReturn(``), false);
  });

  it(`scans known text extensions and dot-files`, () => {
    for (const name of [
      `a.js`,
      `a.cjs`,
      `a.mjs`,
      `a.ts`,
      `a.json`,
      `a.md`,
      `a.css`,
      `a.html`,
      `a.svg`,
      `a.rs`,
      `a.toml`,
      `a.bat`,
      `a.sh`,
      `a.yml`,
      `a.txt`,
      `.gitignore`,
    ]) {
      assert.strictEqual(isTextFile(name), true, name);
    }
  });

  it(`skips binary and unknown files`, () => {
    for (const name of [`icon.png`, `icon.ico`, `font.woff2`, `archive.zip`, `a.wasm`]) {
      assert.strictEqual(isTextFile(name), false, name);
    }
  });

  it(`skips excluded folders`, () => {
    for (const name of [`node_modules`, `build`, `target`, `gen`, `dist`, `test-results`]) {
      assert.strictEqual(isExcludedDir(name), true, name);
    }
    assert.strictEqual(isExcludedDir(`src`), false);
  });

  it(`exits with 1 only when a carriage return is found`, () => {
    assert.strictEqual(exitCodeFor([]), 0);
    assert.strictEqual(exitCodeFor([{ file: `a.js`, line: 1 }]), 1);
  });
});
