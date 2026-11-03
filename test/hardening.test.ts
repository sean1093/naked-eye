import { describe, expect, it } from 'vitest';
import type { Display } from '../src/css/properties.js';
import { extractVisible } from '../src/index.js';
import { styled } from './helpers.js';

const STANDARDS = '<!doctype html>';
const kind = (display: Display): string => (display.kind === 'box' ? display.outer : display.kind);
const hidden = (css: string, body = '<p id=t>x') =>
  kind(styled(`${STANDARDS}<style>${css}</style>${body}`).style('t').display) === 'none';

describe('selectors match the way browsers match them', () => {
  it('treats type selectors as case-insensitive, also as the rightmost compound', () => {
    expect(hidden('P { display: none }')).toBe(true);
    expect(hidden('BODY P:FIRST-CHILD { display: none }')).toBe(true);
  });

  it('makes :read-only match every element that is not editable', () => {
    expect(hidden('p:read-only { display: none }')).toBe(true);
    expect(hidden('p:read-write { display: none }', '<p id=t contenteditable>x')).toBe(true);
    expect(
      hidden('span:read-write { display: none }', '<div contenteditable><span id=t>x</span></div>'),
    ).toBe(true);
    expect(
      hidden(
        'span:read-write { display: none }',
        '<div contenteditable><span id=t contenteditable=false>x</span></div>',
      ),
    ).toBe(false);
    expect(hidden('input:read-write + p { display: none }', '<input><p id=t>x')).toBe(true);
    expect(hidden('input:read-only + p { display: none }', '<input readonly><p id=t>x')).toBe(true);
    expect(
      hidden(
        'input:read-only + p { display: none }',
        '<fieldset disabled><input><p id=t>x</fieldset>',
      ),
    ).toBe(true);
    expect(hidden('input:read-only + p { display: none }', '<input type=checkbox><p id=t>x')).toBe(
      true,
    );
  });

  it('rejects css-select extensions that browsers do not know', () => {
    expect(hidden('p { display: none } p:parent { display: block }')).toBe(true);
    expect(hidden('p:contains(x) { display: none }')).toBe(false);
    expect(hidden(':is(p:header, p) { display: none }')).toBe(true);
  });

  it('drops only the unusable arguments of :is() and :where()', () => {
    expect(hidden(':is(p, :no-such-state) { display: none }')).toBe(true);
    expect(hidden(':where(:no-such-state, p) { display: none }')).toBe(true);
    expect(hidden(':is(p, ::before) { display: none }')).toBe(true);
    expect(hidden(':is(:no-such-state) { display: none }')).toBe(false);
  });

  it('resolves namespace prefixes', () => {
    expect(hidden('*|p { display: none }')).toBe(true);
    expect(hidden('|p { display: none }')).toBe(false);
    expect(hidden('@namespace h url(http://www.w3.org/1999/xhtml); h|p { display: none }')).toBe(
      true,
    );
    expect(hidden('@namespace s url(http://www.w3.org/2000/svg); s|p { display: none }')).toBe(
      false,
    );
    expect(hidden('x|p { display: none } p { color: red }')).toBe(false);
  });

  it('evaluates the constraints a control fails without interaction', () => {
    const invalid = (control: string) =>
      hidden(':invalid + p { display: none }', `${control}<p id=t>x`);
    expect(invalid('<input type=email value=x>')).toBe(true);
    expect(invalid('<input type=email value=a@b.example>')).toBe(false);
    expect(invalid('<input type=email multiple value="a@b.example, nope">')).toBe(true);
    expect(invalid('<input type=url value=x>')).toBe(true);
    expect(invalid('<input type=url value=https://example.com>')).toBe(false);
    expect(invalid('<input type=number min=5 value=3>')).toBe(true);
    expect(invalid('<input type=number step=2 value=3>')).toBe(true);
    expect(invalid('<input type=number step=any value=3.3>')).toBe(false);
    expect(invalid('<input pattern="\\d+" value=abc>')).toBe(false);
  });

  it('resolves dir=auto from the first strong character', () => {
    expect(hidden('p:dir(rtl) { display: none }', '<p id=t dir=auto>שלום world')).toBe(true);
    expect(hidden('p:dir(rtl) { display: none }', '<p id=t dir=auto>hello שלום')).toBe(false);
  });
});

