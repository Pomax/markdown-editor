# Markdown Editor - Design Documentation

## Overview

This document describes the design decisions, patterns, and conventions used in the Markdown Editor. It complements the Architecture documentation and provides guidance for implementing new features.

## Design Principles

### 1. Separation of Concerns

Each class has a single, well-defined responsibility:
- **Parser**: Converts text to tree structure
- **SyntaxTree**: Holds document structure
- **Renderer**: Converts tree to DOM
- **Editor**: Coordinates all components

### 2. One Class Per File

Every class is in its own file. See the Source Structure tree below for the full layout. Top-level editor files:
```
src/web/scripts/editor/
├── index.js               # Editor class (coordinator)
├── crc32.js               # CRC32 digest for content-change detection
├── offset-mapping.js      # Pure functions for raw ↔ rendered offset mapping
├── page-resize.js         # Page resize handles (both source and writing modes)
├── range-operations.js    # RangeOperations — selection range deletion, Ctrl+A
├── content-types/         # Image, link, table, code-block modals and helpers
├── edit-operations/       # Per-action edit logic (backspace, delete, enter, insert)
├── formatters/            # View-mode-specific formatting
│   ├── source2-formatter.js  # Textarea-based formatting for source2 mode
│   └── tree-formatter.js     # Tree-based formatting for writing mode
├── handlers/              # Clipboard, event, input, keyboard, menu handlers
├── managers/              # Cursor, selection, undo, persistence managers
├── renderers/             # Source + writing + source2 renderers
└── syntax-highlighter/    # Per-language syntax highlighting
```

### 3. No Nested Function Declarations

Functions are not declared inside other functions. Instead:
- Use class methods
- Use separate utility functions
- Use arrow functions only for simple callbacks

**Wrong:**
```javascript
function outer() {
    function inner() { /* ... */ }
    inner();
}
```

**Correct:**
```javascript
function inner() { /* ... */ }

function outer() {
    inner();
}
```

### 4. No Inline Function Arguments

Functions are not declared inline as arguments:

**Wrong:**
```javascript
array.map(function(item) {
    return item.value;
});
```

**Correct:**
```javascript
function extractValue(item) {
    return item.value;
}

array.map(extractValue);
```

Exception: Simple arrow functions for trivial operations:
```javascript
array.filter(item => item.active);
```

## File Organization

### Source Structure

```
src/
├── web/                      # The page, loaded in the webview
│   ├── index.html            # HTML entry, with the page's Content-Security-Policy
│   ├── styles/               # CSS files
│   │   ├── main.css         # Base styles, CSS custom properties
│   │   ├── editor.css       # Editor and syntax highlighting styles
│   │   ├── toolbar.css      # Toolbar styles
│   │   ├── image.css        # Image dialog and element styles
│   │   ├── link.css         # Link dialog styles
│   │   ├── table.css        # Table dialog and element styles
│   │   ├── toc.css          # Table of Contents sidebar styles
│   │   ├── preferences.css  # Preferences modal styles
│   │   ├── word-count.css   # Word count modal styles
│   │   ├── search.css       # Search panel styles
│   │   ├── tab-bar.css      # Tab bar styles
│   │   └── code-language.css # Code-block language tag styles
│   │
│   └── scripts/              # JavaScript
│       ├── app.js           # App entry, wires components together
│       ├── editor/          # Core editor (see Section 2 for full breakdown)
│       │   ├── index.js               # Editor class (coordinator)
│       │   ├── content-types/         # Image, link, table, code-block modals
│       │   ├── edit-operations/       # Backspace, delete, enter, insert
│       │   ├── handlers/              # Clipboard, event, input, keyboard, menu
│       │   ├── managers/              # Cursor, selection, undo, persistence
│       │   ├── renderers/             # Source + writing renderers
│       │   └── syntax-highlighter/    # Per-language syntax highlighting
│       └── utility/         # UI components
│           ├── modal/           # Base modal class
│           │   └── base-modal.js
│           ├── toolbar/         # Formatting toolbar + icons
│           │   ├── toolbar.js
│           │   ├── toolbar-button.js
│           │   └── icons.js
│           ├── toc/             # Table of Contents sidebar
│           │   └── toc.js
│           ├── preferences/     # Preferences modal
│           │   └── preferences-modal.js
│           ├── search/          # Search panel
│           │   └── search-bar.js
│           ├── tab-bar/         # Multi-file tab bar
│           │   └── tab-bar.js
│           └── word-count/      # Word count modal
│               └── word-count-modal.js
│
├── parsers/old/              # DFA tokenizer, parser and syntax tree
├── types.d.ts                # Global TypeScript type declarations
│
└── tauri/                    # The Tauri backend
    ├── main.rs               # Entry point, window, session, close flow
    ├── preload.js            # The bridge, injected into the page
    ├── ipc_handler.rs        # The commands the bridge invokes
    ├── menu_builder.rs       # Application menu and context menu
    ├── file_manager.rs       # Current file, recent files, export paths
    ├── settings_manager.rs   # Settings in SQLite
    ├── media_protocol.rs     # Local images, audio and video for the page
    ├── webview_settings.rs   # Webview limits, settings, keys and page dialogs
    ├── message_box.rs        # Message box texts and buttons
    ├── image_path.rs         # Image paths and renames
    ├── web_contents.rs       # Page events and evaluations until the bridge is ready
    ├── test_hooks.rs         # Test-hooks builds only: the channel the specs drive
    ├── build.rs              # Declares the app's commands, each refused unless granted
    ├── bin/
    │   └── win-runner.rs     # The Windows runner the real-input tests send input with
    ├── capabilities/
    │   └── default.json      # What the page may call
    └── icons/                # The app's icons
```

