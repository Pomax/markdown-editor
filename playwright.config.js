/**
 * @fileoverview Playwright configuration for integration tests.
 * Uses Firefox as the browser for testing.
 */

import { defineConfig, devices } from "@playwright/test";
import os from "os"; // Import the OS module

const CI_RUN = !!process.env.GITHUB_ACTIONS;
const platform = os.platform();

const config = {
  retries: platform === `darwin` ? 1 : 0,
  timeout: platform === `darwin` ? 20_000 : 5_000,
  workers: { win32: 8, linux: 4, darwin: 1 }[platform] ?? 4,
};

/**
 * The specs that fail when other specs run beside them. They run one at a
 * time, in a run of their own after the other specs' run, as
 * scripts/test-integration.js runs them.
 */
const SOLO_SPECS = [
  `**/app/search.spec.js`,
  `**/document/view-switching.spec.js`,
  `**/content/inline-image.spec.js`,
];

if (CI_RUN) {
  let overrides = {
    retries: 1,
  };
  if (platform === `darwin`) {
    overrides = {
      timeout: 60_000,
      workers: 2,
    };
  } else if (platform === `linux`) {
    overrides = {
      timeout: 30_000,
      workers: 4,
    };
  } else if (platform === `win32`) {
    overrides = {
      timeout: 30_000,
      workers: 2,
    };
  }
  Object.assign(config, overrides);
}

export default defineConfig({
  ...config,
  testDir: `./test/integration`,
  testMatch: `**/*.spec.js`,
  fullyParallel: false,
  reporter: `list`,
  projects: [
    {
      name: `firefox`,
      use: { ...devices[`Desktop Firefox`] },
      testIgnore: SOLO_SPECS,
    },
    {
      name: `firefox-solo`,
      use: { ...devices[`Desktop Firefox`] },
      testMatch: SOLO_SPECS,
      workers: 1,
    },
  ],
  use: {
    trace: `on-first-retry`,
    screenshot: `only-on-failure`,
  },
});
