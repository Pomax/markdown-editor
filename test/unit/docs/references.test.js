/**
 * @fileoverview Checks the developer documents and the README after the
 * port: none refers to the removed layer (the old bridge script,
 * `better-sqlite3`, or the download and native rebuild `npm run setup` used to do), and each has
 * the sections it must have.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`, `..`, `..`);

/**
 * @param {string} file
 * @returns {string}
 */
function read(file) {
  return readFileSync(join(root, file), `utf-8`);
}

/**
 * The text of the section under a heading, up to the next heading of the
 * same or a higher level, or an empty string when there is no such
 * heading.
 * @param {string} text
 * @param {RegExp} heading - matches the heading line, `#` marks included
 * @returns {string}
 */
function section(text, heading) {
  const lines = text.split(`\n`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return ``;
  const level = /** @type {string} */ (lines[start].match(/^#+/)?.[0]).length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const marks = line.match(/^(#+)\s/);
    return marks !== null && marks[1].length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join(`\n`);
}

/**
 * The removed parts no document may refer to.
 * @type {{ name: string, pattern: RegExp }[]}
 */
const REMOVED = [
  { name: `the old bridge script`, pattern: new RegExp(`${[`pre`, `load`].join(``)}\\.cjs`) },
  { name: `better-sqlite3`, pattern: /better-sqlite3/ },
  { name: `the native rebuild in npm run setup`, pattern: /install-app-deps/ },
];

/**
 * The documents checked.
 * @type {Record<string, string>}
 */
const DOCUMENTS = {
  architecture: `docs/developers/architecture.md`,
  design: `docs/developers/design.md`,
  gettingStarted: `docs/developers/getting-started.md`,
  readme: `README.md`,
};

/**
 * The removed parts a document refers to.
 * @param {string} file
 * @returns {string[]}
 */
function removedReferences(file) {
  const text = read(file);
  return REMOVED.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

describe(`architecture.md`, () => {
  const text = read(DOCUMENTS.architecture);

  it(`refers to nothing removed`, () => {
    assert.deepStrictEqual(removedReferences(DOCUMENTS.architecture), []);
  });

  it(`has a process model section`, () => {
    assert.notStrictEqual(section(text, /^## Process Model/), ``);
  });

  it(`names every backend module and the bridge in a table`, () => {
    const rows = text.split(`\n`).filter((line) => line.startsWith(`|`));
    const modules = readdirSync(join(root, `src`, `tauri`)).filter(
      (name) => name.endsWith(`.rs`) || name === `backend-bridge.js`,
    );
    const missing = modules.filter((name) => !rows.some((row) => row.includes(`\`${name}\``)));
    assert.deepStrictEqual(missing, []);
  });

  it(`has a security section covering the port's decisions`, () => {
    const security = section(text, /^## Security/);
    const topics = [
      /threat model/i,
      /capabilit/i,
      /Content-Security-Policy|CSP/,
      /`media` protocol/,
      /navigat/i,
      /window\.open/,
      /permission request/i,
      /sandbox/,
      /page script can reach/i,
      /before document scripts may run/i,
    ];
    const missing = topics.filter((topic) => !topic.test(security)).map(String);
    assert.deepStrictEqual(missing, []);
  });
});

describe(`design.md`, () => {
  const text = read(DOCUMENTS.design);

  it(`refers to nothing removed`, () => {
    assert.deepStrictEqual(removedReferences(DOCUMENTS.design), []);
  });

  it(`shows the source structure with the Tauri backend`, () => {
    const source = section(text, /^### Source Structure/);
    assert.match(source, /tauri\//);
    assert.doesNotMatch(source, /src-tauri/);
  });

  it(`shows the test structure with the port's test folders`, () => {
    const tests = section(text, /^### Test Structure/);
    for (const folder of [/tauri\//, /bridge\//, /scripts\//, /release\//]) {
      assert.match(tests, folder);
    }
  });
});

describe(`getting-started.md`, () => {
  const text = read(DOCUMENTS.gettingStarted);

  it(`refers to nothing removed`, () => {
    assert.deepStrictEqual(removedReferences(DOCUMENTS.gettingStarted), []);
  });

  it(`lists the prerequisites for each platform`, () => {
    const prerequisites = section(text, /^## Prerequisites/);
    for (const needed of [/Windows/, /MSVC/, /WebView2/, /macOS/, /Xcode/, /Linux/, /WebKitGTK/]) {
      assert.match(prerequisites, needed);
    }
  });

  it(`gives the port's test commands`, () => {
    for (const command of [`npm run test:unit`, `npm run test:rust`, `npm run test:integration`]) {
      assert.ok(text.includes(command), command);
    }
  });
});

describe(`README.md`, () => {
  const text = read(DOCUMENTS.readme);

  it(`refers to nothing removed`, () => {
    assert.deepStrictEqual(removedReferences(DOCUMENTS.readme), []);
  });

  it(`has its title, and says how to run, test and build`, () => {
    assert.ok(text.startsWith(`# Pomax's Markdown Editor\n`), `title`);
    for (const command of [`npm start`, `npm test`, `npm run build`]) {
      assert.ok(text.includes(command), command);
    }
  });
});
