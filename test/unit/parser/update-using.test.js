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

const sections = Array.from(README.matchAll(/(### (.*\n)(\r?\n?[^#]+)*)\s*\n/g)).map((e) => e[0]);
const headings = README_LINES.filter((e) => e.startsWith(`#`));
const paragraphs = README_LINES.filter((e) => !!e.match(/^\w/));

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
 * Removes the first occurrence of `target` (and surrounding blank lines)
 * from `source`.
 *
 * @param {string} source
 * @param {string} target
 * @returns {string}
 */
function removeBlock(source, target) {
  const index = source.indexOf(target);
  if (index === -1) return source;
  const before = source.slice(0, index);
  const after = source.slice(index + target.length);
  return before.replace(/\n\n$/, `\n\n`) + after.replace(/^\n\n/, ``);
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
    const { 0: l, length: len } = paragraphs;
    const originalLine = l;
    const editedLine = l.substring(10) + l.substring(0, len - 10);
    const editedReadme = replaceFirst(README, originalLine, editedLine);

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);

    const editedOldIndex = oldTree.children.findIndex((c) => c.content === originalLine);
    const editedNodeId = oldTree.children[editedOldIndex].id;
    const originalIds = collectIds(oldTree);

    oldTree.updateUsing(newTree);

    assert.strictEqual(oldTree.children[editedOldIndex].id, editedNodeId);
    assert.strictEqual(oldTree.children[editedOldIndex].content, editedLine);

    for (let i = 0; i < oldTree.children.length; i++) {
      if (i !== editedOldIndex) {
        assert.strictEqual(oldTree.children[i].id, originalIds[i]);
      }
    }
  });

  it(`assigns a fresh ID to an inserted node while preserving others`, async () => {
    // FIX THIS FUCKING TEST WHY IS IT FUCKING HARDCODED CONTENT INSTEAD OF FUCKING FINDING "WHATEVER IS IN THE README THAT WE CAN USE
    const versionMatch = README.match(/^## Current version: .+$/m);
    assert.ok(versionMatch, `README must contain a "## Current version:" heading`);
    const insertionPoint = versionMatch[0];
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
    const lineToRemove = paragraphs[0];
    const editedReadme = removeBlock(README, lineToRemove);

    const oldTree = await parser.parse(README);
    const newTree = await parser.parse(editedReadme);

    const removedIndex = oldTree.children.findIndex((c) => c.content === lineToRemove);
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
    // FIX THIS FUCKING TEST WHY IS IT FUCKING HARDCODED CONTENT INSTEAD OF FUCKING FINDING "WHATEVER IS IN THE README THAT WE CAN USE
    const headingContent = `So... what is this?`;
    const oldTree = await parser.parse(README);
    const headingNode = oldTree.children.find(
      (c) => c.type === `heading2` && c.content === headingContent,
    );
    assert.ok(headingNode, `expected to find heading2 node with content "${headingContent}"`);
    const headingId = headingNode.id;
    const originalIds = collectIds(oldTree);

    const editedReadme = replaceFirst(README, `## ${headingContent}`, headingContent);
    const newTree = await parser.parse(editedReadme);

    oldTree.updateUsing(newTree);

    const paragraphNode = oldTree.children.find(
      (c) => c.type === `paragraph` && c.content === headingContent,
    );
    assert.ok(paragraphNode, `expected a paragraph node with the former heading content`);
    assert.notStrictEqual(paragraphNode.id, headingId);

    const unchangedOriginals = originalIds.filter((id) => id !== headingId);
    const updatedIds = collectIds(oldTree);
    for (const id of unchangedOriginals) {
      assert.ok(updatedIds.includes(id), `unchanged node ID ${id} not preserved`);
    }
  });

  it(`handles simultaneous edit, insert, and delete`, async () => {
    // FIX THIS FUCKING TEST WHY IS IT FUCKING HARDCODED CONTENT INSTEAD OF FUCKING FINDING "WHATEVER IS IN THE README THAT WE CAN USE
    const { 0: l, 1: lineToRemove, length: len } = paragraphs;
    const originalLine = l;
    const editedLine = l.substring(10) + l.substring(0, len - 10);
    const insertionPoint = `### Downloads`;
    const fence = `\`\`\``;
    const insertedBlock = `${fence}sh\nnpm run check\n${fence}`;

    let editedReadme = replaceFirst(README, originalLine, editedLine);
    editedReadme = removeBlock(editedReadme, lineToRemove);
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
