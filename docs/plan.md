# Plan: issue 153, a selected image line cannot be deleted

Issue: https://github.com/Pomax/markdown-editor/issues/153

## Problem

In writing view, selecting a line that holds only a block image and pressing Backspace does not delete the line. The selection is dropped and the caret lands at the end of the line. Whether the image loaded makes no difference; a broken image only looks like a line of text.

## Cause

A block image renders as an element holding only an `<img>`, with no text node. `computeOffsetInContent` in `src/web/scripts/editor/managers/cursor-manager.js` returns 0 for both ends of a selection on it, so `treeRange` is the image node from 0 to 0. `deleteSelectedRange` in `src/web/scripts/editor/range-operations.js` slices the alt text from 0 to 0, changes nothing, and still reports the deletion as done. The redraw puts the caret after the `<img>`.

## Affected

- Backspace, Delete, Cut, typing a character and Enter on a selected block image line, linked images included.
- Deleting a selection from paragraph text through a block image: the image is removed and its alt text is appended to the paragraph as text.
- Deleting a selection from a block image or a horizontal rule into paragraph text: the image or rule stays and takes the rest of the paragraph's text as its content, and the paragraph is removed.
- Inline images inside a paragraph: `src/web/scripts/editor/offset-mapping.js` counts an inline image as one character, the DOM gives it none, so every offset after an inline image is one too low. Its failing test confirms this before anything changes.
- DOM positions whose container is the editor element: `mapDOMPositionToTree` returns nothing and `syncCursorFromDOM` leaves the previous `treeCursor` and `treeRange` in place. Its failing test confirms this before anything changes.

Tables are out of scope.

## Tasks

### Failing tests

Each test is added to `test/integration/user-interaction/interaction/range-handling.spec.js` and seen failing against the current code before the fix is written.

- [ ] A broken block image line selected with Ctrl+A: Backspace removes the line.
- [ ] A broken block image line selected with Ctrl+A: Delete removes the line.
- [ ] A broken block image line selected with Ctrl+A: Cut removes the line.
- [ ] A broken block image line selected with Ctrl+A: typing a character replaces the line with that character.
- [ ] A broken block image line selected with Ctrl+A: Enter removes the image and leaves the caret on an empty line where it was.
- [ ] A block image line whose image file exists, selected with Ctrl+A: Backspace removes the line.
- [ ] A linked image line selected with Ctrl+A: Backspace removes the line.
- [ ] A selection from paragraph text through a block image: Backspace removes the image and the paragraph keeps only the text before the selection, with no alt text in it.
- [ ] A selection from a block image into paragraph text: Backspace removes the image and the paragraph keeps the text after the selection.
- [ ] A selection from a horizontal rule into paragraph text: Backspace removes the rule and the paragraph keeps the text after the selection.
- [ ] Typing right after an inline image puts the text after the image and leaves the image's URL unchanged.
- [ ] A selection whose ends sit directly in the editor element: Backspace deletes that selection.

### Fix

- [ ] One set of the node types that have no editable text in writing view (`image`, `linked-image`, `horizontal-rule`), defined once and used by both `cursor-manager.js` and `range-operations.js`.
- [ ] `syncCursorFromDOM`: for a non-collapsed selection, an end on such a node maps to the start of the node when it is before the node's element content and to the end of the node's content when it is after it.
- [ ] `deleteSelectedRange`, selection within one such node: remove the node, place the caret at the start of the next node, and put an empty paragraph in its place when it was the only node.
- [ ] `deleteSelectedRange`, such a node as the first or last node of a longer selection: remove it entirely, never merging its content into a text node or a text node's content into it.
- [ ] `computeOffsetInContent`, `placeCursor` and `resolveOffsetInDOM` count an inline `<img>` as one character, matching `offset-mapping.js`.
- [ ] `mapDOMPositionToTree`: a position directly in the editor element maps to the start of the block after it, or to the end of the block before it.

### After the tests pass

- [ ] Run `range-handling.spec.js` and the other specs that cover the changed files, until they pass.
- [ ] Run `npm run lint`.
- [ ] Update the repository documentation the change invalidates.
- [ ] Run the release build, then the release smoke test.
