/// <reference path="../../types.d.ts" />

import { crc32 } from './editor/crc32.js';
import { cursorToAbsoluteOffset } from './editor/managers/cursor-persistence.js';
import { Editor } from './editor/index.js';
import { initPageResizeHandles } from './editor/page-resize.js';
import { KeyboardHandler } from './editor/handlers/keyboard-handler.js';
import { MenuHandler } from './editor/handlers/menu-handler.js';
import {
  applyColors,
  applyHighlightActiveElement,
  applyMargins,
  applyPageWidth,
} from './utility/preferences/preferences-modal.js';
import { SearchBar } from './utility/search/search-bar.js';
import { TabBar, getDisambiguatedLabels } from './utility/tab-bar/tab-bar.js';
import { TableOfContents } from './utility/toc/toc.js';
import { Toolbar } from './utility/toolbar/toolbar.js';
import { AppData } from './editor/types.js';

/**
 * Main application class.
 * Coordinates all editor components.
 */
class App extends AppData {
  constructor() {
    super();
  }

  /**
   * Initializes the application.
   */
  async initialize() {
    // Get container elements
    const editorContainer = document.getElementById(`editor`);
    const toolbarContainer = document.getElementById(`toolbar-container`);
    const tocContainer = document.getElementById(`toc-sidebar`);

    if (!editorContainer || !toolbarContainer) {
      console.error(`Required container elements not found`);
      return;
    }

    // The scroll container is `#editor-container`; each tab will
    // get its own contenteditable div inside it.
    this.scrollContainer = /** @type {HTMLElement} */ (editorContainer.parentElement);

    // Initialize editor with the original contenteditable div
    this.editor = new Editor(editorContainer);
    await this.editor.initialize();
    await this.loadStyleElementsSetting();

    // Initialize page resize handles (writing mode only).
    // Store the retarget function so tab switches can update the handles.
    this.retargetResizeHandles = initPageResizeHandles(editorContainer);

    // Initialize toolbar
    this.toolbar = new Toolbar(toolbarContainer, this.editor);
    this.toolbar.initialize();

    // Initialize handlers
    this.menuHandler = new MenuHandler(this.editor, this.toolbar);

    this.keyboardHandler = new KeyboardHandler(this.editor);
    this.keyboardHandler.initialize();

    // Initialize search bar
    this.searchBar = new SearchBar(this.editor);
    this.searchBar.initialize();

    document.addEventListener(`search:open`, () => {
      this.searchBar?.open();
    });

    document.addEventListener(`search:close`, () => {
      if (this.searchBar?.isOpen) this.searchBar.close();
    });

    // Initialize Table of Contents sidebar
    if (tocContainer) {
      this.toc = new TableOfContents(tocContainer, this.editor);
      this.toc.initialize();
    }

    // Initialize tab bar
    const tabBarContainer = document.getElementById(`tab-bar`);
    if (tabBarContainer) {
      this.tabBar = new TabBar(tabBarContainer);
      this.tabBar.initialize();

      // Register the initial #editor element as the first tab's container
      const firstTabId = this.nextTabId();
      this.tabBar.addTab(firstTabId, undefined, true);
      this.tabContainers.set(firstTabId, editorContainer);

      this.tabBar.onTabSelect = (tabId) => this.switchToTab(tabId);
      this.tabBar.onTabClose = (tabId) => this.closeTab(tabId);
    }

    document.addEventListener(`contextmenu`, (event) => this.keepContextMenuToDocument(event));

    // Keep cursor position in sync with the main process so that
    // saveOpenFiles() always has a fresh offset.  Debounce to avoid
    // excessive IPC on rapid cursor movement.
    document.addEventListener(`selectionchange`, () => {
      if (this.cursorDebounce) clearTimeout(this.cursorDebounce);
      this.cursorDebounce = setTimeout(() => this.notifyOpenFiles(), 500);
    });

    // Flush any pending cursor update before the window closes so
    // that saveOpenFiles() in main always has the latest offset.
    window.addEventListener(`beforeunload`, () => {
      if (this.cursorDebounce) {
        clearTimeout(this.cursorDebounce);
        this.cursorDebounce = undefined;
      }
      this.notifyOpenFiles();
    });

    // Keep tab bar in sync with editor file state
    document.addEventListener(`editor:fileStateChanged`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (this.tabBar?.activeTabId && detail) {
        this.tabBar.updateTabPath(this.tabBar.activeTabId, detail.filePath);
        this.tabBar.setModified(this.tabBar.activeTabId, detail.modified);
        this.notifyOpenFiles();
      }
    });