At the root, next to `package.json`: `Cargo.toml` (the crate: its binaries and build script in `src/tauri/`, its dependencies and the test-hooks feature) with its `Cargo.lock`, and `tauri.conf.json` (app name, version, where the page is, the icons). Cargo builds into `target/` at the root, which is not checked in; the release build links the C runtime statically on Windows through the Rust flags `scripts/build-executable.js` gives it.

Each Rust module keeps its unit tests in a `tests` module at its end; `npm run test:rust` runs them.

### Test Structure

```
test/
├── unit/                     # Unit tests (Node.js native test runner)
│   ├── parser/
│   │   ├── apply-format-html.test.js
│   │   ├── dfa-parser.test.js
│   │   ├── inline-tokenizer.test.js
│   │   └── syntax-tree.test.js
│   ├── editor/
│   │   ├── clipboard-handler.test.js
│   │   ├── crc32.test.js
│   │   ├── cursor-persistence.test.js
│   │   ├── offset-mapping.test.js
│   │   ├── page-resize.test.js
│   │   └── undo-manager.test.js
│   ├── table/
│   │   └── table-modal.test.js
│   ├── word-count/
│   │   └── word-count-modal.test.js
│   ├── bridge/
│   │   └── preload.test.js       # The bridge, run in a Node VM against a fake Tauri
│   ├── tauri/                    # The configuration the app relies on
│   │   ├── capabilities.test.js
│   │   ├── cargo-config.test.js
│   │   ├── no-old-runtime.test.js
│   │   ├── package-end-state.test.js
│   │   ├── tauri-conf.test.js
│   │   └── tool-coverage.test.js
│   ├── scripts/
│   │   ├── build-executable.test.js
│   │   ├── dev-server.test.js
│   │   ├── lint-eol.test.js
│   │   └── stage-frontend.test.js
│   ├── web/
│   │   └── csp.test.js           # The page's Content-Security-Policy
│   ├── docs/
│   │   └── references.test.js    # These documents and the README
│   └── test-harness/
│       └── tauri-app.test.js     # The hook client, against a fake app process
│
├── release/
│   └── release-smoke.test.js     # The release executable starts, loads its page and exits; it opens a file it is started with
│
├── real-input/               # Real keyboard and mouse input on Windows, run by npm run test:real-input
│   ├── runner.js             # Runs the Windows runner; an element's middle in physical pixels
│   ├── alt-f4.spec.js
│   ├── image.spec.js
│   ├── shortcuts.spec.js
│   └── typing.spec.js
│
└── integration/              # Integration tests (Playwright)
    ├── test-utils.js         # launchApp starts the test build and attaches over the DevTools protocol
    ├── tauri-app.js          # TauriApp, the client for the test build's hooks
    ├── test-http-server.js   # Serves src/ for the specs that run the page alone in Firefox
    ├── app-functionality/
    │   ├── app/
    │   │   ├── editor.spec.js
    │   │   ├── file-buttons.spec.js
    │   │   ├── load-images.spec.js
    │   │   ├── page-height.spec.js
    │   │   ├── page-resize.spec.js
    │   │   ├── reload.spec.js
    │   │   ├── search.spec.js
    │   │   └── session-save.spec.js
    │   ├── document/
    │   │   ├── code-block-trailing-paragraph.spec.js
    │   │   ├── details-collapse-toggle.spec.js
    │   │   ├── details-trailing-paragraph.spec.js
    │   │   ├── html-block.spec.js
    │   │   ├── html-image.spec.js
    │   │   ├── iframe.spec.js
    │   │   ├── inline-html.spec.js
    │   │   ├── toc-highlight.spec.js
    │   │   ├── toc-scroll.spec.js
    │   │   ├── underscore-emphasis.spec.js
    │   │   ├── view-mode-dropdown.spec.js
    │   │   └── view-mode-switch.spec.js
    │   └── toolbar/
    │       ├── bold-button.spec.js
    │       ├── checklist.spec.js
    │       ├── image.spec.js
    │       ├── italic-button.spec.js
    │       ├── list.spec.js
    │       ├── strikethrough-button.spec.js
    │       ├── subscript-button.spec.js
    │       ├── superscript-button.spec.js
    │       ├── table.spec.js
    │       ├── toolbar-active.spec.js
    │       ├── toolbar-tooltip.spec.js
    │       ├── source2-toolbar.spec.js
    │       └── source2-hotkeys.spec.js
    └── user-interaction/
        ├── content/
        │   ├── backspace-after-html-block.spec.js
        │   ├── backspace-heading.spec.js
        │   ├── code-block-enter.spec.js
        │   ├── code-block-language-tag.spec.js
        │   ├── code-block-source-edit.spec.js
        │   ├── cursor-typing-delimiters.spec.js
        │   ├── details-summary-input.spec.js
        │   ├── heading-input.spec.js
        │   ├── inline-image.spec.js
        │   ├── source-view-summary-edit.spec.js
        │   └── table-cell-edit.spec.js
        └── interaction/
            ├── click-outside-defocus.spec.js
            ├── cursor-scroll.spec.js
            ├── cursor-sync.spec.js
            ├── image-click-edit.spec.js
            ├── link-click-edit.spec.js
            ├── link-single-click.spec.js
            ├── linked-image-click-edit.spec.js
            ├── paste.spec.js
            ├── range-handling.spec.js
            ├── select-all.spec.js
            ├── source-view-editing.spec.js
            ├── source2-cursor-position.spec.js
            └── source2-roundtrip.spec.js
```

