/**
 * @fileoverview Playwright configuration for the real-input specs, which
 * show the test app's window and drive it with real keyboard and mouse
 * input through the Windows runner. They take the mouse, keyboard and
 * screen while they run, so they run one at a time, and only through
 * `npm run test:real-input`.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: `./test/real-input`,
  testMatch: `**/*.spec.js`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: `list`,
  use: {
    screenshot: `only-on-failure`,
  },
});
