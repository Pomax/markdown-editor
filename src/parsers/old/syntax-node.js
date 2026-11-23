import { buildInlineTree, tokenizeInline } from './inline-tokenizer.js';

/**
 * Node types whose content contains inline formatting and should be
 * modelled as inline child nodes (text, bold, italic, link, etc.).
 * @type {Set<string>}
 */
const INLINE_CONTENT_TYPES = new Set([
  `paragraph`,
  `heading1`,
  `heading2`,
  `heading3`,
  `heading4`,
  `heading5`,
  `heading6`,
  `list-item`,
]);

/**
 * The text between two sibling blocks in markdown: a newline between
 * two list items, a blank line between anything else.
 * @param {SyntaxNode} previous
 * @param {SyntaxNode} next
 * @returns {string}
 */
export function separatorBetween(previous, next) {
  return previous.type === `list-item` && next.type === `list-item` ? `\n` : `\n\n`;
}

/**
 * Counter for generating unique node IDs.
 * @type {number}
 */
let nodeIdCounter = 0;

/**
 * Generates a unique node ID.
 * @returns {string}
 */
function generateNodeId() {
  return `node-${++nodeIdCounter}`;
}

/**
 * Represents a node in the syntax tree.
 */
export class SyntaxNode {
  /**
   * @param {string} type - The node type (heading1-6, paragraph, etc.)
   * @param {string} content - The text content of the node
   */
  constructor(type, content = ``) {
    /**
     * Unique identifier for this node.
     * @type {string}
     */
    this.id = generateNodeId();

    /**
     * The type of node.
     * @type {string}
     */
    this.type = type;

    /**
     * The raw text content (backing field for the `content` accessor).
     * @type {string}
     */
    this.__content = content;

    /**
     * Child nodes.  For inline-containing block types (paragraph,
     * heading, list-item), children are inline nodes (text, bold,
     * italic, link, etc.).  For container blocks (blockquote,
     * html-block), children are other block-level nodes.
     * @type {SyntaxNode[]}
     */
    this.children = [];

    /**
     * Parent node reference.
     * @type {SyntaxNode | undefined}
     */
    this.parent;

    /**
     * Additional attributes for the node.
     * @type {NodeAttributes}
     */
    this.attributes = {};

    /**
     * Starting line in the source (0-based).
     * @type {number}
     */
    this.startLine = 0;

    /**
     * Ending line in the source (0-based).
     * @type {number}
     */
    this.endLine = 0;

    // Build inline children for types that contain inline formatting.
    if (content && INLINE_CONTENT_TYPES.has(type)) {
      this.buildInlineChildren();
    }
  }

  /** @returns {string} */
  get content() {
    return this.__content;
  }

  /** @param {string} val */
  set content(val) {
    this.__content = val;
    if (INLINE_CONTENT_TYPES.has(this.type)) {
      this.buildInlineChildren();
    }
  }

  /**
   * (Re)builds inline child nodes from this node's raw content.
   * Only meaningful for inline-containing types (paragraph, heading,
   * list-item).
   */
  buildInlineChildren() {
    this.children = [];
    if (!this.__content) return;
    const tokens = tokenizeInline(this.__content);
    const segments = buildInlineTree(tokens);
    for (const seg of segments) {
      this.appendChild(SyntaxNode.segmentToNode(seg));
    }
  }

  /**
   * Converts an InlineSegment (from buildInlineTree) into a SyntaxNode.
   * @param {InlineSegment} segment
   * @returns {SyntaxNode}
   */
  static segmentToNode(segment) {
    switch (segment.type) {
      case `text`:
        return new SyntaxNode(`text`, segment.text ?? ``);
      case `code`:
        return new SyntaxNode(`inline-code`, segment.content ?? ``);
      case `image`: {
        const img = new SyntaxNode(`inline-image`, ``);
        img.attributes.alt = segment.alt ?? ``;
        img.attributes.src = segment.src ?? ``;
        return img;
      }
      default: {
        // Containers: bold, italic, bold-italic, strikethrough,
        // link, and HTML inline tags (sub, sup, etc.)
        const node = new SyntaxNode(segment.type, ``);
        if (segment.href) node.attributes.href = segment.href;
        if (segment.tag) node.attributes.tag = segment.tag;
        if (segment.children) {
          for (const child of segment.children) {
            node.appendChild(SyntaxNode.segmentToNode(child));
          }
        }
        return node;
      }
    }
  }

