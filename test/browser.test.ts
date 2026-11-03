import { createContext, runInContext } from 'node:vm';
import type { Frame as PlaywrightFrame, Page as PlaywrightPage } from 'playwright';
import { type Browser, type BrowserType, chromium, firefox, type Page, webkit } from 'playwright';
import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { extractVisibleFromPage, type PageLike } from '../src/browser.js';
import type { HiddenReason } from '../src/types.js';
import { type Case, cases, type Where } from './cases.js';

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

/**
 * The engines to drive, as a comma-separated list in `NAKED_EYE_BROWSERS`, so
 * that `npm test` passes on a machine with no browsers installed. An unknown
 * name fails loudly rather than silently running nothing.
 */
const selected = (process.env.NAKED_EYE_BROWSERS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
for (const name of selected) {
  if (ENGINES[name] === undefined)
    throw new Error(`NAKED_EYE_BROWSERS names ${name}, which is not chromium, firefox or webkit`);
}

const documentOf = (html: string): string =>
  html.toLowerCase().startsWith('<!doctype')
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;

function expectationFor(
  testCase: Case,
  engine: Where,
): { visible: string; hidden: [HiddenReason, string][] } {
  const divergence =
    testCase.diverges?.find((entry) => entry.where === engine) ??
    testCase.diverges?.find((entry) => entry.where === 'browser');
  if (divergence === undefined) return { visible: testCase.visible, hidden: testCase.hidden ?? [] };
  return { visible: divergence.visible, hidden: divergence.hidden ?? [] };
}

describe('extractVisibleFromPage', () => {
  it('accepts the page objects Playwright and Puppeteer hand out', () => {
    expectTypeOf<PlaywrightPage>().toExtend<PageLike>();
    expectTypeOf<PlaywrightFrame>().toExtend<PageLike>();
    expectTypeOf<PuppeteerPage>().toExtend<PageLike>();
  });

  it('rejects invalid thresholds', async () => {
    await expect(
      extractVisibleFromPage({ evaluate: async () => ({}) }, { minContrast: -1 }),
    ).rejects.toThrow(TypeError);
    await expect(
      extractVisibleFromPage({ evaluate: async () => ({}) }, { minFontSize: Number.NaN }),
    ).rejects.toThrow(TypeError);
  });

  it('sends one self-contained expression that needs nothing but the page', async () => {
    // A bare VM context has no bundler, no module loader and no library: if the
    // page script were not embedded whole, this would not run at all.
    const document = { childNodes: [], createElement: () => ({ getContext: () => null }) };
    const page: PageLike = {
      evaluate: async (script) => runInContext(script, createContext({ document })) as unknown,
    };
    await expect(extractVisibleFromPage(page)).resolves.toEqual({
      text: '',
      hidden: [],
      generated: [],
      warnings: [],
    });
  });
});

describe.runIf(selected.length > 0)('the shared corpus in browser mode', () => {
  for (const name of selected) {
    describe(name, () => {
      let browser: Browser;
      let page: Page;

      beforeAll(async () => {
        browser = await (ENGINES[name] as BrowserType).launch();
        page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      });

      afterAll(async () => {
        await browser.close();
      });

      it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
        '%s',
        async (_, testCase) => {
          await page.setContent(documentOf(testCase.html));
          const result = await extractVisibleFromPage(page);
          const expected = expectationFor(testCase, name as Where);
          expect(result.text).toBe(expected.visible);
          const found = result.hidden.map((finding) => [finding.reason, finding.text]);
          for (const finding of expected.hidden) expect(found).toContainEqual(finding);
        },
      );

      it('reads a same-origin frame and warns about a cross-origin one', async () => {
        for (const origin of ['https://inside.test', 'https://outside.test']) {
          await page.route(`${origin}/**`, (route) =>
            route.fulfill({ contentType: 'text/html', body: '<p>frame text</p>' }),
          );
        }
        await page.goto('https://inside.test/');
        await page.setContent(
          documentOf(
            '<p>host</p><iframe src="https://inside.test/same"></iframe><iframe src="https://outside.test/other"></iframe>',
          ),
        );
        const result = await extractVisibleFromPage(page);
        expect(result.text).toContain('frame text');
        expect(result.warnings.map((warning) => warning.code)).toContain('cross-origin-frame');
        expect(
          result.warnings.find((warning) => warning.code === 'cross-origin-frame')?.message,
        ).toContain('https://outside.test/other');
      });

      it('extracts a large page in time linear in the number of text nodes', async () => {
        const time = async (count: number): Promise<number> => {
          await page.setContent(documentOf('<span>x</span>'.repeat(count)));
          const started = performance.now();
          const { text } = await extractVisibleFromPage(page);
          const elapsed = performance.now() - started;
          expect(text).toHaveLength(count);
          return elapsed;
        };
        await time(2_000);
        // Four times the text nodes: linear work takes about four times as
        // long, work that hit-tests each node against every box sixteen.
        const small = await time(8_000);
        const large = await time(32_000);
        expect(large / small).toBeLessThan(10);
      });
    });
  }
});
