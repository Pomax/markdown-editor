# Handoff: finishing the Tauri app on macOS and Ubuntu

This document is for Claude, starting with no memory of this project, on a Mac or an Ubuntu machine. It holds what you need to finish the macOS and Ubuntu work: the state of the code, how the app and its tests work, what the user has already decided, what is known to be broken, and the order to do the work in.

Everything here was learned on Windows. No line of this app has been compiled or run on macOS or Linux. Where this document says what will happen on those platforms, treat it as a prediction from reading the code, and measure it before acting on it.

## Contents

1. Where things stand
2. Getting the code
3. Rules for this work
4. Decisions already made
5. How the app works
6. Repository map
7. Commands
8. How the tests work
9. Platform-specific code
10. Known blockers
11. Work plan
12. macOS notes
13. Ubuntu notes
14. Verification checklist
15. Traps already hit on Windows
16. Finishing and reporting

## 1. Where things stand

| Item | State |
|---|---|
| App | Markdown editor, Tauri 2 with a Rust backend and a JavaScript page |
| Version | 3.0.0 |
| Code | Commit `b1e0fee` on `origin/port/tauri` |
| Windows | Works. See the last test results below |
| macOS | Never compiled, never run |
| Ubuntu | Never compiled, never run |
| CI workflows | Written for all three platforms, never run on GitHub |

Last Windows results, on the code before the final cleanup:

| Suite | Result |
|---|---|
| Lint | Passes |
| Unit tests | All pass |
| Rust tests | 75 for the app, 5 for the runner |
| Integration specs | 528 of 528 |
| Real-input specs | 31 of 31 |
| Release smoke test | 2 of 2 |

After those runs, `scripts/clean-dist.js`, `scripts/copy-icons.js`, `src/web/icons/` and `src/parsers/new/` were deleted. Nothing used them, and the full suite was not rerun afterwards.

## 2. Getting the code

```sh
git clone <repository-url>
cd <repository-folder>
git checkout port/tauri
```

Confirm you have this document and that `package.json` says version 3.0.0. The user may have moved the work to another branch since this was written, so ask which branch to use if `port/tauri` does not hold this file.

Do not run any other git command unless the user tells you to. That includes commits, pushes and branch changes.

## 3. Rules for this work

Read `.claude/RULES.md` in full before you do anything. It binds every step. Where it mentions `cmd //c`, `scripts\test.bat` or PowerShell, those are the Windows forms; on these platforms the test runner is `scripts/test.sh`, which still has to be written (blocker 6).

The rules that matter most here, plus standing instructions from the user that are not in that file:

**Scope**

- Do exactly what the user asked and nothing else. If you think something else is needed, say so and wait.
- Answer a question with an answer. A question is not an instruction to change code.
- When the user tells you to do something, do it without asking for confirmation.
- Ask one question at a time, in plain text, without a choice picker.

**Testing**

- Test first. See the test fail against the fault, for the reason you expect, then see it pass against the fix.
- Run the named tests for what you changed. Do not run the whole suite to check something a named test covers.
- All tests pass before any build. The release build is the last step.
- Any script that chains steps must stop at the first failure.
- Never claim something works unless you ran it where it matters.
- Measure before proposing a fix. Do not reason from the code in place of a measurement.
- While something long runs, read its output every 10 seconds.

**Files**

- Snapshot a file into your scratchpad before you edit it, under a new name each time.
- Use LF line endings everywhere. No em dashes anywhere.
- No python, sed, perl, awk or heredocs. Use the editing tools, or a small Node script in your scratchpad.
- Run Cargo only through the npm scripts.
- Nothing transient stays in the repository.
- Never sign anything: no `Co-Authored-By`, no "Generated with", no attribution of any kind.
- No banner comments, and no comments about history or about this conversation.

**The user's machine**

- Taking the mouse, keyboard or screen needs the user's yes, every time.
- Do not tell the user to close an application so that your step succeeds.
- The user does no manual checks. If something needs checking, write a test that checks it.

## 4. Decisions already made

Do not reopen these.

