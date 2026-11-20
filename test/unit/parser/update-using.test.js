/**
 * @fileoverview Unit tests for SyntaxTree.updateUsing(newTree).
 * Uses the real DFA parser and README.md as a representative document.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { SyntaxNode } from '../../../src/parsers/old/syntax-node.js';
import { parser } from '../../../src/parsers/old/dfa-parser.js';
import { SyntaxTree } from '../../../src/parsers/old/syntax-tree.js';

const README = readFileSync(resolve(`README.md`), `utf-8`);
const README_LINES = README.split(`\n`);
const README_NODES = (await parser.parse(README)).children;

const paragraphs = README_NODES.filter((node) => node.type === `paragraph`);
const heading2 = /** @type {SyntaxNode} */ (README_NODES.find((node) => node.type === `heading2`));
const heading3 = /** @type {SyntaxNode} */ (README_NODES.find((node) => node.type === `heading3`));

/**
 * The README's sections that start with a level 3 heading, as the
 * README's own text: each such heading with the nodes after it, up to
 * the next heading.
 * @type {string[]}
 */
const sections = README_NODES.flatMap((node, index) => {
  if (node.type !== `heading3`) return [];
  const next = README_NODES.slice(index + 1).find((other) => other.type.startsWith(`heading`));
  if (!next) return [];
  return [README_LINES.slice(node.startLine, next.startLine).join(`\n`)];
});

/**
 * Collects the IDs of all top-level children in a tree.
 *
 * @param {SyntaxTree} tree
 * @returns {string[]}
 */
function collectIds(tree) {
  return tree.children.map((c) => c.id);
}

/**
 * Replaces the first occurrence of `target` in `source` with `replacement`.
 *
 * @param {string} source
 * @param {string} target
 * @param {string} replacement
 * @returns {string}
 */
function replaceFirst(source, target, replacement) {
  const index = source.indexOf(target);
  if (index === -1) return source;
  return source.slice(0, index) + replacement + source.slice(index + target.length);
}

/**
 * Removes the first occurrence of `target`, and the blank line after it,
 * from `source`.
 *
 * @param {string} source
 * @param {string} target
 * @returns {string}
 */
function removeBlock(source, target) {
  const index = source.indexOf(target);
  if (index === -1) return source;
  const after = source.slice(index + target.length);
  return source.slice(0, index) + after.replace(/^\n\n/, ``);
}

