/**
 * @fileoverview Unit tests for cursor-persistence helpers.
 *
 * Checks cursorToAbsoluteOffset and absoluteOffsetToCursor against the
 * markdown text of a normal markdown document: every caret offset in
 * every text block must give the place of that caret in the markdown
 * text, and that place must give the caret offset back.
 */

// @ts-nocheck: test assertions access optional properties without guards

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { parser } from '../../../src/parsers/old/dfa-parser.js';
import { SyntaxNode } from '../../../src/parsers/old/syntax-node.js';
import { SyntaxTree } from '../../../src/parsers/old/syntax-tree.js';
import { TableModal } from '../../../src/web/scripts/editor/content-types/table/table-modal.js';
import { Editor } from '../../../src/web/scripts/editor/index.js';
import {
  absoluteOffsetToCursor,
  cursorToAbsoluteOffset,
} from '../../../src/web/scripts/editor/managers/cursor-persistence.js';

const { getPrefixLength, buildMarkdownLine } = Editor.prototype;

const tree = await parser.parse(
  readFileSync(
    new URL(`../../fixtures/document-with-every-markdown-feature.md`, import.meta.url),
    `utf8`,
  ),
);

const quotesTree = await parser.parse(
  [
    `Before the quotes.`,
    ``,
    `> One level`,
    `> over two lines`,
    `>`,
    `> > Two levels`,
    `> >`,
    `> > > Three levels with **bold**`,
    `>`,
    `> # A heading in a quote`,
    `>`,
    `> - first item`,
    `> - second item`,
    `>`,
    `> \`\`\`js`,
    `> const quoted = true;`,
    `> \`\`\``,
    ``,
    `After the quotes.`,
  ].join(`\n`),
);

/** The block types whose content the caret moves through. */
const TEXT_BLOCK_TYPES = new Set([
  `paragraph`,
  `heading1`,
  `heading2`,
  `heading3`,
  `heading4`,
  `heading5`,
  `heading6`,
  `list-item`,
  `code-block`,
  `table`,
]);

/**
 * The text blocks among the nodes, in document order, including those
 * inside quotes and html blocks.
 * @param {SyntaxNode[]} nodes
 * @returns {SyntaxNode[]}
 */
function textBlocks(nodes) {
  return nodes.flatMap((node) => {
    if (node.type === `blockquote` || (node.type === `html-block` && node.children.length > 0)) {
      return textBlocks(node.children);
    }
    return TEXT_BLOCK_TYPES.has(node.type) ? [node] : [];
  });
}

/**
 * Each caret in each text block, as its tree cursor and its place in the
 * markdown text, found by looking each line of the block's content, or
 * each cell of a table, up in the text, in document order.  A caret in a
 * table is in a cell, at an offset into that cell's text, as the writing
 * view puts it.
 * @param {SyntaxTree} tree
 * @param {string} source - The markdown text the source view shows for the tree.
 * @returns {Map<SyntaxNode, { cursor: TreeCursor, place: number }[]>}
 */
function caretsInSource(tree, source) {
  const carets = new Map();
  let from = 0;
  for (const node of textBlocks(tree.children)) {
    const found = [];
    if (node.type === `table`) {
      TableModal.parseTableContent(node.content).cells.forEach((row, cellRow) => {
        row.forEach((text, cellCol) => {
          const start = source.indexOf(text, from);
          assert.notEqual(start, -1, `the markdown text has the cell "${text}"`);
          for (let offset = 0; offset <= text.length; offset++) {
            found.push({
              cursor: { nodeId: node.id, offset, cellRow, cellCol },
              place: start + offset,
            });
          }
          from = start + text.length;
        });
      });
    } else {
      let contentStart = 0;
      for (const line of node.content.split(`\n`)) {
        const start = source.indexOf(line, from);
        assert.notEqual(start, -1, `the markdown text has the line "${line}"`);
        for (let column = 0; column <= line.length; column++) {
          found.push({
            cursor: { nodeId: node.id, offset: contentStart + column },
            place: start + column,
          });
        }
        contentStart += line.length + 1;
        from = start + line.length + 1;
      }
    }
    carets.set(node, found);
  }
  return carets;
}

/**
 * The markdown text around a place in it, with `|` at the place.
 * @param {string} source
 * @param {number} place
 * @returns {string}
 */
function around(source, place) {
  return `${source.slice(Math.max(0, place - 16), place)}|${source.slice(place, place + 16)}`;
}

/**
 * Names a text block by its type and the start of its content.
 * @param {SyntaxNode} node
 * @returns {string}
 */
function blockName(node) {
  return `${node.type} "${node.content.split(`\n`)[0].slice(0, 32)}"`;
}

/**
 * Checks that each caret's tree cursor in each text block of a document
 * gives the caret's place in the document's markdown text, and that the
 * place gives the tree cursor back.
 * @param {string} title
 * @param {SyntaxTree} tree
 */
function describeCaretsIn(title, tree) {
  const source = tree.toMarkdown();
  describe(title, () => {
    for (const [node, carets] of caretsInSource(tree, source)) {
      it(`${blockName(node)}: each caret's tree cursor gives the caret's place in the markdown text`, () => {
        const wrong = carets
          .map(({ cursor, place }) => ({
            cursor,
            expected: place,
            given: cursorToAbsoluteOffset(tree, cursor, buildMarkdownLine, getPrefixLength),
          }))
          .find(({ expected, given }) => given !== expected);
        assert.equal(
          wrong && {
            cursor: wrong.cursor,
            given: around(source, wrong.given),
            expected: around(source, wrong.expected),
          },
          undefined,
        );
      });

      it(`${blockName(node)}: each caret's place in the markdown text gives its tree cursor`, () => {
        const wrong = carets
          .map(({ cursor, place }) => ({
            place: around(source, place),
            expected: cursor,
            given: absoluteOffsetToCursor(tree, place, getPrefixLength),
          }))
          .find(({ expected, given }) => !isDeepStrictEqual(given, expected));
        assert.equal(wrong, undefined);
      });
    }
  });
}

describeCaretsIn(`a caret in a normal markdown document`, tree);
describeCaretsIn(`a caret in quotes nested three deep`, quotesTree);

function makeTree(...nodes) {
  const tree = new SyntaxTree();
  for (const node of nodes) {
    tree.appendChild(node);
  }
  return tree;
}

describe(`cursor-persistence edge cases`, () => {
  it(`returns -1 when node ID is not found`, () => {
    const p = new SyntaxNode(`paragraph`, `Hello`);
    const tree = makeTree(p);
    const cursor = { nodeId: `nonexistent`, offset: 0 };
    assert.equal(cursorToAbsoluteOffset(tree, cursor, buildMarkdownLine, getPrefixLength), -1);
  });

  it(`falls back to end of last node for large offset`, () => {
    const p = new SyntaxNode(`paragraph`, `Hello`);
    const tree = makeTree(p);
    const cursor = absoluteOffsetToCursor(tree, 9999, getPrefixLength);
    assert.equal(cursor.nodeId, p.id);
    assert.equal(cursor.offset, 5);
  });

  it(`returns undefined for empty tree`, () => {
    const tree = makeTree();
    const cursor = absoluteOffsetToCursor(tree, 0, getPrefixLength);
    assert.equal(cursor, undefined);
  });
});
