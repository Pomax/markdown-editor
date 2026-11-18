# Markdown Editor - Architecture Documentation

## Overview

This document describes the high-level architecture of the Markdown Editor application. It is intended for developers who need to understand, maintain, or extend the codebase.

## Technology Stack

- **Runtime**: Tauri 2: a Rust backend and the system webview (WebView2 on Windows, WebKit on macOS and Linux)
- **Language**: JavaScript (ES Modules) with JSDoc type annotations in the page; Rust in the backend
- **Type Checking**: TypeScript (`tsc`) via `jsconfig.json`, checking `.js` files
- **Linting / Formatting**: Biome and ESLint for JavaScript, `cargo fmt` for Rust
- **Testing**: Node.js native test runner (unit), `cargo test` (backend), Playwright (integration: Firefox for the page-only specs, the Tauri app over the DevTools protocol for the rest; real input on Windows: the test app's window driven by real keyboard and mouse input from the Windows runner)
- **Settings storage**: SQLite through `rusqlite` (bundled, so nothing is installed separately)
- **Packaging**: `tauri build`, driven by `scripts/build-executable.js`

## Process Model

The application is a Tauri app: one Rust process that owns the window, the menu, the file system and the settings, and a webview in which the editor page runs. The page reaches the backend only through the bridge, `src/tauri/preload.js`, which Tauri injects into the page before any page script runs. The bridge calls the backend's commands through Tauri's IPC, and the backend sends the page `menu:action` events and, for the few calls that need the page's answer, evaluates script in it.

```
┌──────────────────────────────────────────────────────────────┐
│                 Backend (Rust, src/tauri)                    │
│  ┌─────────┐ ┌───────────────┐ ┌─────────────────┐           │
│  │ main.rs │ │ ipc_handler.rs│ │ menu_builder.rs │           │
│  └─────────┘ └───────────────┘ └─────────────────┘           │
│  ┌─────────────────┐ ┌─────────────────────┐                 │
│  │ file_manager.rs │ │ settings_manager.rs │                 │
│  └─────────────────┘ └─────────────────────┘                 │
│  ┌───────────────────┐ ┌─────────────────────┐ ┌───────────┐ │
│  │ media_protocol.rs │ │ webview_settings.rs │ │ message_  │ │
│  └───────────────────┘ └─────────────────────┘ │ box.rs    │ │
│  ┌───────────────┐ ┌─────────────────┐         └───────────┘ │
│  │ image_path.rs │ │ web_contents.rs │                       │
│  └───────────────┘ └─────────────────┘                       │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         │ Tauri IPC and events (via the bridge, preload.js)
                         │ `media` protocol (local images, audio, video)
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                 Page in the webview (app.js)                 │
│    ┌── Editor ──────────────────────────────────────────┐    │
│    │  ┌────────────────┐  ┌──────────────────────────┐  │    │
│    │  │   DFAParser    │──│       SyntaxTree         │  │    │
│    │  └────────────────┘  └──────────────────────────┘  │    │
│    │  ┌─────────────────┐ ┌────────────────┐            │    │
│    │  │ WritingRenderer │ │ SourceRenderer │            │    │
│    │  └─────────────────┘ └────────────────┘            │    │
│    │  ┌───────────────────┐ ┌──────────────────┐        │    │
│    │  │SourceRendererV2   │ │ Source2Formatter │        │    │
│    │  └───────────────────┘ └──────────────────┘        │    │
│    │  ┌──────────────────┐ ┌─────────────┐              │    │
│    │  │ SelectionManager │ │ UndoManager │              │    │
│    │  └──────────────────┘ └─────────────┘              │    │
│    │  ┌───────────────┐ ┌──────────────┐                │    │
│    │  │ CursorManager │ │ TableManager │                │    │
│    │  └───────────────┘ └──────────────┘                │    │
│    │  ┌──────────────┐ ┌────────────────┐               │    │
│    │  │ InputHandler │ │ EditOperations │               │    │
│    │  └──────────────┘ └────────────────┘               │    │
│    │  ┌────────────────┐ ┌──────────────────┐           │    │
│    │  │RangeOperations │ │ ClipboardHandler │           │    │
│    │  └────────────────┘ └──────────────────┘           │    │
│    │  ┌──────────────┐ ┌─────────────┐ ┌────────────┐   │    │
│    │  │ EventHandler │ │ ImageHelper │ │ LinkHelper │   │    │
│    │  └──────────────┘ └─────────────┘ └────────────┘   │    │
│    └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌── Toolbar ──────────────────┐  ┌── MenuHandler ─────────┐ │
│  │  ┌────────────┐             │  │  ┌──────────────────┐  │ │
│  │  │ ImageModal │ (on demand) │  │  │ PreferencesModal │  │ │
│  │  └────────────┘             │  │  └──────────────────┘  │ │
│  │  ┌────────────┐             │  │  ┌────────────────┐    │ │
│  │  │ TableModal │ (on demand) │  │  │ WordCountModal │    │ │
│  │  └────────────┘             │  │  └────────────────┘    │ │
│  └─────────────────────────────┘  └────────────────────────┘ │
│                                                              │
│          ┌─────────────────┐  ┌───────────────────┐          │
│          │ KeyboardHandler │  │ TableOfContents   │          │
│          │ (source2 textarea) └───────────────────┘          │
│          └─────────────────┘                                 │
│                                                              │
│              ┌────────┐  ┌───────────┐                       │
│              │ TabBar │  │ SearchBar │                       │
│              └────────┘  └───────────┘                       │
└──────────────────────────────────────────────────────────────┘
```

## Backend Components

The backend lives in `src/tauri`, built by the `Cargo.toml` at the project root, with `tauri.conf.json` beside it. Each module, and the bridge:

| File | Responsibility |
|------|----------------|
| `main.rs` | Entry point: registers the commands, the `media` protocol, the menu and the window events; creates the window hidden, sizes it from the saved bounds and shows it on the first page load; delivers a file named on the command line; restores and saves the open files of a session; runs the close flow; on macOS, opens the window again when the app is reopened from the Dock without one; honours `TESTING` and `STARTUP_TIMING` |
| `ipc_handler.rs` | The commands the bridge invokes (`file_*`, `settings_*`, `document_*`, `view_*`, `element_*`, `image_*`, `path_to_relative`, `dialog_confirm`, `app_reload`, `context_menu`, `bridge_ready`, `web_contents_reply`); file dialogs and message boxes |
| `file_manager.rs` | The current file, the unsaved flag, the recent files list, the Save As name, the HTML export paths and stylesheet, and reading a file as UTF-8 |
| `settings_manager.rs` | The settings: one JSON value per key in an SQLite database in the app's data folder |
| `menu_builder.rs` | The application menu and the context menu, built first as data and then as Tauri menus; a refresh changes only the native items that differ; each item runs its action; Images > Gather |
| `message_box.rs` | The texts and buttons of the app's message boxes |
| `image_path.rs` | The plain file name check, image renames, relative image paths and percent-decoding |
| `media_protocol.rs` | The `media` protocol, through which the page loads local images, audio and video (see Security) |
| `web_contents.rs` | Holds events and script evaluations for the page until the bridge says it is ready, and matches each evaluation to its reply |
| `webview_settings.rs` | The navigation, new-window and permission limits; the WebView2 settings and browser arguments; on Windows, menu shortcuts and Alt plus a menu letter while the page has focus, the page's `alert` and `confirm` as the app's message box, Reload bypassing the cache, and Inspect Element: WebView2's own context menu requests are answered without showing its menu, and the one for the right-click sent at the inspected point runs WebView2's Inspect command |
| `test_hooks.rs` | Only in builds with the `test-hooks` feature: the channel on standard input through which the Playwright specs drive the app |
| `build.rs` | The build script: declares the app's commands, so each is refused unless the capability in `capabilities/` grants it, and points Tauri at the capabilities and the window icon in `src/tauri` |
| `bin/win-runner.rs` | Not part of the app: the Windows runner the real-input tests use, a second binary of the crate that finds the app's window by process id, brings it to the front, presses keys, types and clicks through `SendInput`, and reads the window's title, whether the menu bar is active and the open menu's items |
| `preload.js` | The bridge (below) |

### Window, session and close flow (`main.rs`)

- The window is created hidden, given the saved bounds (position as ratios of the work area, size in DIPs, maximized state) or its starting size, kept on screen, and shown on the first page load. Its page is at least 998 pixels wide, the width the toolbar needs at full size.
- With no file on the command line, the open files of the last session are restored on the first page load: the first into the page's own tab, the rest as `file:loaded` menu actions, then `view:switchFile` and `session:restore` so the page can put back the cursor, the active ToC heading and the scroll position. Help > Reload restores them again after the reload.
- Closing the window first has the page save its open files; with unsaved changes it asks Save, Save As, Discard or Cancel.
- Under `TESTING` the window is never shown, unless a `test-hooks` build also has `TESTING_VISIBLE` (the real-input tests set it), and the open files are not restored. With `STARTUP_TIMING` naming a file, the time of the first page load is written to it and the app exits.

### Menus (`menu_builder.rs`)

- **File**: New, Load, Open Recent, Save, Save As, Export > HTML (writes `<name>.html` and `default.css` next to the document; when `<name>.html` exists, it first asks Replace or Cancel, and Cancel writes nothing), Close, Word Count, Copy File Path, Exit
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All, Images > Gather, Preferences
- **View**: Writing View (`Ctrl+1`), Source View (`Ctrl+2`), the open files with a checkmark on the active one
- **Help**: Reload, Debug, About
- **Context menu** (right-click where the page did not handle it): Copy, Cut, Paste, Inspect Element (DevTools on the element under the pointer; on macOS and Linux it opens DevTools)

Menu actions reach the page as `menu:action` events. Cut, Copy and Paste send their keystroke to the webview, which runs the native clipboard command and so fires the DOM clipboard events the editor's `ClipboardHandler` handles. The six Edit shortcuts the page handles itself are not registered as menu accelerators on Windows and Linux, so they are not handled twice.

## Bridge (`src/tauri/preload.js`)

- Injected by Tauri before any page script, on the app's own origin only. It uses `window.__TAURI_INTERNALS__`; Tauri's global API object stays off.
- Defines `window.pageToBackendBridge` (read-only), through which the page calls the backend, with `toDisplayUrl` and `fromDisplayUrl`, which turn a local file reference into a `media` URL and back.
- Subscribes to `menu:action` before the page runs and queues its messages until the page registers its handler, then tells the backend it is ready.
- Sets the window title to `document.title` whenever it changes.
- Turns a right-click the page did not handle into the app's context menu at the pointer, except the one the backend sends for Inspect Element, which it lets through to the webview.
- Turns files dropped on the window (Tauri's drag-drop event) into a DOM `drop` event at the drop point, with `File` objects whose paths `getPathForFile` returns.
- The full API surface is declared in `src/types.d.ts`.

## Page Components

### App (`app.js`)

The page's entry point. Wires together all page components:

- Creates Editor, Toolbar, TabBar, TableOfContents, SearchBar, PreferencesModal, WordCountModal
- Manages multi-file document state (content, cursor, undo/redo stacks per tab)
- Handles tab creation, switching, and closing (with unsaved-changes prompts)
- Registers the bridge handler for menu actions
- Loads persisted settings and applies them to the editor
- Listens for custom events from modals (e.g. `toc:settingsChanged`, `imageHandling:settingsChanged`)
- Sends the open-files list to the backend so the View menu stays in sync
- Exposes `editorAPI`, which the backend's script evaluations read editor state through
- Handles `session:restore` events to restore cursor position, ToC heading highlight, and scroll position for all tabs after a close-and-reopen. Active tab is restored live; background tabs are patched in `_documentStates`.
- **Tab switching** preserves the DOM container and syntax tree — nothing is re-rendered. `_restoreState` restores `treeRange` (text selection) and sets `_isRendering = true` around `focus()` + `placeSelection()`/`placeCursor()` to suppress the `selectionchange` handler. If a `treeRange` exists, `placeSelection()` restores the full selection; otherwise `placeCursor()` places a collapsed caret. **Session restore** (app relaunch) rebuilds the DOM from scratch and uses `fullRenderAndPlaceCursor()`. The cursor position is the single source of positional truth on restore — the view scrolls to the cursor's node, and the persisted ToC heading highlight is applied via `_lockedHeadingId` with `_programmaticScroll` suppressing scroll-based recalculation.

### Editor

Core editing coordinator. The Editor class owns the document
state and public API, but delegates operational concerns to focused manager
classes. Each manager receives the editor as a constructor argument and
accesses state via `this.editor`.

**Manager classes:**

| Class | File | Responsibility |
|-------|------|----------------|
| `CursorManager` | `managers/cursor-manager.js` | DOM ↔ tree cursor synchronization and placement |
| `TableManager` | `content-types/table/table-manager.js` | Table cell editing, navigation, markdown building |
| `InputHandler` | `handlers/input-handler.js` | Keyboard and `beforeinput` event dispatch |
| `EditOperations` | `edit-operations/index.js` | Tree-level edits: insert, backspace, delete, enter |
| `RangeOperations` | `range-operations.js` | Selection range deletion and Ctrl+A |
| `ClipboardHandler` | `handlers/clipboard-handler.js` | Cut and copy operations |
| `EventHandler` | `handlers/event-handler.js` | Click, focus, blur, selectionchange, drag/drop (images and markdown files) |
| `ImageHelper` | `content-types/image/image-helper.js` | Image modal, insert/update, path rewriting |
| `LinkHelper` | `content-types/link/link-helper.js` | Link edit modal |

**Additional editor utilities:**

| Module | File | Purpose |
|--------|------|---------|
| `offset-mapping` | `offset-mapping.js` | Pure functions for raw ↔ rendered offset mapping (used by `CursorManager`) |
| `crc32` | `crc32.js` | CRC32 digest for content-change detection |
| `cursor-persistence` | `managers/cursor-persistence.js` | Cursor position ↔ absolute source offset conversion (`cursorToAbsoluteOffset`, `absoluteOffsetToCursor`) |
| `page-resize` | `page-resize.js` | Page resize handles for the editor (both source and writing modes) |
| `syntax-highlighter` | `syntax-highlighter/index.js` | Per-language syntax highlighting for source view |
| `source2-formatter` | `formatters/source2-formatter.js` | Textarea-based formatting for source2 mode (inline formats, block types, lists, images, tables) |
| `tree-formatter` | `formatters/tree-formatter.js` | Tree-based formatting delegation wrapper for writing mode |
| `keyboard-handler` | `handlers/keyboard-handler.js` | Keyboard shortcut handler for source2 textarea (21 shortcuts) |

The Editor itself keeps:
- Document state (`syntaxTree`, `treeRange`, `viewMode`) — cursor state lives on `syntaxTree.treeCursor`
- Rendering methods (`fullRender`, `renderNodes`, `fullRenderAndPlaceCursor`)
- Dispatches `editor:renderComplete` custom event after `fullRender()` and `renderNodes()`, used by SearchBar to re-apply highlights
- Tree helpers (`getCurrentNode`, `getCurrentBlockNode`, `getBlockNodeId`, `getSiblings`, `getNodeIndex`) — `getCurrentNode()` returns the inline node when the cursor is inside formatting; `getCurrentBlockNode()` always returns the block-level parent
- Markdown helpers (`buildMarkdownLine`, `getPrefixLength`)
- Public API consumed by the toolbar, IPC handlers, and tests

### SearchBar

Floating draggable search panel for finding text in the editor:
- Opened via Ctrl+F (Cmd+F on macOS); closed via Escape or the close button
- Supports plain text and regex search modes, with a case-sensitivity toggle
- Plain text search requires a minimum of 2 characters
- In source view, searches against `syntaxTree.toMarkdown()` (raw markdown)
- In writing view, plain text search is confined to per-node boundaries using `SyntaxNode.toBareText()`; regex search uses `syntaxTree.toBareText()` across the full document
- Builds an offset map to translate flat-document match positions back to individual syntax-tree nodes for DOM highlighting
- Highlights matches using `<mark>` elements injected via TreeWalker-based text node splitting
- Re-applies highlights on `editor:renderComplete` events (fired after re-renders)
- Initial match selection starts at the match closest to the current cursor position
- Navigation via Enter (next), Shift+Enter (previous), and prev/next buttons
- Scrolls to the active match using `scrollIntoView({ behavior: 'instant' })`
- Draggable via mouse (repositions with CSS `left`/`top`); position resets on each open
- Appended to the `#app` element, styled in `search.css`

### DFAParser

Converts markdown text to a syntax tree using a token-driven DFA (no regular expressions):
- Character-level tokenizer (`dfa-tokenizer.js`) produces a flat token stream
- Block-level parsing (headings, paragraphs, code blocks, blockquotes, lists, images, tables, horizontal rules)
- Token-based recognition with ordered priority
- Position tracking (start/end line) for each node
- Multi-line block handling (code blocks, tables)

#### HTML block handling

The parser recognises several categories of HTML blocks, each with specialised handling:

- **Known block tags** (`HTML_BLOCK_TAGS`): `div`, `section`, `details`, `summary`, `style`, etc. Parsed as multi-line `html-block` nodes with child nodes for their content.
- **Void elements** (`VOID_HTML_ELEMENTS`): `br`, `hr`, `img`, `input`, `link`, `meta`, `source`, `wbr`, etc. These have no closing tag — the parser stores the full opening tag in `attributes.openingTag` and sets `attributes.closingTag` to `''`.
- **Raw content tags** (`RAW_CONTENT_TAGS`): `script`, `style`, `textarea`. Content between opening and closing tags is stored verbatim in `attributes.rawContent` (array of lines) without being parsed as markdown.
- **Inline-only tags** (`INLINE_ONLY_TAGS`): `strong`, `em`, `sub`, `sup`, `mark`, `u`, `b`, `i`, `del`, `s`. These are never promoted to block-level; they remain inline formatting within their parent node.
- **Unknown tags**: Any tag not in the above sets is detected via `_isUnknownHtmlTag()` (token-based, no regex look-ahead) and parsed as a block-level `html-block`.
- **HTML comments** (`<!-- ... -->`): Detected by `_isHtmlCommentStart()` (checks `LT BANG DASH DASH` tokens) and consumed through `-->` by `_parseHtmlComment()`. Stored as `html-block` with `tagName: '!--'` and the full comment text in `attributes.openingTag`.

In writing mode, HTML comments, void elements, and raw content tags are hidden (`element.hidden = true`) since they have no visual representation. In source mode they are displayed normally.

### SyntaxTree / SyntaxNode

Data structure for parsed documents:
- `SyntaxTree`: root container with `children` array of `SyntaxNode`
- `SyntaxNode`: type, content, attributes, children, unique ID, position info
- `toMarkdown()`: serializes back to markdown text
- `toBareText()`: returns visible/rendered text with markdown syntax stripped (heading prefixes, emphasis delimiters, link URLs, image syntax, etc. removed). Used by search in writing view.
- `clone()`: deep cloning for undo/redo snapshots
- Node lookup by ID or position- `updateUsing(newTree)`: structural tree diffing — matches children between old and new trees using `matchChildren()` (exact match first, then fuzzy via `contentSimilarity()`), applies changes via `updateMatchedNode()` (preserving node identity/IDs for unchanged or edited nodes), and inserts new nodes. Used when switching from source2 back to writing view to preserve node IDs across the round-trip.- `getPathToCursor()` / `setCursorPath(path)`: serialize and restore cursor position as an index path (array of child indices + character offset). Used for session persistence — node IDs are ephemeral but tree structure is deterministic for the same document.
- `getPathToNode(nodeId)` / `getNodeAtPath(path)`: convert between node IDs and index paths. Used to persist the active ToC heading across sessions.

#### Inline children model

Block-level nodes that contain inline formatting (paragraphs, headings, blockquotes, list items) automatically build inline child nodes when their `content` is set. The `content` property is a getter/setter backed by a `_content` field — setting it triggers `buildInlineChildren()`, which tokenizes the raw markdown text via `InlineTokenizer` and converts the resulting segments into child `SyntaxNode` instances.

Inline node types: `text`, `inline-code`, `inline-image`, `bold`, `italic`, `bold-italic`, `strikethrough`, `link`, and HTML inline tags (e.g. `sub`, `sup`). Container types like `bold` and `link` can have their own inline children recursively.

Helper methods on `SyntaxNode`:
- `isInlineNode()` — returns `true` if this node is an inline child (`getBlockParent() !== this`).
- `getBlockParent()` — walks `.parent` up to the nearest block-level ancestor (an `INLINE_CONTENT_TYPES` node).

In writing mode, inline formatting elements in the DOM carry `data-node-id` matching their inline child node IDs. The cursor manager (`_mapDOMPositionToTree`) detects these and records the inline node as `treeCursor.nodeId` while computing offset relative to the block parent. Editing operations use `getCurrentBlockNode()` to work on the block's `content` string; the toolbar uses `getCurrentNode()` (the inline node) to detect active formats by walking `.parent`.

### Renderers

#### SourceRenderer (legacy)
Displays markdown with syntax highlighting:
- Shows literal markdown syntax
- Color-codes different element types (headings, code, emphasis, etc.)
- Uses the `highlight()` function from `syntax-highlighter` for inline syntax coloring
- Supports incremental rendering via `renderNodes()` (same interface as WritingRenderer)
- Handles bare-text html-block children (e.g. `<summary>text</summary>`) by re-rendering the parent html-block
- Maintains editability
- **Code-block source edit mode**: when a code block receives focus, the renderer calls `node.enterSourceEditMode()` to store the full markdown (fences + language + content) in `sourceEditText` and renders it as a single editable `<div>`. On defocus, `editor.finalizeCodeBlockSourceEdit(node)` re-parses the text and exits source edit mode. This allows editing fences and the language tag directly in source view.
- **Status**: This renderer is being replaced by SourceRendererV2 and is no longer in the view mode cycle.

#### SourceRendererV2
Textarea-based source editing surface (the active source view):
- Renders the full document as plain markdown text inside a `<textarea>` element — no per-node DOM elements, no node ID correspondences
- A `<pre>` mirror element overlaps the textarea with identical styling for pixel-accurate coordinate lookups via the Range API (used by `getCaretRect()` for scroll-preserving view switches)
- Mirror sync is lazy: a `mirrorDirty` flag is set on `input` events; the actual `pre.textContent` update is deferred to `getCaretRect()`
- `fullRender(syntaxTree, container)` serializes the tree via `toMarkdown()`, sets the textarea value, and records the original markdown for change detection
- `hasChanges()` compares current textarea content against the original markdown loaded in `fullRender()`, used to skip reparsing when the user made no edits
- `getContent()` returns the current textarea value
- `getCaretRect(offset)` returns the bounding rect of the caret at a given character offset, used for scroll-preserving view switches
- Toolbar formatting is handled by `Source2Formatter` (accessed via `editor.getFormatter()`), not by the renderer
- Keyboard shortcuts are handled by `KeyboardHandler`, which listens on the textarea's `keydown` event

#### WritingRenderer
WYSIWYG-style display:
- Renders every block as the HTML element its markdown stands for, with `data-node-id` and the `md-<type>` class on that element itself: `<h1>` to `<h6>`, `<p>` (also for images, as `<p class="md-image"><img></p>`), `<blockquote>` containing a `<p class="md-content">`, `<pre class="md-code-block">` containing `<code class="md-content">`, `<table>`, `<hr>`, and `<li>`. HTML blocks keep a wrapper `<div class="html-element">`.
- `renderBlockSequence()` renders a sibling sequence, grouping consecutive `list-item` nodes into `<ul>`/`<ol>` elements through `layoutListRun()`: an item indented further than the previous one opens a nested list inside the previous `<li>`, a change between ordered and unordered at the same depth starts a sibling list. Numbering comes from the `<ol>` itself. Checklist items carry the `md-checklist-item` class.
- Incremental rendering (`renderNodes()`) replaces an updated `<li>` in place when its list type and depth are unchanged, moving its nested list into the new element; any other change touching a list item (added, removed, re-indented, converted) re-renders the whole run of list items it belongs to through `rebuildListRegions()`.
- Cursor placement, range selection and search highlighting read a block's own text through `getContentElement()` and `createOwnTextWalker()` (exported from `cursor-manager.js`). The walker skips nested lists, since a parent `<li>` also contains its nested items' text.
- Hides syntax when not focused
- Shows formatted output (rendered images, tables, horizontal rules, etc.)
- Reveals raw markdown syntax on element focus (click to edit)
- On defocus (click outside the editor page), nodes revert to their unfocused presentation (e.g. code blocks switch from plain text back to syntax-highlighted); clicking back in re-renders the node as focused and restores the cursor
- Supports click-to-focus on non-text elements like images and horizontal rules
- **Code-block language tags**: renders two `<span data-lang>` elements (top-right and bottom-right) showing the language (or a dim "lang" placeholder when empty). Bottom tag only visible when the block has >= 20 lines (`.tall` class). Mousedown guard prevents caret movement; click opens the `CodeLanguageModal` via `EventHandler._openCodeLanguageModal()`.

### UndoManager

Unlimited undo/redo history:
- Maintains undo and redo stacks of markdown snapshots
- Batches rapid changes (debounced)
- No memory limit

### SelectionManager

Tracks and manipulates text selection:
- Converts between DOM positions and logical tree cursor positions
- Tracks current node at cursor
- Dispatches `editor:selectionchange` custom event with `bubbles: true` so ancestor elements (e.g. the toolbar listening on `document`) can observe selection changes across tabs

### Range Handling

When the user has a non-collapsed selection (highlighted text), the editor
tracks it as a `TreeRange`:

```
TreeRange = { startNodeId, startOffset, endNodeId, endOffset }
```

Key behaviors:
- **Typing/pasting with selection**: deletes the selected range first, then inserts
- **Backspace/Delete with selection**: deletes the selected range
- **Ctrl+A**: context-restricted to the current node (not the whole document)
- **Cut**: writes raw markdown to clipboard, then deletes the range
- **Copy**: writes raw markdown to clipboard without mutation
- **Cross-node deletion**: trims endpoints, removes intermediates, merges remaining text

### InlineTokenizer

Tokenizes inline markdown formatting within a line of text:
- Splits text into segments of plain text and formatting delimiters
- Handles bold, italic, bold-italic (`***`), strikethrough, code, links, images, subscript, superscript
- Treats `***` as an atomic bold-italic delimiter (single open/close token pair)
- Treats four or more consecutive asterisks (`****`+) as plain text
- Used by `SyntaxNode.buildInlineChildren()` to populate inline child nodes, by `SyntaxNode.toBareText()` for text extraction, and by the `highlight()` function in `syntax-highlighter` for inline syntax coloring

### BaseModal

Abstract base class for modal dialogs (`modal/base-modal.js`):
- Shared open/close lifecycle and backdrop handling
- Extended by `ImageModal`, `TableModal`, `LinkModal`, `CodeLanguageModal`, `PreferencesModal`, `WordCountModal`

### CodeLanguageModal

Modal for editing a code block's language tag (`code-language/code-language-modal.js`):
- Single text input pre-filled with the current language (or empty for bare code blocks)
- Opened by `EventHandler._openCodeLanguageModal()` when the user clicks a `[data-lang]` span in writing view
- Styled in `code-language.css`
- The caller saves and restores both `treeCursor` and `treeRange` around the dialog open/close to prevent the focus-steal selectionchange from corrupting editor state

### LinkModal

Modal for inserting and editing links (`link/link-modal.js`):
- Set link text and URL
- Opened by `LinkHelper` when editing or inserting a link
- Styled in `link.css`

### Toolbar

WYSIWYG formatting toolbar using a CSS grid layout with three areas (`left`, `center`, `right`):
- **File buttons** (left-aligned): New File, Open File, Save File — wired to existing file events (`file:new`, `file:loaded`, `file:save`)
- **Content toolbar** (centred): formatting and element-type buttons
- Lucide SVG icons with per-button coloring
- Context-aware button visibility (buttons only shown when applicable to current element type)
- Element type buttons (H1–H4, paragraph, blockquote, code block)
- Format buttons (bold, italic, strikethrough, inline code, link, image, table)
- List buttons (unordered, ordered, checklist)
- View mode dropdown selector
- Keyboard shortcut indicators in tooltips
- Always shown at full size; the window's page is at least as wide as the toolbar row needs

### TableOfContents

Sidebar showing a navigable document outline:
- Extracts h1–h4 headings from the syntax tree
- Renders a nested, clickable tree of links
- Scrolls the editor to the clicked heading
- Auto-refreshes via MutationObserver when the document changes
- Supports show/hide toggle and left/right positioning
- Resizable width via drag handle, persisted to settings

### PreferencesModal

Settings dialog for user preferences:
- Sidebar navigation with section links
- Sections: Default View, Page Width, Margins, Colors, Table of Contents, Image Handling, Content
- Image Handling: "Ensure local paths" checkbox (auto-rewrites downstream image paths to relative form)
- Content: "Highlight active element" (on by default; it only toggles the body's `with-highlight` class, and every writing-view rule for the block the cursor is in sits inside `body.with-highlight` in `writing-view.css`), "Load `<details>` closed", "Enable `<style>` elements in document"
- Reads and writes settings through the bridge to the backend's settings
- Applies CSS custom property changes immediately on save
- Dispatches custom events so `app.js` can update runtime state

### ImageModal

Modal for inserting and editing images:
- Browse for image file
- Set alt text and optional link URL
- Set optional `class` and `style` attributes; an image with either one is written as an HTML `<img>` tag, and as markdown `![alt](src)` when both are empty
- Rename image file on disk
- Shows live image preview

### TableModal

Modal for inserting and editing tables:
- Set row and column counts
- Edit cell contents in a grid
- Generates markdown table syntax

### WordCountModal

Modal displaying document statistics:
- Total word count
- Word count excluding code blocks and inline code

### TabBar

Bottom tab bar for multi-file editing:
- Displays one tab button per open document
- Active tab is visually highlighted; modified tabs show a dot indicator
- Click to switch tabs; close button on each tab (with unsaved-changes prompt)
- Tooltips show the full absolute file path
- Disambiguates tabs with identical filenames by appending the minimum parent directory path (e.g. "README.md — docs")
- Exports `getDisambiguatedLabels()` utility used by both the tab bar and the View menu

## Data Flow

### Document Loading

```
User clicks File → Load
       │
       ▼
Menu item → file_load in the backend → file dialog
       │
       ▼
Returns { content, filePath } to the page
       │
       ▼
MenuHandler dispatches 'file:loaded' event
       │
       ▼
App: reuse pristine tab or create new tab
       │
       ▼
Editor.loadMarkdown()
       │
       ▼
DFAParser.parse() → SyntaxTree
       │
       ▼
rewriteImagePaths() (async, if ensureLocalPaths enabled)
       │
       ▼
Renderer.render() → DOM
       │
       ▼
App._notifyOpenFiles() → view_open_files_changed → View menu update
```

### User Input

```
User types a character
       │
       ▼
InputHandler.handleBeforeInput() / handleKeyDown()
       │
       ▼
EditOperations updates current node content
       │
       ▼
UndoManager.recordChange()
       │
       ▼
Re-parse affected node if needed
       │
       ▼
Renderer.render()
```

### Settings Change

```
User opens Edit → Preferences
       │
       ▼
PreferencesModal loads current settings through the bridge
       │
       ▼
User changes values and clicks Save
       │
       ▼
PreferencesModal saves through the bridge (settings_set)
       │
       ▼
Dispatches custom event (e.g. imageHandling:settingsChanged)
       │
       ▼
App.js listener updates Editor properties
       │
       ▼
CSS custom properties updated → immediate visual change
```

## View Modes

### Source View (source2)

- Full-document textarea containing the raw markdown
- No per-node DOM elements — the textarea is the entire editing surface
- Toolbar formatting and keyboard shortcuts work via `Source2Formatter` and `KeyboardHandler`
- On switch back to writing, the textarea content is parsed into a new tree and merged into the existing tree via `updateUsing()`, preserving node IDs for unchanged nodes
- A `hasChanges()` guard skips reparsing entirely when the user made no edits
- Cursor position is preserved across view switches using `cursorToAbsoluteOffset` / `absoluteOffsetToCursor`
- Scroll position is preserved using `getCaretRect()` coordinate lookups

### Source View (legacy)

- Displays raw markdown with syntax highlighting
- All markdown syntax is visible
- Syntax characters are styled with distinct colors
- No longer in the view mode cycle — being replaced by source2
- Best for users who know markdown

### Writing View

- Hides markdown syntax for unfocused elements
- Shows formatted preview (rendered images, tables, horizontal rules)
- Reveals syntax only for the active element
- Click any element (including non-text elements like images) to focus and edit
- Best for distraction-free writing

## Security

### Threat model

Every document is untrusted input, and its scripts are assumed to run in the editor page: today through same-origin frames a document can contain, in future through script support. Nothing in the app may rely on document scripts not running, and anything a script in the page can reach counts as reachable by a document.

### What a page script can reach

Through the bridge, a page script can do what the page itself needs: read any file (`loadFilePath`); make any path the save target (`notifyOpenFiles`) and write it (`saveFile`); write `<name>.html` (an existing one only once the user chooses Replace) and overwrite `default.css` in that file's folder (`exportHtml`); rename any file (`renameImage`, which refuses a new name that is not a plain file name); and queue any files to open at the next start (`setSetting('openFiles', ...)`).

### Decisions

- **Capabilities**: Tauri enforces the boundary in capabilities and in the commands' own checks. The capability grants the `main` window, on the app's own origin only (and the dev server's in dev builds), exactly: event listen and unlisten, window set-title, and the app's own commands. The app's commands are declared in an app manifest in `build.rs`, so each is refused unless granted. There is no `core:default` and no plugin permission at all; the dialog, clipboard and opener plugins are called from Rust only. Tauri's global API object (`withGlobalTauri`) stays off, and the bridge installs itself only on the app's own origin.
- **Navigation**: the main frame can navigate only to the app's own pages (and the dev server in dev builds), so a link or form in an embedded frame cannot replace the editor with a remote page.
- **New windows**: a `window.open`, or `target=_blank` in embedded content, never opens an app window. An `http:` or `https:` URL goes to the system browser, opened from Rust; anything else is refused.
- **Permissions**: every permission request (camera, microphone, location, notifications, clipboard read and the like) is denied without a prompt.
- **Fullscreen**: the page is served with `Permissions-Policy: fullscreen=()` (`app.security.headers` in `tauri.conf.json`, and the dev server's responses), so a fullscreen request from the page or from any frame in a document is refused and nothing goes fullscreen; a `<video>`'s controls show no fullscreen button.
- **The `media` protocol**: local files reach the page only through the app's own `media` protocol (`http://media.localhost/<encoded path>` on Windows, `media://localhost/<encoded path>` elsewhere), not Tauri's asset protocol, which stays off. It serves files with an image, audio or video extension only; every response carries its `Content-Type`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so a served SVG or any other file cannot run script; it answers byte-range requests so media can seek; and it sends no CORS header, so a page script cannot read a file's bytes. The cost: an image file without a known image extension does not load.
- **Media sources in documents**: the page turns local image sources, and the `src` and `poster` of `<video>` and `<audio>`, into `media` URLs through the bridge's `toDisplayUrl`. `<iframe>` and `<object>` sources are left as written, so a document cannot frame a local file.
- **Iframe sandbox**: an `<iframe>` a document creates with content that would share the page's origin (`srcdoc`, no `src`, or a `src` that is relative, `about:`, `blob:`, `javascript:` or on the app's origin) gets a `sandbox` without `allow-same-origin`, keeping the document's other sandbox tokens, or `allow-scripts allow-forms allow-popups` when it gave none. Its scripts then run in an opaque origin and cannot reach `parent.pageToBackendBridge`. Cross-origin `http:` and `https:` iframes stay as written.
- **Content-Security-Policy**: the page's own meta tag is the policy (Tauri's CSP injection is off): a base policy, plus `connect-src 'self' ipc: http://ipc.localhost` for Tauri's IPC, and the `media` protocol's sources in `img-src` and a new `media-src`. Its `script-src https: http:` is what the `srcdoc` path uses, and with the sandbox above it no longer reaches the bridge.
- **Test-only surfaces**: the standard-input hooks, the DevTools port and `TESTING_VISIBLE` exist only in builds with the `test-hooks` feature. In a release build DevTools open only from F12 or Help > Debug.
- **Dev server**: `npm start`'s dev server listens on every interface, so while it runs `src/` can be read from the local network.
- Tauri's isolation pattern is not used: it can check IPC payloads, but cannot tell the bridge's calls from a document script's.

### Before document scripts may run

These have to change before documents may run scripts on purpose:

- The paths the backend trusts from the page must become paths the backend issued itself (from dialogs, the command line, recent files, drops and session restore), and `copy-file-path.spec.js`, which hands the backend a path it never issued, must change to match.
- Document content has to render in a sandboxed frame that has no bridge.
- The CSP's `script-src` must drop `https:` and `http:`.

## Build & CI

- **Local builds**: `npm run build` lints and runs `scripts/build-executable.js` for the current platform; `npm run dist:win`, `dist:mac` and `dist:linux` run the same script for a named platform. The script runs `tauri build` and copies the result to `dist/` as `Markdown-Editor-<version>-<os>.<ext>`: on Windows the release `.exe` itself (the page is embedded in it, and it uses the system's WebView2 runtime, so it starts in place with nothing to unpack), on macOS the `.dmg`, on Linux the `.AppImage`. Each platform's file is built on that platform.
- **Version**: `package.json` holds the version. `tauri.conf.json` reads it from there, and `npm version <version>` runs `scripts/sync-cargo-version.js`, which writes it into `Cargo.toml` and `Cargo.lock`; `cargo-config.test.js` fails if they differ.
- **Release check**: `node --test test/release/release-smoke.test.js` starts the built Windows `.exe` without a window and checks it loads its page and exits, and that started with a markdown file it opens it (its window title, read through the Windows runner, names the file).
- **CI**: `.github/workflows/validate.yml` runs on pull requests to `main`: on Windows `npm test` in full (the integration specs attach to WebView2, which only Windows has), on macOS and Linux the lint, unit and Rust tests. `.github/workflows/build.yml` runs on a version tag: it builds each platform's file with `npm run dist:win`, `dist:mac` and `dist:linux` and publishes them as a GitHub release. Every job installs the stable Rust toolchain, and the Linux jobs install WebKitGTK and the other packages Tauri needs. `test/unit/ci/workflows.test.js` checks the workflows say so; they have not been run on GitHub.
