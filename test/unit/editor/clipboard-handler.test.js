/**
 * @fileoverview Unit tests for ClipboardHandler static helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parser } from '../../../src/parsers/old/dfa-parser.js';
import { SyntaxNode } from '../../../src/parsers/old/syntax-node.js';
import { ClipboardHandler } from '../../../src/web/scripts/editor/handlers/clipboard-handler.js';
import { Editor } from '../../../src/web/scripts/editor/index.js';

/**
 * A clipboard handler for an editor that shows the tree with the range
 * selected.
 * @param {SyntaxTree} tree
 * @param {TreeRange} treeRange
 * @returns {ClipboardHandler}
 */
function handlerFor(tree, treeRange) {
  /** @type {any} */
  const editor = { syntaxTree: tree, treeRange };
  editor.getNodesInRange = Editor.prototype.getNodesInRange.bind(editor);
  return new ClipboardHandler(editor);
}

describe(`ClipboardHandler.getSelectedMarkdownWriting`, () => {
  it(`copies part of a paragraph in a nested quote with its quote markers`, async () => {
    const tree = await parser.parse(`> > quoted text`);
    const paragraph = tree.children[0].children[0].children[0];
    const handler = handlerFor(tree, {
      startNodeId: paragraph.id,
      startOffset: 2,
      endNodeId: paragraph.id,
      endOffset: 8,
    });
    assert.equal(handler.getSelectedMarkdownWriting(), `> > oted t`);
  });

  it(`copies blocks in and out of nested quotes as the markdown they came from`, async () => {
    const markdown = `Before\n\n> first\n>\n> > second\n\nAfter`;
    const tree = await parser.parse(markdown);
    const before = tree.children[0];
    const after = tree.children[2];
    const handler = handlerFor(tree, {
      startNodeId: before.id,
      startOffset: 0,
      endNodeId: after.id,
      endOffset: after.content.length,
    });
    assert.equal(handler.getSelectedMarkdownWriting(), markdown);
  });

  it(`copies from inside a nested quote to text after it`, async () => {
    const tree = await parser.parse(`Before\n\n> first\n>\n> > second\n\nAfter`);
    const first = tree.children[1].children[0];
    const after = tree.children[2];
    const handler = handlerFor(tree, {
      startNodeId: first.id,
      startOffset: 2,
      endNodeId: after.id,
      endOffset: 3,
    });
    assert.equal(handler.getSelectedMarkdownWriting(), `> rst\n>\n> > second\n\nAft`);
  });

  it(`copies from text before a nested quote to inside it`, async () => {
    const tree = await parser.parse(`Before\n\n> first\n>\n> > second\n\nAfter`);
    const before = tree.children[0];
    const second = tree.children[1].children[1].children[0];
    const handler = handlerFor(tree, {
      startNodeId: before.id,
      startOffset: 3,
      endNodeId: second.id,
      endOffset: 3,
    });
    assert.equal(handler.getSelectedMarkdownWriting(), `ore\n\n> first\n>\n> > sec`);
  });
});

describe(`ClipboardHandler.fixHtmlTags`, () => {
  it(`returns the slice unchanged when there are no HTML tags`, () => {
    assert.equal(ClipboardHandler.fixHtmlTags(`hello world`), `hello world`);
  });

  it(`returns the slice unchanged when all tags are balanced`, () => {
    assert.equal(ClipboardHandler.fixHtmlTags(`<strong>bold</strong>`), `<strong>bold</strong>`);
  });

  it(`appends a missing closing tag`, () => {
    assert.equal(ClipboardHandler.fixHtmlTags(`<strong>in`), `<strong>in</strong>`);
  });

  it(`prepends a missing opening tag`, () => {
    assert.equal(ClipboardHandler.fixHtmlTags(`nd</strong>`), `<strong>nd</strong>`);
  });

  it(`handles both missing opener and closer`, () => {
    // Slice from the middle of <em>…</em> text <strong>…</strong>
    assert.equal(
      ClipboardHandler.fixHtmlTags(`xt</em> and <strong>in`),
      `<em>xt</em> and <strong>in</strong>`,
    );
  });

  it(`handles nested tags`, () => {
    assert.equal(
      ClipboardHandler.fixHtmlTags(`<strong><em>text`),
      `<strong><em>text</em></strong>`,
    );
  });

  it(`handles empty string`, () => {
    assert.equal(ClipboardHandler.fixHtmlTags(``), ``);
  });

  it(`preserves self-contained tags amid unmatched ones`, () => {
    assert.equal(
      ClipboardHandler.fixHtmlTags(`text</sub> and <sup>more`),
      `<sub>text</sub> and <sup>more</sup>`,
    );
  });
});

describe(`ClipboardHandler.nodeToPartialMarkdown`, () => {
  it(`wraps heading1 content with # prefix`, () => {
    const node = new SyntaxNode(`heading1`, `full heading`);
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `ading`), `# ading`);
  });

  it(`wraps heading2 content with ## prefix`, () => {
    const node = new SyntaxNode(`heading2`, `full heading`);
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `partial`), `## partial`);
  });

  it(`returns paragraph content as-is`, () => {
    const node = new SyntaxNode(`paragraph`, `some text`);
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `me tex`), `me tex`);
  });

  it(`wraps blockquote content with > prefix`, () => {
    const node = new SyntaxNode(`blockquote`, `quoted text`);
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `oted`), `> oted`);
  });

  it(`wraps unordered list-item with marker`, () => {
    const node = new SyntaxNode(`list-item`, `item text`);
    node.attributes = { ordered: false, indent: 0 };
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `item`), `- item`);
  });

  it(`wraps ordered list-item with a 1. marker`, () => {
    const node = new SyntaxNode(`list-item`, `item text`);
    node.attributes = { ordered: true, indent: 0 };
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `text`), `1. text`);
  });

  it(`wraps checklist item with checkbox prefix`, () => {
    const node = new SyntaxNode(`list-item`, `todo item`);
    node.attributes = { ordered: false, indent: 0, checked: false };
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `todo`), `- [ ] todo`);
  });

  it(`wraps indented list-item with indent spaces`, () => {
    const node = new SyntaxNode(`list-item`, `nested`);
    node.attributes = { ordered: false, indent: 2 };
    assert.equal(ClipboardHandler.nodeToPartialMarkdown(node, `nested`), `    - nested`);
  });
});