## Coding Conventions

### JSDoc Type Annotations

All functions, classes, and significant variables should have JSDoc:

```javascript
/**
 * Parses markdown text into a syntax tree.
 * @param {string} markdown - The markdown text to parse
 * @returns {SyntaxTree} The parsed syntax tree
 */
function parse(markdown) {
    // ...
}
```

### Class Structure

```javascript
/**
 * @fileoverview Description of this file.
 */

import { Dependency } from './dependency.js';

/**
 * Description of the class.
 */
export class MyClass {
    /**
     * @param {Type} param - Description
     */
    constructor(param) {
        /** @type {Type} */
        this.property = param;
    }

    /**
     * Description of method.
     * @param {Type} param - Description
     * @returns {Type} Description
     */
    methodName(param) {
        // Implementation
    }
}
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `SyntaxTree` |
| Functions | camelCase | `parseMarkdown` |
| Variables | camelCase | `nodeCount` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Private | underscore prefix | `_privateMethod` |
| Files | kebab-case | `syntax-tree.js` |
| CSS classes | kebab-case | `md-heading-marker` |

### Import/Export

Use ES Modules:
```javascript
// Named exports
export { ClassName };
export function utilityFunction() {}

// Named imports
import { ClassName, utilityFunction } from './module.js';
```

## Component Patterns

### Editor Pattern

The Editor class uses a coordinator pattern. It delegates concerns to
focused manager classes that receive the editor as a constructor argument:

```javascript
class Editor {
    constructor(container) {
        this.parser = new DFAParser();
        this.syntaxTree = null;
        this.sourceRenderer = new SourceRenderer(this);
        this.sourceRendererV2 = new SourceRendererV2(this);
        this.writingRenderer = new WritingRenderer(this);
        this.undoManager = new UndoManager();

        // Task managers
        this.cursorManager = new CursorManager(this);
        this.tableManager = new TableManager(this);
        this.inputHandler = new InputHandler(this);
        this.editOperations = new EditOperations(this);
        this.rangeOperations = new RangeOperations(this);
        this.clipboardHandler = new ClipboardHandler(this);
        this.eventHandler = new EventHandler(this);
        this.imageHelper = new ImageHelper(this);
        this.linkHelper = new LinkHelper(this);

        // Formatters (accessed via getFormatter())
        this.treeFormatter = new TreeFormatter(this);
        this.source2Formatter = new Source2Formatter(this);
    }

    /**
     * Returns the view-mode-specific formatter.
     * @returns {Formatter}
     */
    getFormatter() {
        return this.viewMode === `source2`
            ? this.source2Formatter
            : this.treeFormatter;
    }

    loadMarkdown(markdown) {
        this.syntaxTree = this.parser.parse(markdown);
        this.undoManager.clear();
        this.fullRenderAndPlaceCursor();
    }
}
```

Each manager accesses editor state via `this.editor` and calls back into
the editor's public API (e.g. `this.editor.recordAndRender()`,
`this.editor.placeCursor()`). The editor itself keeps the public API
surface, document state, and rendering methods.
```

### Parser Pattern

