// Cleans a fetched page before it enters a RAG pipeline: only the text a
// reader would see is chunked for the index, and everything the page hid is
// logged instead.
//
//   node examples/clean-for-rag.mjs https://example.com/article
//
// Without a URL it reads the sample page next to this file.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractVisible } from 'naked-eye';

const url = process.argv[2];
const html =
  url === undefined
    ? await readFile(new URL('./hostile-page.html', import.meta.url), 'utf8')
    : await (await fetch(url)).text();

// Static mode never fetches: a page's external style sheets apply only when
// you pass their CSS as `stylesheets`, and `warnings` lists the ones you did not.
const { text, hidden, warnings } = extractVisible(html);

// Blank lines in `text` separate paragraphs, which makes them natural chunks.
const chunks = text.split(/\n{2,}/).map((chunk) => chunk.trim());
for (const [index, chunk] of chunks.entries()) console.log(`chunk ${index + 1}: ${chunk}`);

for (const finding of hidden) {
  console.log(`withheld (${finding.reason}, ${finding.selector}): ${finding.text}`);
}
for (const warning of warnings) console.log(`warning (${warning.code}): ${warning.message}`);

if (url === undefined) {
  // The sample hides five instructions; none of them may reach the index.
  assert.equal(chunks.join(' ').includes('Ignore'), false);
  assert.equal(hidden.length, 5);
}
