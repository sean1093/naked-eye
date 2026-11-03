// One step of a browsing agent: the page is open in Playwright, and the model
// is given only what a person looking at that page would see.
//
//   node examples/playwright-agent.mjs https://example.com
//
// Without a URL it opens the sample page next to this file. Requires
// `npm install playwright` and `npx playwright install chromium`.
import assert from 'node:assert/strict';
import { extractVisibleFromPage } from 'naked-eye/browser';
import { chromium } from 'playwright';

const url = process.argv[2] ?? new URL('./hostile-page.html', import.meta.url).href;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url);
  const { text, hidden } = await extractVisibleFromPage(page);

  console.log(`The model reads:\n${text}\n`);
  console.log(`Withheld from the model (${hidden.length}):`);
  for (const finding of hidden) console.log(`- ${finding.reason}: ${finding.text}`);

  if (process.argv[2] === undefined) {
    assert.equal(text.includes('Ignore'), false);
    assert.equal(hidden.length, 5);
  }
} finally {
  await browser.close();
}
