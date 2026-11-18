/**
 * @fileoverview Builds a standalone HTML document from the editor's
 * syntax tree, using the writing renderer's markup so the editor's own
 * stylesheets apply unchanged.
 */

/// <reference path="../../../../types.d.ts" />

/**
 * CSS custom properties the preferences dialog sets on the root element.
 * @type {string[]}
 */
const PAGE_VARIABLES = [
  `--page-max-width`,
  `--page-padding-top`,
  `--page-padding-right`,
  `--page-padding-bottom`,
  `--page-padding-left`,
  `--page-bg`,
  `--page-text`,
];

/**
 * Escapes text for use inside an HTML element.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`);
}

/**
 * Returns the `file://` prefix the writing renderer prepends to relative
 * image sources for the given markdown file.
 * @param {string} filePath
 * @returns {string}
 */
function fileUrlPrefix(filePath) {
  const fileDir = filePath.replace(/[\\/][^\\/]+$/, ``).replace(/\\/g, `/`);
  return fileDir.startsWith(`/`) ? `file://${fileDir}/` : `file:///${fileDir}/`;
}

/**
 * The value a display URL was made from, or the URL itself where there
 * is no bridge.
 * @param {string} url
 * @returns {string}
 */
function fromDisplayUrl(url) {
  return window.pageToBackendBridge?.fromDisplayUrl(url) ?? url;
}

/**
 * Turns the sources the renderer displayed back into what the markdown
 * wrote: each image `src`, and each `<video>` and `<audio>` `src` and
 * `poster`, goes through `fromDisplayUrl`, and an image source resolved
 * against the markdown file's folder goes back to its relative path.
 * @param {HTMLElement} container
 * @param {string} filePath
 */
function restoreRelativeImageSources(container, filePath) {
  const prefix = fileUrlPrefix(filePath);
  for (const img of container.querySelectorAll(`img`)) {
    const shown = img.getAttribute(`src`) ?? ``;
    const src = fromDisplayUrl(shown);
    const written = src.startsWith(prefix) ? src.substring(prefix.length) : src;
    if (written !== shown) img.setAttribute(`src`, written);
  }
  for (const media of container.querySelectorAll(`video, audio`)) {
    for (const name of [`src`, `poster`]) {
      const shown = media.getAttribute(name);
      if (shown === null) continue;
      const written = fromDisplayUrl(shown);
      if (written !== shown) media.setAttribute(name, written);
    }
  }
}

/**
 * Returns the document title: the text of the first heading, or the
 * file name without its extension when there is no heading.
 * @param {HTMLElement} container
 * @param {string} filePath
 * @returns {string}
 */
function documentTitle(container, filePath) {
  const heading = container.querySelector(
    `.md-heading1, .md-heading2, .md-heading3, .md-heading4, .md-heading5, .md-heading6`,
  );
  const text = heading?.textContent?.trim();
  if (text) return text;
  const fileName = filePath.split(/[\\/]/).pop() ?? ``;
  return fileName.replace(/\.[^.]+$/, ``) || `Untitled`;
}

/**
 * Returns a `:root` rule carrying the page settings currently applied to
 * the editor, or an empty string when none are set.
 * @returns {string}
 */
export function pageSettingsCss() {
  const style = document.documentElement.style;
  const declarations = PAGE_VARIABLES.map((name) => [name, style.getPropertyValue(name)])
    .filter(([, value]) => value)
    .map(([name, value]) => `    ${name}: ${value};`);
  if (declarations.length === 0) return ``;
  return `:root {\n${declarations.join(`\n`)}\n}\n`;
}

/**
 * Builds the HTML document for the editor's current content.
 * @param {Editor} editor
 * @param {string} filePath - The markdown file the export sits next to
 * @returns {string | undefined} The HTML, or undefined without a syntax tree
 */
export function buildHtmlDocument(editor, filePath) {
  const tree = editor.syntaxTree;
  if (!tree) return undefined;

  const container = document.createElement(`div`);
  for (const element of editor.writingRenderer.renderBlockSequence(tree.children, undefined)) {
    container.appendChild(element);
  }
  restoreRelativeImageSources(container, filePath);

  const title = escapeHtml(documentTitle(container, filePath));

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<title>${title}</title>`,
    `<link rel="stylesheet" href="default.css">`,
    `</head>`,
    `<body>`,
    `<div id="editor-container">`,
    `<div id="editor" class="editor writing-view">`,
    container.innerHTML,
    `</div>`,
    `</div>`,
    `</body>`,
    `</html>`,
    ``,
  ].join(`\n`);
}
