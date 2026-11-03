import { describe, expect, it } from 'vitest';
import { extractVisible } from '../src/index.js';
import { cases } from './cases.js';

const documentOf = (html: string): string =>
  html.toLowerCase().startsWith('<!doctype')
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;

describe('the shared corpus in static mode', () => {
  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_, testCase) => {
    const result = extractVisible(documentOf(testCase.html));
    expect(result.text).toBe(testCase.visible);
    const found = result.hidden.map((finding) => [finding.reason, finding.text]);
    for (const expected of testCase.hidden ?? []) expect(found).toContainEqual(expected);
  });
});

describe('extractVisible', () => {
  it('reports where and why text was removed', () => {
    const { hidden } = extractVisible(
      documentOf('<div id="box"><p>a</p><p style="font-size: 0.5px">tiny</p></div>'),
    );
    expect(hidden).toEqual([
      {
        text: 'tiny',
        reason: 'font-size',
        selector: '#box > p:nth-of-type(2)',
        detail: 'font-size: 0.5px',
      },
    ]);
  });

  it('merges the text of one hidden element into one finding', () => {
    const { hidden } = extractVisible(documentOf('<div style="display: none">a <b>b</b> c</div>'));
    expect(hidden).toEqual([
      {
        text: 'a b c',
        reason: 'display-none',
        selector: 'html > body > div',
        detail: 'display: none',
      },
    ]);
  });

  it('keeps text only when it is visible with and without undecidable rules', () => {
    const hiding =
      '<style>@container (min-width: 1px) { .a { display: none } }</style><p class="a">secret</p>keep';
    const revealing =
      '<style>.b { display: none } @container (min-width: 1px) { .b { display: block } }</style><p class="b">secret</p>keep';
    for (const html of [hiding, revealing]) {
      const result = extractVisible(documentOf(html));
      expect(result.text).toBe('keep');
      expect(result.hidden.map((finding) => finding.text)).toEqual(['secret']);
    }
  });

  it('marks findings that only an undecidable condition produced', () => {
    const { hidden, warnings } = extractVisible(
      documentOf('<style>@container (width > 0) { p { opacity: 0 } }</style><p>x</p>'),
    );
    expect(hidden[0]?.detail).toContain('opacity: 0');
    expect(warnings.map((warning) => warning.code)).toEqual(['unknown-condition']);
  });

  it('applies stylesheets the caller supplies, and warns about the rest', () => {
    const html = documentOf(
      '<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/other.css"><p class="x">secret</p>',
    );
    const result = extractVisible(html, { stylesheets: { '/site.css': '.x { display: none }' } });
    expect(result.text).toBe('');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['unresolved-stylesheet']);
    expect(result.warnings[0]?.message).toContain('/other.css');
  });

  it('honours the thresholds and viewport it is given', () => {
    const html = documentOf(
      '<style>@media (max-width: 500px) { .m { display: none } }</style><p style="font-size: 6px">six</p><p style="opacity: 0.3">faint</p><p style="position: relative; left: -600px">near</p><p class="m">wide only</p>',
    );
    expect(extractVisible(html).text).toBe('six\n\nfaint\n\nnear\n\nwide only');
    expect(
      extractVisible(html, {
        minFontSize: 8,
        minOpacity: 0.5,
        offScreenDistance: 500,
        viewport: { width: 400, height: 800 },
      }).text,
    ).toBe('');
  });

  it('keeps text in a color it cannot evaluate, and warns', () => {
    const result = extractVisible(
      documentOf('<p style="color: rgb(from white r g b)">relative</p>'),
    );
    expect(result.text).toBe('relative');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['unsupported-color']);
  });

  it('applies the contrast threshold and the preferred color scheme it is given', () => {
    const gray = documentOf('<p style="color: #777">gray</p>');
    expect(extractVisible(gray).text).toBe('gray');
    expect(extractVisible(gray, { minContrast: 5 }).hidden).toEqual([
      {
        text: 'gray',
        reason: 'low-contrast',
        selector: 'html > body > p',
        detail: '#777777 on #ffffff, contrast 4.48:1',
      },
    ]);
    const adaptive =
      '<!doctype html><html style="color-scheme: light dark"><body><p style="color: light-dark(#111, #eee)">adaptive</p></body></html>';
    expect(extractVisible(adaptive).text).toBe('adaptive');
    expect(extractVisible(adaptive, { colorScheme: 'dark' }).text).toBe('adaptive');
    const fixed =
      '<!doctype html><html style="color-scheme: light dark"><body><p style="color: #111">fixed</p></body></html>';
    expect(
      extractVisible(fixed, { colorScheme: 'dark' }).hidden.map((finding) => finding.reason),
    ).toEqual(['low-contrast']);
  });

  it('rejects invalid options', () => {
    expect(() => extractVisible('', { minFontSize: -1 })).toThrow(TypeError);
    expect(() => extractVisible('', { minOpacity: Number.NaN })).toThrow(TypeError);
    expect(() => extractVisible('', { minContrast: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => extractVisible('', { viewport: { width: 0, height: 800 } })).toThrow(TypeError);
  });

  it('extracts nothing from a document nested deeper than any real page, and says so', () => {
    const started = Date.now();
    const result = extractVisible(`${'<div>'.repeat(200_000)}deep secret`);
    expect(result.text).toBe('');
    expect(result.hidden).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['document-too-deep']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('builds finding selectors in time linear in the number of siblings', () => {
    const started = Date.now();
    const { hidden } = extractVisible(
      documentOf('<span style="display: none">x</span>'.repeat(20_000)),
    );
    expect(hidden).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('removes soft hyphens without reporting them', () => {
    expect(extractVisible(documentOf('<p>co&shy;operate</p>'))).toEqual({
      text: 'cooperate',
      hidden: [],
      generated: [],
      warnings: [],
    });
  });

  it('reports invisible characters against the element that holds them, in order', () => {
    const { hidden } = extractVisible(documentOf('<div id="note">ok\u200B\u{E0041}</div>'));
    expect(hidden.map(({ text, reason, selector }) => ({ text, reason, selector }))).toEqual([
      { text: 'U+200B', reason: 'invisible-unicode', selector: '#note' },
      { text: 'A', reason: 'invisible-unicode', selector: '#note' },
    ]);
  });

  it('removes glyph variation selectors without reporting them', () => {
    const result = extractVisible(
      documentOf('<p>\u845B\u{E0100} \u2268\uFE00 \u182E\u1823\u180B</p>'),
    );
    expect(result.text).toBe('\u845B \u2268 \u182E\u1823');
    expect(result.hidden).toEqual([]);
  });

  it('keeps a joiner that inline markup separates from the letters it joins', () => {
    const result = extractVisible(
      documentOf(
        '<p><b>\u0645\u06CC</b>\u200C\u0631\u0648\u0645</p><p><b>\u0915\u094D</b>\u200D\u0937</p>',
      ),
    );
    expect(result.text).toBe('\u0645\u06CC\u200C\u0631\u0648\u0645\n\n\u0915\u094D\u200D\u0937');
    expect(result.hidden).toEqual([]);
  });

  it('lists the text CSS generates, with its pseudo-element', () => {
    const result = extractVisible(
      documentOf(
        '<style>#total::before { content: "Total: " } #total::after { content: "\\200B" }</style><p id="total">9</p>',
      ),
    );
    expect(result.text).toBe('Total: 9');
    expect(result.generated).toEqual([{ text: 'Total:', selector: '#total::before' }]);
    expect(result.hidden.map(({ text, reason, selector }) => ({ text, reason, selector }))).toEqual(
      [{ text: 'U+200B', reason: 'invisible-unicode', selector: '#total::after' }],
    );
  });

  it('reports generated text that exists only under an undecidable condition', () => {
    const result = extractVisible(
      documentOf(
        '<style>@container (width > 0) { p::before { content: "maybe " } }</style><p>x</p>',
      ),
    );
    expect(result.text).toBe('x');
    expect(result.hidden.map(({ text, selector }) => ({ text, selector }))).toEqual([
      { text: 'maybe', selector: 'html > body > p::before' },
    ]);
  });

  it('caps how much text generated content may add', () => {
    const result = extractVisible(
      documentOf(
        `<style>*::before { content: "${'A'.repeat(5000)}" }</style>${'<div></div>'.repeat(300)}`,
      ),
    );
    const generated = result.generated.reduce((total, entry) => total + entry.text.length, 0);
    expect(generated).toBeLessThanOrEqual(1_000_000);
    expect(result.warnings.map((warning) => warning.code)).toContain('unsupported-content');
  });

  it('warns about counters and images in generated content', () => {
    const result = extractVisible(
      documentOf(
        '<style>li::before { content: counter(item) ". " url(dot.png) }</style><ol><li>first</li></ol>',
      ),
    );
    expect(result.text).toBe('. first');
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'unsupported-content',
      'unsupported-content',
    ]);
  });

  it('handles fragments and empty input', () => {
    expect(extractVisible('').text).toBe('');
    expect(extractVisible('plain <b>text</b>').text).toBe('plain text');
  });
});