The parser uses a token-driven DFA. A character-level tokenizer produces a flat token stream, then the parser dispatches to block-specific sub-parsers based on the current token:

```javascript
class DFAParser {
    parse(markdown) {
        const tokens = tokenize(markdown);
        const tree = new SyntaxTree();
        const ctx = { tokens, pos: 0, line: 0 };

        while (ctx.pos < ctx.tokens.length && ctx.tokens[ctx.pos].type !== 'EOF') {
            if (ctx.tokens[ctx.pos].type === 'NEWLINE') {
                ctx.line++;
                ctx.pos++;
                continue;
            }
            const node = this._parseBlock(ctx);
            if (node) tree.appendChild(node);
        }
        return tree;
    }
}
```

### Renderer Pattern

Renderers convert syntax tree nodes to DOM:

```javascript
class SourceRenderer {
    render(syntaxTree, container) {
        container.innerHTML = '';
        for (const node of syntaxTree.children) {
            const element = this.renderNode(node);
            container.appendChild(element);
        }
    }

    renderNode(node) {
        switch (node.type) {
            case 'heading1':
                return this.renderHeading(node);
            case 'paragraph':
                return this.renderParagraph(node);
            // ...
        }
    }
}
```

## Event Handling

### Custom Events

Use CustomEvent for component communication:

```javascript
// Dispatch
const event = new CustomEvent('editor:selectionchange', {
    detail: { selection, node }
});
this.container.dispatchEvent(event);

// Listen
editor.container.addEventListener('editor:selectionchange', handleSelection);
```

### Backend Events

The page talks to the backend only through the bridge's `window.pageToBackendBridge`:

```javascript
// In the page
window.pageToBackendBridge.onMenuAction((action, ...args) => {
    handleAction(action, args);
});
```

In the backend, `ipc_handler::emit_menu_action` sends a `menu:action` event with the action and its arguments; the bridge queues it until the page has registered its handler. A command the page calls is a `#[tauri::command]` function in `ipc_handler.rs`, declared in `build.rs` and granted in `capabilities/default.json`.

## State Management

### Document State

The document state is the SyntaxTree:
- Single source of truth
- Immutable operations (create new nodes)
- Serializable to markdown

### UI State

UI state is managed locally:
- View mode in Editor
- Button states in Toolbar
- Selection in SelectionManager

### Undo State

Undo state is managed by UndoManager:
- Before/after content snapshots
- Unlimited history stack
- Batching for rapid changes

## Error Handling

### Graceful Degradation

```javascript
async function loadFile() {
    try {
        const result = await fileManager.load();
        if (result.success) {
            editor.loadMarkdown(result.content);
        }
    } catch (error) {
        console.error('Failed to load file:', error);
        // Show user-friendly message
    }
}
```

## CSS Architecture

### Custom Properties

Use CSS custom properties for theming:

```css
:root {
    --color-primary: #0d6efd;
    --spacing-md: 1rem;
    --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.button {
    color: var(--color-primary);
    padding: var(--spacing-md);
    font-family: var(--font-family);
}
```

### BEM-like Naming

```css
[data-node-id] { }        /* Block (any node with a node ID) */
.md-heading1 { }          /* Block type modifier */
.md-heading-marker { }    /* Element within context */
```

## Testing Guidelines

### Unit Tests

Test individual functions and classes:

```javascript
describe('DFAParser', () => {
    it('should parse heading level 1', () => {
        const parser = new DFAParser();
        const tree = parser.parse('# Title');
        assert.strictEqual(tree.children[0].type, 'heading1');
    });
});
```

### Integration Tests

Test complete user workflows:

```javascript
test('should allow typing in the editor', async () => {
    const editor = await page.locator('#editor');
    await editor.click();
    await page.keyboard.type('Hello');
    const content = await editor.innerText();
    expect(content).toContain('Hello');
});
```

## Adding New Features

### Adding a New Element Type

1. Add block dispatch case in `DFAParser._parseBlock()`
2. Create sub-parser method in `DFAParser`
3. Add `toMarkdown()` case in `SyntaxNode`
4. Add render method in `SourceRenderer`
5. Add render method in `WritingRenderer`
6. Add button config in `Toolbar.getButtonConfigs()` (if it should appear in the toolbar)
7. Add a Lucide SVG icon entry in `toolbar/icons.js`
8. Add a button color rule in `toolbar.css`
9. Add tests for parser and rendering
10. Update documentation

### Adding a New Preference

1. Add a default constant in `preferences-modal.js`
2. Add a nav link (`data-section`) and fieldset with controls
3. Add a load method (called from `open()`)
4. Add save logic that persists via `setSetting` and dispatches a custom event
5. Add CSS styles in `preferences.css`
6. Wire the custom event listener in `app.js` to update runtime state
7. Add tests if the preference has complex logic
