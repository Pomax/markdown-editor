/**
 * @fileoverview Dev server for `tauri dev`.
 *
 * Reuses the integration tests' HTTP server so files load live from src/
 * while developing. Serves on port
 * 1420 by default; tests pass their own port.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/integration/test-http-server.js';

const thisFile = fileURLToPath(import.meta.url);

/**
 * Starts the dev server.
 *
 * @param {number} [port=1420] - Port to listen on (0 picks a free port).
 * @returns {Promise<{ server: import('node:http').Server, baseURL: string }>}
 */
export function start(port = 1420) {
  return startServer(port);
}

if (process.argv[1] === thisFile) {
  const port = Number(process.argv[2]) || 1420;
  const { baseURL } = await start(port);
  console.log(`dev server listening on ${baseURL}`);
}