| Decision | Detail |
|---|---|
| Runtime | Tauri 2. The name of the old desktop runtime appears nowhere except `README.md` and `plans/plan.md`, and `test/unit/tauri/no-old-runtime.test.js` enforces that. Do not write that name in any other file |
| Layout | Rust source sits flat in `src/tauri`. `Cargo.toml`, `Cargo.lock` and `tauri.conf.json` are at the root. No `.cargo` folder, no `target` inside `src` |
| Bridge name | `window.pageToBackendBridge`, type `PageToBackendBridge`. Names must say what a thing does, in full |
| Release folders | `dist/windows`, `dist/macos`, `dist/ubuntu` |
| Release file names | `Markdown-Editor.exe`, `Markdown-Editor.dmg`, `Markdown-Editor.AppImage`. No OS and no version in the name |
| Version | `package.json` holds it. `npm version <version>` also updates `Cargo.toml` and `Cargo.lock` |
| Scripting API | Removed. Do not bring it back |
| Fullscreen | A fullscreen request from a document does nothing |
| Highlight active element | A Content preference, on by default. Its CSS sits inside `body.with-highlight { ... }`, and the checkbox only toggles that class |
| Export HTML | Asks Replace or Cancel when the file exists |
| Parser | `src/parsers/old` stays in JavaScript. Do not port or replace it unless told to |
| `scripts/parse-markdown.js` | Stays |
| Scripts | `build.bat` and `test.bat` find their own folder and work from any folder. The macOS and Ubuntu scripts must do the same |
| A root `index.html` | Do not touch it, restore it or ask about it |

## 5. How the app works

### Two halves

The Rust backend owns the window, the menu, the file system, the settings and all native dialogs. The editor itself is JavaScript in the system webview: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux.

The page reaches the backend only through the bridge. The backend reaches the page by sending `menu:action` events, and by evaluating script in the page when it needs an answer.

### The bridge

`src/tauri/backend-bridge.js` is injected before any page script on every load. Rust replaces `__MEDIA_ORIGIN__` in it first. It defines the frozen object `window.pageToBackendBridge` with these members:

`toDisplayUrl`, `fromDisplayUrl`, `version`, `newDocument`, `loadFile`, `loadFilePath`, `saveFile`, `saveFileAs`, `exportHtml`, `setUnsavedChanges`, `confirmClose`, `undo`, `redo`, `setWritingView`, `setSource2View`, `notifyOpenFiles`, `confirmDialog`, `reload`, `getRecentFiles`, `getSettings`, `getSetting`, `setSetting`, `browseForImage`, `getPathForFile`, `renameImage`, `toRelativeImagePath`, `changeElementType`, `applyFormat`, `onMenuAction`.

It also:

- queues menu actions until the page registers its handler, then tells the backend it is ready through `bridge_ready`;
- copies `document.title` into the window title;
- turns a right-click the page did not handle into the app's context menu;
- turns Tauri's `tauri://drag-drop` event into a DOM `drop` event, converting physical pixels to CSS pixels.

### Backend modules (`src/tauri`)

| File | Job |
|---|---|
| `main.rs` | Entry point: commands, `media` protocol, window creation, session restore, bounds, close flow, macOS reopen |
| `ipc_handler.rs` | The commands the bridge calls, file dialogs and message boxes |
| `menu_builder.rs` | Application and context menus, built as data and then as native menus |
| `webview_settings.rs` | Navigation and new-window limits; Windows webview settings, shortcuts, page dialogs and Inspect Element |
| `file_manager.rs` | Current file, unsaved flag, recent files, export paths |
| `settings_manager.rs` | Settings in SQLite, one JSON value per key |
| `media_protocol.rs` | Serves local images, audio and video to the page |
| `message_box.rs` | Texts and buttons of the app's message boxes |
| `image_path.rs` | Image renames and relative image paths |
| `web_contents.rs` | Holds events and script evaluations until the bridge is ready |
| `test_hooks.rs` | Test channel, compiled only with the `test-hooks` feature |
| `build.rs` | Declares the app's commands and points Tauri at the capabilities and icon |
| `bin/win-runner.rs` | Windows real-input tool, a second binary of the crate |
| `capabilities/default.json` | What the page may call. A new command must be added here and in `build.rs` |

