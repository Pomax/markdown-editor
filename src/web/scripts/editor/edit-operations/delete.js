/// <reference path="../../../../types.d.ts" />

/**
 * Handles the Delete key.
 * @param {EditOperations} ops
 */
export async function handleDelete(ops) {
  ops.editor.syncCursorFromDOM();

  // If there is a non-collapsed selection, delete the entire range
  // instead of a single character.
  if (ops.editor.treeRange) {
    const rangeResult = ops.editor.rangeOperations.deleteSelectedRange();
    if (rangeResult) {
      ops.cleanupEmptyNodeAfterDelete(rangeResult);
      ops.editor.recordAndRender(rangeResult.before, rangeResult.hints);
      return;
    }
  }

  const node = ops.editor.getCurrentBlockNode();
  if (!node || !ops.editor.syntaxTree || !ops.editor.syntaxTree.treeCursor) return;

  // Containers are structural (writing view).
  if (node.isContainer()) return;

  // Table cell delete
  if (
    node.type === `table` &&
    ops.editor.syntaxTree.treeCursor.cellRow !== undefined &&
    ops.editor.syntaxTree.treeCursor.cellCol !== undefined
  ) {
    const { cellRow, cellCol, offset } = ops.editor.syntaxTree.treeCursor;
    const cellText = ops.editor.tableManager.getTableCellText(node, cellRow, cellCol);
    if (offset < cellText.length) {
      const before = ops.editor.syntaxTree.toMarkdown();
      const left = cellText.substring(0, offset);
      const right = cellText.substring(offset + 1);
      ops.editor.tableManager.setTableCellText(node, cellRow, cellCol, left + right);
      ops.editor.syntaxTree.treeCursor = {
        nodeId: node.id,
        offset,
        cellRow,
        cellCol,
      };
      ops.editor.recordAndRender(before, { updated: [node.id] });
    }
    // At end of cell — no-op
    return;
  }

  const before = ops.editor.syntaxTree.toMarkdown();
  /** @type {{ updated?: string[], added?: string[], removed?: string[] }} */
  let renderHints = { updated: [node.id] };

  const effectiveLength = node.content.length;

  if (ops.editor.syntaxTree.treeCursor.offset < effectiveLength) {
    // Delete one character after the cursor
    const left = node.content.substring(0, ops.editor.syntaxTree.treeCursor.offset);
    const right = node.content.substring(ops.editor.syntaxTree.treeCursor.offset + 1);
    const newContent = left + right;
    const oldType = node.type;
    const oldPrefixLen = ops.editor.getPrefixLength(node.type, node.attributes);

    // Code-block content is raw code — skip re-parsing.
    if (node.type === `code-block`) {
      node.content = newContent;
      ops.editor.syntaxTree.treeCursor = {
        nodeId: node.id,
        offset: left.length,
      };
      ops.editor.recordAndRender(before, { updated: [node.id] });
      return;
    }

    // Re-parse to detect type changes
    const wasBareText = !!node.attributes.bareText;
    const fullLine = ops.editor.buildMarkdownLine(node.type, newContent, node.attributes);
    const parsed = await ops.editor.reparseLine(fullLine);

    // A line that starts with `> ` becomes a quote around what follows.
    if (parsed?.type === `blockquote` && fullLine.startsWith(`> `)) {
      await ops.replaceWithQuote(node, fullLine, oldPrefixLen + left.length);
      ops.editor.recordAndRender(before);
      return;
    }

    if (parsed && parsed.type !== `blockquote`) {
      node.type = parsed.type;
      node.content = parsed.content;
      node.attributes = parsed.attributes;
    } else {
      node.content = newContent;
    }

    // Preserve the bareText flag (see insertTextAtCursor).
    if (wasBareText) {
      node.attributes.bareText = true;
    }

    // The absolute cursor position in the full markdown line doesn't
    // change on delete — only the character to the right is removed.
    const absPos = oldPrefixLen + left.length;
    const newPrefixLen = ops.editor.getPrefixLength(node.type, node.attributes);
    ops.editor.syntaxTree.treeCursor = {
      nodeId: node.id,
      offset: Math.max(0, absPos - newPrefixLen),
    };
  } else {
    // Cursor is at the end — merge with the next node.
    const siblings = ops.editor.getSiblings(node);
    const idx = siblings.indexOf(node);
    if (idx < siblings.length - 1) {
      const next = siblings[idx + 1];

      if ((node.type === `paragraph` || node.type === `list-item`) && node.content === ``) {
        // An empty paragraph or list item is empty space, which is
        // removed, keeping the block after it.
        siblings.splice(idx, 1);
        node.parent = undefined;
        const first = next.firstLeaf();
        ops.editor.syntaxTree.treeCursor =
          first.type === `table`
            ? { nodeId: first.id, offset: 0, cellRow: 0, cellCol: 0 }
            : { nodeId: first.id, offset: 0 };
        renderHints = { updated: [next.id], removed: [node.id] };
      } else if (next.isContainer()) {
        // In writing view, merge the first block inside the
        // container into this node.
        const firstChild = next.firstLeaf();
        const holder = /** @type {SyntaxNode} */ (firstChild.parent);
        const curLen = node.content.length;
        node.content += firstChild.content;
        holder.children.splice(holder.children.indexOf(firstChild), 1);
        firstChild.parent = undefined;
        const removed = [firstChild.id];
        // A quote left with no blocks is removed too.
        removed.push(...(ops.editor.removeEmptyQuotes(holder)?.removed ?? []));
        // If the html-block is now empty, remove it too.
        if (next.type === `html-block` && next.children.length === 0) {
          siblings.splice(idx + 1, 1);
          next.parent = undefined;
          removed.push(next.id);
        }
        ops.editor.syntaxTree.treeCursor = {
          nodeId: node.id,
          offset: curLen,
        };
        renderHints = { updated: [node.id], removed };
      } else {
        const curLen = node.content.length;
        node.content += next.content;
        siblings.splice(idx + 1, 1);
        next.parent = undefined;
        ops.editor.syntaxTree.treeCursor = { nodeId: node.id, offset: curLen };
        renderHints = { updated: [node.id], removed: [next.id] };
      }
    }
  }

  ops.editor.recordAndRender(before, renderHints);
}