  /**
   * Adds a child node.
   * @param {SyntaxNode} child - The child node to add
   */
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  /**
   * Returns the nearest block-level ancestor (an INLINE_CONTENT_TYPES node,
   * or any node inside a container), or `this` if this node is itself a
   * block-level node.
   * @returns {SyntaxNode}
   */
  getBlockParent() {
    /** @type {SyntaxNode} */
    let node = this;
    while (node.parent) {
      if (INLINE_CONTENT_TYPES.has(node.type) || node.parent.isContainer()) return node;
      node = node.parent;
    }
    return node;
  }

  /**
   * Returns true if this node is an inline child (created by
   * buildInlineChildren), not a block-level node.
   * @returns {boolean}
   */
  isInlineNode() {
    return this.getBlockParent() !== this;
  }

  /**
   * Returns true if this node holds block-level children: a blockquote,
   * or an html-block with children.
   * @returns {boolean}
   */
  isContainer() {
    return this.type === `blockquote` || (this.type === `html-block` && this.children.length > 0);
  }

  /**
   * Returns the first block inside this node that is not a container,
   * or this node when it is not a container.
   * @returns {SyntaxNode}
   */
  firstLeaf() {
    /** @type {SyntaxNode} */
    let node = this;
    while (node.isContainer() && node.children.length > 0) {
      node = node.children[0];
    }
    return node;
  }

  /**
   * Returns the last block inside this node that is not a container,
   * or this node when it is not a container.
   * @returns {SyntaxNode}
   */
  lastLeaf() {
    /** @type {SyntaxNode} */
    let node = this;
    while (node.isContainer() && node.children.length > 0) {
      node = node.children[node.children.length - 1];
    }
    return node;
  }

