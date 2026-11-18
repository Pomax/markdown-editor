/**
 * @fileoverview Asserts the Tauri capability grants only the main
 * window, the app's own origin, and a minimal set of core permissions
 * (event listen/unlisten and window set-title), with no core:default and
 * no plugin permissions. App command permissions are added per command
 * in Phase 3 and are allowed here, except the scripting API's, which the
 * app no longer has.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);
const capability = JSON.parse(
  readFileSync(join(root, `src`, `tauri`, `capabilities`, `default.json`), `utf-8`),
);

describe(`capabilities`, () => {
  it(`scopes to the main window only`, () => {
    assert.deepStrictEqual(capability.windows, [`main`]);
  });

  it(`grants exactly the minimal core permissions`, () => {
    const core = capability.permissions.filter(
      (/** @type {unknown} */ p) => typeof p === `string` && p.startsWith(`core:`),
    );
    assert.deepStrictEqual([...core].sort(), [
      `core:event:allow-listen`,
      `core:event:allow-unlisten`,
      `core:window:allow-set-title`,
    ]);
  });

  it(`does not grant core:default`, () => {
    assert.ok(!capability.permissions.includes(`core:default`));
  });

  it(`grants no plugin permissions`, () => {
    const pluginPrefixes = [`dialog:`, `clipboard-manager:`, `opener:`, `fs:`, `shell:`];
    for (const permission of capability.permissions) {
      if (typeof permission !== `string`) continue;
      assert.ok(
        !pluginPrefixes.some((prefix) => permission.startsWith(prefix)),
        `unexpected plugin permission: ${permission}`,
      );
    }
  });

  it(`grants no scripting API command`, () => {
    assert.ok(!capability.permissions.includes(`allow-api-execute`));
    assert.ok(!capability.permissions.includes(`allow-api-commands`));
  });

  it(`targets only the app's own origin`, () => {
    assert.strictEqual(capability.remote, undefined);
  });
});
