/// <reference path="../../../../types.d.ts" />

/**
 * The level of a heading, or 0 for any other block.
 * @param {SyntaxNode} node
 * @returns {number}
 */
function headingLevel(node) {
  const match = node.type.match(/^heading([1-6])$/);
  return match ? Number(match[1]) : 0;
}

/**
 * A block, and when it is a list item, the more deeply indented list
 * items directly after it, which are its sub-items.
 * @param {EditOperations} ops
 * @param {SyntaxNode} node
 * @returns {SyntaxNode[]}
 */
function withSubItems(ops, node) {
  if (node.type !== `list-item`) return [node];
  const siblings = ops.editor.getSiblings(node);
  const start = siblings.indexOf(node);
  const indent = node.attributes.indent || 0;
  let end = start + 1;
  while (
    end < siblings.length &&
    siblings[end].type === `list-item` &&
    (siblings[end].attributes.indent || 0) > indent
  ) {
    end++;
  }
  return siblings.slice(start, end);
}

/**
 * Applies Tab to a block by its type: a paragraph goes in a quote, one
 * quote deeper when it is already in one, a heading becomes one level
 * smaller up to h6, and a list item is indented with its sub-items.
 * @param {EditOperations} ops
 * @param {SyntaxNode} node
 * @returns {boolean} Whether the document changed.
 */
function indent(ops, node) {
  const level = headingLevel(node);
  if (node.type === `paragraph`) {
    ops.editor.wrapInQuote(node);
    return true;
  }
  if (level > 0 && level < 6) {
    node.type = `heading${level + 1}`;
    return true;
  }
  if (node.type === `list-item`) {
    for (const item of withSubItems(ops, node)) {
      item.attributes.indent = (item.attributes.indent || 0) + 1;
    }
    return true;
  }
  return false;
}

/**
 * Applies Shift+Tab to a block by its type: a heading becomes one level
 * larger up to h1, and a list item is undented with its sub-items.  A
 * block in a quote that this leaves unchanged is taken out of the quote,
 * with its sub-items when it is a list item.
 * @param {EditOperations} ops
 * @param {SyntaxNode} node
 * @returns {boolean} Whether the document changed.
 */
function undent(ops, node) {
  const level = headingLevel(node);
  if (level > 1) {
    node.type = `heading${level - 1}`;
    return true;
  }
  if (node.type === `list-item` && (node.attributes.indent || 0) > 0) {
    for (const item of withSubItems(ops, node)) {
      item.attributes.indent = (item.attributes.indent || 0) - 1;
    }
    return true;
  }
  if (node.parent?.type === `blockquote`) {
    for (const block of withSubItems(ops, node)) {
      ops.editor.liftOutOfQuote(block);
    }
    return true;
  }
  return false;
}

/**
 * Handles Tab and Shift+Tab in the writing view.  For the block the
 * caret or selection is in, they indent and undent it by its type, and
 * in a code block Tab types a tab character.  With several blocks
 * selected, Tab puts each in a quote and Shift+Tab takes each out of its
 * quote.  Tables are handled by the table manager instead.
 * @param {EditOperations} ops
 * @param {boolean} shift - Whether Shift was held.
 */
export async function handleTab(ops, shift) {
  const editor = ops.editor;
  editor.syncCursorFromDOM();
  if (!editor.syntaxTree) return;
  const before = editor.syntaxTree.toMarkdown();

  const range = editor.treeRange;
  if (range && range.startNodeId !== range.endNodeId) {
    let changed = false;
    for (const block of editor.getNodesInRange(range.startNodeId, range.endNodeId)) {
      if (!shift) {
        editor.wrapInQuote(block);
        changed = true;
      } else if (block.parent?.type === `blockquote`) {
        editor.liftOutOfQuote(block);
        changed = true;
      }
    }
    if (!changed) return;
    editor.treeRange = undefined;
    editor.recordAndRender(before);
    return;
  }

  const node = editor.getCurrentBlockNode();
  if (!node || node.isContainer() || node.type === `table`) return;

  if (node.type === `code-block` && !shift) {
    await ops.insertTextAtCursor(`\t`);
    return;
  }

  if (shift ? undent(ops, node) : indent(ops, node)) {
    editor.recordAndRender(before);
  }
}
