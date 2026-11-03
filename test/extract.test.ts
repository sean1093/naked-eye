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
    expect(hidden[0]?.detail).toBe('opacity: 0 (under a condition static mode cannot decide)');
    expect(warnings.map((warning) => warning.code)).toEqual(['unknown-condition']);
  });

  it('applies stylesheets the caller supplies, and warns about the rest', () => {
    const html = documentOf(
      '<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/other.css"><p class="x">secret</p>',
    );
    const result = extractVisible(html, { stylesheets: { '/site.css': '.x { display: none }' } });
    expect(result.text).toBe('');
    expect(result.warnings).toEqual([
      {
        code: 'unresolved-stylesheet',
        message:
          '<link rel="stylesheet" href="/other.css"> was not applied: its CSS was not supplied',
      },
    ]);
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
    expect(result.warnings).toEqual([
      {
        code: 'unsupported-color',
        message: 'Unsupported color rgb(from …): text drawn with it was kept',
      },
    ]);
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
    expect(result).toEqual({
      text: '',
      hidden: [],
      warnings: [
        { code: 'document-too-deep', message: 'The document nests elements more than 1024 deep.' },
      ],
    });
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

  it('handles fragments and empty input', () => {
    expect(extractVisible('').text).toBe('');
    expect(extractVisible('plain <b>text</b>').text).toBe('plain text');
  });
});
