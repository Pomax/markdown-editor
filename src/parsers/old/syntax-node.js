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
 * The text between two sibling blocks in markdown: a newline between two
 * list items, and before a block written directly under the one before it
 * unless both are paragraphs; a blank line between anything else.
 * @param {SyntaxNode} previous
 * @param {SyntaxNode} next
 * @returns {string}
 */
export function separatorBetween(previous, next) {
  if (previous.type === `list-item` && next.type === `list-item`) return `\n`;
  const twoParagraphs = previous.type === `paragraph` && next.type === `paragraph`;
  return next.noBlankLineBefore && !twoParagraphs ? `\n` : `\n\n`;
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

    /**
     * Whether the block was written directly under the block before it,
     * with no blank line between them.
     * @type {boolean}
     */
    this.noBlankLineBefore = false;

    /**
     * The indentation a list item was written with before each line of
     * its content after the first.
     * @type {string}
     */
    this.lineIndent = ``;

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
        if (segment.attrs) node.attributes.attrs = { ...segment.attrs };
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
   * Returns true if this node's content is raw text that is edited as
   * typed and never parsed as markdown: a code block or a math block.
   * @returns {boolean}
   */
  isRawBlock() {
    return this.type === `code-block` || this.type === `math-block`;
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
      case `math-block`:
        return `\\[\n${this.content}\n\\]`;
      case `list-item`: {
        const indent = `  `.repeat(this.attributes.indent || 0);
        const marker = this.attributes.ordered ? `1. ` : `- `;
        const checkbox =
          typeof this.attributes.checked === `boolean`
            ? this.attributes.checked
              ? `[x] `
              : `[ ] `
            : ``;
        return `${indent}${marker}${checkbox}${SyntaxNode.indentLines(this.content, this.continuationIndent())}`;
      }
      case `horizontal-rule`:
        return `---`;
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

        const parts = [`${this.attributes.openingTag || ``}${this.attributes.html ?? ``}`];
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
   * The indentation of the lines of a list item's content after the first
   * when it has none it was written with: two spaces more than the item.
   * @param {number} [indent] - The item's nesting level.
   * @returns {string}
   */
  static listLineIndent(indent = 0) {
    return `  `.repeat(indent + 1);
  }

  /**
   * A list item's content as its markdown writes it, with the given
   * indentation before each line after the first.
   * @param {string} content
   * @param {string} lineIndent
   * @returns {string}
   */
  static indentLines(content, lineIndent) {
    return content.replaceAll(`\n`, `\n${lineIndent}`);
  }

  /**
   * The indentation this list item's markdown puts before each line of its
   * content after the first.
   * @returns {string}
   */
  continuationIndent() {
    return this.lineIndent || SyntaxNode.listLineIndent(this.attributes.indent);
  }

  /**
   * The offset into this block's markdown, after its syntax prefix, of an
   * offset into its content.
   * @param {number} contentOffset
   * @returns {number}
   */
  markdownOffset(contentOffset) {
    if (this.type !== `list-item`) return contentOffset;
    const lineBreaks = this.content.slice(0, contentOffset).split(`\n`).length - 1;
    return contentOffset + lineBreaks * this.continuationIndent().length;
  }

  /**
   * The offset into this block's content of an offset into its markdown
   * after its syntax prefix.  An offset in the indentation before a line
   * gives the start of that line.
   * @param {number} markdownOffset
   * @returns {number}
   */
  contentOffset(markdownOffset) {
    if (this.type !== `list-item`) return markdownOffset;
    const indent = this.continuationIndent().length;
    const lines = this.content.split(`\n`);
    let markdownStart = 0;
    let contentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const lead = i === 0 ? 0 : indent;
      if (markdownOffset <= markdownStart + lead + lines[i].length || i === lines.length - 1) {
        const column = Math.min(markdownOffset - markdownStart - lead, lines[i].length);
        return contentStart + Math.max(0, column);
      }
      markdownStart += lead + lines[i].length + 1;
      contentStart += lines[i].length + 1;
    }
    return contentStart;
  }

  /**
   * The markup of an image: markdown image syntax when it has no attributes
   * besides its source and alt text, and an `<img>` tag otherwise, which
   * keeps the attributes of the tag it was written as that `data` does not
   * set.  A link URL puts the image inside a markdown link.
   * @param {{ alt?: string, src?: string, href?: string, style?: string, className?: string }} data
   * @param {Record<string, string>} [written] - The attributes of the `<img>`
   *     tag the image was written as.
   * @returns {string}
   */
  static imageMarkup(data, written = {}) {
    const src = data.src ?? ``;
    const alt = data.alt ?? ``;
    /** @type {[string, string][]} */
    const extra = [];
    if (data.className) extra.push([`class`, data.className]);
    if (data.style) extra.push([`style`, data.style]);
    for (const [name, value] of Object.entries(written)) {
      if (![`src`, `alt`, `class`, `style`].includes(name)) extra.push([name, value]);
    }
    let markup = `![${alt}](${src})`;
    if (extra.length > 0) {
      /** @type {[string, string][]} */
      const attrs = [[`src`, src]];
      if (alt) attrs.push([`alt`, alt]);
      attrs.push(...extra);
      const parts = attrs.map(([name, value]) =>
        value === `` && name !== `src` ? name : `${name}="${value}"`,
      );
      markup = `<img ${parts.join(` `)} />`;
    }
    return data.href ? `[${markup}](${data.href})` : markup;
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
    cloned.noBlankLineBefore = this.noBlankLineBefore;
    cloned.lineIndent = this.lineIndent;

    for (const child of this.children) {
      cloned.appendChild(child.clone());
    }

    return cloned;
  }
}
