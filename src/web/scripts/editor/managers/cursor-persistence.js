/**
 * @fileoverview Cursor position ↔ absolute source offset conversion.
 *
 * These helpers convert between the editor's tree-based cursor
 * (`{ nodeId, offset }`) and an absolute character offset into the
 * raw markdown source string.  The absolute offset is stable across
 * parse cycles (provided the source hasn't changed) and can be
 * persisted to restore the cursor on next launch.
 */

import { separatorBetween } from '../../../../parsers/old/syntax-tree.js';
import { TableModal } from '../content-types/table/table-modal.js';

/**
 * The offset into a block's content of a tree cursor in it.  A caret in a
 * table cell is at its offset into that cell's text.
 * @param {SyntaxNode} node
 * @param {TreeCursor} cursor
 * @returns {number}
 */
function contentOffsetOf(node, cursor) {
  if (node.type !== `table` || cursor.cellRow === undefined || cursor.cellCol === undefined) {
    return cursor.offset;
  }
  const cell = TableModal.locateTableCells(node.content)[cursor.cellRow]?.[cursor.cellCol];
  if (!cell) return 0;
  return cell.start + Math.min(cursor.offset, cell.text.length);
}

/**
 * The tree cursor in a table for an offset into the table's content: in
 * the cell whose text the offset is in, or else in the last cell that
 * starts before it, kept inside that cell's text.
 * @param {SyntaxNode} node
 * @param {number} contentOffset
 * @returns {TreeCursor}
 */
function tableCellCursor(node, contentOffset) {
  let found = { cellRow: 0, cellCol: 0, offset: 0 };
  TableModal.locateTableCells(node.content).forEach((row, cellRow) => {
    row.forEach((cell, cellCol) => {
      if (cell.start <= contentOffset) {
        const offset = Math.min(contentOffset - cell.start, cell.text.length);
        found = { cellRow, cellCol, offset };
      }
    });
  });
  return { nodeId: node.id, ...found };
}

/**
 * The text between two blocks inside an html block's markdown, which is
 * always a blank line.
 * @returns {string}
 */
function separatorInsideHtmlBlock() {
  return `\n\n`;
}

/**
 * The length of the syntax in front of each line after the first of a
 * block's markdown: a blockquote has its `> ` on every line, other
 * blocks only have syntax in front of their first line.
 * @param {SyntaxNode} node
 * @param {number} prefix - The length of the syntax in front of the first line.
 * @returns {number}
 */
function linePrefixLength(node, prefix) {
  return node.type === `blockquote` ? prefix : 0;
}

/**
 * The offset into a block's markdown of an offset into its content.
 * @param {SyntaxNode} node
 * @param {number} offset - Offset into the node's content.
 * @param {number} prefix - The length of the syntax in front of the first line.
 * @returns {number}
 */
function contentToMarkdownOffset(node, offset, prefix) {
  const lineBreaks = node.content.slice(0, offset).split(`\n`).length - 1;
  return prefix + offset + lineBreaks * linePrefixLength(node, prefix);
}

/**
 * The offset into a block's content of an offset into its markdown at or
 * after the end of the syntax in front of the first line.  An offset in
 * the syntax in front of a later line gives the start of that line, and
 * one past the content gives its end.
 * @param {SyntaxNode} node
 * @param {number} markdownOffset - Offset into the node's markdown.
 * @param {number} prefix - The length of the syntax in front of the first line.
 * @returns {number}
 */
function markdownToContentOffset(node, markdownOffset, prefix) {
  const lines = node.content.split(`\n`);
  const linePrefix = linePrefixLength(node, prefix);
  let lineStart = prefix;
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = lineStart + lines[i].length;
    if (markdownOffset <= lineEnd || i === lines.length - 1) {
      return contentStart + Math.max(0, Math.min(markdownOffset - lineStart, lines[i].length));
    }
    lineStart = lineEnd + 1 + linePrefix;
    contentStart += lines[i].length + 1;
  }
  return node.content.length;
}

/**
 * Computes the absolute character offset into the raw markdown source
 * for the current tree cursor position.
 *
 * Walks `syntaxTree.children` in order, accumulating the markdown
 * length of each node (separated by `\n\n`).  When the node matching
 * `cursor.nodeId` is found, the final offset is the accumulated
 * position plus the node's prefix length plus the cursor offset.
 *
 * @param {SyntaxTree} tree
 * @param {TreeCursor} cursor
 * @param {(type: string, content: string, attrs: NodeAttributes) => string} buildMarkdownLine
 * @param {(type: string, attrs?: NodeAttributes) => number} getPrefixLength
 * @returns {number} Absolute offset, or -1 if the node was not found.
 */
