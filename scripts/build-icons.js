/**
 * @fileoverview Makes the app's icon images from src/tauri/icons/icon.svg
 * with the Tauri CLI's icon command: every other file in src/tauri/icons is
 * replaced by the image of the same name that the command makes, so the
 * folder keeps the images it has and gets no others. The command's output
 * goes to build/icons, which is deleted once the images are copied. Fails,
 * changing nothing, when the command makes no image of one of those names.
 * Every build runs it first; on its own, run with: npm run build:icons
 */

import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '@tauri-apps/cli';

const thisFile = fileURLToPath(import.meta.url);
const root = join(dirname(thisFile), `..`);

/** The folder of the app's icon images. */
const ICONS_DIR = join(root, `src`, `tauri`, `icons`);

/** The image all the others are made from. */
const ICON_SOURCE = `icon.svg`;

/** Where the icon command's output goes before it is copied. */
const OUTPUT_DIR = join(root, `build`, `icons`);

/**
 * Makes the icon images from the icon source and puts them in place of the
 * ones in the icons folder.
 * @returns {Promise<string[]>} The names of the images replaced.
 */
async function buildIcons() {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  try {
    await run([`icon`, join(ICONS_DIR, ICON_SOURCE), `--output`, OUTPUT_DIR], `build-icons`);
    const names = readdirSync(ICONS_DIR).filter((name) => name !== ICON_SOURCE);
    const missing = names.filter((name) => !existsSync(join(OUTPUT_DIR, name)));
    if (missing.length > 0) {
      throw new Error(`the icon command made no ${missing.join(`, `)}`);
    }
    for (const name of names) copyFileSync(join(OUTPUT_DIR, name), join(ICONS_DIR, name));
    return names;
  } finally {
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
}

if (process.argv[1] === thisFile) {
  const names = await buildIcons();
  console.log(`Made ${names.join(`, `)} from ${ICON_SOURCE}`);
}
