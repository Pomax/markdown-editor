/**
 * @fileoverview Writing Renderer for WYSIWYG-style editing.
 * Hides markdown syntax unless the cursor is on a specific element.
 */

import { buildInlineTree, tokenizeInline } from '../../../../../parsers/old/inline-tokenizer.js';
import { highlight } from '../../syntax-highlighter/index.js';
import { cursorToAbsoluteOffset } from '../../managers/cursor-persistence.js';
import { WritingRendererData } from '../../types.js';

let styleScopeCounter = 0;

/**
 * @param {Element} el
 * @returns {boolean}
 */
export function isListElement(el) {
  return el.tagName === `UL` || el.tagName === `OL`;
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isListPart(el) {
  return isListElement(el) || el.tagName === `LI`;
}

/**
 * @param {Element} el
 * @param {Element} blockParent
 */
function removeEmptyLists(el, blockParent) {
  /** @type {Element | null} */
  let current = el;
  while (current && current !== blockParent) {
    if (!isListElement(current) || current.querySelector(`li`)) break;
    /** @type {Element | null} */
    const parent = current.parentElement;
    current.remove();
    current = parent;
  }
}

/**
 * Renders the syntax tree in writing mode.
 */
export class WritingRenderer extends WritingRendererData {
  /**
   * @param {Editor} editor - The editor instance
   */
  constructor(editor) {
    super();
    this.editor = editor;
  }

  /**
   * Resolves a potentially-relative image `src` to an absolute file:// URL
   * based on the directory of the currently loaded markdown file.
   * @param {string} src - The raw src attribute from the markdown
   * @returns {string} An absolute file:// URL, or the original src if
   *     it is already absolute or no file is loaded.
   */
  resolveImageSrc(src) {
    // Already a full URL (http, https, data, file, etc.) — leave it alone.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;

    const filePath = this.editor.currentFilePath;
    if (!filePath) return src;

    // Derive the directory that contains the markdown file, then
    // resolve the relative src against it.
    const fileDir = filePath.replace(/[\\/][^\\/]+$/, ``);
    // Normalise to forward-slashes for the file:// URL.
    const resolved = `${fileDir}/${src}`.replace(/\\/g, `/`);

    // On Windows paths start with a drive letter (C:/…), so we need
    // three slashes: file:///C:/…
    return resolved.startsWith(`/`) ? `file://${resolved}` : `file:///${resolved}`;
  }

  /**
   * Renders the syntax tree to the container.
   * @param {SyntaxTree} syntaxTree - The syntax tree to render
   * @param {HTMLElement} container - The container element
   */
  fullRender(syntaxTree, container) {
    // Use the tree cursor (the canonical cursor position) to determine
    // which node is focused, rather than the selection manager which
    // may be stale when switching view modes.
    const currentNodeId = this.editor.getFocusedNodeId();

    // Clear and rebuild content
    container.innerHTML = ``;
    container.classList.add(`writing-view`);

    const fragment = document.createDocumentFragment();

    for (const element of this.renderBlockSequence(syntaxTree.children, currentNodeId)) {
      fragment.appendChild(element);
    }

    // If empty, add a placeholder paragraph
    if (syntaxTree.children.length === 0) {
      const placeholder = document.createElement(`p`);
      placeholder.className = `md-paragraph writing-placeholder`;
      placeholder.appendChild(document.createElement(`br`));
      fragment.appendChild(placeholder);
    }

    container.appendChild(fragment);

    // Append a phantom paragraph after a trailing code block so the
    // user has somewhere to place the cursor.  This element is not
    // backed by a tree node — it is promoted on first interaction.
    this.ensurePhantomParagraph(container, syntaxTree);
  }

  /**
   * @param {SyntaxNode[]} nodes
   * @param {string | undefined} currentNodeId - The focused node's id
   * @returns {HTMLElement[]} The top-level elements, in order
   */
  renderBlockSequence(nodes, currentNodeId) {
    /** @type {HTMLElement[]} */
    const elements = [];
    let i = 0;
    while (i < nodes.length) {
      if (nodes[i].type === `list-item`) {
        /** @type {SyntaxNode[]} */
        const run = [];
        while (i < nodes.length && nodes[i].type === `list-item`) {
          run.push(nodes[i]);
          i++;
        }
        elements.push(...this.renderListRun(run, currentNodeId));
        continue;
      }
      const element = this.renderNode(nodes[i], nodes[i].id === currentNodeId);
      if (element) elements.push(element);
      i++;
    }
    return elements;
  }

  /**
   * Computes, for each item of a run of consecutive list items, how deep
   * it nests and whether it starts a new list.  An item indented further
   * than the previous one opens a list inside the previous item; an item
   * indented less closes lists until the depth matches; a change between
   * ordered and unordered at the same depth starts a sibling list.
   *
   * @param {SyntaxNode[]} items
   * @returns {ListLayoutEntry[]}
   */
  layoutListRun(items) {
    /** @type {{ indent: number, ordered: boolean }[]} */
    const stack = [];
    /** @type {ListLayoutEntry[]} */
    const entries = [];
    for (const node of items) {
      const indent = node.attributes.indent || 0;
      const ordered = !!node.attributes.ordered;
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      let startsList = false;
      if (top && top.indent === indent && top.ordered !== ordered) {
        stack.pop();
        stack.push({ indent, ordered });
        startsList = true;
      } else if (!top || top.indent < indent) {
        stack.push({ indent, ordered });
        startsList = true;
      }
      entries.push({ node, depth: stack.length, ordered, startsList });
    }
    return entries;
  }

  /**
   * @param {SyntaxNode[]} items
   * @param {string | undefined} currentNodeId - The focused node's id
   * @returns {HTMLElement[]} The top-level list elements
   */
  renderListRun(items, currentNodeId) {
    /** @type {HTMLElement[]} */
    const roots = [];
    /** @type {HTMLElement[]} open list elements, index = depth - 1 */
    const lists = [];
    for (const entry of this.layoutListRun(items)) {
      if (entry.startsList) {
        lists.length = entry.depth - 1;
        const list = document.createElement(entry.ordered ? `ol` : `ul`);
        if (entry.depth === 1) {
          roots.push(list);
        } else {
          const parentList = lists[entry.depth - 2];
          (parentList.lastElementChild ?? parentList).appendChild(list);
        }
        lists.push(list);
      } else {
        lists.length = entry.depth;
      }
      const li = this.renderNode(entry.node, entry.node.id === currentNodeId);
      if (li) lists[entry.depth - 1].appendChild(li);
    }
    return roots;
  }

  /**
   * Counted from 1.
   *
   * @param {SyntaxNode[]} siblings
   * @param {SyntaxNode} node
   * @returns {number}
   */
  computeListDepth(siblings, node) {
    const idx = siblings.indexOf(node);
    let start = idx;
    while (start > 0 && siblings[start - 1].type === `list-item`) start--;
    const entries = this.layoutListRun(siblings.slice(start, idx + 1));
    return entries[entries.length - 1].depth;
  }

  /**
   * Counted from 1.
   *
   * @param {Element} li
   * @returns {number}
   */
  domListDepth(li) {
    let depth = 0;
    /** @type {Element | null} */
    let el = li.parentElement;
    while (el && isListPart(el)) {
      if (isListElement(el)) depth++;
      el = el.parentElement;
    }
    return depth;
  }

  /**
   * Returns the element whose direct children are the block elements of
   * a sibling sequence: the editor container, or the html-block content
   * element, found by walking out of any enclosing lists.
   *
   * @param {Element} blockEl - A rendered block element
   * @returns {HTMLElement}
   */
  blockParentOf(blockEl) {
    /** @type {Element} */
    let parent = /** @type {Element} */ (blockEl.parentElement);
    while (isListPart(parent)) {
      parent = /** @type {Element} */ (parent.parentElement);
    }
    return /** @type {HTMLElement} */ (parent);
  }

  /**
   * Returns the direct child of `blockParent` that contains `el`: the
   * element itself, or the top-level list it sits in.
   *
   * @param {Element} el
   * @param {Element} blockParent
   * @returns {Element}
   */
  topLevelBlockOf(el, blockParent) {
    let top = el;
    while (top.parentElement && top.parentElement !== blockParent) {
      top = top.parentElement;
    }
    return top;
  }

  /**
   * Incrementally updates the DOM by re-rendering, adding, or removing
   * specific nodes rather than rebuilding the entire document.
   *
   * @param {HTMLElement} container - The editor container
   * @param {{ updated?: string[], added?: string[], removed?: string[] }} hints
   *     - updated: node IDs whose content or focus state changed (re-render in place)
   *     - added:   node IDs that were just inserted into the tree (create & insert DOM element)
   *     - removed: node IDs that were just removed from the tree (delete DOM element)
   */
  renderNodes(container, { updated = [], added = [], removed = [] }) {
    const tree = this.editor.syntaxTree;
    if (!tree) return;

    const currentNodeId = this.editor.getFocusedNodeId();

    /** @type {Set<string>} node ids whose list run must be re-rendered */
    const listTouched = new Set();

    // 1. Remove DOM elements for deleted nodes.
    for (const nodeId of removed) {
      const el = container.querySelector(`[data-node-id="${nodeId}"]`);
      if (!el) continue;
      const blockParent = this.blockParentOf(el);
      const top = this.topLevelBlockOf(el, blockParent);
      const items = [...el.querySelectorAll(`li[data-node-id]`)];
      for (const neighbour of [top.previousElementSibling, top.nextElementSibling]) {
        const li =
          neighbour && isListElement(neighbour) && neighbour.querySelector(`li[data-node-id]`);
        if (li) items.push(li);
      }
      for (const li of items) {
        const id = /** @type {HTMLElement} */ (li).dataset.nodeId;
        if (id && tree.findNodeById(id)) listTouched.add(id);
      }
      el.remove();
      removeEmptyLists(top, blockParent);
    }

    // 2. Re-render existing nodes in-place.
    for (const nodeId of updated) {
      const node = tree.findNodeById(nodeId);
      const existing = container.querySelector(`[data-node-id="${nodeId}"]`);
      if (!node || !existing) continue;
      const isListItem = node.type === `list-item`;
      const wasListItem = existing.tagName === `LI`;
      if (!isListItem && !wasListItem) {
        this.replaceNodeElement(container, tree, nodeId, nodeId === currentNodeId);
        continue;
      }
      if (isListItem && wasListItem && this.listShapeUnchanged(tree, node, existing)) {
        const fresh = this.renderNode(node, nodeId === currentNodeId);
        if (!fresh) continue;
        for (const child of [...existing.children]) {
          if (isListElement(child)) fresh.appendChild(child);
        }
        existing.replaceWith(fresh);
        continue;
      }
      listTouched.add(nodeId);
    }

    // 3. Insert DOM elements for newly added nodes.
    for (const nodeId of added) {
      const node = tree.findNodeById(nodeId);
      if (!node) continue;

      const siblings = node.parent ? node.parent.children : tree.children;
      const idx = siblings.indexOf(node);
      const nextToList =
        (idx > 0 && siblings[idx - 1].type === `list-item`) ||
        (idx < siblings.length - 1 && siblings[idx + 1].type === `list-item`);
      if (node.type === `list-item` || nextToList) {
        listTouched.add(nodeId);
        continue;
      }

      const element = this.renderNode(node, nodeId === currentNodeId);
      if (!element) continue;

      // Insert after the previous sibling's DOM element.
      if (idx > 0) {
        const prevSibling = siblings[idx - 1];
        const prevEl = container.querySelector(`[data-node-id="${prevSibling.id}"]`);
        if (prevEl) {
          prevEl.after(element);
          continue;
        }
      }

      if (node.parent && node.parent.type === `html-block`) {
        const parentFocused = node.parent.id === currentNodeId;
        this.replaceNodeElement(container, tree, node.parent.id, parentFocused);
      } else {
        container.prepend(element);
      }
    }

    if (listTouched.size > 0) {
      this.rebuildListRegions(container, tree, listTouched, currentNodeId);
    }

    // Refresh the phantom paragraph after incremental updates.
    this.ensurePhantomParagraph(container, tree);
  }

  /**
   * @param {SyntaxTree} tree
   * @param {SyntaxNode} node
   * @param {Element} existing
   * @returns {boolean}
   */
  listShapeUnchanged(tree, node, existing) {
    const parentList = existing.parentElement;
    if (!parentList || !isListElement(parentList)) return false;
    const ordered = !!node.attributes.ordered;
    if (parentList.tagName !== (ordered ? `OL` : `UL`)) return false;
    const siblings = node.parent ? node.parent.children : tree.children;
    return this.computeListDepth(siblings, node) === this.domListDepth(existing);
  }

  /**
   * Re-renders the stretches of sibling nodes that contain the given
   * nodes, widened to whole runs of list items on both sides.
   *
   * @param {HTMLElement} container
   * @param {SyntaxTree} tree
   * @param {Set<string>} nodeIds
   * @param {string | undefined} currentNodeId
   */
  rebuildListRegions(container, tree, nodeIds, currentNodeId) {
    /** @type {Map<SyntaxNode | undefined, SyntaxNode[]>} touched nodes per parent */
    const groups = new Map();
    for (const id of nodeIds) {
      const node = tree.findNodeById(id);
      if (!node) continue;
      const group = groups.get(node.parent) ?? [];
      group.push(node);
      groups.set(node.parent, group);
    }

    for (const [parent, nodes] of groups) {
      const siblings = parent ? parent.children : tree.children;
      let lo = siblings.length;
      let hi = -1;
      for (const node of nodes) {
        const idx = siblings.indexOf(node);
        if (idx < lo) lo = idx;
        if (idx > hi) hi = idx;
      }
      while (lo > 0 && siblings[lo - 1].type === `list-item`) lo--;
      while (hi < siblings.length - 1 && siblings[hi + 1].type === `list-item`) hi++;

      /** @type {HTMLElement | undefined} */
      let blockParent;
      for (let i = lo; i <= hi && !blockParent; i++) {
        const el = container.querySelector(`[data-node-id="${siblings[i].id}"]`);
        if (el) blockParent = this.blockParentOf(el);
      }
      if (!blockParent && lo > 0) {
        const prevEl = container.querySelector(`[data-node-id="${siblings[lo - 1].id}"]`);
        if (prevEl) blockParent = this.blockParentOf(prevEl);
      }
      if (!blockParent) {
        if (parent && parent.type === `html-block`) {
          this.replaceNodeElement(container, tree, parent.id, parent.id === currentNodeId);
          continue;
        }
        blockParent = container;
      }

      for (let i = lo; i <= hi; i++) {
        const el = container.querySelector(`[data-node-id="${siblings[i].id}"]`);
        if (el?.isConnected) this.topLevelBlockOf(el, blockParent).remove();
      }

      const fresh = this.renderBlockSequence(siblings.slice(lo, hi + 1), currentNodeId);
      const prevEl =
        lo > 0 ? container.querySelector(`[data-node-id="${siblings[lo - 1].id}"]`) : undefined;
      if (prevEl) {
        this.topLevelBlockOf(prevEl, blockParent).after(...fresh);
      } else {
        blockParent.prepend(...fresh);
      }
    }
  }

  /**
   * Appends (or removes) a phantom paragraph at the end of the container
   * when the last tree node is a code block.  The phantom is a
   * presentation-only DOM element — it is not backed by a tree node.
   * When the user interacts with it (clicks, types), it is promoted to
   * a real SyntaxNode by {@link Editor#promotePhantomParagraph}.
   *
   * @param {HTMLElement} container
   * @param {SyntaxTree} tree
   */
  ensurePhantomParagraph(container, tree) {
    const existing = container.querySelector(`[data-is-phantom]`);
    const children = tree.children;
    const last = children.length > 0 ? children[children.length - 1] : undefined;
    const needsPhantom = last?.type === `code-block`;

    if (needsPhantom && !existing) {
      const phantom = document.createElement(`p`);
      phantom.className = `md-paragraph`;
      phantom.dataset.isPhantom = ``;
      phantom.setAttribute(`contenteditable`, `true`);
      phantom.appendChild(document.createElement(`br`));
      container.appendChild(phantom);
    } else if (!needsPhantom && existing) {
      existing.remove();
    }
  }

  /**
   * Finds a node by id in the syntax tree, renders it, and replaces
   * the corresponding DOM element in the container.
   *
   * @param {HTMLElement} container
   * @param {SyntaxTree} tree
   * @param {string} nodeId
   * @param {boolean} isFocused
   */
  replaceNodeElement(container, tree, nodeId, isFocused) {
    const node = tree.findNodeById(nodeId);
    if (!node) return;

    const existing = container.querySelector(`[data-node-id="${nodeId}"]`);
    if (!existing) return;

    const updated = this.renderNode(node, isFocused);
    if (updated) {
      existing.replaceWith(updated);
    }
  }

  /**
   * @param {SyntaxNode} node
   * @returns {number}
   */
  headingLevel(node) {
    return Number.parseInt(node.type.replace(`heading`, ``), 10);
  }

  /**
   * @param {SyntaxNode} node
   * @returns {string}
   */
  blockTagName(node) {
    switch (node.type) {
      case `heading1`:
      case `heading2`:
      case `heading3`:
      case `heading4`:
      case `heading5`:
      case `heading6`:
        return `h${this.headingLevel(node)}`;
      case `blockquote`:
        return `blockquote`;
      case `code-block`:
        return `pre`;
      case `list-item`:
        return `li`;
      case `horizontal-rule`:
        return `hr`;
      case `table`:
        return `table`;
      case `html-block`:
        return `div`;
      default:
        return `p`;
    }
  }

  /**
   * Renders a syntax tree node to an HTML element.
   * @param {SyntaxNode} node - The node to render
   * @param {boolean} isFocused - Whether this node has focus
   * @returns {HTMLElement | undefined}
   */
  renderNode(node, isFocused) {
    const element = document.createElement(this.blockTagName(node));
    element.className = node.type === `html-block` ? `html-element` : `md-${node.type}`;
    element.dataset.nodeId = node.id;

    if (isFocused) {
      element.dataset.hasFocus = ``;
    }

    switch (node.type) {
      case `heading1`:
      case `heading2`:
      case `heading3`:
      case `heading4`:
      case `heading5`:
      case `heading6`:
        return this.renderHeading(node, element, isFocused);

      case `paragraph`:
        return this.renderParagraph(node, element, isFocused);

      case `blockquote`:
        return this.renderBlockquote(node, element, isFocused);

      case `code-block`:
        return this.renderCodeBlock(node, element, isFocused);

      case `list-item`:
        return this.renderListItem(node, element, isFocused);

      case `horizontal-rule`:
        return this.renderHorizontalRule(node, element);

      case `image`:
      case `linked-image`:
        return this.renderImage(node, element);

      case `table`:
        return this.renderTable(node, element);

      case `html-block`:
        return this.renderHtmlBlock(node, element, isFocused);

      default:
        return this.renderParagraph(node, element, isFocused);
    }
  }

  /**
   * Renders a heading node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderHeading(node, element, isFocused) {
    this.renderInlineContent(node, element);
    return element;
  }

  /**
   * Renders a paragraph node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderParagraph(node, element, isFocused) {
    this.renderInlineContent(node, element);
    return element;
  }

  /**
   * Renders a blockquote node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderBlockquote(node, element, isFocused) {
    const paragraph = document.createElement(`p`);
    paragraph.className = `md-content`;
    this.renderInlineContent(node, paragraph);
    element.appendChild(paragraph);

    // Apply blockquote styling
    element.style.borderLeft = `3px solid #ccc`;
    element.style.paddingLeft = `1em`;
    element.style.fontStyle = `italic`;

    return element;
  }

  /**
   * Renders a code block node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderCodeBlock(node, element, isFocused) {
    const attrs = /** @type {NodeAttributes} */ (node.attributes);
    const language = attrs.language || ``;

    // Language tag spans are always rendered so the user can click
    // to set or change the language even when none is set yet.
    // The mousedown guard (preventDefault + stopPropagation) keeps the
    // browser from moving the caret, which would overwrite the user's
    // cursor offset.
    const tagTop = document.createElement(`span`);
    tagTop.className = `top`;
    tagTop.dataset.lang = ``;
    tagTop.addEventListener(`mousedown`, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    const tagBottom = document.createElement(`span`);
    tagBottom.className = `bottom`;
    tagBottom.dataset.lang = ``;
    tagBottom.addEventListener(`mousedown`, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    if (language) {
      tagTop.textContent = language;
      tagBottom.textContent = language;
    } else {
      tagTop.textContent = `lang`;
      tagBottom.textContent = `lang`;
      tagTop.classList.add(`empty`);
      tagBottom.classList.add(`empty`);
    }

    const code = document.createElement(`code`);
    code.className = `md-content`;
    if (isFocused) {
      // Plain text when focused so cursor positions map 1:1.
      // Append a trailing newline so the last line always has
      // visual height (trailing newlines collapse even in <pre>).
      code.textContent = `${node.content}\n`;
    } else {
      code.appendChild(highlight(node.content, language));
    }

    // Only show the bottom tag when the code block is tall (>= 20 lines).
    const lineCount = (node.content.match(/\n/g) || []).length + 1;
    if (lineCount >= 20) {
      element.classList.add(`tall`);
    }

    element.appendChild(tagTop);
    element.appendChild(code);
    element.appendChild(tagBottom);

    return element;
  }

  /**
   * Renders a list item node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderListItem(node, element, isFocused) {
    const attrs = /** @type {NodeAttributes} */ (node.attributes);
    const isChecklist = typeof attrs.checked === `boolean`;

    /** @type {HTMLInputElement | undefined} */
    let checkbox;

    if (isChecklist) {
      // Checklist: no bullet/number, show a checkbox
      element.classList.add(`md-checklist-item`);

      checkbox = document.createElement(`input`);
      checkbox.type = `checkbox`;
      if (attrs.checked) {
        checkbox.setAttribute(`checked`, `checked`);
      }

      // mousedown guard: prevent caret movement
      checkbox.addEventListener(`mousedown`, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      checkbox.addEventListener(`click`, (e) => {
        e.preventDefault();
        e.stopPropagation();
        const before = this.editor.getMarkdown();
        node.attributes.checked = !node.attributes.checked;
        this.editor.undoManager.recordChange({
          type: `checklistToggle`,
          before,
          after: this.editor.getMarkdown(),
        });
        this.editor.renderNodesAndPlaceCursor({ updated: [node.id] });
        this.editor.setUnsavedChanges(true);
      });

      // Append checkbox AFTER the content so the browser doesn't
      // create a caret position before it. Absolute positioning
      // keeps it visually to the left.
    }

    this.renderInlineContent(node, element);

    // Append checkbox inside a non-editable wrapper so the browser
    // never creates caret positions around it.
    if (checkbox) {
      const wrapper = document.createElement(`span`);
      wrapper.contentEditable = `false`;
      wrapper.appendChild(checkbox);
      element.appendChild(wrapper);
    }

    return element;
  }

  /**
   * Renders an image node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @returns {HTMLElement}
   */
  renderImage(node, element) {
    const attrs = /** @type {NodeAttributes} */ (node.attributes);
    const alt = attrs.alt ?? node.content;
    const src = attrs.url ?? ``;

    // Always show rendered image (WYSIWYG)
    const img = document.createElement(`img`);
    img.src = this.resolveImageSrc(src);
    img.alt = alt;
    img.title = alt;
    if (attrs.style) {
      img.setAttribute(`style`, attrs.style);
    }
    if (attrs.className) {
      img.setAttribute(`class`, attrs.className);
    }

    if (attrs.href) {
      const link = document.createElement(`a`);
      link.href = attrs.href;
      link.appendChild(img);
      element.appendChild(link);
    } else {
      element.appendChild(img);
    }

    return element;
  }

  /**
   * Renders a horizontal rule node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @returns {HTMLElement}
   */
  renderHorizontalRule(node, element) {
    return element;
  }

  /**
   * Renders a table node.
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @returns {HTMLElement}
   */
  renderTable(node, element) {
    this.parseTableToHTML(node.content, /** @type {HTMLTableElement} */ (element));
    return element;
  }

  /**
   * Parses markdown table content into an HTML table.
   * @param {string} content - The table content
   * @param {HTMLTableElement} table - The table to fill
   * @returns {HTMLTableElement}
   */
  parseTableToHTML(content, table) {
    const lines = content.split(`\n`).filter((line) => line.trim());

    for (let i = 0; i < lines.length; i++) {
      // Skip separator line (must contain at least one dash)
      if (/^[\s|:-]+$/.test(lines[i]) && lines[i].includes(`-`)) continue;

      const row = document.createElement(`tr`);
      const cells = lines[i].split(`|`).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

      for (const cellContent of cells) {
        const cell = document.createElement(i === 0 ? `th` : `td`);
        this.renderInlineString(cellContent.trim(), cell);
        row.appendChild(cell);
      }

      if (i === 0) {
        const thead = document.createElement(`thead`);
        thead.appendChild(row);
        table.appendChild(thead);
      } else {
        let tbody = table.querySelector(`tbody`);
        if (!tbody) {
          tbody = document.createElement(`tbody`);
          table.appendChild(tbody);
        }
        tbody.appendChild(row);
      }
    }

    return table;
  }

  /**
   * Renders an HTML block container node.
   *
   * The container's tag (e.g. `<div>`, `<details>`) is rendered as an
   * actual HTML element and the child nodes are rendered inside it as
   * normal markdown nodes.
   *
   * For `<details>` blocks the element is rendered open by default so
   * the user can see and edit the content.  A self-closed `<summary>`
   * child is rendered as a native `<summary>` element with editable
   * inline content.
   *
   * @param {SyntaxNode} node
   * @param {HTMLElement} element - The wrapper div with data-node-id
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderHtmlBlock(node, element, isFocused) {
    const attrs = /** @type {NodeAttributes} */ (node.attributes);
    const tagName = attrs.tagName || `div`;

    // For <details> blocks we use a fake disclosure widget built from
    // plain <div>s so we have full control over collapsing without any
    // of the quirky browser behaviour of the native <details> element.
    if (tagName === `details`) {
      return this.renderFakeDetails(node, element, isFocused);
    }

    // HTML comments, void elements, and raw content tags have no
    // visual representation in writing mode — hide them entirely.
    const isComment = tagName === `!--`;
    const isVoid = attrs.closingTag === `` && node.children.length === 0;
    const isRawContent = attrs.rawContent !== undefined;

    // The scope root is the editor container that holds this style element,
    // so the rules apply to this document only.
    if (tagName === `style` && isRawContent && this.editor.enableStyleElements) {
      const styleEl = document.createElement(`style`);
      styleEl.dataset.nodeId = node.id;
      styleEl.dataset.injectedStyle = `true`;
      styleEl.dataset.scope = `${++styleScopeCounter}`;
      const raw = attrs.rawContent || ``;
      styleEl.textContent = `@scope (.editor:has(style[data-scope="${styleEl.dataset.scope}"])) { ${raw} }`;
      element.appendChild(styleEl);
      element.hidden = true;
      return element;
    }

    if (isComment || isVoid || isRawContent) {
      element.hidden = true;
      return element;
    }

    // Create the actual semantic element so tags like <iframe>, <section>,
    // <nav>, etc. render with their native behaviour.
    const container = document.createElement(tagName);

    // Copy attributes from the opening tag onto the semantic element
    this.applyHtmlAttributes(container, attrs.openingTag || ``);

    // Determine which child (if any) is focused
    const currentNodeId = this.editor.getFocusedNodeId();

    for (const childElement of this.renderBlockSequence(node.children, currentNodeId)) {
      container.appendChild(childElement);
    }

    // If no children, add a placeholder so the element is visible
    if (node.children.length === 0) {
      container.appendChild(document.createElement(`br`));
    }

    element.appendChild(container);
    return element;
  }

  /**
   * Renders a fake &lt;details&gt; disclosure widget using plain divs.
   * The first child that is itself an html-block with tagName "summary"
   * is rendered as the summary row (with a clickable disclosure triangle).
   * All remaining children form the collapsible body.
   *
   * @param {SyntaxNode} node
   * @param {HTMLElement} element
   * @param {boolean} isFocused
   * @returns {HTMLElement}
   */
  renderFakeDetails(node, element, isFocused) {
    const attrs = /** @type {NodeAttributes} */ (node.attributes);
    const defaultOpen = !this.editor.detailsClosed;

    // Check runtime toggle state stored on the node; fall back to the
    // user preference on first render.
    if (node.attributes.detailsOpen === undefined) {
      node.attributes.detailsOpen = defaultOpen;
    }
    const isOpen = !!node.attributes.detailsOpen;

    element.classList.add(`html-details`);
    if (isOpen) {
      element.dataset.open = ``;
    }

    // Copy any extra attributes from the original opening tag
    this.applyHtmlAttributes(element, attrs.openingTag || ``);

    const currentNodeId = this.editor.getFocusedNodeId();

    // Split children into summary child and body children
    /** @type {SyntaxNode | undefined} */
    let summaryNode;
    /** @type {SyntaxNode[]} */
    const bodyChildren = [];

    for (const child of node.children) {
      if (!summaryNode && child.type === `html-block` && child.attributes.tagName === `summary`) {
        summaryNode = child;
      } else {
        bodyChildren.push(child);
      }
    }

    // Summary row
    if (summaryNode) {
      const summaryRow = document.createElement(`div`);
      summaryRow.className = `html-summary`;

      // Disclosure triangle
      const triangle = document.createElement(`span`);
      triangle.className = `dropdown`;
      triangle.textContent = isOpen ? `▼` : `▶`;
      triangle.setAttribute(`role`, `button`);
      triangle.setAttribute(`aria-label`, isOpen ? `Collapse` : `Expand`);
      // Intercept mousedown to prevent the browser from moving the
      // caret into the details body.
      triangle.addEventListener(`mousedown`, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      triangle.addEventListener(`click`, (e) => {
        e.stopPropagation();
        node.attributes.detailsOpen = !node.attributes.detailsOpen;
        this.editor.renderNodes({ updated: [node.id] });
        this.editor.placeCursor();
      });
      summaryRow.appendChild(triangle);

      // Render summary content
      const summaryContent = document.createElement(`div`);
      const summaryFocused = summaryNode.id === currentNodeId;
      // Render summary's own children (the bareText paragraph)
      for (const scEl of this.renderBlockSequence(summaryNode.children, currentNodeId)) {
        summaryContent.appendChild(scEl);
      }
      summaryRow.appendChild(summaryContent);
      element.appendChild(summaryRow);
    }

    // Collapsible body
    const body = document.createElement(`div`);

    for (const childElement of this.renderBlockSequence(bodyChildren, currentNodeId)) {
      body.appendChild(childElement);
    }

    if (bodyChildren.length === 0) {
      body.appendChild(document.createElement(`br`));
    }

    element.appendChild(body);
    return element;
  }

  /**
   * Parses HTML attributes from an opening tag string and applies them
   * to a DOM element (excluding the tag name itself).
   *
   * @param {HTMLElement} el - The element to apply attributes to
   * @param {string} openingTag - e.g. `<div class="note">`
   */
  applyHtmlAttributes(el, openingTag) {
    // Strip `<tagName` from the front and `>` from the end
    const withoutBrackets = openingTag
      .replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, ``)
      .replace(/>$/, ``)
      .trim();
    if (!withoutBrackets) return;

    // Use a temporary element to parse attributes safely
    const tmp = document.createElement(`div`);
    tmp.innerHTML = `<span ${withoutBrackets}></span>`;
    const parsed = tmp.firstElementChild;
    if (!parsed) return;

    for (const attr of parsed.attributes) {
      el.setAttribute(attr.name, attr.value);
    }
  }

  /**
   * Renders inline content from a SyntaxNode's inline children.
   * Each formatting element gets a `data-node-id` attribute so the
   * cursor manager can resolve the cursor to the correct inline node.
   *
   * @param {SyntaxNode} node - The block-level node
   * @param {HTMLElement} container - The container element
   */
  renderInlineContent(node, container) {
    if (!node.content) {
      container.appendChild(document.createElement(`br`));
      return;
    }

    if (node.children && node.children.length > 0) {
      this.renderSyntaxNodeChildren(node.children, container);
    } else {
      // Fallback for nodes without inline children
      this.renderInlineParts(node.content, container);
    }
  }

  /**
   * Renders inline content from a raw string (no SyntaxNode children
   * available).  Used for table cells whose content is extracted from
   * the raw table markdown.
   *
   * @param {string} content - The raw inline text
   * @param {HTMLElement} container - The container element
   */
  renderInlineString(content, container) {
    if (!content) {
      container.appendChild(document.createElement(`br`));
      return;
    }
    this.renderInlineParts(content, container);
  }

  /**
   * Tokenizes inline markdown + HTML and appends rendered DOM nodes.
   * @param {string} content - The raw inline markdown text
   * @param {HTMLElement} container - The element to append rendered nodes to
   */
  renderInlineParts(content, container) {
    const tokens = tokenizeInline(content);
    const tree = buildInlineTree(tokens);
    this.appendSegments(tree, container);
  }

  /**
   * Recursively renders inline SyntaxNode children into the DOM.
   * Formatting elements receive `data-node-id` so that cursor tracking
   * can resolve to the correct inline node.
   *
   * @param {SyntaxNode[]} children
   * @param {HTMLElement} container
   */
  renderSyntaxNodeChildren(children, container) {
    for (const child of children) {
      switch (child.type) {
        case `text`:
          container.appendChild(document.createTextNode(child.content));
          break;
        case `inline-code`: {
          const code = document.createElement(`code`);
          code.dataset.nodeId = child.id;
          code.textContent = child.content;
          container.appendChild(code);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `inline-image`: {
          const img = document.createElement(`img`);
          img.dataset.nodeId = child.id;
          img.alt = child.attributes.alt ?? ``;
          img.src = this.resolveImageSrc(child.attributes.src ?? ``);
          container.appendChild(img);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `bold`: {
          const strong = document.createElement(`strong`);
          strong.dataset.nodeId = child.id;
          this.renderSyntaxNodeChildren(child.children, strong);
          container.appendChild(strong);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `bold-italic`: {
          const strong = document.createElement(`strong`);
          strong.dataset.nodeId = child.id;
          const em = document.createElement(`em`);
          this.renderSyntaxNodeChildren(child.children, em);
          strong.appendChild(em);
          container.appendChild(strong);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `italic`: {
          const em = document.createElement(`em`);
          em.dataset.nodeId = child.id;
          this.renderSyntaxNodeChildren(child.children, em);
          container.appendChild(em);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `strikethrough`: {
          const del = document.createElement(`del`);
          del.dataset.nodeId = child.id;
          this.renderSyntaxNodeChildren(child.children, del);
          container.appendChild(del);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `link`: {
          const a = document.createElement(`a`);
          a.dataset.nodeId = child.id;
          a.href = child.attributes.href ?? ``;
          this.renderSyntaxNodeChildren(child.children, a);
          container.appendChild(a);
          container.appendChild(document.createTextNode(``));
          break;
        }
        default: {
          // HTML inline tags (sub, sup, mark, u, etc.)
          if (child.attributes.tag) {
            const el = document.createElement(child.attributes.tag);
            el.dataset.nodeId = child.id;
            this.renderSyntaxNodeChildren(child.children, el);
            container.appendChild(el);
            container.appendChild(document.createTextNode(``));
          }
          break;
        }
      }
    }
  }

  /**
   * Recursively walks an InlineSegment tree and appends DOM nodes.
   * Used as fallback when SyntaxNode children are not available.
   * @param {InlineSegment[]} segments
   * @param {HTMLElement} container
   */
  appendSegments(segments, container) {
    for (const seg of segments) {
      switch (seg.type) {
        case `text`:
          container.appendChild(document.createTextNode(seg.text ?? ``));
          break;
        case `code`: {
          const code = document.createElement(`code`);
          code.textContent = seg.content ?? ``;
          container.appendChild(code);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `bold`: {
          const strong = document.createElement(`strong`);
          this.appendSegments(seg.children ?? [], strong);
          container.appendChild(strong);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `bold-italic`: {
          const strong = document.createElement(`strong`);
          const em = document.createElement(`em`);
          this.appendSegments(seg.children ?? [], em);
          strong.appendChild(em);
          container.appendChild(strong);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `italic`: {
          const em = document.createElement(`em`);
          this.appendSegments(seg.children ?? [], em);
          container.appendChild(em);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `strikethrough`: {
          const del = document.createElement(`del`);
          this.appendSegments(seg.children ?? [], del);
          container.appendChild(del);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `link`: {
          const a = document.createElement(`a`);
          a.href = seg.href ?? ``;
          this.appendSegments(seg.children ?? [], a);
          container.appendChild(a);
          container.appendChild(document.createTextNode(``));
          break;
        }
        case `image`: {
          const img = document.createElement(`img`);
          img.alt = seg.alt ?? ``;
          img.src = this.resolveImageSrc(seg.src ?? ``);
          container.appendChild(img);
          container.appendChild(document.createTextNode(``));
          break;
        }
        default: {
          // HTML inline tags (sub, sup, mark, span, br, etc.)
          if (seg.tag) {
            const el = document.createElement(seg.tag);
            if (seg.attrs) {
              for (const [key, value] of Object.entries(seg.attrs)) {
                el.setAttribute(key, value);
              }
            }
            this.appendSegments(seg.children ?? [], el);
            container.appendChild(el);
            container.appendChild(document.createTextNode(``));
          }
          break;
        }
      }
    }
  }

  /**
   * Compute the absolute cursor offset and capture the caret's pixel
   * position for scroll-preservation when leaving writing view.
   * @returns {Promise<ViewSwitchData>}
   */
  async leaveView() {
    const editor = this.editor;

    // Compute the absolute cursor offset so we can place the textarea
    // caret in the same position when entering source2.
    let absoluteCursorOffset;
    if (editor.syntaxTree?.treeCursor) {
      absoluteCursorOffset = cursorToAbsoluteOffset(
        editor.syntaxTree,
        editor.syntaxTree.treeCursor,
        editor.buildMarkdownLine.bind(editor),
        editor.getPrefixLength.bind(editor),
      );
    }

    // Capture the actual caret pixel position from the browser
    // selection so we can match it after the switch.
    let savedCaretTop;
    const scrollContainer = editor.container.parentElement;
    if (scrollContainer) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        // Firefox returns a zero-height rect for collapsed selections
        // after inline elements (e.g. <em>), producing a bogus top
        // value that would scroll the content off-screen.
        if (rect.height > 0) {
          const containerRect = scrollContainer.getBoundingClientRect();
          savedCaretTop = rect.top - containerRect.top;
        }
      }
    }

    // Anchor on the cursor's node if one exists, since that is what
    // the user is focused on.  Fall back to the node closest to the
    // viewport centre so content doesn't jump when there is no cursor.
    /** @type {string | undefined} */
    let anchorNodeId;
    let savedOffsetFromTop;

    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();

      // Prefer the cursor's node as anchor.
      if (editor.syntaxTree?.treeCursor) {
        const blockId = editor.getBlockNodeId();
        const cursorEl = blockId
          ? editor.container.querySelector(`[data-node-id="${blockId}"]`)
          : undefined;
        if (cursorEl && blockId) {
          anchorNodeId = blockId;
          savedOffsetFromTop = cursorEl.getBoundingClientRect().top - containerRect.top;
        }
      }

      // Fallback: node closest to the viewport centre.
      if (!anchorNodeId) {
        const centreY = containerRect.top + containerRect.height / 2;
        const nodeEls = editor.container.querySelectorAll(`[data-node-id]`);
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const el of nodeEls) {
          const rect = el.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          const dist = Math.abs(mid - centreY);
          if (dist < bestDistance) {
            bestDistance = dist;
            anchorNodeId = /** @type {HTMLElement} */ (el).dataset.nodeId ?? undefined;
            savedOffsetFromTop = rect.top - containerRect.top;
          }
        }
      }
    }

    return {
      absoluteCursorOffset,
      savedCaretTop,
      anchorNodeId,
      savedOffsetFromTop,
    };
  }

  /**
   * Activate writing view: restore contenteditable, render, restore
   * selection, and scroll-preserve.
   * @param {ViewSwitchData} data
   */
  enterView(data) {
    const editor = this.editor;
    const { savedCaretTop, anchorNodeId, savedOffsetFromTop } = data;
    const scrollContainer = editor.container.parentElement;

    editor.container.setAttribute(`contenteditable`, `true`);

    editor.viewMode = `writing`;
    editor.container.dataset.viewMode = `writing`;
    editor.fullRenderAndPlaceCursor();

    // If the tree owns a non-collapsed selection, rebuild it in the
    // new DOM so the user's selection survives the view-mode switch.
    if (editor.treeRange) {
      editor.placeSelection();
    }

    // Restore scroll so the anchor node sits at the same viewport offset.
    if (anchorNodeId && scrollContainer && savedOffsetFromTop !== undefined) {
      const el = editor.container.querySelector(`[data-node-id="${anchorNodeId}"]`);
      if (el) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const currentOffsetFromTop = el.getBoundingClientRect().top - containerRect.top;
        scrollContainer.scrollTop += currentOffsetFromTop - savedOffsetFromTop;
      }
    }

    // Scroll-preserve for source2 → writing: match the writing-mode
    // caret position to where it was in the source2 textarea.
    if (savedCaretTop !== undefined && scrollContainer) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const currentOffsetFromTop = rect.top - containerRect.top;
        scrollContainer.scrollTop += currentOffsetFromTop - savedCaretTop;
      }
    }
  }
}
