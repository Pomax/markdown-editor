/**
 * @fileoverview Asserts the GitHub Actions workflows test and build the
 * Tauri app: every job that compiles it installs the Rust toolchain, the
 * Linux jobs install WebKitGTK and the other packages Tauri needs, the
 * Windows job runs `npm test` in full (the integration specs attach to
 * WebView2, which only Windows has), the macOS and Linux jobs run the lint,
 * unit and Rust tests, and each build job runs its platform's `dist`
 * script.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);

/**
 * The packages Tauri lists for building on Debian and Ubuntu.
 * @type {string[]}
 */
const LINUX_PACKAGES = [
  `libwebkit2gtk-4.1-dev`,
  `build-essential`,
  `libxdo-dev`,
  `libssl-dev`,
  `libayatana-appindicator3-dev`,
  `librsvg2-dev`,
];

/**
 * The text of each job in a workflow file, by job name.
 * @param {string} file
 * @returns {Record<string, string>}
 */
function jobsOf(file) {
  const text = readFileSync(join(root, `.github`, `workflows`, file), `utf-8`);
  const body = text.slice(text.indexOf(`\njobs:\n`));
  /** @type {Record<string, string>} */
  const jobs = {};
  for (const part of body.split(/^ {2}(?=[\w-]+:$)/m).slice(1)) {
    jobs[part.slice(0, part.indexOf(`:`))] = part;
  }
  return jobs;
}

/**
 * Asserts a job installs the stable Rust toolchain with rustfmt.
 * @param {string} name
 * @param {string} job
 */
function assertRust(name, job) {
  assert.ok(job.includes(`uses: dtolnay/rust-toolchain@stable`), `${name} installs Rust`);
  assert.ok(job.includes(`components: rustfmt`), `${name} installs rustfmt`);
}

describe(`validate.yml`, () => {
  const jobs = jobsOf(`validate.yml`);

  it(`installs the Rust toolchain in every test job`, () => {
    for (const name of [`test-windows`, `test-macos`, `test-linux`]) assertRust(name, jobs[name]);
  });

  it(`runs the whole test suite on Windows`, () => {
    assert.ok(jobs[`test-windows`].includes(`npm run setup && npm test`));
  });

  it(`runs the lint, unit and Rust tests on macOS and Linux`, () => {
    for (const name of [`test-macos`, `test-linux`]) {
      const job = jobs[name];
      assert.ok(job.includes(`npm run lint && npm run test:unit && npm run test:rust`), name);
      assert.ok(!/npm test\b/.test(job), `${name} does not run npm test`);
      assert.ok(!job.includes(`npm run setup`), `${name} installs no Playwright browser`);
    }
  });

  it(`installs the packages Tauri needs on Linux`, () => {
    for (const pkg of LINUX_PACKAGES) assert.ok(jobs[`test-linux`].includes(pkg), pkg);
  });
});

describe(`build.yml`, () => {
  const jobs = jobsOf(`build.yml`);

  it(`installs the Rust toolchain and runs the platform's dist script in every build job`, () => {
    for (const os of [`windows`, `macos`, `linux`]) {
      const name = `build-${os}`;
      const job = jobs[name];
      assertRust(name, job);
      const dist = { windows: `win`, macos: `mac`, linux: `linux` }[os];
      assert.ok(job.includes(`npm run dist:${dist}`), `${name} runs dist:${dist}`);
      const folder = { windows: `windows`, macos: `macos`, linux: `ubuntu` }[os];
      assert.ok(job.includes(`path: dist/${folder}/*`), `${name} uploads dist/${folder}`);
      assert.ok(!job.includes(`7zip`), `${name} installs no 7zip`);
      assert.ok(!job.includes(`npm run setup`), `${name} installs no Playwright browser`);
    }
  });

  it(`installs the packages Tauri needs, and patchelf for the AppImage, on Linux`, () => {
    for (const pkg of [...LINUX_PACKAGES, `patchelf`]) {
      assert.ok(jobs[`build-linux`].includes(pkg), pkg);
    }
  });
});
