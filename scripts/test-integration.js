/**
 * @fileoverview Runs the integration specs (`playwright test`, with any
 * arguments given, such as spec files) as two runs: the specs that run
 * beside each other, and then the specs that run one at a time. Each run
 * passes when the arguments select none of its specs. Exits with the
 * status of the first run that failed.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const PLAYWRIGHT = fileURLToPath(import.meta.resolve(`@playwright/test/cli`));

let status = 0;
for (const project of [`firefox`, `firefox-solo`]) {
  const result = spawnSync(
    process.execPath,
    [PLAYWRIGHT, `test`, `--project`, project, `--pass-with-no-tests`, ...process.argv.slice(2)],
    { stdio: `inherit` },
  );
  if (status === 0) status = result.status ?? 1;
}
process.exit(status);
