# Getting Started with Markdown Editor Development

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v22.0.0 or higher)
- **npm** (comes with Node.js)
- **Git**
- **Rust** (the stable toolchain, installed with `rustup`)

And for your platform:

- **Windows**: the Microsoft C++ build tools (MSVC, the "Desktop development with C++" workload of the Visual Studio Build Tools), and the WebView2 runtime, which Windows 10 and 11 normally already have
- **macOS**: the Xcode command line tools (`xcode-select --install`)
- **Linux**: the WebKitGTK 4.1 development packages and the other system packages Tauri lists for your distribution (on Debian and Ubuntu: `libwebkit2gtk-4.1-dev`, `build-essential`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`)

## Initial Setup

### 1. Clone the Repository

```sh
git clone <repository-url>
cd markdown-editor
```

### 2. Install Dependencies

```sh
npm install --ignore-scripts
npm run setup
```

Dependency install scripts are not run. `npm run setup` installs the Playwright Firefox browser used by the integration tests. Run it again after any reinstall of `node_modules`.

### 3. Run the Application

```sh
npm start
```

This runs `tauri dev`: it builds the backend (the first build compiles all the Rust dependencies and takes a few minutes) and opens the app, which loads the page from a small dev server that serves `src/` as it is on disk, so Help > Reload shows an edited page file.

## Project Overview

### Directory Structure

```
markdown-editor/
├── src/
│   ├── parsers/old/       # DFA tokenizer, parser and syntax tree
│   ├── tauri/             # The Tauri backend: the Rust modules, the bridge (preload.js),
│   │                      #   build.rs, the capabilities and the icons
│   ├── types.d.ts         # Global TypeScript type declarations
│   └── web/               # What the webview loads
│       ├── index.html
│       ├── styles/
│       │   ├── main.css
│       │   ├── editor.css
│       │   ├── toolbar.css
│       │   ├── image.css
│       │   ├── link.css
│       │   ├── table.css
│       │   ├── toc.css
│       │   ├── preferences.css
│       │   ├── word-count.css
│       │   ├── search.css
│       │   └── tab-bar.css
│       └── scripts/
│           ├── app.js           # Renderer entry point
│           ├── editor/          # Core editor, undo, selection, renderers, formatters
│           └── utility/         # UI components (toolbar, modals, toc, search, etc.)
│
├── Cargo.toml             # The Rust crate, its source in src/tauri
├── tauri.conf.json        # The Tauri app's configuration
│
├── test/
│   ├── unit/              # Node.js native unit tests
│   ├── integration/       # Playwright integration tests
│   └── release/           # The release executable's smoke test
│
├── docs/
│   └── developers/        # Developer guides (you are here)
│
├── scripts/               # Build and utility scripts
│   ├── build.bat          # Windows: builds the release app (build-executable.js)
│   ├── test.bat           # Windows: runs npm test, or the named test file or specs
│   ├── build-executable.js # Builds the release app and copies it into dist/
│   ├── build-test-app.js  # Builds the debug app with the test hooks
│   ├── dev-server.js      # Serves src/ for npm start
│   ├── lint-comments.js   # Flags visual divider comments
│   ├── lint-eol.js        # Checks every file uses LF line endings
│   ├── parse-markdown.js  # CLI tool for testing parser output
│   ├── stage-frontend.js  # Copies the page into build/frontend for the app build
│   └── sync-cargo-version.js # Gives Cargo.toml and Cargo.lock package.json's version
│
├── package.json
├── backticks.config.js    # ESLint config for backtick-quote enforcement
├── biome.json             # Biome formatter config
├── jsconfig.json          # TypeScript type-checking config (for JSDoc)
└── playwright.config.js   # Playwright integration test config
```

### Key Files

| File | Purpose |
|------|---------|
| `src/tauri/main.rs` | Backend entry point, window, session and close flow |
| `src/tauri/preload.js` | The bridge: the page's `pageToBackendBridge` |
| `src/tauri/ipc_handler.rs` | The commands the page calls |
| `src/tauri/file_manager.rs` | Current file, recent files, export paths |
| `src/tauri/menu_builder.rs` | Application menu and context menu |
| `src/tauri/settings_manager.rs` | Settings persistence via SQLite |
| `src/tauri/capabilities/default.json` | What the page may call |
| `src/web/scripts/app.js` | Page entry point, wires everything together |
| `src/web/scripts/editor/index.js` | Core editor class (coordinator) |
| `src/parsers/old/dfa-tokenizer.js` | DFA-based markdown tokenizer |
| `src/parsers/old/dfa-parser.js` | Markdown → syntax tree |
| `src/parsers/old/syntax-tree.js` | SyntaxTree / SyntaxNode data structures |
| `src/types.d.ts` | Global TypeScript type declarations |

## Running Tests

### Unit Tests

Run all unit tests:
```sh
npm run test:unit
```

Run a specific test file:
```sh
node --test test/unit/parser/dfa-parser.test.js
```

### Backend Tests

The Rust modules' unit tests:
```sh
npm run test:rust
```

### Integration Tests

Run integration tests:
```sh
npm run test:integration
```

This first builds the debug app with the `test-hooks` feature (`scripts/build-test-app.js`, into `target/test`), then runs Playwright. Most specs start that app with `TESTING=1`, so its window never appears, and drive its page over the DevTools protocol and its backend through the test hooks; the specs that need only the page run it in Firefox, which `npm run setup` installs. Run a single spec by naming it:

```sh
npm run test:integration -- test/integration/app-functionality/app/menus.spec.js
```

### Real-Input Tests (Windows)

The specs in `test/real-input/` show the test app's window and drive it with real keyboard and mouse input, sent by the Windows runner (`src/tauri/bin/win-runner.rs`): the menu shortcuts in writing and source view, the menu bar and its menus, Alt+F4, typing, and putting in an image through the image dialog. They take the mouse, keyboard and screen while they run, so they are not part of `npm test`:
```sh
npm run test:real-input
```

This builds the test app and the runner (`scripts/build-win-runner.js`) first, then runs Playwright with `playwright.real-input.config.js`, one test at a time.

### Release Executable

After `npm run build`, check the release executable starts, loads its page and exits, and opens a markdown file it is started with (its window title, read through the Windows runner, names the file):
```sh
node --test test/release/release-smoke.test.js
```

### All Tests + Lint

```sh
npm run test
```

This runs `lint`, `test:unit`, `test:rust`, `test:integration` and `test:cleanup` in sequence.

### On Windows: `scripts\test.bat`

```sh
scripts\test.bat
scripts\test.bat test/unit/parser/dfa-parser.test.js
scripts\test.bat test/integration/app-functionality/app/menus.spec.js
```

It runs from any folder: it works from the project root, which it finds from its own location, and reads the files you name relative to the folder you run it in. With no argument it runs `npm test`. A `.test.js` file runs with `node --test`; anything else runs as integration specs through `npm run test:integration`, which builds the test app first. Its exit code is that of the run.

## Code Quality

### Linting and Formatting

We use Biome for code formatting, ESLint for enforcing backtick quotes, and TypeScript for type checking via JSDoc annotations. The `lint` script runs all checks:

```sh
# Run all checks (codestyle + format + type check + codestyle)
npm run lint

# Individual steps:
npm run lint:eol        # LF line endings everywhere
npm run lint:codestyle  # Comment style + backtick quotes
npm run lint:format     # Biome format
npm run lint:rust       # cargo fmt
npm run lint:typing     # TypeScript type checking (tsc)
```

## Building Executables

Build the app for the current platform (a single `.exe` on Windows, a `.dmg` on macOS, an AppImage on Linux):

```sh
npm run build
```

Or name the platform explicitly (the same script, without the lint step); each platform's file has to be built on that platform:

```sh
npm run dist:win    # Windows .exe
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```

On Windows, `scripts\build.bat` runs the same script for the current platform, without the lint step, from any folder. `build-executable.js` itself works from the project root whatever folder it is started in.

The script runs `tauri build` and copies the result to `dist/windows`, `dist/macos` or `dist/ubuntu` as `Markdown-Editor.<ext>`. The Windows `.exe` has the page embedded and uses the system's WebView2 runtime, so it starts in place, with nothing to unpack. The `.dmg` and AppImage bundlers download Tauri's bundling tools the first time they run.

On GitHub, `.github/workflows/build.yml` builds all three on a version tag and publishes them as a release, and `.github/workflows/validate.yml` tests pull requests (see Build & CI in [Architecture](./architecture.md)).

## Development Workflow

### Making Changes

1. Make your changes following the coding conventions (see [Design](./design.md))
2. Add tests for new functionality
3. Run `npm run lint` to check for issues
4. Run `npm run test` to ensure nothing is broken
5. Update documentation if needed

### Code Style

- Use ES Modules (`import`/`export`)
- Add JSDoc comments to all public APIs
- One class per file
- No nested function declarations
- No inline function arguments (except trivial arrow functions)
- Run `npm run lint` before committing

## Common Tasks

### Adding a New Toolbar Button

1. Add a new entry to `getButtonConfigs()` in `src/web/scripts/toolbar/toolbar.js`
2. Add a Lucide SVG icon entry in `src/web/scripts/toolbar/icons.js`
3. Add a button color rule in `src/web/styles/toolbar.css`
4. Handle the action in `Editor.applyFormat()` if needed

### Adding a New Markdown Element

1. Add block dispatch case in `DFAParser._parseBlock()` in `src/parsers/old/dfa-parser.js`
2. Add sub-parser method in `DFAParser`
3. Add `toMarkdown()` case in `SyntaxNode` (`src/parsers/old/syntax-tree.js`)
4. Add rendering in both `SourceRenderer` and `WritingRenderer`
5. Add tests for parser and rendering
6. Update documentation

### Adding a New Preference

1. Add a default constant and UI (fieldset + controls) in `src/web/scripts/preferences/preferences-modal.js`
2. Add a nav link, a load method, and save logic with a custom event dispatch
3. Add CSS styles in `src/web/styles/preferences.css`
4. Wire the custom event listener in `src/web/scripts/app.js`
5. Persist via `setSetting` / `getSetting` IPC calls

### Modifying the Menu

1. Open `src/tauri/menu_builder.rs`
2. Modify the appropriate menu in `build_file_menu`, `build_edit_menu`, `build_view_menu` or `build_help_menu`; an item with an `action` is sent to the page as a `menu:action` event unless `run_item` handles it in the backend
3. Handle new actions in `src/web/scripts/editor/handlers/menu-handler.js`

## Debugging

### Using Debug Mode

Help > Debug (or F12) opens DevTools. Inspect Element in the right-click context menu opens DevTools on the element under the pointer.

### Backend

Backend logs appear in the terminal where `npm start` was run.

### Page

Page logs appear in the DevTools console (open via Help > Debug or F12).

## Security Model

Every document is treated as untrusted. The page reaches the backend only through the bridge, and only the commands the capability grants; the webview cannot navigate away from the app's own pages, open app windows or grant permissions; local images, audio and video load through the app's own `media` protocol; and a document's same-origin iframes are sandboxed. See the Security section of [Architecture](./architecture.md) for the full model.

## Common Issues

### "pageToBackendBridge is not defined"

The bridge installs itself only on the app's own pages. Check the page was loaded by the app (or by `npm start`'s dev server), not opened in a browser.

### Tests fail with "Cannot find module"

ESM requires full file extensions and proper relative paths:
```javascript
import { MyClass } from './my-class.js';  // .js is required
```

### Changes not reflected in the app

1. A page change shows after Help > Reload; a backend change needs the app rebuilt, so stop `npm start` and run it again
2. Check the DevTools console for errors (Help > Debug)

## Further Reading

- [Architecture](./architecture.md) — component overview and data flow
- [Design](./design.md) — coding conventions and patterns