### Commands

`settings_get`, `settings_set`, `settings_get_all`, `bridge_ready`, `document_undo`, `document_redo`, `view_writing`, `view_source2`, `element_change_type`, `element_format`, `file_new`, `file_load`, `file_save`, `file_save_as`, `file_export_html`, `file_set_unsaved_changes`, `file_get_recent_files`, `file_load_path`, `image_browse`, `image_rename`, `path_to_relative`, `file_confirm_close`, `dialog_confirm`, `view_open_files_changed`, `app_reload`, `web_contents_reply`, `context_menu`.

### Security model

Every document is untrusted, and its scripts are assumed to run in the page. Keep these limits on every platform:

- The capability grants only the app's own commands, event listen and unlisten, and set-title. There is no `core:default` and no plugin permission.
- The main frame can navigate only to the app's own pages (`is_app_url`).
- `window.open` never opens an app window. `http` and `https` URLs go to the system browser.
- Every permission request is denied.
- Local files reach the page only through the `media` protocol, and only with image, audio or video extensions.
- Same-origin iframes in a document get a `sandbox` without `allow-same-origin`.
- The page's Content-Security-Policy is the meta tag in `src/web/index.html`.

### Window lifecycle

The window is created hidden, sized from saved bounds, and shown on the first page load. Closing it first flushes the page's open files, then asks about unsaved changes. The app quits when its window closes, on every platform.

### The page

`src/web/scripts/app.js` is the entry point. `App.initialize()` creates the editor, loads the style-element setting, creates the toolbar and handlers, exposes `window.editorAPI`, registers the menu handler last, and then loads the remaining settings. The menu handler has to come last: registering it delivers any queued menu action at once, so every listener those actions reach must already exist.

## 6. Repository map

```
.claude/RULES.md              Rules for this repository
.github/workflows/            validate.yml (pull requests), build.yml (version tags)
Cargo.toml, Cargo.lock        The Rust crate
tauri.conf.json               Tauri configuration
package.json                  npm scripts and the version
playwright.config.js          Integration specs
playwright.real-input.config.js  Real-input specs, one worker
docs/developers/              architecture.md, design.md, getting-started.md
plans/plan.md                 The port's plan and its records
scripts/
  build-executable.js         Release build, copies the result into dist/<platform>
  build-leftovers.js          Removes build/, gen/ and permissions/
  build-test-app.js           Debug build with test hooks, into target/test
  build-win-runner.js         Builds the Windows runner
  build.bat, test.bat         Windows entry points
  dev-server.js               Serves src/ for npm start
  lint-comments.js, lint-eol.js  Lint steps
  parse-markdown.js           Prints a document's syntax tree
  stage-frontend.js           Copies the page into build/frontend for a build
  sync-cargo-version.js       Runs from npm version
  test-rust.js                cargo test, then removes leftovers
src/
  parsers/old/                Markdown parser and syntax tree
  tauri/                      Rust backend and the bridge
  types.d.ts                  Type declarations
  web/                        index.html, scripts, styles
test/
  fixtures/                   Test documents and images
  integration/                Playwright specs and their helpers
  real-input/                 Specs driven by real keyboard and mouse input
  release/                    Smoke test of the built release file
  unit/                       Node unit tests
```

Generated and ignored: `node_modules/`, `target/`, `dist/`, `build/`, `gen/`, `permissions/`, `test-results/`, `.cache/`.

## 7. Commands

| Command | What it does |
|---|---|
| `npm ci --ignore-scripts` | Installs dependencies |
| `npm run setup` | Installs Playwright's Firefox and its system packages |
| `npm start` | Runs the app from `src/` with `tauri dev` |
| `npm run lint` | Line endings, comments, quotes, Biome, `cargo fmt`, `tsc` |
| `npm run test:unit` | All unit tests |
| `node --test <file>` | One unit test file, from the project root |
| `npm run test:rust` | Rust tests. Add a filter after `--` |
| `npm run build:test-app` | Debug app with test hooks, in `target/test/debug` |
| `npm run test:integration` | Builds the test app, then runs all integration specs |
| `npm run test:integration -- <spec>` | The same for named specs, paths with forward slashes |
| `npm run test:real-input` | Real-input specs. Windows only today |
| `npm test` | Lint, unit, Rust, integration, cleanup |
| `npm run build` | Lint, then the release build for this platform |
| `npm run dist:mac` | Release build to `dist/macos/Markdown-Editor.dmg` |
| `npm run dist:linux` | Release build to `dist/ubuntu/Markdown-Editor.AppImage` |
| `npm version <version>` | Changes the version everywhere. Pass `--no-git-tag-version` unless told to commit |

