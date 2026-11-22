/**
 * @fileoverview Helpers for the real-input specs: the Windows runner,
 * which sends real keyboard and mouse input to the app and reads back its
 * window and menu, and the point of an element in the window's client
 * area.
 */

import { spawnSync } from 'node:child_process';
import { WIN_RUNNER_BINARY } from '../../scripts/build-win-runner.js';

/**
 * Runs one runner command for the app's process and returns its answer.
 * @param {string} command
 * @param {number} pid
 * @param {...(string | number)} args
 * @returns {any}
 */
export function runner(command, pid, ...args) {
  const result = spawnSync(WIN_RUNNER_BINARY, [command, String(pid), ...args.map(String)], {
    encoding: `utf-8`,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`win-runner ${command}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * The middle of an element in the window's client area, in physical
 * pixels.
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<{ x: number, y: number }>}
 */
export async function clientPoint(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`element not laid out`);
  const ratio = await locator.page().evaluate(() => window.devicePixelRatio);
  return {
    x: Math.round((box.x + box.width / 2) * ratio),
    y: Math.round((box.y + box.height / 2) * ratio),
  };
}
