/**
 * @fileoverview Tree-based formatter for writing view mode.
 * Delegates all formatting operations to the editor's existing tree-based
 * methods. Implements the {@link Formatter} interface.
 */

/// <reference path="../../../../types.d.ts" />

import { TreeFormatterData } from '../types.js';

/**
 * Formatter that operates on the syntax tree via the editor's existing methods.
 * Used for `writing` view mode.
 * @implements {Formatter}
 */
export class TreeFormatter extends TreeFormatterData {
  /**
   * @param {Editor} editor
   */
  constructor(editor) {
    super();
    this.editor = editor;
  }

  /**
   * Applies an inline format to the current selection.
   * @param {string} format
   */
  applyFormat(format) {
    this.editor.applyFormat(format);
  }

  /**
   * Changes the block type of the current element.
   * @param {string} elementType
   */
  changeElementType(elementType) {
    this.editor.changeElementType(elementType);
  }

  /**
   * Toggles list formatting on the current node.
   * @param {'unordered' | 'ordered' | 'checklist'} kind
   * @returns {Promise<void>}
   */
  async toggleList(kind) {
    await this.editor.toggleList(kind);
  }

  /**
   * Inserts or updates an image at the cursor.
   * @param {string} alt
   * @param {string} src
   * @param {string} href
   * @param {string} [style]
   * @param {string} [className]
   */
  insertOrUpdateImage(alt, src, href, style = ``, className = ``) {
    this.editor.insertOrUpdateImage(alt, src, href, style, className);
  }

  /**
   * Inserts or updates a table at the cursor.
   * @param {TableData} tableData
   */
  insertOrUpdateTable(tableData) {
    this.editor.insertOrUpdateTable(tableData);
  }

  /**
   * Returns the selected span of the current block's raw content, or
   * the collapsed cursor offset when nothing is selected. Selections
   * that span more than one block yield undefined.
   * @returns {{ node: SyntaxNode, start: number, end: number } | undefined}
   */
  getSelectedSpan() {
    const node = this.editor.getCurrentBlockNode();
    const cursor = this.editor.syntaxTree?.treeCursor;
    if (!node || !cursor) return undefined;

    const range = this.editor.treeRange;
    if (!range) return { node, start: cursor.offset, end: cursor.offset };
    if (range.startNodeId !== node.id || range.endNodeId !== node.id) return undefined;

    return {
      node,
      start: Math.min(range.startOffset, range.endOffset),
      end: Math.max(range.startOffset, range.endOffset),
    };
  }

  /**
   * Returns prefill data for the link modal: the selected text, if any.
   * @returns {Partial<LinkData>}
   */
  getLinkPrefill() {
    const span = this.getSelectedSpan();
    if (!span || span.start === span.end) return {};
    return { text: span.node.content.substring(span.start, span.end) };
  }

  /**
   * Replaces the current selection, or inserts at the cursor, with a
   * markdown link and places the cursor after it.
   * @param {string} text - The link display text
   * @param {string} url - The link URL
   */
  insertOrUpdateLink(text, url) {
    const tree = this.editor.syntaxTree;
    const span = this.getSelectedSpan();
    if (!tree || !span) return;

    const { node, start, end } = span;
    const before = tree.toMarkdown();
    const link = `[${text}](${url})`;
    node.content = node.content.substring(0, start) + link + node.content.substring(end);

    tree.treeCursor = { nodeId: node.id, offset: start + link.length };
    this.editor.treeRange = undefined;
    this.editor.recordAndRender(before, { updated: [node.id] });
  }
}
