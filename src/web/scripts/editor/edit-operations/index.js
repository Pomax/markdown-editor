/**
 * @fileoverview Tree-level edit operations: inserting text, backspace,
 * delete, and Enter key handling.
 *
 * All edits flow through the parse tree: user input is intercepted,
 * applied to the tree, and then the DOM is re-rendered from the tree.
 *
 * The heavy per-operation logic lives in separate files; this module
 * wires them together into the EditOperations class.
 */

/// <reference path="../../../../types.d.ts" />

import { SyntaxNode } from '../../../../parsers/old/syntax-node.js';
import { insertTextAtCursor } from './insert.js';
import { handleBackspace } from './backspace.js';
import { handleDelete } from './delete.js';
import { handleEnterKey } from './enter.js';
import { handleTab } from './tab.js';
import { EditOperationsData } from '../types.js';

/**
 * Node types that should be removed when left empty after a
 * selection-delete.  Easily extensible as new element types are added.
 * @type {Set<string>}
 */
const REMOVABLE_WHEN_EMPTY = new Set([
  `paragraph`,
  `heading1`,
  `heading2`,
  `heading3`,
  `heading4`,
  `heading5`,
  `heading6`,
  `blockquote`,
  `list-item`,
  `code-block`,
  `table`,
  `html-block`,
]);

/**
 * Handles tree-level edit operations on the syntax tree.
 */
export class EditOperations extends EditOperationsData {
  /**
   * @param {Editor} editor
   */
  constructor(editor) {
    super();
    this.editor = editor;
  }

  /**
   * After a selection-delete, checks whether the surviving node is empty
   * and should be removed entirely.  If so, removes it from the tree,
   * moves the cursor to an adjacent node, and updates the render hints.
   *
   * If removing the node would leave the document empty, a fresh empty
   * paragraph is inserted instead.
   *
   * @param {{ before: string, hints: { updated?: string[], added?: string[], removed?: string[] } }} result
   *     The result object from `deleteSelectedRange()`, mutated in place.
   */
  cleanupEmptyNodeAfterDelete(result) {
    const node = this.editor.getCurrentBlockNode();
    if (!node || !this.editor.syntaxTree) return;

    // Only remove types in the extensible set.
    if (!REMOVABLE_WHEN_EMPTY.has(node.type)) return;

    // Check if the node is truly empty.
    if (node.content !== ``) return;
    // For tables, content is '' but rows may still have data — skip.
    if (node.type === `table`) return;
    // For html-blocks with children, skip unless all children are gone.
    if (node.type === `html-block` && node.children.length > 0) return;

    const siblings = this.editor.getSiblings(node);
    const idx = siblings.indexOf(node);
    const wasListItem = node.type === `list-item`;
    const parent = node.parent;

    // Remove the empty node from the tree.
    siblings.splice(idx, 1);
    node.parent = undefined;
    const removedIds = result.hints.removed ?? [];
    result.hints.removed = removedIds;
    removedIds.push(node.id);

    // A quote left with no blocks is removed too.
    const emptied = this.editor.removeEmptyQuotes(parent);
    if (emptied) removedIds.push(...emptied.removed);

    // Remove from updated hints — it no longer exists.
    if (result.hints.updated) {
      result.hints.updated = result.hints.updated.filter((id) => id !== node.id);
    }

    // Renumber adjacent ordered list items after removing a list item.
    if (wasListItem && siblings.length > 0) {
      const renumberIdx = Math.min(idx, siblings.length - 1);
      const renumbered = this.editor.renumberAdjacentList(siblings, renumberIdx);
      for (const id of renumbered) {
        if (!result.hints.updated) result.hints.updated = [];
        if (!result.hints.updated.includes(id)) {
          result.hints.updated.push(id);
        }
      }
    }

    // If document is now empty, insert a fresh paragraph.
    if (this.editor.syntaxTree.children.length === 0) {
      const fresh = new SyntaxNode(`paragraph`, ``);
      this.editor.syntaxTree.children.push(fresh);
      if (!result.hints.added) result.hints.added = [];
      result.hints.added.push(fresh.id);
      this.editor.syntaxTree.treeCursor = { nodeId: fresh.id, offset: 0 };
      return;
    }

    // Move cursor to the adjacent node.
    const around = emptied ?? { siblings, index: idx };
    const newIdx = Math.min(around.index, around.siblings.length - 1);
    if (newIdx >= 0 && newIdx < around.siblings.length) {
      const target = around.siblings[newIdx].firstLeaf();
      this.editor.syntaxTree.treeCursor = {
        nodeId: target.id,
        offset: 0,
      };
    }
  }

  /**
   * Replaces a block whose markdown line starts with `> ` by the blocks
   * that line parses to, a quote first, with the caret in the quote's
   * first block at the same place in the text.
   * @param {SyntaxNode} node
   * @param {string} line - The block's markdown line.
   * @param {number} caret - The caret's offset into the line.
   */
  async replaceWithQuote(node, line, caret) {
    if (!this.editor.syntaxTree) return;
    const blocks = await this.editor.parseMultiLine(line);
    this.editor.replaceBlock(node, blocks);
    const leaf = blocks[0].firstLeaf();
    const textAfterCaret = Math.max(0, line.split(`\n`)[0].length - caret);
    this.editor.syntaxTree.treeCursor = {
      nodeId: leaf.id,
      offset: Math.max(0, leaf.content.split(`\n`)[0].length - textAfterCaret),
    };
  }

  /**
   * Inserts text at the current tree cursor position, re-parses the affected
   * line to detect type changes (e.g. `# ` → heading), and re-renders.
   * @param {string} text
   */
  async insertTextAtCursor(text) {
    await insertTextAtCursor(this, text);
  }

  /**
   * Handles the Backspace key.
   */
  async handleBackspace() {
    await handleBackspace(this);
  }

  /**
   * Handles the Delete key.
   */
  async handleDelete() {
    await handleDelete(this);
  }

  /**
   * Handles the Enter key — splits the current node at the cursor.
   */
  handleEnterKey() {
    handleEnterKey(this);
  }

  /**
   * Handles Tab and Shift+Tab in the writing view.
   * @param {boolean} shift - Whether Shift was held.
   */
  async handleTab(shift) {
    await handleTab(this, shift);
  }
}
