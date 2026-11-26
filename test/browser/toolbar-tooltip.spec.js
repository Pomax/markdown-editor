/**
 * @fileoverview Browser test for where the toolbar's tooltips are drawn:
 * with the toolbar at each edge of the document area, the tooltip of the
 * Bold button opens towards the document and stays inside the document
 * area. The tooltip is measured from the pixels drawn: the ones outside
 * the button that change when the pointer moves onto it, in screenshots
 * taken once the page has stopped changing.
 */

import zlib from 'node:zlib';
import { expect, test } from '@playwright/test';
import { VIEWPORT, resetPage, setToolbarPosition } from '../integration/test-utils.js';
import { startServer, stopServer } from '../integration/test-http-server.js';

/** @type {import('node:http').Server} */
let server;

/** @type {string} */
let baseURL;

test.beforeAll(async () => {
  ({ server, baseURL } = await startServer());
});

test.afterAll(async () => {
  await stopServer(server);
});

test.afterEach(async ({ page }) => {
  await resetPage(page);
});

/** The edges the toolbar can be at. */
const POSITIONS = /** @type {ToolbarPosition[]} */ ([`top`, `right`, `bottom`, `left`]);

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 */

/**
 * The Paeth predictor of PNG's fourth filter.
 * @param {number} left
 * @param {number} up
 * @param {number} upLeft
 * @returns {number}
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * The pixels of a PNG image as Playwright's screenshots write it: eight
 * bits a channel, RGB or RGBA, not interlaced.
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
function decodePng(png) {
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Buffer[]} */
  const data = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString(`latin1`, offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === `IHDR`) {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 0;
      if (chunk[8] !== 8 || chunk[12] !== 0 || channels === 0) {
        throw new Error(`a PNG this decoder does not read`);
      }
    } else if (type === `IDAT`) {
      data.push(chunk);
    }
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const line = y * (stride + 1);
    const filter = raw[line];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels] : 0;
      const up = y > 0 ? pixels[at - stride] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        predicted = paeth(left, up, x >= channels && y > 0 ? pixels[at - stride - channels] : 0);
      }
      pixels[at] = (raw[line + 1 + x] + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * A screenshot of the page once it has stopped changing: the second of two
 * in a row that are the same.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Buffer>}
 */
async function settledScreenshot(page) {
  let last = await page.screenshot({ scale: `css` });
  await expect
    .poll(async () => {
      const next = await page.screenshot({ scale: `css` });
      const same = next.equals(last);
      last = next;
      return same;
    })
    .toBe(true);
  return last;
}

/**
 * Where the Bold button's tooltip is drawn, in CSS pixels: the box around
 * the pixels outside the button that change when the pointer moves from
 * the middle of the document area onto the button. With it, the button's
 * box and the box of the part of the document area beside its scrollbar.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ tooltip: Box | null, button: Box, area: Box }>}
 */
async function drawnTooltip(page) {
  const { button, area } = await page.evaluate(() => {
    const scroller = /** @type {HTMLElement} */ (document.getElementById(`editor-container`));
    const outer = /** @type {HTMLElement} */ (
      document.getElementById(`document-area`)
    ).getBoundingClientRect();
    const box = /** @type {HTMLElement} */ (
      document.querySelector(`[data-button-id="bold"]`)
    ).getBoundingClientRect();
    return {
      button: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      area: {
        left: outer.left,
        top: outer.top,
        right: outer.right - (scroller.offsetWidth - scroller.clientWidth),
        bottom: outer.bottom,
      },
    };
  });
  await page.mouse.move((area.left + area.right) / 2, (area.top + area.bottom) / 2);
  const before = decodePng(await settledScreenshot(page));
  await page.mouse.move((button.left + button.right) / 2, (button.top + button.bottom) / 2);
  const after = decodePng(await settledScreenshot(page));
  const { width, height, channels } = after;
  /** @type {Box | null} */
  let tooltip = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onButton =
        x >= Math.floor(button.left) - 1 &&
        x < Math.ceil(button.right) + 1 &&
        y >= Math.floor(button.top) - 1 &&
        y < Math.ceil(button.bottom) + 1;
      if (onButton) continue;
      const at = (y * width + x) * channels;
      let changed = false;
      for (let c = 0; c < channels && !changed; c++) {
        changed = before.pixels[at + c] !== after.pixels[at + c];
      }
      if (!changed) continue;
      tooltip = tooltip
        ? {
            left: Math.min(tooltip.left, x),
            top: Math.min(tooltip.top, y),
            right: Math.max(tooltip.right, x + 1),
            bottom: Math.max(tooltip.bottom, y + 1),
          }
        : { left: x, top: y, right: x + 1, bottom: y + 1 };
    }
  }
  return { tooltip, button, area };
}

for (const position of POSITIONS) {
  test(`with the toolbar at the ${position}, the Bold button's tooltip opens towards the document, inside the document area`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(baseURL);
    await page.waitForSelector(`#editor [data-node-id]`);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    await setToolbarPosition(page, position);
    const { tooltip, button, area } = await drawnTooltip(page);
    const layout = JSON.stringify({ tooltip, button, area });
    expect(tooltip, layout).not.toBeNull();
    const drawn = /** @type {Box} */ (tooltip);
    expect(drawn.left, layout).toBeGreaterThanOrEqual(area.left);
    expect(drawn.top, layout).toBeGreaterThanOrEqual(area.top);
    expect(drawn.right, layout).toBeLessThanOrEqual(area.right);
    expect(drawn.bottom, layout).toBeLessThanOrEqual(area.bottom);
    if (position === `top`) expect(drawn.top, layout).toBeGreaterThanOrEqual(button.bottom);
    if (position === `bottom`) expect(drawn.bottom, layout).toBeLessThanOrEqual(button.top);
    if (position === `left`) expect(drawn.left, layout).toBeGreaterThanOrEqual(button.right);
    if (position === `right`) expect(drawn.right, layout).toBeLessThanOrEqual(button.left);
  });
}