`npm test` will fail on macOS and Linux until blocker 3 is solved.

## 8. How the tests work

### Suites

| Suite | Location | Runs on macOS and Linux today? |
|---|---|---|
| Unit | `test/unit/**/*.test.js` | Should, not yet tried |
| Rust | `#[cfg(test)]` blocks in `src/tauri` | Should, not yet tried |
| Firefox specs | 6 specs that load the page over HTTP | Should, not yet tried |
| App specs | 68 specs that call `launchApp`, plus `startup-timing.spec.js` | `launchApp` cannot attach. `startup-timing.spec.js` starts the binary directly, so it may run |
| Real-input | `test/real-input/*.spec.js` | Skipped |
| Release smoke | `test/release/release-smoke.test.js` | Fails: its path and runner are Windows-only |

### How an app spec starts

`launchApp` in `test/integration/test-utils.js`:

1. Picks a free port, and gives the launch its own webview folder and the spec file its own settings folder, all under `test-results/`.
2. Spawns `target/test/debug/markdown-editor` with the environment below.
3. Waits for the DevTools endpoint on that port, then attaches with `chromium.connectOverCDP`.
4. Finds the page whose URL ends in `web/index.html` and waits for `readyState` to be `complete`.
5. Returns `{ app, page }`: `app` is a `TauriApp`, `page` is a Playwright page.

Steps 3 and 4 only work with WebView2.

### Test environment variables

| Variable | Effect | Platforms |
|---|---|---|
| `TESTING` | The window stays hidden, open files are not restored, closing is immediate | All |
| `TESTING_VISIBLE` | Shows the window under `TESTING` (test-hooks builds) | All |
| `TESTING_SETTINGS_DIR` | Folder for the settings database | All |
| `STARTUP_TIMING` | Writes the time of the first page load to this file and exits | All |
| `TESTING_DEVTOOLS_PORT` | Opens the DevTools protocol on this port | Windows only |
| `TESTING_WEBVIEW_DIR` | WebView2 data folder | Windows only |

### The test hook channel

A build with the `test-hooks` feature reads one JSON request per line from stdin: `{"id":1,"method":"windowCount","params":null}`. It answers on stdout with a tagged line: `__HOOK__{"id":1,"result":1}`. `test/integration/tauri-app.js` is the client. Add new hooks to `dispatch` in `src/tauri/test_hooks.rs`.

| Hooks | Purpose |
|---|---|
| `windowCount`, `windowState`, `setWindowBounds`, `maximize` | Window state and geometry |
| `close`, `requestClose` | Closing, with or without the normal close flow |
| `saveOpenFiles`, `restoreOpenFiles` | Session handling |
| `settings.get`, `settings.set` | Settings |
| `setFileDialogResult`, `fileDialogs` | Answers and records file dialogs |
| `setMessageBoxResponse`, `messageBoxes` | Answers and records message boxes |
| `menu.items`, `menu.isEnabled`, `menu.click`, `menu.changes` | The application menu |
| `contextMenus`, `contextMenu.click` | Context menus, recorded instead of shown |
| `clipboard.writeText`, `clipboard.readText` | The system clipboard |
| `sentKeystrokes` | Keystrokes Cut, Copy and Paste would send |
| `dropFiles` | Emits Tauri's drag-drop event |
| `sendMenuAction` | Sends a menu action to the page |
| `recordOpenedUrls`, `openedUrl` | URLs handed to the system browser |
| `recordRevealedItems`, `revealedItem` | Items revealed in the file browser |
| `webviewSettings` | Webview settings in effect |
| `inspections`, `isDevtoolsOpen` | Inspect Element and DevTools |