export function cursorToAbsoluteOffset(tree, cursor, buildMarkdownLine, getPrefixLength) {
  let pos = 0;

  /**
   * Recursively walks nodes following the same structure as
   * `SyntaxNode.toMarkdown()` / `SyntaxTree.toMarkdown()`.
   *
   * @param {SyntaxNode[]} nodes
   * @param {(previous: SyntaxNode, next: SyntaxNode) => string} separatorFor
   * @returns {number} The absolute offset, or -1 if not found in this subtree.
   */
  function walk(nodes, separatorFor) {
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) pos += separatorFor(nodes[i - 1], nodes[i]).length;

      const node = nodes[i];

      // If this is the cursor node, compute final offset.
      // Also match when the cursor is on an inline child (e.g. <em>)
      // whose blockNodeId points to this block-level node — the
      // offset is already block-relative from computeOffsetInContent.
      if (node.id === cursor.nodeId || node.id === cursor.blockNodeId) {
        // For html-block containers, the cursor may be on the
        // opening/closing tag line (source view tagPart).
        if (node.type === `html-block` && node.children.length > 0 && !cursor.tagPart) {
          // Cursor is on a child — not this node itself.
          // Fall through to walk children below.
        } else if (cursor.tagPart === `closing`) {
          // Cursor is on the closing tag line of an html-block.
          const md = node.toMarkdown();
          const closingTag = node.attributes.closingTag ?? ``;
          return pos + md.length - closingTag.length + cursor.offset;
        } else if (cursor.prefixOffset !== undefined) {
          // Cursor is inside the syntax prefix (source view).
          return pos + cursor.prefixOffset;
        } else {
          const prefix = getPrefixLength(node.type, node.attributes);
          return pos + contentToMarkdownOffset(node, contentOffsetOf(node, cursor), prefix);
        }
      }

      // For html-block containers, walk children to find the cursor.
      if (node.type === `html-block` && node.children.length > 0) {
        const openingTag = node.attributes.openingTag ?? ``;

        // Check if this is a single bare-text child (collapsed form).
        if (
          node.children.length === 1 &&
          node.children[0].attributes.bareText &&
          node.children[0].type === `paragraph`
        ) {
          const child = node.children[0];
          if (child.id === cursor.nodeId) {
            // <tag>content</tag> — cursor is inside the content
            const tag = node.attributes.tagName || `div`;
            return pos + `<${tag}>`.length + cursor.offset;
          }
          // Not found here; advance past this node's markdown
          pos += node.toMarkdown().length;
          continue;
        }

        // Multi-child html-block: opening tag \n\n child1 \n\n child2 ... \n\n closing tag
        pos += openingTag.length;
        // Separator between opening tag and first child
        pos += `\n\n`.length;

        const result = walk(node.children, separatorInsideHtmlBlock);
        if (result !== -1) return result;

        // Closing tag
        if (node.attributes.closingTag) {
          pos += `\n\n`.length;
          pos += node.attributes.closingTag.length;
        }
      } else {
        // Leaf node — advance past its markdown
        pos += node.toMarkdown().length;
      }
    }
    return -1;
  }

  return walk(tree.children, separatorBetween);
}

/**
 * Resolves an absolute character offset in the raw markdown source
 * back to a tree cursor `{ nodeId, offset }`.
 *
 * Walks the tree in the same order as `cursorToAbsoluteOffset`,
 * subtracting each node's markdown length until the target offset
 * falls within the current node.
 *
 * @param {SyntaxTree} tree
 * @param {number} absoluteOffset
 * @param {(type: string, attrs?: NodeAttributes) => number} getPrefixLength
 * @returns {TreeCursor | undefined} The cursor, or undefined if offset is out of range.
 */
export function absoluteOffsetToCursor(tree, absoluteOffset, getPrefixLength) {
  let pos = 0;

  /**
   * @param {SyntaxNode[]} nodes
   * @param {(previous: SyntaxNode, next: SyntaxNode) => string} separatorFor
   * @returns {TreeCursor | undefined}
   */
  function walk(nodes, separatorFor) {
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) pos += separatorFor(nodes[i - 1], nodes[i]).length;

      const node = nodes[i];
      const md = node.toMarkdown();
      const nodeEnd = pos + md.length;

      if (absoluteOffset <= nodeEnd) {
        // Target is within this node (or at its end boundary).

        // For html-block containers with children, recurse.
        if (node.type === `html-block` && node.children.length > 0) {
          // Single bare-text child (collapsed):  <tag>content</tag>
          if (
            node.children.length === 1 &&
            node.children[0].attributes.bareText &&
            node.children[0].type === `paragraph`
          ) {
            const child = node.children[0];
            const tag = node.attributes.tagName || `div`;
            const openLen = `<${tag}>`.length;
            const contentOffset = absoluteOffset - pos - openLen;
            return {
              nodeId: child.id,
              offset: Math.max(0, Math.min(contentOffset, child.content.length)),
            };
          }

          // Multi-child: opening tag \n\n children \n\n closing tag
          const openingTag = node.attributes.openingTag ?? ``;
          const afterOpen = pos + openingTag.length + `\n\n`.length;

          if (absoluteOffset < afterOpen) {
            // Cursor is on the opening tag line
            return {
              nodeId: node.id,
              offset: Math.min(absoluteOffset - pos, openingTag.length),
              tagPart: `opening`,
            };
          }

          pos += openingTag.length + `\n\n`.length;
          const result = walk(node.children, separatorInsideHtmlBlock);
          if (result) return result;

          // If we get here, offset is in the closing tag area
          if (node.attributes.closingTag) {
            pos += `\n\n`.length;
            const closingOffset = absoluteOffset - pos;
            return {
              nodeId: node.id,
              offset: Math.max(0, Math.min(closingOffset, node.attributes.closingTag.length)),
              tagPart: `closing`,
            };
          }

          // Fallback
          return { nodeId: node.id, offset: 0 };
        }

        // Leaf node — the offset falls within this node's content.
        const prefix = getPrefixLength(node.type, node.attributes);
        if (absoluteOffset - pos < prefix) {
          // Cursor is inside the syntax prefix (source view).
          return {
            nodeId: node.id,
            offset: 0,
            prefixOffset: absoluteOffset - pos,
          };
        }
        const contentOffset = markdownToContentOffset(node, absoluteOffset - pos, prefix);
        if (node.type === `table`) return tableCellCursor(node, contentOffset);
        return { nodeId: node.id, offset: contentOffset };
      }

      pos += md.length;
    }
    return undefined;
  }

  const cursor = walk(tree.children, separatorBetween);
  if (cursor) return cursor;

  // Offset past the end — place cursor at end of last node.
  const last = tree.children[tree.children.length - 1];
  if (last) {
    return { nodeId: last.id, offset: last.content.length };
  }
  return undefined;
}
