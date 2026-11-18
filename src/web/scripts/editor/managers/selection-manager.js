import { SelectionManagerData } from '../types.js';

/**
 * Manages text selection within the editor.
 */
export class SelectionManager extends SelectionManagerData {
  /**
   * @param {Editor} editor
   */
  constructor(editor) {
    super();
    this.editor = editor;
  }

  /**
   * Updates the selection state from the DOM.
   */
  updateFromDOM() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.currentSelection = undefined;
      this.currentNode = undefined;
      return;
    }

    const range = selection.getRangeAt(0);
    const container = this.editor.container;

    // Get the start and end positions relative to the editor content
    const startPos = this.getPositionInContent(range.startContainer, range.startOffset);
    const endPos = this.getPositionInContent(range.endContainer, range.endOffset);

    this.currentSelection = {
      startLine: startPos.line,
      startColumn: startPos.column,
      endLine: endPos.line,
      endColumn: endPos.column,
      isCollapsed: selection.isCollapsed,
    };

    // Update current node
    this.updateCurrentNode();

    // Dispatch selection change event
    this.dispatchSelectionChange();
  }

  /**
   * Gets the line and column position for a DOM position.
   * @param {Node} node - The DOM node
   * @param {number} offset - The offset within the node
   * @returns {{line: number, column: number}}
   */
  getPositionInContent(node, offset) {
    const content = this.editor.container.innerText;
    const lines = content.split(`\n`);

    // Get the text offset from the start of the editor
    const textOffset = this.getTextOffset(node, offset);

    // Convert text offset to line and column
    let currentOffset = 0;
    for (let line = 0; line < lines.length; line++) {
      const lineLength = lines[line].length;
      if (currentOffset + lineLength >= textOffset) {
        return {
          line,
          column: textOffset - currentOffset,
        };
      }
      currentOffset += lineLength + 1; // +1 for newline
    }

    // Default to end of content
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1]?.length ?? 0,
    };
  }

  /**
   * Gets the text offset from the start of the editor container.
   * @param {Node} node - The DOM node
   * @param {number} offset - The offset within the node
   * @returns {number}
   */
  getTextOffset(node, offset) {
    const container = this.editor.container;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

    let totalOffset = 0;
    let currentNode = walker.nextNode();

    while (currentNode) {
      if (currentNode === node) {
        return totalOffset + offset;
      }
      totalOffset += currentNode.textContent?.length ?? 0;
      currentNode = walker.nextNode();
    }

    return totalOffset;
  }

  /**
   * Updates the current node based on the selection.
   */
  updateCurrentNode() {
    if (!this.currentSelection || !this.editor.syntaxTree) {
      this.currentNode = undefined;
      return;
    }

    // Prefer the editor's treeCursor (set by syncCursorFromDOM via a
    // DOM data-node-id walk) because the text-offset-based line
    // calculation can be thrown off by html-block container elements.
    const cursorNodeId = this.editor.syntaxTree?.treeCursor?.nodeId;
    if (cursorNodeId) {
      this.currentNode = this.editor.syntaxTree.findNodeById(cursorNodeId) ?? undefined;
      if (this.currentNode) return;
    }

    // Fallback: find the node at the current cursor position
    this.currentNode =
      this.editor.syntaxTree.findNodeAtPosition(
        this.currentSelection.startLine,
        this.currentSelection.startColumn,
      ) ?? undefined;
  }

  /**
   * Gets the current selection state.
   * @returns {SelectionState | undefined}
   */
  getSelection() {
    return this.currentSelection;
  }

  /**
   * Gets the current syntax tree node at the cursor.
   * @returns {SyntaxNode | undefined}
   */
  getCurrentNode() {
    return this.currentNode;
  }

  /**
   * Dispatches a custom event for selection changes.
   */
  dispatchSelectionChange() {
    const event = new CustomEvent(`editor:selectionchange`, {
      bubbles: true,
      detail: {
        selection: this.currentSelection,
        node: this.currentNode,
      },
    });
    this.editor.container.dispatchEvent(event);
  }
}
