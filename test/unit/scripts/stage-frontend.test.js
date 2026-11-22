/**
 * @fileoverview Unit test for scripts/stage-frontend.js: it stages
 * src/web and src/parsers/old into build/frontend as siblings, dropping
 * type declarations and node_modules, and once the build is done the
 * staged copy is deleted with the build folder, which then no longer
 * exists.
 */

import assert from 'node:assert';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stage, unstage } from '../../../scripts/stage-frontend.js';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const dest = join(root, `build`, `frontend`);

/**
 * Collects every file path under a directory.
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe(`stage-frontend`, () => {
  before(() => stage());
  after(() => unstage());

  it(`copies web and parsers/old side by side`, () => {
    assert.ok(existsSync(join(dest, `web`, `index.html`)), `web/index.html`);
    assert.ok(
      existsSync(join(dest, `parsers`, `old`, `dfa-parser.js`)),
      `parsers/old/dfa-parser.js`,
    );
  });

  it(`omits type declarations and node_modules`, () => {
    const files = walk(dest);
    assert.ok(!files.some((f) => f.endsWith(`.d.ts`)), `no .d.ts files should be staged`);
    assert.ok(
      !files.some((f) => f.split(/[\\/]/).includes(`node_modules`)),
      `no node_modules should be staged`,
    );
  });

  it(`deletes the staged copy and the build folder once the build is done`, () => {
    unstage();
    assert.ok(!existsSync(join(root, `build`)), `build/ should be gone`);
  });
});