    // Handle session restore after close-and-reopen: wait for
    // the document and ToC to be fully loaded, then restore the
    // cursor position and ToC heading highlight.
    document.addEventListener(`session:restore`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (detail) {
        this.queueFileAction(() => this.restoreSession(detail));
      }
    });

    // Handle file switching from the View menu
    document.addEventListener(`view:switchFile`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      this.queueFileAction(() => {
        if (detail?.tabId) {
          this.switchToTab(detail.tabId);
        } else if (detail?.filePath && this.tabBar) {
          const tab = this.tabBar.tabs.find((t) => t.filePath === detail.filePath);
          if (tab) {
            this.switchToTab(tab.id);
          }
        }
      });
    });

    // Handle File → New: create a new tab with an empty document
    document.addEventListener(`file:new`, async () => {
      await this.createNewTab(undefined, ``);
    });

    // Handle File → Load / Open Recent: open in a new tab (or switch
    // to an existing tab if the file is already open)
    document.addEventListener(`file:loaded`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (!detail) return;
      this.queueFileAction(async () => {
        const filePath = detail.filePath || undefined;
        // If this file is already open in another tab, switch to it
        if (filePath && this.tabBar) {
          const existing = this.tabBar.tabs.find((t) => t.filePath === filePath);
          if (existing) {
            this.switchToTab(existing.id);
            return;
          }
        }

        // If the active tab is a pristine empty document, reuse it
        // instead of opening a new tab alongside it
        if (this.isActiveTabPristine()) {
          await this.loadIntoCurrentTab(filePath, detail.content ?? ``);
        } else {
          await this.createNewTab(filePath, detail.content ?? ``);
        }
      });
    });

    // Handle File → Save: save the active document
    document.addEventListener(`file:save`, () => {
      this.menuHandler?.handleSave();
    });

    // Handle File → Close: close the active tab
    document.addEventListener(`file:close`, () => {
      if (this.tabBar?.activeTabId) {
        this.closeTab(this.tabBar.activeTabId);
      }
    });

    // Listen for TOC settings changes from the preferences modal
    document.addEventListener(`toc:settingsChanged`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (this.toc && detail) {
        this.toc.setVisible(detail.visible);
        this.toc.setPosition(detail.position);
      }
    });

    // Listen for image handling settings changes from the preferences modal
    document.addEventListener(`imageHandling:settingsChanged`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (this.editor && detail) {
        this.editor.ensureLocalPaths = !!detail.ensureLocalPaths;
        if (this.editor.ensureLocalPaths) {
          this.editor.rewriteImagePaths().then((changedIds) => {
            if (this.editor && changedIds && changedIds.length > 0) {
              this.editor.renderNodesAndPlaceCursor({ updated: changedIds });
            }
          });
        }
      }
    });

    // Listen for content settings changes from the preferences modal
    document.addEventListener(`content:settingsChanged`, (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (this.editor && detail) {
        this.editor.detailsClosed = !!detail.detailsClosed;

        // Only re-render <details> html-block nodes.
        const detailsIds = [];
        if (this.editor.syntaxTree) {
          for (const node of this.editor.syntaxTree.children) {
            if (node.type === `html-block` && node.attributes.tagName === `details`) {
              detailsIds.push(node.id);
            }
          }
        }
        if (detailsIds.length > 0) {
          this.editor.renderNodesAndPlaceCursor({ updated: detailsIds });
        }

        // Handle <style> element injection toggle
        const enableStyleElements = !!detail.enableStyleElements;
        this.editor.enableStyleElements = enableStyleElements;

        if (!enableStyleElements) {
          // Remove any previously injected <style> elements from the DOM
          const injected = document.querySelectorAll(`[data-injected-style="true"]`);
          for (const el of injected) el.remove();
        }

        // Re-render <style> html-block nodes so they inject or stop injecting
        const styleIds = [];
        if (this.editor.syntaxTree) {
          for (const node of this.editor.syntaxTree.children) {
            if (node.type === `html-block` && node.attributes.tagName === `style`) {
              styleIds.push(node.id);
            }
          }
        }
        if (styleIds.length > 0) {
          this.editor.renderNodesAndPlaceCursor({ updated: styleIds });
        }
      }
    });

    // Expose API for main process queries
    this.exposeEditorAPI();

    // Menu actions sent before now, such as a file named on the command
    // line, are delivered as soon as the handler registers, so it
    // registers once every listener they reach exists.
    this.menuHandler.initialize();

    await this.loadSettings();
  }

  /**
   * Shows no menu for a right-click outside the document: the app's UI has
   * no document menu, and the webview's own menu never shows. A right-click
   * in the document is left to the document's menu.
   * @param {MouseEvent} event
   */
  keepContextMenuToDocument(event) {
    const target = event.target;
    if (target instanceof Element && target.closest(`.editor`)) return;
    event.preventDefault();
  }

  /**
   * Generates a unique tab identifier.
   * @returns {string}
   */
  nextTabId() {
    this.tabCounter++;
    return `tab-${this.tabCounter}`;
  }

  /**
   * Saves the current editor state for the active tab.
   */
  saveCurrentState() {
    const tabId = this.tabBar?.activeTabId;
    if (!tabId || !this.editor) return;

    const md = this.editor.getMarkdown();
    let absOffset = 0;
    if (this.editor.syntaxTree?.treeCursor) {
      absOffset = cursorToAbsoluteOffset(
        this.editor.syntaxTree,
        this.editor.syntaxTree.treeCursor,
        this.editor.buildMarkdownLine.bind(this.editor),
        this.editor.getPrefixLength.bind(this.editor),
      );
    }

    const hash = crc32(md);

    // Capture the currently highlighted ToC heading so it can be
    // restored without recomputing viewport-based highlighting.
    let tocHeadingId = this.toc?.lockedHeadingId;
    if (!tocHeadingId && this.toc) {
      const activeLink = this.toc.container.querySelector(`.toc-active`);
      if (activeLink) {
        tocHeadingId = /** @type {HTMLElement} */ (activeLink).dataset.nodeId;
      }
    }

    this.documentStates.set(tabId, {
      content: md,
      filePath: this.editor.currentFilePath,
      modified: this.editor.hasUnsavedChanges,
      cursor: this.editor.syntaxTree?.treeCursor
        ? { ...this.editor.syntaxTree.treeCursor }
        : undefined,
      cursorOffset: absOffset,
      contentHash: hash,
      syntaxTree: this.editor.syntaxTree,
      treeRange: this.editor.treeRange ? { ...this.editor.treeRange } : undefined,
      scrollTop: this.scrollContainer ? this.scrollContainer.scrollTop : 0,
      tocActiveHeadingId: tocHeadingId,
      undoStack: [...this.editor.undoManager.undoStack],
      redoStack: [...this.editor.undoManager.redoStack],
    });

    // Hide the current tab's container (DOM stays intact)
    this.editor.container.style.display = `none`;
  }

  /**
   * Restores the editor state for a given tab.
   * @param {string} tabId
   */
  restoreState(tabId) {
    if (!this.editor) return;

    const targetContainer = this.tabContainers.get(tabId);
    const state = this.documentStates.get(tabId);

    if (targetContainer) {
      // Suppress the ToC's scroll handler while we swap containers
      if (this.toc) {
        this.toc.programmaticScroll = true;
      }

      // Swap the editor to the target tab's container
      this.editor.swapContainer(targetContainer);
      targetContainer.style.display = ``;

      // Re-target resize handles to the new container
      if (this.retargetResizeHandles) {
        this.retargetResizeHandles(targetContainer);
      }

      // Restore editor state
      if (state) {
        this.editor.currentFilePath = state.filePath;
        this.editor.syntaxTree = state.syntaxTree;
        if (this.editor.syntaxTree)
          this.editor.syntaxTree.treeCursor = state.cursor ? { ...state.cursor } : null;
        this.editor.lastRenderedNodeId = this.editor.syntaxTree?.treeCursor?.nodeId;
        this.editor.undoManager.undoStack = [...state.undoStack];
        this.editor.undoManager.redoStack = [...state.redoStack];
        this.editor.setUnsavedChanges(state.modified);
      }

      // Restore scroll position on the shared scroll container.
      // If scrollTop is 0 but we have a saved ToC heading, scroll
      // to that heading instead — this happens after a session
      // restore where the tab was loaded fresh (scrollTop reset
      // to 0) but the heading was preserved.
      if (this.scrollContainer && state) {
        if (state.scrollTop) {
          this.scrollContainer.scrollTop = state.scrollTop;
        } else if (state.tocActiveHeadingId) {
          const el = this.editor.container.querySelector(
            `[data-node-id="${state.tocActiveHeadingId}"]`,
          );
          if (el) {
            el.scrollIntoView({ block: `start` });
          }
        }
      }

      // Place cursor/selection and focus.  The DOM and syntax
      // tree are identical — nothing changed — so just set the
      // browser selection.  Suppress selectionchange so the event
      // handler doesn't trigger a spurious re-render.
      this.editor.treeRange = state?.treeRange ? { ...state.treeRange } : undefined;
      this.editor.isRendering = true;
      this.editor.container.focus({ preventScroll: true });
      if (this.editor.treeRange) {
        this.editor.placeSelection();
      } else {
        this.editor.placeCursor();
      }
      this.editor.isRendering = false;

      if (this.toc) {
        // Lock the ToC to the heading that was active when we
        // left this tab so refresh() doesn't recompute it from
        // viewport geometry.
        this.toc.lockedHeadingId = state?.tocActiveHeadingId;
        this.toc.reobserve();
        // Keep the programmatic-scroll flag active until the
        // next frame — scroll events from scrollTop / placeCursor
        // are dispatched asynchronously and would otherwise clear
        // the locked heading.
        requestAnimationFrame(() => {
          if (this.toc) {
            this.toc.programmaticScroll = false;
          }
        });
      }
    } else {
      this.editor.reset();
    }
  }

  /**
   * Returns true when the active tab is an untouched empty document —
   * no file path, no unsaved changes, and no content.  Loading a file
   * into such a tab should reuse it rather than opening a second tab.
   * @returns {boolean}
   */
  isActiveTabPristine() {
    if (!this.editor || !this.tabBar?.activeTabId) return false;

    const tab = this.tabBar.tabs.find((t) => t.id === this.tabBar?.activeTabId);
    if (!tab) return false;

    return (
      !tab.filePath && !this.editor.hasUnsavedChanges && this.editor.getMarkdown().trim() === ``
    );
  }

  /**
   * Runs a file action once every file action queued before it has
   * finished, so that files loaded, switched to and restored by menu
   * actions are handled one after the other, in the order they arrived.
   * @param {() => void | Promise<void>} action
   */
  queueFileAction(action) {
    this.fileActions = this.fileActions.then(action).catch((error) => {
      console.error(error);
    });
  }

  /**
   * Restores cursor position and ToC heading after a session restore.
   * Waits for the document and ToC to be fully loaded before applying.
   * For the active tab, restores live. For background tabs, patches
   * their saved document state.
   * @param {Array<{filePath: string, active: boolean, cursorPath?: number[], tocHeadingPath?: number[]}>} entries
   */
  restoreSession(entries) {
    const tryRestore = () => {
      // Wait for the syntax tree to be parsed
      if (!this.editor?.syntaxTree?.children?.length) {
        requestAnimationFrame(tryRestore);
        return;
      }

      // Wait for the ToC to have rendered its links
      const tocLinks = this.toc?.container.querySelectorAll(`.toc-link`);
      if (!tocLinks?.length) {
        requestAnimationFrame(tryRestore);
        return;
      }

      // Restore background tabs by patching their document states
      for (const entry of entries) {
        if (entry.active) continue;

        // Find the tab for this file
        const tab = this.tabBar?.tabs.find((t) => t.filePath === entry.filePath);
        if (!tab) continue;

        const state = this.documentStates.get(tab.id);
        if (!state?.syntaxTree) continue;

        // Restore cursor on the background tab's syntax tree
        if (entry.cursorPath) {
          state.syntaxTree.setCursorPath(entry.cursorPath);
          state.cursor = state.syntaxTree.treeCursor
            ? { ...state.syntaxTree.treeCursor }
            : undefined;
        }

        // Restore ToC heading for the background tab
        if (entry.tocHeadingPath) {
          const node = state.syntaxTree.getNodeAtPath(entry.tocHeadingPath);
          if (node) {
            state.tocActiveHeadingId = node.id;
          }
        }
      }

      // Restore the active tab live
      const activeEntry = entries.find((e) => e.active) ?? entries[0];
      if (!activeEntry) return;

      // Lock the ToC heading BEFORE any re-render so that
      // MutationObserver-triggered refresh() respects it.
      let tocNode;
      if (activeEntry.tocHeadingPath && this.toc) {
        tocNode = this.editor.syntaxTree.getNodeAtPath(activeEntry.tocHeadingPath);
        if (tocNode) {
          this.toc.programmaticScroll = true;
          this.toc.lockedHeadingId = tocNode.id;
          this.toc.setActiveLink(tocNode.id);
        }
      }

      // Restore cursor position from the saved path.
      // Focus the container first so the DOM selection set by
      // placeCursor() is visible (selections on unfocused elements
      // are silently discarded by the browser).
      if (activeEntry.cursorPath) {
        this.editor.syntaxTree.setCursorPath(activeEntry.cursorPath);
        this.editor.container.focus({ preventScroll: true });
        this.editor.fullRenderAndPlaceCursor();
      }

      // Scroll to the cursor's node — the cursor is the single
      // source of positional truth on restore.
      const cursorNodeId = this.editor.syntaxTree?.treeCursor?.nodeId;
      if (cursorNodeId) {
        requestAnimationFrame(() => {
          const el = this.editor?.container.querySelector(`[data-node-id="${cursorNodeId}"]`);
          if (el) {
            el.scrollIntoView({ block: `start` });
          }
          requestAnimationFrame(() => {
            if (this.toc) {
              this.toc.programmaticScroll = false;
            }
          });
        });
      } else if (this.toc) {
        this.toc.programmaticScroll = false;
      }
    };

    requestAnimationFrame(tryRestore);
  }

  /**
   * Scrolls the element for the given tree node into view within the
   * scroll container.
   * @param {string} nodeId
   */
  scrollToNode(nodeId) {
    if (!this.editor) return;
    requestAnimationFrame(() => {
      const el = this.editor?.container.querySelector(`[data-node-id="${nodeId}"]`);
      if (el) {
        el.scrollIntoView({ block: `start` });
      }
    });
  }

  /**
   * Loads a file into the current (active) tab, replacing its content
   * without creating a new tab.
   * @param {string} filePath
   * @param {string} content
   */
  async loadIntoCurrentTab(filePath, content) {
    if (!this.editor || !this.tabBar?.activeTabId) return;

    this.tabBar.updateTabPath(this.tabBar.activeTabId, filePath);

    this.editor.currentFilePath = filePath;
    await this.editor.loadMarkdown(content);

    this.editor.updateWindowTitle();

    this.notifyOpenFiles();
  }

  /**
   * Creates a new tab and loads content into it.
   * @param {string | undefined} filePath
   * @param {string} content
   */
  async createNewTab(filePath, content) {
    if (!this.editor || !this.tabBar || !this.scrollContainer) return;

    // Save the current tab's state before switching
    this.saveCurrentState();

    const tabId = this.nextTabId();
    this.tabBar.addTab(tabId, filePath, true);

    // Create a new contenteditable div for this tab
    const newContainer = document.createElement(`div`);
    newContainer.className = `editor`;
    newContainer.contentEditable = `true`;
    newContainer.spellcheck = false;
    newContainer.dataset.viewMode = this.editor.viewMode;
    this.scrollContainer.appendChild(newContainer);

    // Swap the editor to the new container and register it
    this.editor.swapContainer(newContainer);
    this.tabContainers.set(tabId, newContainer);

    // Re-target resize handles to the new container
    if (this.retargetResizeHandles) {
      this.retargetResizeHandles(newContainer);
    }

    // Load the new content into the editor
    this.editor.currentFilePath = filePath;
    await this.editor.loadMarkdown(content);

    // Re-attach the ToC observer to the new container so it picks
    // up the freshly rendered content.
    this.toc?.reobserve();

    // Reset scroll for the new tab
    this.scrollContainer.scrollTop = 0;

    this.editor.updateWindowTitle();

    this.notifyOpenFiles();
  }

  /**
   * Switches to a different tab, saving and restoring state.
   * @param {string} tabId
   */
  switchToTab(tabId) {
    if (!this.editor || !this.tabBar) return;
    if (tabId === this.tabBar.activeTabId) {
      // Already on this tab — just ensure the ToC reflects
      // the current container (needed after multi-file restore).
      this.toc?.reobserve();
      return;
    }

    // Save current tab's state
    this.saveCurrentState();

    // Activate the new tab
    this.tabBar.setActiveTab(tabId);

    // Restore the target tab's state
    this.restoreState(tabId);

    this.notifyOpenFiles();
  }

  /**
   * Closes a tab. If the document has unsaved changes, prompts the
   * user to save, discard, or cancel before closing.
   * If it's the last tab, resets to a fresh untitled document.
   * @param {string} tabId
   */
  async closeTab(tabId) {
    if (!this.tabBar || !this.editor) return;

    const tab = this.tabBar.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Check whether this tab has unsaved changes.  For the active
    // tab we ask the editor directly; for background tabs we check
    // the saved document-state snapshot.
    const isActive = tabId === this.tabBar.activeTabId;
    const isModified = isActive
      ? this.editor.hasUnsavedChanges
      : (this.documentStates.get(tabId)?.modified ?? false);

    if (isModified && window.pageToBackendBridge) {
      // If we're closing a background tab, switch to it first so
      // the user can see what they're being asked about.
      if (!isActive) {
        this.switchToTab(tabId);
      }

      const { action } = await window.pageToBackendBridge.confirmClose();

      if (action === `cancel`) return;

      if (action === `save`) {
        const content = this.editor.getMarkdown();
        const result = await window.pageToBackendBridge.saveFile(content);
        if (!result.success) return; // save dialog was cancelled
      }
      // 'discard' falls through to the removal below
    }

    this.documentStates.delete(tabId);

    // Remove the tab's container element from the DOM
    const closedContainer = this.tabContainers.get(tabId);
    if (closedContainer) {
      closedContainer.remove();
      this.tabContainers.delete(tabId);
    }

    // Re-check active state — it may have changed if we switched above
    const wasActive = tabId === this.tabBar.activeTabId;
    this.tabBar.removeTab(tabId);

    if (this.tabBar.tabs.length === 0) {
      // Last tab was closed — create a fresh untitled tab
      const newId = this.nextTabId();
      this.tabBar.addTab(newId, undefined, true);

      // Create a new container for the fresh tab
      const newContainer = document.createElement(`div`);
      newContainer.className = `editor`;
      newContainer.contentEditable = `true`;
      newContainer.spellcheck = false;
      newContainer.dataset.viewMode = this.editor.viewMode;
      if (this.scrollContainer) {
        this.scrollContainer.appendChild(newContainer);
      }
      this.editor.swapContainer(newContainer);
      this.tabContainers.set(newId, newContainer);

      // Re-target resize handles to the new container
      if (this.retargetResizeHandles) {
        this.retargetResizeHandles(newContainer);
      }

      this.editor.reset();
    } else if (wasActive && this.tabBar.activeTabId) {
      // removeTab already picked a new active tab; restore its state
      this.restoreState(this.tabBar.activeTabId);
    }

    this.notifyOpenFiles();
  }

  /**
   * Sends the current list of open files to the main process
   * so the View menu can be rebuilt.  Includes cursor position and
   * content hash for session restore.
   */
  notifyOpenFiles() {
    if (!this.tabBar || !window.pageToBackendBridge) return;

    const labels = getDisambiguatedLabels(this.tabBar.tabs);
    const activeTabId = this.tabBar.activeTabId;

    const files = this.tabBar.tabs.map((tab) => {
      const entry = {
        id: tab.id,
        filePath: tab.filePath,
        label: labels.get(tab.id) ?? tab.label,
        active: tab.active,
        cursorOffset: 0,
        contentHash: 0,
        scrollTop: 0,
        cursorPath: /** @type {number[] | undefined} */ (undefined),
        tocHeadingPath: /** @type {number[] | undefined} */ (undefined),
      };

      if (tab.id === activeTabId && this.editor?.syntaxTree?.treeCursor) {
        // Active tab — read live state from the editor
        const md = this.editor.getMarkdown();
        entry.contentHash = crc32(md);
        entry.cursorOffset = cursorToAbsoluteOffset(
          this.editor.syntaxTree,
          this.editor.syntaxTree.treeCursor,
          this.editor.buildMarkdownLine.bind(this.editor),
          this.editor.getPrefixLength.bind(this.editor),
        );
        entry.cursorPath = this.editor.syntaxTree.getPathToCursor() ?? undefined;
        entry.scrollTop = this.scrollContainer ? this.scrollContainer.scrollTop : 0;
        const tocId =
          this.toc?.lockedHeadingId ??
          /** @type {HTMLElement} */ (this.toc?.container.querySelector(`.toc-active`))?.dataset
            ?.nodeId;
        if (tocId && this.editor.syntaxTree) {
          entry.tocHeadingPath = this.editor.syntaxTree.getPathToNode(tocId) ?? undefined;
        }
      } else {
        // Background tab — read from cached document state
        const state = this.documentStates.get(tab.id);
        if (state) {
          entry.cursorOffset = state.cursorOffset;
          entry.contentHash = state.contentHash;
          entry.scrollTop = state.scrollTop ?? 0;
          entry.cursorPath = state.syntaxTree?.getPathToCursor() ?? undefined;
          const bgTocId = state.tocActiveHeadingId;
          if (bgTocId && state.syntaxTree) {
            entry.tocHeadingPath = state.syntaxTree.getPathToNode(bgTocId) ?? undefined;
          }
        }
      }

      return entry;
    });

    return window.pageToBackendBridge.notifyOpenFiles(files);
  }

  /**
   * Loads persisted settings from the database and applies them.
   */
  async loadSettings() {
    if (!window.pageToBackendBridge) return;

    try {
      const result = await window.pageToBackendBridge.getSetting(`defaultView`);
      if (result.success && result.value) {
        await this.editor?.setViewMode(result.value);
        this.toolbar?.setViewMode(result.value);
      }
    } catch {
      // Use hardcoded default (writing)
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`pageWidth`);
      if (result.success && result.value) {
        applyPageWidth(result.value);
      }
    } catch {
      // Use CSS defaults
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`margins`);
      if (result.success && result.value) {
        applyMargins(result.value);
      }
    } catch {
      // Use CSS defaults
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`colors`);
      if (result.success && result.value) {
        applyColors(result.value);
      }
    } catch {
      // Use CSS defaults
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`highlightActiveElement`);
      if (result.success && result.value !== undefined) {
        applyHighlightActiveElement(!!result.value);
      }
    } catch {
      // Default is highlighted, from the body's class in index.html
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`tocVisible`);
      if (result.success && result.value !== undefined) {
        this.toc?.setVisible(!!result.value);
      }
    } catch {
      // Default is visible
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`tocPosition`);
      if (result.success && result.value) {
        this.toc?.setPosition(result.value === `right` ? `right` : `left`);
      }
    } catch {
      // Default is left
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`tocWidth`);
      if (result.success && result.value) {
        this.toc?.setWidth(Number(result.value));
      }
    } catch {
      // Default width from CSS
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`ensureLocalPaths`);
      if (result.success && result.value !== undefined) {
        if (this.editor) {
          this.editor.ensureLocalPaths = !!result.value;
        }
      }
    } catch {
      // Default is false
    }

    try {
      const result = await window.pageToBackendBridge.getSetting(`detailsClosed`);
      if (result.success && result.value !== undefined) {
        if (this.editor) {
          this.editor.detailsClosed = !!result.value;
        }
      }
    } catch {
      // Default is false (open)
    }
  }

  /**
   * Reads whether a document's `<style>` elements are injected. It runs
   * before the menu handler registers and the editor API exists, as
   * either can deliver a document, which is rendered with the setting as
   * it is then.
   */
  async loadStyleElementsSetting() {
    if (!window.pageToBackendBridge || !this.editor) return;
    try {
      const result = await window.pageToBackendBridge.getSetting(`enableStyleElements`);
      if (result.success && result.value !== undefined) {
        this.editor.enableStyleElements = !!result.value;
      }
    } catch {
      // Default is false (disabled)
    }
  }

  /**
   * Exposes the editor API to the main process.
   */
  exposeEditorAPI() {
    /** @type {any} */ (window).__editor = this.editor;
    window.editorAPI = {
      hasUnsavedChanges: () => this.editor?.hasUnsavedChanges ?? false,
      getContent: () => this.editor?.getMarkdown() ?? ``,
      setContent: async (content) => {
        await this.editor?.loadMarkdown(content);
      },
      getViewMode: () => this.editor?.viewMode ?? `writing`,
      setViewMode: async (/** @type {string} */ mode) => {
        await this.editor?.setViewMode(/** @type {ViewMode} */ (mode));
        this.toolbar?.setViewMode(mode);
      },
      setUnsavedChanges: (v) => this.editor?.setUnsavedChanges(v),
      placeCursorAtNode: (/** @type {string} */ nodeId, /** @type {number} */ offset) => {
        if (this.editor) {
          if (this.editor.syntaxTree)
            this.editor.syntaxTree.treeCursor = { nodeId, offset: offset ?? 0 };
          this.editor.fullRenderAndPlaceCursor();
          this.scrollToNode(nodeId);
        }
      },
    };

    // Expose a flush function the main process can call via
    // executeJavaScript before persisting open-files state.
    /** @type {any} */ (window).__flushOpenFiles = () => {
      if (this.cursorDebounce) {
        clearTimeout(this.cursorDebounce);
        this.cursorDebounce = undefined;
      }
      return this.notifyOpenFiles();
    };

    // Expose file path and cursor info as globals so integration tests
    // (and other tooling) can inspect editor state.
    Object.defineProperty(window, `__editorFilePath`, {
      get: () => this.editor?.currentFilePath,
      set: (v) => {
        if (this.editor) this.editor.currentFilePath = v;
      },
      configurable: true,
    });

    Object.defineProperty(window, `__editorCursorNodeId`, {
      get: () => this.editor?.syntaxTree?.treeCursor?.nodeId,
      configurable: true,
    });

    Object.defineProperty(window, `__editorCursorOffset`, {
      get: () => this.editor?.syntaxTree?.treeCursor?.offset ?? 0,
      configurable: true,
    });
  }
}

// Initialize the application when the DOM is ready
document.addEventListener(`DOMContentLoaded`, async () => {
  const app = new App();
  await app.initialize();
});