describe(`SyntaxTree.updateUsing`, () => {
  it(`preserves all IDs when trees are identical`, async () => {
    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(README);
    const originalIds = collectIds(oldTree);
    oldTree.updateUsing(newTree);
    const updatedIds = collectIds(oldTree);
    assert.deepStrictEqual(updatedIds, originalIds);
    assert.strictEqual(oldTree.toMarkdown(), newTree.toMarkdown());
  });

  it(`preserves ID of an edited paragraph and updates its content`, async () => {
    const [paragraph] = paragraphs;
    const editedIndex = README_NODES.indexOf(paragraph);
    const editedContent = paragraph.content.slice(10) + paragraph.content.slice(0, 10);
    const editedReadme = replaceFirst(README, paragraph.content, editedContent);

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);
    const originalIds = collectIds(oldTree);

    oldTree.updateUsing(newTree);

    assert.deepStrictEqual(collectIds(oldTree), originalIds);
    assert.strictEqual(oldTree.children[editedIndex].content, editedContent);
  });

  it(`assigns a fresh ID to an inserted node while preserving others`, async () => {
    const insertionPoint = heading2.toMarkdown();
    const insertedSection = `## What's New\n\nThis section was just added with **bold** emphasis and a [link](https://example.com).`;
    const editedReadme = replaceFirst(
      README,
      insertionPoint,
      `${insertedSection}\n\n${insertionPoint}`,
    );

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);
    const originalIds = new Set(collectIds(oldTree));

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, newTree.children.length);

    let freshCount = 0;
    for (const child of oldTree.children) {
      if (!originalIds.has(child.id)) freshCount++;
    }
    assert.ok(
      freshCount >= 2,
      `expected at least 2 fresh IDs (heading + paragraph), got ${freshCount}`,
    );
  });

  it(`removes a node and preserves surviving IDs`, async () => {
    const [paragraph] = paragraphs;
    const removedIndex = README_NODES.indexOf(paragraph);
    const editedReadme = removeBlock(README, paragraph.content);

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);
    const survivingIds = collectIds(oldTree).filter((_, i) => i !== removedIndex);

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, newTree.children.length);
    const updatedIds = collectIds(oldTree);
    for (const id of survivingIds) {
      assert.ok(updatedIds.includes(id), `surviving ID ${id} not found after update`);
    }
  });

  it(`preserves IDs when sections are reordered`, async () => {
    const section1 = sections[0];
    const section2 = sections[1];
    const editedReadme = README.replace(section1, `PLACEHOLDER`)
      .replace(section2, section1)
      .replace(`PLACEHOLDER`, section2);

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);
    const originalIds = new Set(collectIds(oldTree));

    oldTree.updateUsing(newTree);

    const updatedIds = collectIds(oldTree);
    for (const id of updatedIds) {
      assert.ok(originalIds.has(id), `unexpected fresh ID after reordering: ${id}`);
    }
    assert.strictEqual(oldTree.toMarkdown(), newTree.toMarkdown());
  });

  it(`assigns a fresh ID when a node's type changes`, async () => {
    const headingIndex = README_NODES.indexOf(heading2);
    const oldTree = await parser.parse(README);
    const originalIds = collectIds(oldTree);
    const headingId = originalIds[headingIndex];

    const editedReadme = replaceFirst(README, heading2.toMarkdown(), heading2.content);
    const newTree = await parser.parse(editedReadme);

    oldTree.updateUsing(newTree);

    const changedNode = oldTree.children[headingIndex];
    assert.strictEqual(changedNode.type, `paragraph`);
    assert.strictEqual(changedNode.content, heading2.content);
    assert.notStrictEqual(changedNode.id, headingId);

    const unchangedOriginals = originalIds.filter((id) => id !== headingId);
    const updatedIds = collectIds(oldTree);
    for (const id of unchangedOriginals) {
      assert.ok(updatedIds.includes(id), `unchanged node ID ${id} not preserved`);
    }
  });

  it(`handles simultaneous edit, insert, and delete`, async () => {
    const [edited, removed] = paragraphs;
    const editedContent = edited.content.slice(10) + edited.content.slice(0, 10);
    const insertionPoint = heading3.toMarkdown();
    const fence = `\`\`\``;
    const insertedBlock = `${fence}sh\nnpm run check\n${fence}`;

    let editedReadme = replaceFirst(README, edited.content, editedContent);
    editedReadme = removeBlock(editedReadme, removed.content);
    editedReadme = replaceFirst(
      editedReadme,
      insertionPoint,
      `${insertionPoint}\n\n${insertedBlock}`,
    );

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);
    const originalIds = new Set(collectIds(oldTree));

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.toMarkdown(), newTree.toMarkdown());
    assert.strictEqual(oldTree.children.length, newTree.children.length);

    let preserved = 0;
    let fresh = 0;
    for (const child of oldTree.children) {
      if (originalIds.has(child.id)) preserved++;
      else fresh++;
    }
    // The edited paragraph fuzzy-matches its original → preserved ID.
    // The inserted code-block has no same-type unclaimed candidate
    // (all existing code-blocks are exact-matched) → fresh ID.
    assert.ok(preserved > 0, `expected some preserved IDs`);
    assert.ok(fresh > 0, `expected some fresh IDs`);
  });

  it(`replaces all children from newTree when old tree is empty`, async () => {
    const oldTree = new SyntaxTree();
    const newTree = await parser.parse(README);
    const newIds = collectIds(newTree);

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, newTree.children.length);
    assert.deepStrictEqual(collectIds(oldTree), newIds);
  });

  it(`empties children when new tree is empty`, async () => {
    const oldTree = await parser.parse(README);
    const newTree = new SyntaxTree();

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, 0);
  });

  it(`is a no-op when both trees are empty`, () => {
    const oldTree = new SyntaxTree();
    const newTree = new SyntaxTree();

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, 0);
  });

  it(`uses list-item indent as tiebreaker for matching`, async () => {
    const listContent = `Navigate to the **project** directory and run \`npm test\``;
    const oldTree = new SyntaxTree();
    const indent0 = new SyntaxNode(`list-item`, listContent);
    indent0.attributes = { indent: 0 };
    const indent1 = new SyntaxNode(`list-item`, listContent);
    indent1.attributes = { indent: 1 };
    oldTree.children = [indent0, indent1];
    const indent0Id = indent0.id;
    const indent1Id = indent1.id;

    const newTree = new SyntaxTree();
    const newIndent0 = new SyntaxNode(`list-item`, listContent);
    newIndent0.attributes = { indent: 0 };
    const newIndent1 = new SyntaxNode(`list-item`, listContent);
    newIndent1.attributes = { indent: 1 };
    newTree.children = [newIndent0, newIndent1];

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children[0].id, indent0Id);
    assert.strictEqual(oldTree.children[1].id, indent1Id);
  });

  it(`sets parent to undefined on all result children`, async () => {
    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(README);

    oldTree.updateUsing(newTree);

    for (const child of oldTree.children) {
      assert.strictEqual(child.parent, undefined);
    }
  });

  it(`preserves html-block child IDs during recursive diffing`, () => {
    const childContent = `This is a paragraph inside a details block`;
    const updatedChildContent = `This is an updated paragraph inside a details block`;
    const containerAttrs = {
      tagName: `details`,
      openingTag: `<details>`,
      closingTag: `</details>`,
    };

    const oldChild = new SyntaxNode(`paragraph`, childContent);
    const oldContainer = new SyntaxNode(`html-block`, ``);
    oldContainer.attributes = { ...containerAttrs };
    oldContainer.children = [oldChild];
    oldChild.parent = oldContainer;
    const oldChildId = oldChild.id;

    const oldTree = new SyntaxTree();
    oldTree.children = [oldContainer];

    const newChild = new SyntaxNode(`paragraph`, updatedChildContent);
    const newContainer = new SyntaxNode(`html-block`, ``);
    newContainer.attributes = { ...containerAttrs };
    newContainer.children = [newChild];
    newChild.parent = newContainer;

    const newTree = new SyntaxTree();
    newTree.children = [newContainer];

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children[0].children[0].id, oldChildId);
    assert.strictEqual(oldTree.children[0].children[0].content, updatedChildContent);
  });

  it(`matches duplicate identical nodes to distinct originals`, async () => {
    const duplicateContent = `This is a **duplicate** paragraph with \`inline code\` in it.`;

    const oldTree = new SyntaxTree();
    const dup1 = new SyntaxNode(`paragraph`, duplicateContent);
    const dup2 = new SyntaxNode(`paragraph`, duplicateContent);
    oldTree.children = [dup1, dup2];
    const dup1Id = dup1.id;
    const dup2Id = dup2.id;

    const newTree = new SyntaxTree();
    const newDup1 = new SyntaxNode(`paragraph`, duplicateContent);
    const newDup2 = new SyntaxNode(`paragraph`, duplicateContent);
    newTree.children = [newDup1, newDup2];

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children.length, 2);
    const ids = collectIds(oldTree);
    assert.ok(ids.includes(dup1Id), `first original ID preserved`);
    assert.ok(ids.includes(dup2Id), `second original ID preserved`);
    assert.notStrictEqual(ids[0], ids[1], `IDs are distinct`);
  });

  it(`does not modify treeCursor`, async () => {
    const oldTree = await parser.parse(README);
    const cursor = { nodeId: oldTree.children[0].id, offset: 5 };
    oldTree.treeCursor = cursor;
    const newTree = await parser.parse(README);

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.treeCursor, cursor);
  });

  it(`preserves every node ID on a toMarkdown-reparse round-trip with no edits`, async () => {
    const oldTree = await parser.parse(README);
    const idsBefore = collectIds(oldTree);
    const markdown = oldTree.toMarkdown();
    const newTree = await parser.parse(markdown);

    oldTree.updateUsing(newTree);

    const idsAfter = collectIds(oldTree);
    assert.strictEqual(idsAfter.length, idsBefore.length, `node count must not change`);
    for (let i = 0; i < idsBefore.length; i++) {
      assert.strictEqual(
        idsAfter[i],
        idsBefore[i],
        `node ${i} (type: ${oldTree.children[i].type}) ID must be preserved`,
      );
    }
  });
});
