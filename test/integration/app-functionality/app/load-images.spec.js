/**
 * @fileoverview Integration test for loading a markdown file with images.
 * Launches the editor with a CLI file path argument, waits for the document
 * to load, and verifies that the referenced images actually load. For the
 * document the DOCUMENT environment variable names, it verifies that each
 * HTML element holding HTML of its own renders as the HTML it was written
 * as, with the same elements and attributes other than data attributes
 * and image sources, with its images loaded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parser } from '../../../../src/parsers/old/dfa-parser.js';
import { closeApp, launchApp, projectRoot } from '../../test-utils.js';

const testFile = path.join(projectRoot, `test`, `fixtures`, `images.md`);

test(`images in a loaded markdown file resolve and load successfully`, async () => {
  // Give CI runners extra time for image loading.
  test.setTimeout(60_000);

  const { app, page } = await launchApp([testFile]);

  // Wait for the editor to finish rendering the loaded document.
  await page.waitForSelector(`#editor [data-node-id]`);

  // The app defaults to writing mode, so unfocused image nodes render
  // as <img> elements.  Wait for at least one to appear (the document
  // has many images).
  const images = page.locator(`#editor img`);
  await expect(images.first()).toBeVisible({ timeout: 10_000 });

  const count = await images.count();
  expect(count).toBeGreaterThan(0);

  // Wait for every image to finish loading (or erroring) before we
  // check naturalWidth — images loaded via file:// still need time.
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll(`#editor img`)].map((img) =>
        /** @type {HTMLImageElement} */ (img).complete
          ? Promise.resolve()
          : new Promise((r) => {
              img.addEventListener(`load`, r, { once: true });
              img.addEventListener(`error`, r, { once: true });
            }),
      ),
    ),
  );

  // Verify every rendered image actually loaded (naturalWidth > 0).
  for (let i = 0; i < count; i++) {
    const naturalWidth = await images
      .nth(i)
      .evaluate((/** @type {HTMLImageElement} */ img) => img.naturalWidth);
    const src = await images.nth(i).getAttribute(`src`);
    expect(naturalWidth, `image "${src}" should have loaded`).toBeGreaterThan(0);
  }

  await closeApp(app);
});

/**
 * The HTML each HTML element holding HTML of its own was written as, in
 * document order.
 * @param {import('../../../../src/parsers/old/syntax-node.js').SyntaxNode[]} nodes
 * @returns {string[]}
 */
function writtenHtml(nodes) {
  return nodes.flatMap((node) => {
    const [only] = node.children;
    const tag = node.attributes.tagName ?? ``;
    if (
      node.type === `html-block` &&
      node.children.length === 1 &&
      only.type === `paragraph` &&
      only.attributes.bareText &&
      ![`summary`, `details`].includes(tag)
    ) {
      return [`${node.attributes.openingTag}${only.content}${node.attributes.closingTag}`];
    }
    return node.type === `html-block` || node.type === `blockquote`
      ? writtenHtml(node.children)
      : [];
  });
}

test(`the HTML elements of the document DOCUMENT names render as the HTML they were written as, with their images loaded`, async () => {
  const named = process.env.DOCUMENT;
  test.skip(!named, `DOCUMENT names no document`);
  test.setTimeout(60_000);

  const written = writtenHtml((await parser.parse(readFileSync(String(named), `utf-8`))).children);
  expect(written.length).toBeGreaterThan(0);

  const { app, page } = await launchApp([String(named)]);
  await page.waitForSelector(`#editor [data-node-id]`);

  const elements = page.locator(`#editor [data-html-block-id]`);
  await expect(elements).toHaveCount(written.length);
  for (let i = 0; i < written.length; i++) {
    const element = elements.nth(i);
    await element.scrollIntoViewIfNeeded();
    await element.evaluate((el) =>
      Promise.all(
        [...el.querySelectorAll(`img`)].map((img) => img.decode().catch(() => undefined)),
      ),
    );
    const { rendered, asWritten, whiteSpace, unloaded } = await element.evaluate((el, html) => {
      /**
       * @param {Element} node
       * @returns {object}
       */
      const shape = (node) => ({
        tag: node.tagName,
        attributes: [...node.attributes]
          .filter(({ name }) => !name.startsWith(`data-`) && name !== `src`)
          .map(({ name, value }) => `${name}=${value}`),
        children: [...node.children].map(shape),
      });
      const template = document.createElement(`template`);
      template.innerHTML = html;
      return {
        rendered: shape(el),
        asWritten: template.content.firstElementChild && shape(template.content.firstElementChild),
        whiteSpace: getComputedStyle(el).whiteSpace,
        unloaded: [...el.querySelectorAll(`img`)]
          .filter((img) => img.naturalWidth === 0)
          .map((img) => img.getAttribute(`src`)),
      };
    }, written[i]);
    expect(rendered).toEqual(asWritten);
    expect({ whiteSpace, unloaded }).toEqual({ whiteSpace: `normal`, unloaded: [] });
  }

  await closeApp(app);
});