describe('properties browsers alias', () => {
  it('reads prefixed hiding properties', () => {
    const style = styled(
      `${STANDARDS}<p id=t style="-webkit-filter: opacity(0); -webkit-transform: scale(0); -webkit-clip-path: inset(50%)">x`,
    ).style('t');
    expect(style.filterOpacity).toBe(0);
    expect(style.transform).toEqual([{ name: 'scale', args: [0] }]);
    expect(typeof style.clipPath === 'object' && style.clipPath.shape).toBe('inset');
  });

  it('reads logical sizes as physical ones', () => {
    const style = styled(
      `${STANDARDS}<div id=t style="inline-size: 0; block-size: 0; max-block-size: 0; max-inline-size: 0">x</div>`,
    ).style('t');
    expect([style.width, style.height, style.maxWidth, style.maxHeight]).toEqual([0, 0, 0, 0]);
  });

  it('reads containment', () => {
    const style = (css: string) =>
      styled(`${STANDARDS}<div id=t style="${css}">x</div>`).style('t');
    expect(style('contain: strict').contain).toEqual({ size: true, paint: true });
    expect(style('contain: content').contain).toEqual({ size: false, paint: true });
    expect(style('contain: size paint').contain).toEqual({ size: true, paint: true });
    expect(style('contain: strict; contain: size size').contain).toEqual({
      size: true,
      paint: true,
    });
    expect(style('contain-intrinsic-size: auto 100px').intrinsicHeight).toBe(true);
    expect(style('contain-intrinsic-size: 10px none').intrinsicHeight).toBe(false);
    expect(style('contain-intrinsic-block-size: 5px').intrinsicHeight).toBe(true);
  });

  it('rejects transform argument lists browsers reject', () => {
    const transform = (value: string) =>
      styled(
        `${STANDARDS}<style>p { transform: scale(0) } p { transform: ${value} }</style><p id=t>x`,
      ).style('t').transform;
    for (const value of [
      'scale(1 1)',
      'translate(1px 2px)',
      'scale(1, 1, 1, 1, 1)',
      'rotate(1px)',
      'matrix(1, 0, 0, 1, 0)',
      'translateZ(5%)',
    ]) {
      expect(transform(value)).toEqual([{ name: 'scale', args: [0] }]);
    }
    expect(transform('rotate3d(0, 0, 1, 90deg)')).toEqual([
      { name: 'rotate3d', args: [0, 0, 1, 90] },
    ]);
  });

  it('resets every longhand of the white-space shorthand', () => {
    const style = styled(
      `${STANDARDS}<div style="white-space: nowrap"><p id=t style="white-space: preserve">x</div>`,
    ).style('t');
    expect([style.whiteSpaceCollapse, style.textWrapMode]).toEqual(['preserve', 'wrap']);
  });
});

describe('definitions under undecidable conditions', () => {
  it('keeps @keyframes and @property definitions apart per world', () => {
    const css =
      '@keyframes f { to { opacity: 0 } } @container (min-width: 0) { @keyframes f { to { opacity: 1 } } } p { animation: f 1s forwards }';
    const { style } = styled(`${STANDARDS}<style>${css}</style><p id=t>x`);
    expect([style('t', 0).opacity, style('t', 1).opacity]).toEqual([0, 1]);
    const property =
      '@property --d { syntax: "*"; inherits: false; initial-value: block } @container (min-width: 0) { @property --d { syntax: "*"; inherits: false; initial-value: none } } p { display: var(--d) }';
    const registered = styled(`${STANDARDS}<style>${property}</style><p id=t>x`);
    expect([
      kind(registered.style('t', 0).display),
      kind(registered.style('t', 1).display),
    ]).toEqual(['block', 'none']);
  });
});

