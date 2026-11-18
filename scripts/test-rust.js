/**
 * @fileoverview Runs the Rust tests (`cargo test`, with any arguments
 * given, such as a test name filter), then deletes what the build left
 * behind, and exits with Cargo's status.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { removeBuildLeftovers } from './build-leftovers.js';

const result = spawnSync(`cargo`, [`test`, ...process.argv.slice(2)], { stdio: `inherit` });
removeBuildLeftovers();
process.exit(result.status ?? 1);
