/**
 * @fileoverview Unit tests for scripts/test.sh, scripts/build.sh and
 * scripts/run.sh, the test, build and run entry points outside Windows.
 * Each test runs the script from a folder below the project root. For
 * test.sh and build.sh, stub `npm` and `node` commands are first on the
 * PATH. For run.sh, a copy of the project holds the release file with a
 * stub app: on Linux a real package in dist/ubuntu, and for macOS a disk
 * image in dist/macos, with stub `uname`, `hdiutil` and `defaults`
 * commands standing in for macOS's, so both run on any platform with
 * bash. A stub records the folder it ran in, its own name or path and its
 * arguments, and exits with the code the test asks for, after the time the
 * test asks it to run for. Windows has no
 * bash to run the scripts with, so they are skipped there, and run.sh's
 * Linux tests are skipped where there is no `dpkg-deb`.
 */

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`));
const callerDir = join(root, `test`, `unit`);
const stubDir = join(root, `test-results`, `shell-script-stubs`);
const stubLog = join(stubDir, `log.txt`);

/**
 * A stub command: writes the folder it runs in, its own name and each of
 * its arguments to $STUB_LOG, one per line, and exits with $STUB_EXIT, or,
 * when $STUB_SLEEP is set, writes its process id to a `running` file next
 * to itself and runs for that many seconds, ignoring the signals
 * $STUB_IGNORE names.
 * @type {string}
 */
const STUB = [
  `#!/bin/sh`,
  `printf '%s\\n' "$(pwd -P)" "$(basename "$0")" "$@" > "$STUB_LOG"`,
  `if [ -n "$STUB_SLEEP" ]; then`,
  `  if [ -n "$STUB_IGNORE" ]; then trap '' $STUB_IGNORE; fi`,
  `  echo $$ > "$(dirname "$0")/running"`,
  `  exec sleep "$STUB_SLEEP"`,
  `fi`,
  `exit "$STUB_EXIT"`,
  ``,
].join(`\n`);

/**
 * What one run of a script did: its exit code, and the folder, command
 * and arguments the stub it called recorded.
 * @typedef {object} ScriptRun
 * @property {number | null} status
 * @property {string} cwd
 * @property {string} command
 * @property {string[]} args
 */

/**
 * Runs a script from scripts/ in callerDir, with the stubs first on the
 * PATH, and returns what the stub it called recorded.
 * @param {string} script - The script's file name.
 * @param {string[]} args
 * @param {number} [exitCode] - The code the stub exits with.
 * @returns {ScriptRun}
 */
function runScript(script, args, exitCode = 0) {
  rmSync(stubLog, { force: true });
  const result = spawnSync(join(root, `scripts`, script), args, {
    cwd: callerDir,
    env: {
      ...process.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
      STUB_LOG: stubLog,
      STUB_EXIT: String(exitCode),
    },
    encoding: `utf-8`,
  });
  if (result.error) throw result.error;
  const [cwd, command, ...rest] = readFileSync(stubLog, `utf-8`).split(`\n`).slice(0, -1);
  return { status: result.status, cwd, command, args: rest };
}