describe('hostile input stays bounded', () => {
  it('keeps the rest of a style sheet when one value nests too deep', () => {
    const deep = `${'('.repeat(600)}1px${')'.repeat(600)}`;
    expect(hidden(`p { display: none } p { width: ${deep} }`)).toBe(true);
    expect(
      kind(
        styled(`${STANDARDS}<p id=t style="display: none; width: ${deep}">x`).style('t').display,
      ),
    ).toBe('none');
    expect(
      hidden(`${':is('.repeat(600)}p${')'.repeat(600)} { color: red } p { display: none }`),
    ).toBe(true);
  });

  it('invalidates a custom property that expands without bound', () => {
    const levels = Array.from(
      { length: 24 },
      (_, level) => `--v${level}: var(--v${level + 1}) var(--v${level + 1});`,
    ).join(' ');
    const started = Date.now();
    const style = styled(
      `${STANDARDS}<style>p { ${levels} --v24: 1px; width: var(--v0); display: var(--v0, none) }</style><p id=t>x`,
    ).style('t');
    expect(style.width).toBe('auto');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('styles deeply nested rules in time linear in their depth', () => {
    const depth = 24;
    const css = `${'a, b, c { '.repeat(depth)}& p { display: none }${' }'.repeat(depth)}`;
    const started = Date.now();
    expect(hidden(css, `${'<b>'.repeat(depth)}<p id=t>x`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('shares inherited text-shadow lists instead of resolving them per element', () => {
    const time = (count: number): number => {
      const layers = Array.from(
        { length: count },
        (_, index) => `0 0 #${index.toString(16).padStart(6, '0')}`,
      ).join(', ');
      const html = `${STANDARDS}<body style="text-shadow: ${layers}">${'<p>x</p>'.repeat(5000)}</body>`;
      const started = performance.now();
      expect(extractVisible(html).text.length).toBeGreaterThan(0);
      return performance.now() - started;
    };
    time(100);
    // Resolved once and shared, four times the layers costs about the same; per element, four times.
    const few = time(500);
    expect(time(2000) / few).toBeLessThan(2.5);
  }, 60_000);

  it('handles lists longer than a function call can take as arguments', () => {
    const wide = 150_000;
    const tags = extractVisible(`${STANDARDS}<p>x${'\u{E0041}'.repeat(wide)}</p>`);
    expect(tags.text).toBe('x');
    expect(tags.hidden[0]?.text).toHaveLength(wide);
    expect(extractVisible(`${STANDARDS}<body>${'<b>x</b>'.repeat(wide)}</body>`).text).toHaveLength(
      wide,
    );
    const template = extractVisible(
      `${STANDARDS}<body><template>${'<b>x</b>'.repeat(wide)}</template></body>`,
    );
    expect(template.text).toBe('');
    expect(template.hidden[0]?.reason).toBe('not-rendered');
    const options = `<select><optgroup>${'<option>x</option>'.repeat(wide)}</optgroup></select>`;
    expect(extractVisible(`${STANDARDS}${options}`).text).toBe('x');
    const lengths = Array(wide).fill('0px').join(',');
    expect(extractVisible(`${STANDARDS}<p style="font-size: max(${lengths})">x</p>`).text).toBe('');
    expect(extractVisible(`${STANDARDS}<p style="${'opacity: 0;'.repeat(wide)}">x</p>`).text).toBe(
      '',
    );
  }, 120_000);

  it('handles shadow trees wider than a function call can take as arguments', () => {
    const wide = 150_000;
    const items = '<b>x</b>'.repeat(wide);
    const host = (shadow: string, light: string): string =>
      extractVisible(
        `${STANDARDS}<body><div><template shadowrootmode="open">${shadow}</template>${light}</div></body>`,
      ).text;
    expect(host(items, '')).toHaveLength(wide);
    expect(host('<slot name="a"></slot>', items)).toBe('');
    expect(host(`<slot>${items}</slot>`, 'y')).toBe('y');
  }, 120_000);

  it('counts templates and shadow roots toward the nesting limit', () => {
    const html = `${'<div><template shadowrootmode="open">'.repeat(1400)}x${'</template></div>'.repeat(1400)}`;
    expect(extractVisible(html).warnings.map((warning) => warning.code)).toEqual([
      'document-too-deep',
    ]);
  });

  it('matches ::part() rules and exportparts in time linear in their size', () => {
    const time = (html: string): number => {
      const started = performance.now();
      extractVisible(html);
      return performance.now() - started;
    };
    const parts = (count: number): string => {
      const indices = Array.from({ length: count }, (_, index) => index);
      const rules = indices.map((index) => `#h::part(q${index}) { color: red }`).join('');
      const paragraphs = indices.map((index) => `<p part="q${index}">x</p>`).join('');
      return `${STANDARDS}<style>${rules}</style><div id="h"><template shadowrootmode="open">${paragraphs}</template></div>`;
    };
    const exports = (count: number): string => {
      const names = Array.from({ length: count }, (_, index) => `p${index}`);
      return `${STANDARDS}<div><template shadowrootmode="open"><section exportparts="${names.join(',')}"><template shadowrootmode="open"><p part="${names.join(' ')}">x</p></template></section></template></div>`;
    };
    time(parts(250));
    // Four times the input: linear work takes about four times as long, quadratic sixteen.
    const smallParts = time(parts(1000));
    expect(time(parts(4000)) / smallParts).toBeLessThan(10);
    const smallExports = time(exports(10_000));
    expect(time(exports(40_000)) / smallExports).toBeLessThan(10);
  }, 60_000);

  it('parses each imported style sheet once and caps how many are applied', () => {
    const stylesheets: Record<string, string> = { 's6.css': 'p { display: none }' };
    for (let level = 0; level < 6; level += 1) {
      stylesheets[`s${level}.css`] = `@import "s${level + 1}.css";`.repeat(6);
    }
    const started = Date.now();
    const { engine, style } = styled(`${STANDARDS}<style>@import "s0.css";</style><p id=t>x`, {
      stylesheets,
    });
    expect(kind(style('t').display)).toBe('none');
    expect(engine.warnings.map((warning) => warning.code)).toContain('unresolved-stylesheet');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