In test-hooks builds, message boxes, file dialogs and context menus are recorded and answered from stubs, so nothing native appears. That also means no test sees what those native dialogs really look like (see blocker 2).

### The Windows runner

`src/tauri/bin/win-runner.rs` is what makes real input possible on Windows. `test/real-input/runner.js` starts it once per command, and it answers with one JSON line:

| Command | Answer or effect |
|---|---|
| `window <pid>` | Title, whether it is visible and in front, client area in physical pixels |
| `focus <pid>` | Brings the window to the front |
| `keys <pid> <combination>...` | Presses combinations written the Playwright way: `Control+Shift+Z`, `Alt`, `F10` |
| `type <pid> <text>` | Types the text |
| `click <pid> <x> <y>` | Clicks a point of the client area, in physical pixels |
| `menu <pid>` | Whether the menu bar is active, and the open menu's items |

It refuses to send input unless the app's window is the one receiving it. Runners for the other platforms should keep this command contract and this safety check, so the specs can stay the same.

## 9. Platform-specific code

### Windows only, with nothing in its place elsewhere

All of this is in `create_window` in `main.rs` or called from it:

| Code | What macOS and Linux get instead |
|---|---|
| `browser_arguments` | No locale, autoplay or heap arguments |
| `apply_webview_settings` | Webview defaults for status bar, zoom, pinch, swipe, autofill and tracking prevention |
| `route_menu_shortcuts` | Native menu accelerators only |
| `route_script_dialogs` | The webview's own `alert` and `confirm` handling |
| `answer_context_menus`, `inspect_element` | Inspect Element opens DevTools with no element selected |

### Code that differs by platform

| Location | Difference |
|---|---|
| `main.rs:25` `MEDIA_ORIGIN` | `http://media.localhost` on Windows, `media://localhost` elsewhere |
| `main.rs:103` and `:116` | Reopening from the Dock, macOS only |
| `menu_builder.rs:807` `present_accelerator` | macOS registers every shortcut. Windows and Linux do not register the six Edit shortcuts the page handles: `PAGE_HANDLED` at `menu_builder.rs:40` |
| `menu_builder.rs:821` `predefined_role` | macOS uses native Cut, Copy, Paste and Select All items |
| `menu_builder.rs:1196` `send_keystroke` | Linux runs `document.execCommand` |
| `menu_builder.rs:1412` `exit_item` | Cmd+Q on macOS, Alt+F4 elsewhere |
| `webview_settings.rs:140` `reload_ignoring_cache` | Plain reload outside Windows |
| `test_hooks.rs:128` `devtools_open` | Uses `is_devtools_open` outside Windows |

## 10. Known blockers

### Blocker 1: the bridge will not install

`backend-bridge.js:21` accepts only these origins:

```js
const appOrigins = [`http://tauri.localhost`, `https://tauri.localhost`, `http://localhost:1420`];
```

Tauri serves the app from `tauri://localhost` on macOS and Linux. If that holds, `window.pageToBackendBridge` will not exist there, and the app will open but cannot load, save, read settings or receive menu actions.

1. Measure first: log `window.location.origin` from the running app.
2. Add a failing case to `test/unit/bridge/backend-bridge.test.js` for that origin.
3. Add the origin to `appOrigins`.
4. Confirm a foreign origin is still refused, and that the Windows origins still work.

### Blocker 2: the unsaved-changes box loses two buttons, on every platform

`show_message_box` at `ipc_handler.rs:528` uses `tauri_plugin_dialog`, which shows at most two buttons. A box with more is cut down to its default and cancel buttons. `unsaved_changes_box` has Save, Save As..., Discard and Cancel, so a release build offers only Save and Cancel. A user with unsaved changes cannot discard them from that box.

The stubbed test hooks hide this, as they answer with any button index. It also affects Windows, so the fix changes all three platforms.

Ask the user how this should be solved before you start. The two realistic options:

- Native dialogs per platform: `TaskDialogIndirect` on Windows, `NSAlert` on macOS, `GtkMessageDialog` on Linux.
- A dialog drawn in the page, with the close flow waiting for its answer.

