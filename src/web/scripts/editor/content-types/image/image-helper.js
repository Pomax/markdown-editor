/**
 * @fileoverview Image-related helpers: inserting/updating image nodes,
 * opening the image edit modal, rewriting paths to relative form.
 */

/// <reference path="../../../../../types.d.ts" />

import { SyntaxNode } from '../../../../../parsers/old/syntax-node.js';
import { tokenizeInline } from '../../../../../parsers/old/inline-tokenizer.js';
import { ImageModal } from './image-modal.js';
import { ImageHelperData } from '../../types.js';

/**
 * An image in a block's markdown: where its markup starts and ends (a link
 * around nothing but the image included), where its source is, the
 * attributes of the `<img>` tag it was written as, and what the image
 * modal shows for it.
 * @typedef {{ start: number, end: number, srcStart: number, srcEnd: number, written: Record<string, string>, data: Partial<ImageData> }} ImageSpan
 */

/**
 * The offset into an `<img>` tag of the value of its `src` attribute, or
 * the tag's length when it has none.
 * @param {string} raw
 * @returns {number}
 */
function htmlSrcOffset(raw) {
  const match = /\ssrc\s*=\s*["']?/i.exec(raw);
  return match ? match.index + match[0].length : raw.length;
}

/**
 * Manages image-related operations for the editor.
 */
export class ImageHelper extends ImageHelperData {
  /**
   * @param {Editor} editor
   */
  constructor(editor) {
    super();
    this.editor = editor;
  }

  /**
   * Converts an absolute image path to a relative path when the image lives
   * in the same directory as (or a subdirectory of) the current document.
   * Returns the original path unchanged if no document is open or the image
   * is not downstream of the document's folder.
   *
   * Handles both raw filesystem paths and `file:///` URLs.
   * Delegates to the backend, which compares the paths the way the
   * filesystem does.
   *
   * @param {string} imagePath - The absolute image path or file:// URL
   * @returns {Promise<string>} A relative path (using forward slashes) or the original value
   */
  async toRelativeImagePath(imagePath) {
    if (!this.editor.currentFilePath || !imagePath || !window.pageToBackendBridge) return imagePath;
    return window.pageToBackendBridge.toRelativeImagePath(imagePath, this.editor.currentFilePath);
  }

  /**
   * Walks every image in the syntax tree's top-level blocks and rewrites
   * absolute paths that are downstream-relative to the current document to
   * their minimal relative form, changing nothing in the image's markup but
   * its source.  Only runs when `editor.ensureLocalPaths` is true and the
   * document has been saved to disk.
   *
   * @returns {Promise<string[]>} IDs of nodes whose paths were rewritten.
   */
  async rewriteImagePaths() {
    /** @type {string[]} */
    const changedIds = [];
    if (!this.editor.ensureLocalPaths || !this.editor.currentFilePath || !this.editor.syntaxTree)
      return changedIds;

    for (const node of this.editor.syntaxTree.children) {
      if (!this.editor.cursorManager.hasInlineFormatting(node.type)) continue;

      let content = node.content;
      for (const span of this.imageSpans(content).reverse()) {
        const src = span.data.src;
        if (!src) continue;
        const rewritten = await this.toRelativeImagePath(src);
        if (rewritten !== src) {
          content = content.slice(0, span.srcStart) + rewritten + content.slice(span.srcEnd);
        }
      }
      if (content !== node.content) {
        node.content = content;
        changedIds.push(node.id);
      }
    }
    return changedIds;
  }

  /**
   * Updates the image at the cursor, or inserts a paragraph holding a new
   * image when the cursor is on none.
   * @param {string} alt - Alt text
   * @param {string} src - Image source path or URL
   * @param {string} href - Optional link URL (empty string for no link)
   * @param {string} [style] - Optional inline style
   * @param {string} [className] - Optional class names
   */
  insertOrUpdateImage(alt, src, href, style = ``, className = ``) {
    if (!this.editor.syntaxTree) return;

    const target = this.imageAtCursor();
    if (target) {
      this.replaceImage(target.block, target.span, { alt, src, href, style, className });
      return;
    }

    const before = this.editor.syntaxTree.toMarkdown();
    const currentNode = this.editor.getCurrentBlockNode();
    const markup = SyntaxNode.imageMarkup({ alt, src, href, style, className });
    const paragraph = new SyntaxNode(`paragraph`, markup);
    let renderHints;

    if (currentNode) {
      const siblings = this.editor.getSiblings(currentNode);
      const idx = siblings.indexOf(currentNode);
      // If the current node is an empty paragraph, replace it
      if (currentNode.type === `paragraph` && currentNode.content === ``) {
        siblings.splice(idx, 1, paragraph);
        paragraph.parent = currentNode.parent;
        currentNode.parent = undefined;
        renderHints = { added: [paragraph.id], removed: [currentNode.id] };
      } else {
        // Insert after current node
        siblings.splice(idx + 1, 0, paragraph);
        paragraph.parent = currentNode.parent;
        renderHints = { added: [paragraph.id] };
      }
    } else {
      this.editor.syntaxTree.appendChild(paragraph);
      renderHints = { added: [paragraph.id] };
    }

    this.editor.syntaxTree.treeCursor = { nodeId: paragraph.id, offset: markup.length };
    this.editor.recordAndRender(before, renderHints);
  }

  /**
   * Whether a node is an image: an `![alt](src)` or an `<img>` tag.
   * @param {SyntaxNode} node
   * @returns {boolean}
   */
  isImageNode(node) {
    return node.type === `inline-image` || node.attributes.tag === `img`;
  }

  /**
   * The image nodes inside a block, in document order.
   * @param {SyntaxNode} block
   * @returns {SyntaxNode[]}
   */
  imageNodesOf(block) {
    /** @type {SyntaxNode[]} */
    const found = [];
    /** @param {SyntaxNode[]} nodes */
    const walk = (nodes) => {
      for (const node of nodes) {
        if (this.isImageNode(node)) found.push(node);
        walk(node.children);
      }
    };
    walk(block.children);
    return found;
  }

  /**
   * Finds each image in a block's markdown, in the order of the block's
   * image nodes.
   * @param {string} content
   * @returns {ImageSpan[]}
   */
  imageSpans(content) {
    const tokens = tokenizeInline(content);
    /** @type {number[]} */
    const starts = [];
    let pos = 0;
    for (const token of tokens) {
      starts.push(pos);
      pos += token.raw.length;
    }

    /** @type {ImageSpan[]} */
    const spans = [];
    tokens.forEach((token, i) => {
      const markdown = token.type === `image`;
      if (!markdown && !(token.type === `html-void` && token.tag === `img`)) return;
      const linked = tokens[i - 1]?.type === `link-open` && tokens[i + 1]?.type === `link-close`;
      const first = linked ? i - 1 : i;
      const last = linked ? i + 1 : i;
      /** @type {Record<string, string>} */
      const written = markdown ? {} : { ...token.attrs };
      const src = (markdown ? token.src : written.src) ?? ``;
      const srcStart =
        starts[i] + (markdown ? (token.alt ?? ``).length + 4 : htmlSrcOffset(token.raw));
      spans.push({
        start: starts[first],
        end: starts[last] + tokens[last].raw.length,
        srcStart,
        srcEnd: srcStart + src.length,
        written,
        data: {
          alt: (markdown ? token.alt : written.alt) ?? ``,
          src,
          href: linked ? (tokens[i + 1].href ?? ``) : ``,
          style: written.style ?? ``,
          className: written.class ?? ``,
        },
      });
    });
    return spans;
  }

  /**
   * The image at the cursor: the one whose markup the cursor is in, or at
   * either end of, in a block with inline content.
   * @returns {{ block: SyntaxNode, span: ImageSpan } | undefined}
   */
  imageAtCursor() {
    const block = this.editor.getCurrentBlockNode();
    const offset = this.editor.syntaxTree?.treeCursor?.offset;
    if (!block || offset === undefined) return undefined;
    if (!this.editor.cursorManager.hasInlineFormatting(block.type)) return undefined;
    const span = this.imageSpans(block.content).find(
      (candidate) => candidate.start <= offset && offset <= candidate.end,
    );
    return span ? { block, span } : undefined;
  }

  /**
   * Puts an edited image in the place of an image in a block's markdown,
   * with the cursor after it.
   * @param {SyntaxNode} block
   * @param {ImageSpan} span
   * @param {Partial<ImageData>} data
   */
  replaceImage(block, span, data) {
    if (!this.editor.syntaxTree) return;
    const before = this.editor.syntaxTree.toMarkdown();
    const markup = SyntaxNode.imageMarkup(data, span.written);
    block.content = block.content.slice(0, span.start) + markup + block.content.slice(span.end);
    this.editor.syntaxTree.treeCursor = { nodeId: block.id, offset: span.start + markup.length };
    this.editor.recordAndRender(before, { updated: [block.id] });
  }

  /**
   * Returns the shared ImageModal instance, creating it lazily.
   * Both the toolbar and editor use this to avoid duplicate dialogs.
   * @returns {ImageModal}
   */
  getImageModal() {
    if (!this.imageModal) {
      this.imageModal = new ImageModal();
    }
    return this.imageModal;
  }

  /**
   * Opens the image modal pre-filled with an image's data, and puts the
   * edited image in its place in its block's markdown.
   * Used when clicking an image in writing mode.
   * @param {SyntaxNode} node - The image's node
   */
  async openImageModalForNode(node) {
    const block = node.getBlockParent();
    const span = this.imageSpans(block.content)[this.imageNodesOf(block).indexOf(node)];
    if (!span) return;

    const result = await this.getImageModal().open(span.data);
    if (!result) return;

    let src = result.src;

    // Handle file rename if the filename changed
    if (result.rename && window.pageToBackendBridge) {
      const originalFilename = this.extractFilename(src);
      if (result.rename !== originalFilename) {
        const renameResult = await window.pageToBackendBridge.renameImage(
          this.resolveImagePath(src),
          result.rename,
        );
        if (renameResult.success && renameResult.newPath) {
          src = this.replaceFilename(src, result.rename);
        }
      }
    }

    // Use a relative path when the setting is enabled
    if (this.editor.ensureLocalPaths) {
      src = await this.toRelativeImagePath(src);
    }

    this.replaceImage(block, span, { ...result, src });
  }

  /**
   * Extracts the filename from a path or URL.
   * @param {string} src
   * @returns {string}
   */
  extractFilename(src) {
    if (!src) return ``;
    const clean = src.split(`?`)[0].split(`#`)[0];
    const parts = clean.split(/[/\\]/);
    return parts[parts.length - 1] || ``;
  }

  /**
   * Replaces the filename portion of a path or URL.
   * @param {string} src - Original path
   * @param {string} newName - New filename
   * @returns {string}
   */
  replaceFilename(src, newName) {
    const lastSlash = Math.max(src.lastIndexOf(`/`), src.lastIndexOf(`\\`));
    if (lastSlash === -1) return newName;
    return src.substring(0, lastSlash + 1) + newName;
  }

  /**
   * Resolves an image src to an absolute file path for rename operations.
   * Strips file:/// prefix and decodes URI encoding.
   * @param {string} src
   * @returns {string}
   */
  resolveImagePath(src) {
    let resolved = src;
    if (resolved.startsWith(`file:///`)) {
      resolved = resolved.slice(8);
    }
    resolved = decodeURIComponent(resolved);
    resolved = resolved.replace(/\//g, `\\`);
    return resolved;
  }
}
