# Plan: replace Electron with Tauri

## Why

Every copy of the app currently ships Electron's own Chromium: a 213.8 MB `Markdown Editor.exe` plus about 75 MB of Chromium DLLs and data files. The single-file `.exe` therefore has to carry 289 MB and unpack it on first run, which is what the NSIS launcher and all the compression timing were about.

Tauri does not ship a browser. It uses the webview the operating system already has: WebView2 on Windows (part of Windows 10 and 11, Chromium-based), WKWebView on macOS, WebKitGTK on Linux. The app's native side is written in Rust, and a release build is one executable with the web files embedded in it. There is nothing to unpack, so the NSIS launcher, the unpack folder in `%LOCALAPPDATA%` and the compression question all disappear.

## What exists now

Electron main process, 2,721 lines in `src/electron`:

- `main.js`: creates the window, saves and restores window position and size, handles closing with unsaved changes, restores the files that were open last time, opens a file passed on the command line.
- `file-manager.js`: open and save dialogs, reading and writing files, the recent files list.
- `settings-manager.js`: settings in a SQLite database (`better-sqlite3`) in Electron's user data folder.
- `ipc-handler.js`: about 30 channels the page calls.
- `menu-builder.js`: the application menu with its shortcuts, Open Recent, Images → Gather (copies image files next to the document), About, the right-click menu, Reload, DevTools.
- `api-registry.js`: the scripting API, whose commands are forwarded to the page.
- `preload.cjs`: `window.electronAPI`, 31 functions and 2 event subscriptions, used in 49 places across 10 files in `src/web`.

The page loads local images through `file://` URLs, and drag and drop gets file paths from Electron's `webUtils.getPathForFile`.

Tests: 392 unit tests run in Node against `src/web` code and do not involve Electron. 431 Playwright integration tests start the app through Playwright's Electron support; 20 places in 8 spec files reach into Electron's main process.

CI runs the tests on Windows, macOS and Linux, and builds on all three.

## What replaces it

- `src-tauri/` holds the Rust side: the same window, menu, shortcuts, dialogs, file reading and writing, recent files, settings, window position, session restore, command-line file, image rename, Gather Images and scripting API commands, each a Tauri command or event.
- Settings stay in SQLite, through the `rusqlite` crate with SQLite compiled in, using the same `settings` table.
- `window.electronAPI` becomes `window.appAPI`, implemented in `src/web` on top of Tauri's `invoke` and `listen`. The 49 call sites and `types.d.ts` are renamed.
- Local images load through Tauri's asset protocol instead of `file://`, allowed for every path, as `webSecurity: false` allows today.
- Drag and drop takes file paths from Tauri's drag-and-drop event.
- The unsaved-changes prompt has four buttons (Save, Save As, Discard, Cancel). Tauri's native message dialogs have at most three, so this one becomes an HTML dialog in the page, like the existing preferences and word count dialogs.
- Removed: `src/electron`, the `electron`, `electron-builder`, `@electron/rebuild` and `better-sqlite3` packages, `scripts/launcher.nsi`, `scripts/build-executable.js`, the `STARTUP_TIMING` check, and the `build` section of `package.json`.
- `npm run build` runs `tauri build`.

## Differences between the three webviews

WebView2 is Chromium, so on Windows the page renders as it does now. WKWebView and WebKitGTK are WebKit. The stylesheets use `field-sizing: content` for the source view textarea, `@scope` for document styles, `:has()` and CSS nesting. Which of these each WebKit version supports has to be checked before macOS and Linux can be called working.

## Open questions

Asked one at a time; each answer is recorded here.

1. Integration tests on macOS and Linux.
2. Settings and open files saved by the Electron version.
3. macOS and Linux builds.

## Steps

Written once the open questions are answered.
