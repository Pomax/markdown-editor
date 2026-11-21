/**
 * @fileoverview The X11 side of the Linux test harness: a virtual X
 * display for each launch of the app, an Xvfb server on the first free
 * display number with the openbox window manager on it, so the app's
 * window is mapped, renders, can be maximized and takes real input
 * without appearing on the user's screen, and a session bus of its own
 * that starts no services; and X11Input, which sends that input through
 * the X11 runner to the app's window on its display.
 */

import { execFile, spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { X11_RUNNER_BINARY } from '../../scripts/build-test-app.js';

/**
 * The window manager's configuration: no key or mouse bindings.
 * @type {string}
 */
const OPENBOX_CONFIG = fileURLToPath(new URL(`openbox.xml`, import.meta.url));

/**
 * The session bus's configuration: a bus with no services to start. Each
 * of the app's GTK processes asks the session bus to start the desktop
 * portal as it starts, and waits for the answer. On a machine whose
 * session bus has the portal installed but no graphical session for it
 * to start in, as on a CI runner, each wait lasts until the start times
 * out, and the page loads half a minute late. This bus refuses at once.
 * @type {string}
 */
const SESSION_BUS_CONFIG = fileURLToPath(new URL(`session-bus.conf`, import.meta.url));

/**
 * The virtual screen's size and colour depth: larger than the standard
 * viewport plus the window's menu bar.
 * @type {string}
 */
const SCREEN = `2560x1600x24`;

/**
 * A running Xvfb server and its session bus: the display name, the bus's
 * address, and a way to stop both.
 * @typedef {object} VirtualDisplay
 * @property {string} name - The display name, such as `:1`.
 * @property {string} busAddress - The session bus's address.
 * @property {() => void} stop
 */

/**
 * Starts a session bus that starts no services, and resolves with its
 * address once it accepts connections.
 * @returns {Promise<{ address: string, bus: import('node:child_process').ChildProcess }>}
 */
function startSessionBus() {
  const bus = spawn(
    `dbus-daemon`,
    [`--config-file`, SESSION_BUS_CONFIG, `--nofork`, `--print-address=3`],
    { stdio: [`ignore`, `ignore`, `pipe`, `pipe`] },
  );
  return new Promise((resolve, reject) => {
    let address = ``;
    let errors = ``;
    bus.stderr?.on(`data`, (chunk) => {
      errors += chunk;
    });
    bus.stdio[3]?.on(`data`, (chunk) => {
      address += chunk;
      if (address.includes(`\n`)) resolve({ address: address.trim(), bus });
    });
    bus.on(`error`, reject);
    bus.on(`exit`, (code) =>
      reject(new Error(`dbus-daemon exited with ${code}: ${errors.trim()}`)),
    );
  });
}

/**
 * The environment of a process that runs on a virtual display: the
 * current one without Wayland, with the display, its session bus, GTK on
 * X11, software rendering and no accessibility bridge.
 * @param {{ name: string, busAddress?: string }} display
 * @returns {NodeJS.ProcessEnv}
 */
export function displayEnvironment(display) {
  const environment = { ...process.env };
  delete environment.WAYLAND_DISPLAY;
  if (display.busAddress) environment.DBUS_SESSION_BUS_ADDRESS = display.busAddress;
  return {
    ...environment,
    DISPLAY: display.name,
    GDK_BACKEND: `x11`,
    LIBGL_ALWAYS_SOFTWARE: `1`,
    WEBKIT_SKIA_ENABLE_CPU_RENDERING: `1`,
    NO_AT_BRIDGE: `1`,
  };
}

/**
 * Starts an Xvfb server on the first free display number and resolves
 * with its display name once it accepts connections.
 * @returns {Promise<{ name: string, server: import('node:child_process').ChildProcess }>}
 */
function startServer() {
  const server = spawn(`Xvfb`, [`-displayfd`, `3`, `-screen`, `0`, SCREEN, `-nolisten`, `tcp`], {
    stdio: [`ignore`, `ignore`, `pipe`, `pipe`],
  });
  return new Promise((resolve, reject) => {
    let number = ``;
    let errors = ``;
    server.stderr?.on(`data`, (chunk) => {
      errors += chunk;
    });
    server.stdio[3]?.on(`data`, (chunk) => {
      number += chunk;
      if (number.includes(`\n`)) resolve({ name: `:${number.trim()}`, server });
    });
    server.on(`error`, reject);
    server.on(`exit`, (code) => reject(new Error(`Xvfb exited with ${code}: ${errors.trim()}`)));
  });
}

/**
 * Starts an Xvfb server on the first free display number with openbox on
 * it, and a session bus, and resolves with the display name and the
 * bus's address once the server and the bus accept connections and
 * openbox has started.
 * @returns {Promise<VirtualDisplay>}
 */
export async function startVirtualDisplay() {
  const { name, server } = await startServer();
  const manager = spawn(`openbox`, [`--config-file`, OPENBOX_CONFIG, `--sm-disable`], {
    env: { ...process.env, DISPLAY: name },
    stdio: `ignore`,
  });
  try {
    await new Promise((resolve, reject) => {
      manager.once(`spawn`, resolve);
      manager.once(`error`, reject);
    });
    const { address, bus } = await startSessionBus();
    return {
      name,
      busAddress: address,
      stop: () => {
        bus.kill();
        manager.kill();
        server.kill();
      },
    };
  } catch (error) {
    manager.kill();
    server.kill();
    throw error;
  }
}

/**
 * Runs one X11 runner command for a process on a display, and resolves
 * with its answer.
 * @param {string | undefined} display
 * @param {number} pid
 * @param {string} command
 * @param {(string | number)[]} args
 * @returns {Promise<any>}
 */
export function runCommand(display, pid, command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      X11_RUNNER_BINARY,
      [command, String(pid), ...args.map(String)],
      { env: { ...process.env, DISPLAY: display ?? `` }, encoding: `utf-8` },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`x11-runner ${command}: ${stderr.trim() || error.message}`));
        else resolve(JSON.parse(stdout));
      },
    );
  });
}