### Blocker 3: the app specs cannot attach

WKWebView and WebKitGTK do not offer the Chrome DevTools Protocol, so `launchApp` fails after three attempts. The plan intended these specs to skip on other platforms, but no skip was ever written.

The specs lean heavily on Playwright's page object. Calls counted across `test/integration` and `test/real-input`:

| Call | Count |
|---|---|
| `page.locator` | 813 |
| `page.waitForTimeout` | 324 |
| `page.evaluate` | 318 |
| `page.keyboard.press` | 258 |
| `page.waitForSelector` | 62 |
| `page.keyboard.type` | 59 |
| `page.goto` | 28 |
| `page.fill` | 19 |
| `page.mouse.*` | 43 |
| `page.waitForFunction` | 11 |

They also use web-first assertions such as `toBeVisible`, `toHaveText` and `toHaveCount`.

Options to put to the user. Do not choose alone:

| Option | Approach | Cost |
|---|---|---|
| A | Add an `eval` test hook, and write a small `page` adapter over it, with keyboard and mouse going through the platform runner | Works on both platforms and tests the real webview. The adapter and its assertions are real work, and the runner needs a visible window |
| B | `tauri-driver` with WebKitWebDriver | Possible on Linux. Check its current documentation for macOS. Specs would need an adapter or a rewrite |
| C | Run page-only specs in Playwright's WebKit against a stubbed backend | Cheap, but it is not the real app or the real webview |

Option A is the one I would recommend, as it is the only one that exercises the real app the same way on both platforms.

### Blocker 4: real input exists on Windows only

`win-runner` returns an error outside Windows, and all four real-input specs skip themselves. The user does no manual checks, so each platform needs a runner.

| Platform | Likely mechanism, to be verified |
|---|---|
| Ubuntu | XTEST through `xdotool` or a Rust X11 crate, under X11. AT-SPI for the menu state. Wayland blocks synthetic input from ordinary clients |
| macOS | `CGEvent` for input, Accessibility APIs for the window and menu state. The process needs the Accessibility permission, which the user has to grant |

The specs press `Control` combinations, `Alt` plus a letter, and `F10`. macOS needs `Meta` for shortcuts, and has no Alt-letter or F10 menu access, so those specs need per-platform expectations. `WIN_RUNNER_BINARY` in `scripts/build-win-runner.js` also ends in `.exe`.

### Blocker 5: the release smoke test is Windows-only

`release-smoke.test.js` starts `dist/windows/Markdown-Editor.exe` and reads its title through the runner. Each platform needs its own way to start the built file:

- macOS: mount the `.dmg` and start the binary inside the `.app`.
- Ubuntu: start the AppImage, using `--appimage-extract-and-run` if FUSE is not available.

### Blocker 6: `scripts/test.sh` and a build script do not exist

`.claude/RULES.md` requires `scripts/test.sh` outside Windows. Write it, and `scripts/build.sh`, to match the batch files:

- Find the project root from the script's own location, so they work from any folder.
- Read named files relative to the folder the script was called from, and convert them to paths relative to the root.
- With no argument, run `npm test`.
- Send a `.test.js` file to `node --test`, and anything else to `npm run test:integration --`.
- Exit with the exit code of the run.

## 11. Work plan

Do one platform at a time. Ask the user which comes first. For every fix: failing test, fix, passing test, then documents.

### Phase A: first compile

1. Install the prerequisites from section 12 or 13.
2. Run `npm ci --ignore-scripts` and `npm run setup`.
3. Write `scripts/test.sh` and `scripts/build.sh`, and check every path through them.
4. Run `npm run lint`.
5. Run `npm run test:unit`.
6. Run `npm run test:rust`. This is the first compile on this platform, so expect errors in code that has never been built here.

Done when lint, unit and Rust tests all pass.

### Phase B: the app starts and works

1. Fix blocker 1.
2. Start the app with `npm start`, with the user's yes, and confirm that the page loads and the bridge exists.
3. Run the 6 Firefox specs and `startup-timing.spec.js`.

Done when the app opens a document and saves it through the real bridge.