  /**
   * Removes a child node.
   * @param {SyntaxNode} child - The child node to remove
   * @returns {boolean} Whether the child was found and removed
   */
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parent = undefined;
      return true;
    }
    return false;
  }

  /**
   * Inserts a node before another node.
   * @param {SyntaxNode} newNode - The node to insert
   * @param {SyntaxNode} referenceNode - The node to insert before
   * @returns {boolean} Whether the insertion was successful
   */
  insertBefore(newNode, referenceNode) {
    const index = this.children.indexOf(referenceNode);
    if (index !== -1) {
      newNode.parent = this;
      this.children.splice(index, 0, newNode);
      return true;
    }
    return false;
  }

  /**
   * Converts this node to markdown.
   * @returns {string}
   */
  toMarkdown() {
    switch (this.type) {
      case `heading1`:
        return `# ${this.content}`;
      case `heading2`:
        return `## ${this.content}`;
      case `heading3`:
        return `### ${this.content}`;
      case `heading4`:
        return `#### ${this.content}`;
      case `heading5`:
        return `##### ${this.content}`;
      case `heading6`:
        return `###### ${this.content}`;
      case `paragraph`:
        return this.content;
      case `blockquote`:
        return SyntaxNode.quoteMarkdown(SyntaxNode.blocksToMarkdown(this.children));
      case `code-block`: {
        const lang = this.attributes.language || ``;
        const fence = `\``.repeat(this.attributes.fenceCount || 3);
        return `${fence}${lang}\n${this.content}\n${fence}`;
      }
      case `list-item`: {
        const indent = `  `.repeat(this.attributes.indent || 0);
        const marker = this.attributes.ordered ? `${this.attributes.number || 1}. ` : `- `;
        const checkbox =
          typeof this.attributes.checked === `boolean`
            ? this.attributes.checked
              ? `[x] `
              : `[ ] `
            : ``;
        return `${indent}${marker}${checkbox}${this.content}`;
      }
      case `horizontal-rule`:
        return `---`;
      case `image`: {
        const imgAlt = this.attributes.alt ?? this.content;
        const imgSrc = this.attributes.url ?? ``;
        const imgStyle = this.attributes.style ?? ``;
        const imgClass = this.attributes.className ?? ``;
        if (imgStyle || imgClass) {
          const altAttr = imgAlt ? ` alt="${imgAlt}"` : ``;
          const classAttr = imgClass ? ` class="${imgClass}"` : ``;
          const styleAttr = imgStyle ? ` style="${imgStyle}"` : ``;
          return `<img src="${imgSrc}"${altAttr}${classAttr}${styleAttr} />`;
        }
        if (this.attributes.href) {
          return `[![${imgAlt}](${imgSrc})](${this.attributes.href})`;
        }
        return `![${imgAlt}](${imgSrc})`;
      }
      case `table`:
        return this.content;
      case `html-block`: {
        // Raw content tags (script, style, textarea): body stored verbatim
        if (this.attributes.rawContent !== undefined) {
          if (this.attributes.rawContent === ``) {
            return (this.attributes.openingTag || ``) + (this.attributes.closingTag || ``);
          }
          const parts = [this.attributes.openingTag || ``];
          parts.push(this.attributes.rawContent);
          if (this.attributes.closingTag) {
            parts.push(this.attributes.closingTag);
          }
          return parts.join(`\n`);
        }

        // Void elements: opening tag only, no children, no closing tag
        if (this.attributes.closingTag === `` && this.children.length === 0) {
          return this.attributes.openingTag || ``;
        }

        // If the container has exactly one bare-text child, collapse
        // to a single line: <tag ...>content</tag>
        if (
          this.children.length === 1 &&
          this.children[0].attributes.bareText &&
          this.children[0].type === `paragraph`
        ) {
          return `${this.attributes.openingTag}${this.children[0].content}${this.attributes.closingTag}`;
        }

        const parts = [this.attributes.openingTag || ``];
        for (const child of this.children) {
          parts.push(child.toMarkdown());
        }
        if (this.attributes.closingTag) {
          parts.push(this.attributes.closingTag);
        }
        return parts.join(`\n\n`);
      }
      default:
        return this.content;
    }
  }

  /**
   * Returns the visible plain text for this node, with all inline
   * formatting syntax removed.  Images and other non-text elements
   * are omitted entirely; link text is kept but URLs are dropped.
   *
   * Used by the search system for writing-view matching, where the
   * user sees rendered text rather than raw markdown.
   *
   * @returns {string}
   */
  toBareText() {
    switch (this.type) {
      case `heading1`:
      case `heading2`:
      case `heading3`:
      case `heading4`:
      case `heading5`:
      case `heading6`:
      case `paragraph`:
      case `list-item`:
        return SyntaxNode.inlineChildrenToText(this.children);

      case `blockquote`:
        return SyntaxNode.blocksToBareText(this.children);

      case `code-block`:
        return this.content;

      case `table`: {
        // Extract visible cell text from the pipe-delimited table.
        // Skip the separator row (e.g. |---|---|).
        const lines = this.content.split(`\n`);
        const textLines = [];
        for (const line of lines) {
          if (/^\s*\|?\s*[-:]+[-|:\s]*$/.test(line)) continue;
          const cells = line
            .replace(/^\||\|$/g, ``)
            .split(`|`)
            .map((c) => SyntaxNode.extractInlineText(c.trim()));
          textLines.push(cells.join(`\t`));
        }
        return textLines.join(`\n`);
      }

      case `image`:
        // Images are purely visual – no searchable text.
        return ``;

      case `horizontal-rule`:
        return ``;

      case `html-block`: {
        // If the container has exactly one bare-text child,
        // return just its text.
        if (
          this.children.length === 1 &&
          this.children[0].attributes.bareText &&
          this.children[0].type === `paragraph`
        ) {
          return SyntaxNode.inlineChildrenToText(this.children[0].children);
        }

        return SyntaxNode.blocksToBareText(this.children);
      }

      default:
        return SyntaxNode.extractInlineText(this.content);
    }
  }

  /**
   * Puts markdown inside the given number of nested quotes.  Each quote
   * puts `> ` in front of each line with text, and `>` in front of each
   * empty line.
   * @param {string} markdown
   * @param {number} [depth]
   * @returns {string}
   */
  static quoteMarkdown(markdown, depth = 1) {
    let quoted = markdown;
    for (let i = 0; i < depth; i++) {
      quoted = quoted
        .split(`\n`)
        .map((line) => (line === `` ? `>` : `> ${line}`))
        .join(`\n`);
    }
    return quoted;
  }

  /**
   * Merges each run of blockquotes that follow one another among sibling
   * blocks into the first quote of the run, and does the same among the
   * blocks inside every container, since quotes that follow one another
   * are one quote.
   * @param {SyntaxNode[]} blocks
   * @returns {boolean} Whether any quotes were merged.
   */
  static mergeAdjacentQuotes(blocks) {
    let merged = false;
    for (let i = blocks.length - 1; i > 0; i--) {
      const previous = blocks[i - 1];
      const next = blocks[i];
      if (previous.type !== `blockquote` || next.type !== `blockquote`) continue;
      for (const child of next.children) {
        previous.appendChild(child);
      }
      next.children = [];
      previous.endLine = next.endLine;
      blocks.splice(i, 1);
      next.parent = undefined;
      merged = true;
    }
    for (const block of blocks) {
      if (block.isContainer() && SyntaxNode.mergeAdjacentQuotes(block.children)) merged = true;
    }
    return merged;
  }

  /**
   * Joins a sequence of sibling block nodes into markdown.
   * @param {SyntaxNode[]} blocks
   * @returns {string}
   */
  static blocksToMarkdown(blocks) {
    if (blocks.length === 0) return ``;
    const parts = [blocks[0].toMarkdown()];
    for (let i = 1; i < blocks.length; i++) {
      parts.push(separatorBetween(blocks[i - 1], blocks[i]) + blocks[i].toMarkdown());
    }
    return parts.join(``);
  }

  /**
   * Joins the visible text of a sequence of sibling block nodes with
   * blank lines, skipping blocks that have no visible text.
   * @param {SyntaxNode[]} blocks
   * @returns {string}
   */
  static blocksToBareText(blocks) {
    const parts = [];
    for (const block of blocks) {
      const text = block.toBareText();
      if (text !== ``) parts.push(text);
    }
    return parts.join(`\n\n`);
  }

  /**
   * Extracts visible text from inline markdown, stripping all
   * formatting delimiters (`**`, `*`, `~~`, `` ` ``, HTML tags)
   * and removing images.  Link text is preserved; link URLs are dropped.
   *
   * @param {string} content - Raw inline markdown content
   * @returns {string}
   */
  static extractInlineText(content) {
    const tokens = tokenizeInline(content);
    const segments = buildInlineTree(tokens);
    return SyntaxNode.segmentsToText(segments);
  }

  /**
   * Recursively extracts plain text from an InlineSegment tree.
   *
   * @param {InlineSegment[]} segments
   * @returns {string}
   */
  static segmentsToText(segments) {
    let result = ``;
    for (const seg of segments) {
      if (seg.type === `text`) {
        result += seg.text ?? ``;
      } else if (seg.type === `code`) {
        result += seg.content ?? ``;
      } else if (seg.type === `image`) {
        // Images produce no visible text.
      } else if (seg.children) {
        result += SyntaxNode.segmentsToText(seg.children);
      }
    }
    return result;
  }

  /**
   * Recursively extracts plain text from inline SyntaxNode children.
   * Similar to _segmentsToText but operates on SyntaxNode children
   * instead of InlineSegment objects.
   *
   * @param {SyntaxNode[]} children
   * @returns {string}
   */
  static inlineChildrenToText(children) {
    let result = ``;
    for (const child of children) {
      if (child.type === `text`) {
        result += child.content;
      } else if (child.type === `inline-code`) {
        result += child.content;
      } else if (child.type === `inline-image`) {
        // Images produce no visible text.
      } else if (child.children.length > 0) {
        result += SyntaxNode.inlineChildrenToText(child.children);
      }
    }
    return result;
  }

  /**
   * Creates a deep clone of this node.
   * @returns {SyntaxNode}
   */
  clone() {
    const cloned = new SyntaxNode(this.type, this.content);
    // The constructor may have auto-built inline children from
    // content; clear them so we clone the original's children
    // instead (they carry the same structure but the right IDs).
    cloned.children = [];
    cloned.attributes = { ...this.attributes };
    cloned.startLine = this.startLine;
    cloned.endLine = this.endLine;

    for (const child of this.children) {
      cloned.appendChild(child.clone());
    }

    return cloned;
  }
}