/**
 * A command sent to the serving runner, waiting for its answer.
 * @typedef {object} PendingCommand
 * @property {string} command
 * @property {(answer: any) => void} resolve
 * @property {(error: Error) => void} reject
 */

/**
 * A serving runner, and the commands sent to it in the order it answers
 * them.
 * @typedef {object} ServingRunner
 * @property {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @property {PendingCommand[]} pending
 */

/**
 * Real keyboard and mouse input to the app's window on its display,
 * through one X11 runner that serves every command, started with the
 * first command and ended by `close`. On a virtual display the input is
 * XTEST input; on the user's desktop it goes through the desktop portal.
 */
export class X11Input {
  /** @type {string} */
  #display;

  /** @type {number} */
  #pid;

  /** @type {boolean} */
  #desktop;

  /** @type {ServingRunner | undefined} */
  #runner;

  /**
   * @param {string} display - The app's display name.
   * @param {number} pid - The app's process id.
   * @param {{ desktop?: boolean }} [options] - Whether the display is the
   *   user's desktop.
   */
  constructor(display, pid, { desktop = false } = {}) {
    this.#display = display;
    this.#pid = pid;
    this.#desktop = desktop;
  }

  /**
   * Starts the serving runner, which settles each command with its
   * answer line, and fails the commands still waiting if it exits.
   * @returns {ServingRunner}
   */
  #start() {
    const child = spawn(X11_RUNNER_BINARY, this.#desktop ? [`serve`, `desktop`] : [`serve`], {
      env: { ...process.env, DISPLAY: this.#display },
    });
    /** @type {ServingRunner} */
    const runner = { child, pending: [] };
    let output = ``;
    let errors = ``;
    child.stdout.setEncoding(`utf-8`);
    child.stdout.on(`data`, (chunk) => {
      output += chunk;
      for (let end = output.indexOf(`\n`); end >= 0; end = output.indexOf(`\n`)) {
        const answer = JSON.parse(output.slice(0, end));
        output = output.slice(end + 1);
        const pending = runner.pending.shift();
        if (!pending) continue;
        if (`error` in answer)
          pending.reject(new Error(`x11-runner ${pending.command}: ${answer.error}`));
        else pending.resolve(answer.ok);
      }
    });
    child.stderr.on(`data`, (chunk) => {
      errors += chunk;
    });
    // A command written as the runner exits fails with it, below.
    child.stdin.on(`error`, () => {});
    child.on(`close`, (code) => {
      if (this.#runner === runner) this.#runner = undefined;
      for (const pending of runner.pending.splice(0)) {
        pending.reject(
          new Error(`x11-runner ${pending.command}: exited with ${code}: ${errors.trim()}`),
        );
      }
    });
    this.#runner = runner;
    return runner;
  }

  /**
   * Sends one command to the serving runner and resolves with its answer.
   * @param {string} command
   * @param {(string | number)[]} args
   * @returns {Promise<any>}
   */
  #send(command, args) {
    const runner = this.#runner ?? this.#start();
    return new Promise((resolve, reject) => {
      runner.pending.push({ command, resolve, reject });
      runner.child.stdin.write(
        `${JSON.stringify([command, String(this.#pid), ...args.map(String)])}\n`,
      );
    });
  }

  /**
   * Runs one runner command. A key command that finds the window without
   * the input focus gives it the focus and runs once more.
   * @param {string} command
   * @param {...(string | number)} args
   * @returns {Promise<any>}
   */
  async run(command, ...args) {
    try {
      return await this.#send(command, args);
    } catch (error) {
      if (!String(error).includes(`does not have the input focus`)) throw error;
      await this.#send(`focus`, []);
      return this.#send(command, args);
    }
  }

  /** Ends the serving runner, once it has answered what was sent. */
  close() {
    this.#runner?.child.stdin.end();
    this.#runner = undefined;
  }
}