### Phase C: a way to test the app

1. Put the options in blocker 3 to the user and get a decision.
2. Build what was decided.
3. Get `test-window.spec.js` passing first. It proves a hidden window still renders and runs timers, and without that every other result is suspect.
4. Work through the remaining app specs one folder at a time. Sort each failure into a fault in the app, a fault in the harness, or a real platform difference, and tell the user about the last kind.

Done when every app spec passes, or has a skip the user has agreed to.

### Phase D: real input

1. Build the platform runner with the same commands as `win-runner`.
2. Make the specs in `test/real-input` run on this platform, with per-platform keys and expectations.

Done when every shortcut is proven to fire exactly once in both views.

### Phase E: platform differences

Go through section 14. Each difference found gets a failing test first.

### Phase F: blocker 2

Do this once the user has chosen an approach. It changes Windows too, so tell the user that it needs a Windows run as well.

### Phase G: release

1. Run all tests, and stop at any failure.
2. Run `npm run dist:mac` or `npm run dist:linux`.
3. Run the platform's release smoke test on the built file.
4. Confirm that no `build/`, `gen/` or `permissions/` folder is left.

### Phase H: documents and CI

1. Update `docs/developers/` for what changed.
2. Compare `.github/workflows/` with the steps that actually worked, and correct them.
3. Record the results in `plans/plan.md` if the user asks for that.

## 12. macOS notes

### Prerequisites

```sh
xcode-select --install
```

Also Node 22 or later, and the stable Rust toolchain (1.90 or later) with rustfmt.

### What to look at

- **Shortcuts:** macOS registers all menu shortcuts, including the six the page also handles, and the menu takes key equivalents first. Check that Cmd+Z, Y, X, C, V and A each act exactly once, and that undo goes through the editor's own undo.
- **Application menu:** the first submenu becomes the application menu, so File's items may appear under the app's name. Show the user what it looks like if it differs from what they expect.
- **View menu:** AppKit may add full-screen and tab items to a menu titled View.
- **Fullscreen:** a document's request must do nothing. Whether the window's green button should stay is a separate question for the user.
- **`confirm`:** check that the table-shrink `confirm` returns the user's real answer to the page.
- **Dock reopen:** `reopen_main_window` has never been compiled. The app quits when its window closes, so check whether that path can be reached at all.
- **Hidden window:** WKWebView may throttle a hidden page. `test-window.spec.js` will show this.
- **Packaging:** `dist:mac` builds for the machine's own architecture. Nothing is signed or notarized, so check how the `.dmg` behaves after a download, and report that to the user.

## 13. Ubuntu notes

### Prerequisites

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Also Node 22 or later, and the stable Rust toolchain (1.90 or later) with rustfmt. `npm run setup` installs system packages for Firefox and may ask for `sudo`.

### What to look at

- **X11 and Wayland:** Wayland stops an app from positioning its own window and blocks synthetic input, which affects `window-geometry.spec.js` and the runner. Find out which session the machine uses, and test under X11 first.
- **Virtual display:** `xvfb-run` gives the tests a display of their own, so they would not take the user's screen.
- **Menu Cut, Copy, Paste:** `send_keystroke` uses `document.execCommand`. WebKit may refuse paste from script, so test all three from the Edit menu and the context menu.
- **Edit menu text:** the six page-handled shortcuts are not registered, and GTK cannot show their shortcut text.
- **Menu labels:** GTK may treat `_` and `&` in Open Recent paths as mnemonic markers.
- **Blank window:** if the webview renders nothing, try `WEBKIT_DISABLE_DMABUF_RENDERER=1` to find out whether the graphics stack is the cause.
- **AppImage:** the bundler downloads its tools on first use. If it fails at the strip step, try `NO_STRIP=true`. Running an AppImage may need `libfuse2`.
- **Folder name:** the build flag is `--linux`, and the output folder is `dist/ubuntu`.

## 14. Verification checklist

Every line needs a test, or a recorded result from the real app.

### Core