describe(`shell scripts`, { skip: process.platform === `win32` }, () => {
  before(() => {
    mkdirSync(stubDir, { recursive: true });
    for (const name of [`npm`, `node`]) {
      writeFileSync(join(stubDir, name), STUB);
      chmodSync(join(stubDir, name), 0o755);
    }
  });

  after(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  describe(`test.sh`, () => {
    it(`runs npm test in the project root when given nothing`, () => {
      assert.deepStrictEqual(runScript(`test.sh`, []), {
        status: 0,
        cwd: root,
        command: `npm`,
        args: [`test`],
      });
    });

    it(`runs a .test.js file with node --test, named relative to the calling folder`, () => {
      assert.deepStrictEqual(runScript(`test.sh`, [`scripts/shell-scripts.test.js`]), {
        status: 0,
        cwd: root,
        command: `node`,
        args: [`--test`, `test/unit/scripts/shell-scripts.test.js`],
      });
    });

    it(`runs anything else as integration specs, passing flags on unchanged`, () => {
      const spec = `../integration/app-functionality/app/menus.spec.js`;
      const folder = join(root, `test`, `integration`);
      assert.deepStrictEqual(runScript(`test.sh`, [spec, folder, `--workers=1`]), {
        status: 0,
        cwd: root,
        command: `npm`,
        args: [
          `run`,
          `test:integration`,
          `--`,
          `test/integration/app-functionality/app/menus.spec.js`,
          `test/integration`,
          `--workers=1`,
        ],
      });
    });

    it(`exits with the exit code of the run`, () => {
      assert.strictEqual(runScript(`test.sh`, [], 3).status, 3);
      assert.strictEqual(runScript(`test.sh`, [`scripts/shell-scripts.test.js`], 4).status, 4);
      assert.strictEqual(runScript(`test.sh`, [`../integration`], 5).status, 5);
    });
  });

  describe(`build.sh`, () => {
    it(`runs build-executable.js in the project root`, () => {
      assert.deepStrictEqual(runScript(`build.sh`, []), {
        status: 0,
        cwd: root,
        command: `node`,
        args: [`scripts/build-executable.js`],
      });
    });

    it(`exits with the exit code of the build`, () => {
      assert.strictEqual(runScript(`build.sh`, [], 2).status, 2);
    });
  });

  describe(`run.sh`, { skip: spawnSync(`dpkg-deb`, [`--version`]).error !== undefined }, () => {
    const project = join(root, `test-results`, `run-sh-project`);
    const deb = join(project, `dist`, `ubuntu`, `Markdown-Editor.deb`);
    const unpackDir = join(project, `tmp`);

    before(() => {
      mkdirSync(join(project, `scripts`), { recursive: true });
      copyFileSync(join(root, `scripts`, `run.sh`), join(project, `scripts`, `run.sh`));
      chmodSync(join(project, `scripts`, `run.sh`), 0o755);
      const pkg = join(project, `pkg`);
      mkdirSync(join(pkg, `DEBIAN`), { recursive: true });
      mkdirSync(join(pkg, `usr`, `bin`), { recursive: true });
      writeFileSync(
        join(pkg, `DEBIAN`, `control`),
        `Package: markdown-editor\nVersion: 1.0.0\nArchitecture: all\nMaintainer: Test\nDescription: Test\n`,
      );
      writeFileSync(
        join(pkg, `usr`, `bin`, `markdown-editor`),
        STUB.replace(`"$(basename "$0")"`, `"$0"`),
      );
      chmodSync(join(pkg, `usr`, `bin`, `markdown-editor`), 0o755);
      mkdirSync(dirname(deb), { recursive: true });
      mkdirSync(unpackDir, { recursive: true });
      const built = spawnSync(`dpkg-deb`, [`--build`, `--root-owner-group`, pkg, deb]);
      assert.strictEqual(built.status, 0, String(built.stderr));
    });

    after(() => {
      rmSync(project, { recursive: true, force: true });
    });

    /**
     * Runs the copy of run.sh in callerDir, unpacking into unpackDir.
     * @param {string[]} args
     * @param {number} [exitCode] - The code the stub app exits with.
     */
    const runApp = (args, exitCode = 0) => {
      rmSync(stubLog, { force: true });
      return spawnSync(join(project, `scripts`, `run.sh`), args, {
        cwd: callerDir,
        env: {
          ...process.env,
          TMPDIR: unpackDir,
          STUB_LOG: stubLog,
          STUB_EXIT: String(exitCode),
        },
        encoding: `utf-8`,
      });
    };

    it(`runs the app in the release package in dist/ubuntu, in the calling folder, with the arguments given`, () => {
      const result = runApp([`notes.md`, `--flag`]);
      assert.strictEqual(result.status, 0, result.stderr);
      const [cwd, app, ...args] = readFileSync(stubLog, `utf-8`).split(`\n`).slice(0, -1);
      assert.strictEqual(cwd, callerDir);
      assert.ok(app.startsWith(unpackDir), app);
      assert.ok(app.endsWith(join(`usr`, `bin`, `markdown-editor`)), app);
      assert.deepStrictEqual(args, [`notes.md`, `--flag`]);
    });

    it(`exits with the app's exit code and leaves nothing unpacked behind`, () => {
      assert.strictEqual(runApp([], 3).status, 3);
      const app = readFileSync(stubLog, `utf-8`).split(`\n`)[1];
      assert.ok(!existsSync(app), app);
    });

    it(`fails, naming build.sh, when dist/ubuntu has no release package`, () => {
      rmSync(deb);
      const result = runApp([]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /scripts\/build\.sh/);
    });
  });

  describe(`run.sh on macOS`, () => {
    const project = join(root, `test-results`, `run-sh-macos`);
    const dmg = join(project, `dist`, `macos`, `Markdown-Editor.dmg`);
    const macStubs = join(project, `stubs`);
    const mountDir = join(project, `tmp`);
    const appStub = join(project, `app-stub`);
    const hdiutilLog = join(project, `hdiutil.txt`);

    /**
     * Stubs for the macOS commands run.sh uses: `uname` says Darwin,
     * `hdiutil attach` puts an app whose executable is the app stub at the
     * mount point and `hdiutil detach` takes it away again, or fails as
     * busy while that app is running, each logging its arguments, and
     * `defaults` names the app's executable.
     * @type {Record<string, string>}
     */
    const MAC_STUBS = {
      uname: `#!/bin/sh\necho Darwin\n`,
      hdiutil: [
        `#!/bin/sh`,
        `echo "$*" >> "$HDIUTIL_LOG"`,
        `command="$1"`,
        `while [ $# -gt 0 ]; do`,
        `  if [ "$1" = -mountpoint ]; then point="$2"; fi`,
        `  last="$1"`,
        `  shift`,
        `done`,
        `if [ "$command" = attach ]; then`,
        `  mkdir -p "$point/Markdown Editor.app/Contents/MacOS"`,
        `  cp "$APP_STUB" "$point/Markdown Editor.app/Contents/MacOS/Markdown Editor"`,
        `else`,
        `  running="$last/Markdown Editor.app/Contents/MacOS/running"`,
        `  if [ -f "$running" ] && kill -0 "$(cat "$running")" 2>/dev/null; then`,
        `    echo busy >> "$HDIUTIL_LOG"`,
        `    echo "hdiutil: couldn't unmount - Resource busy" >&2`,
        `    exit 16`,
        `  fi`,
        `  rm -rf "$last/Markdown Editor.app"`,
        `fi`,
        ``,
      ].join(`\n`),
      defaults: `#!/bin/sh\necho "Markdown Editor"\n`,
    };

    before(() => {
      mkdirSync(join(project, `scripts`), { recursive: true });
      copyFileSync(join(root, `scripts`, `run.sh`), join(project, `scripts`, `run.sh`));
      chmodSync(join(project, `scripts`, `run.sh`), 0o755);
      mkdirSync(dirname(dmg), { recursive: true });
      writeFileSync(dmg, `disk image`);
      mkdirSync(macStubs, { recursive: true });
      for (const [name, body] of Object.entries(MAC_STUBS)) {
        writeFileSync(join(macStubs, name), body);
        chmodSync(join(macStubs, name), 0o755);
      }
      writeFileSync(appStub, STUB.replace(`"$(basename "$0")"`, `"$0"`));
      chmodSync(appStub, 0o755);
      mkdirSync(mountDir, { recursive: true });
    });

    after(() => {
      rmSync(project, { recursive: true, force: true });
    });

    /**
     * Runs the copy of run.sh in callerDir with the macOS stubs first on
     * the PATH, mounting in mountDir.
     * @param {string[]} args
     * @param {number} [exitCode] - The code the stub app exits with.
     */
    const runApp = (args, exitCode = 0) => {
      rmSync(stubLog, { force: true });
      rmSync(hdiutilLog, { force: true });
      return spawnSync(join(project, `scripts`, `run.sh`), args, {
        cwd: callerDir,
        env: {
          ...process.env,
          PATH: `${macStubs}${delimiter}${process.env.PATH}`,
          TMPDIR: mountDir,
          STUB_LOG: stubLog,
          STUB_EXIT: String(exitCode),
          APP_STUB: appStub,
          HDIUTIL_LOG: hdiutilLog,
        },
        encoding: `utf-8`,
      });
    };

    it(`mounts the disk image in dist/macos read-only and runs its app in the calling folder, with the arguments given`, () => {
      const result = runApp([`notes.md`, `--flag`]);
      assert.strictEqual(result.status, 0, result.stderr);
      const [cwd, app, ...args] = readFileSync(stubLog, `utf-8`).split(`\n`).slice(0, -1);
      assert.strictEqual(cwd, callerDir);
      assert.ok(app.startsWith(mountDir), app);
      assert.ok(app.endsWith(`Markdown Editor.app/Contents/MacOS/Markdown Editor`), app);
      assert.deepStrictEqual(args, [`notes.md`, `--flag`]);
      const [attach] = readFileSync(hdiutilLog, `utf-8`).split(`\n`);
      assert.match(attach, /^attach /);
      assert.match(attach, / -readonly /);
      assert.ok(attach.endsWith(dmg), attach);
    });

    it(`exits with the app's exit code, unmounts the image and leaves no mount point behind`, () => {
      assert.strictEqual(runApp([], 4).status, 4);
      const app = readFileSync(stubLog, `utf-8`).split(`\n`)[1];
      const calls = readFileSync(hdiutilLog, `utf-8`).split(`\n`);
      assert.match(calls[1], /^detach /);
      assert.ok(!existsSync(dirname(dirname(dirname(dirname(app))))), app);
    });

    /**
     * Starts the copy of run.sh in callerDir with the macOS stubs first on
     * the PATH and an app that runs until it is stopped, sends the run's
     * process group a signal once the app is running, and waits for the
     * run to end.
     * @param {NodeJS.Signals} signal
     * @param {string} [ignored] - The signals the app ignores, as `trap` names them.
     * @returns {Promise<number>} The app's process id.
     */
    const stopRunWith = async (signal, ignored = ``) => {
      rmSync(stubLog, { force: true });
      rmSync(hdiutilLog, { force: true });
      const run = spawn(join(project, `scripts`, `run.sh`), [], {
        cwd: callerDir,
        detached: true,
        stdio: `ignore`,
        env: {
          ...process.env,
          PATH: `${macStubs}${delimiter}${process.env.PATH}`,
          TMPDIR: mountDir,
          STUB_LOG: stubLog,
          STUB_EXIT: `0`,
          STUB_SLEEP: `30`,
          STUB_IGNORE: ignored,
          APP_STUB: appStub,
          HDIUTIL_LOG: hdiutilLog,
        },
      });
      const ended = new Promise((resolve) => run.on(`exit`, resolve));
      const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
      while (!existsSync(stubLog)) await wait();
      const running = join(dirname(readFileSync(stubLog, `utf-8`).split(`\n`)[1]), `running`);
      while (!existsSync(running) || !readFileSync(running, `utf-8`).trim()) await wait();
      const app = Number(readFileSync(running, `utf-8`));
      process.kill(-(run.pid ?? 0), signal);
      await ended;
      return app;
    };

    for (const signal of /** @type {NodeJS.Signals[]} */ ([`SIGHUP`, `SIGINT`, `SIGTERM`])) {
      it(`a run stopped by ${signal} unmounts the image and leaves no mount point behind`, async () => {
        await stopRunWith(signal);
        const app = readFileSync(stubLog, `utf-8`).split(`\n`)[1];
        const calls = readFileSync(hdiutilLog, `utf-8`).split(`\n`);
        assert.ok(
          calls.some((call) => call.startsWith(`detach `)),
          calls.join(`\n`),
        );
        assert.ok(!existsSync(dirname(dirname(dirname(dirname(app))))), app);
      });
    }

    it(`a run stopped by SIGHUP while its app keeps running stops the app and unmounts the image`, async () => {
      const app = await stopRunWith(`SIGHUP`, `HUP`);
      const running = spawnSync(`kill`, [`-0`, String(app)]).status === 0;
      if (running) process.kill(app, `SIGKILL`);
      assert.strictEqual(running, false, `the app is still running`);
      const calls = readFileSync(hdiutilLog, `utf-8`).split(`\n`);
      assert.ok(!calls.includes(`busy`), calls.join(`\n`));
    });

    it(`unmounts what a run that was never cleaned up left mounted, and removes its mount point, before mounting the image`, () => {
      const leftover = join(mountDir, `markdown-editor-run.left`);
      mkdirSync(join(leftover, `Markdown Editor.app`), { recursive: true });
      const result = runApp([]);
      assert.strictEqual(result.status, 0, result.stderr);
      const [first, second] = readFileSync(hdiutilLog, `utf-8`).split(`\n`);
      assert.match(first, /^detach /);
      assert.ok(first.endsWith(leftover), first);
      assert.match(second, /^attach /);
      assert.ok(!existsSync(leftover), leftover);
    });

    it(`fails, naming build.sh, when dist/macos has no disk image`, () => {
      rmSync(dmg);
      const result = runApp([]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /scripts\/build\.sh/);
      assert.ok(!existsSync(hdiutilLog));
    });
  });
});