- [ ] The bridge exists on the app's own page and on no other origin
- [ ] New, Load, Save, Save As, Close
- [ ] Open Recent and Clear Recent, including paths containing `_` and `&`
- [ ] A file named on the command line opens
- [ ] Open files, cursor and table-of-contents position are restored after a restart
- [ ] Window size, position and maximized state are restored
- [ ] Closing with unsaved changes offers all four choices, and each one does what it says
- [ ] Export HTML, with Replace and Cancel when the file exists
- [ ] Images > Gather
- [ ] Word Count, including its number format
- [ ] Drag and drop of images and markdown files
- [ ] Preferences save and apply, including Highlight active element

### Input

- [ ] Every menu shortcut fires exactly once, in writing view and in source view
- [ ] Undo, redo, cut, copy, paste and select all, from keys, the Edit menu and the context menu
- [ ] Focus is in the editor after start, after every dialog, and after switching apps
- [ ] Text entry through an input method, in both views

### Rendering

- [ ] Stylesheets render correctly: CSS nesting, `color-mix()` and `@scope`
- [ ] The source view textarea sizes itself (`field-sizing`)
- [ ] `<style>` elements in a document apply when the preference is on
- [ ] Local images, audio and video load through the `media` protocol
- [ ] `http:` images and iframes in a document load or fail as they should
- [ ] An image without an image extension does not load

### Security

- [ ] Navigation to a remote page is blocked
- [ ] `window.open` opens no app window and reaches the system browser
- [ ] A same-origin iframe cannot reach the bridge
- [ ] A permission request gets no prompt and no access
- [ ] A command outside the capability is refused
- [ ] A fullscreen request does nothing. The `Permissions-Policy` header may not be honoured by WebKit, so test the behaviour, not the header

### Webview differences

- [ ] Page `alert` and `confirm` return the right answers
- [ ] Inspect Element opens DevTools
- [ ] Help > Reload shows edited files under `npm start`
- [ ] No browser popups in text fields, on selections or over images
- [ ] Zoom keys, Ctrl plus the wheel, and pinch do what they do on Windows, or the difference is reported

## 15. Traps already hit on Windows

These cost real time. Some will come back in another form.

| Trap | What happened | Lesson |
|---|---|---|
| `readyState` is not readiness | `document.readyState` is `complete` before `App.initialize()` has finished, so `window.editorAPI?.setContent` silently did nothing | `loadContent` waits for `editorAPI` and awaits the load. Any new harness must do the same |
| Blocks get replaced | The editor replaces a block's element when the caret enters or leaves it, so a measured element can vanish | Look an element up again if a measurement comes back empty |
| Queued menu actions | The bridge delivers queued actions the moment the page registers its handler | Register the menu handler after every listener exists |
| Failures that depend on load | Some specs failed only in the full parallel run | Reproduce under the same load before calling something fixed |
| Scanning `build/` | A test that walked the repository read `build/` while other tests created and deleted it | Skip generated folders in any repository scan |
| Stale builds | A snapshot copied back keeps its old modification time, so Cargo does not rebuild | Touch a restored file before rebuilding |
| Generated folders | `tauri-build` writes `gen/` and `permissions/` beside `Cargo.toml` | Every build path must end in `removeBuildLeftovers` |
| Crashes that report success | A panic in the Tauri CLI ended Node with a negative exit code on Windows, which `if errorlevel 1` missed | Check the real exit code in every script |
| Stubs hide native problems | Message boxes are stubbed in test builds, which hid blocker 2 | Stubs prove the app asked. They do not prove what the user sees |
| Modifier keys | WebView2 reported shortcut modifiers unreliably, and they had to be read from the thread's key state | Check modifier handling with real input, not synthetic events |

## 16. Finishing and reporting

A platform is finished when:

1. Lint, unit, Rust, integration and real-input tests all pass on it.
2. The release file is in `dist/macos` or `dist/ubuntu`, under the agreed name.
3. The release smoke test passes on that file.
4. Every line of section 14 has a result.
5. No generated folder is left behind.
6. The documents match what is true.

When you report to the user:

- Say what is true now and what is not, in plain words. Include anything you did not verify.
- Say plainly if you added anything that was not asked for.
- Do not list everything you changed.
- Do not commit, push or tag unless told to.
