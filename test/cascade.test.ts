import { describe, expect, it } from 'vitest';
import type { Display } from '../src/css/properties.js';
import { styled } from './helpers.js';

const STANDARDS = '<!doctype html>';

function name(value: Display): string {
  if (value.kind === 'box') return value.listItem ? 'list-item' : value.outer;
  return value.kind === 'internal' ? value.role : value.kind;
}

const display = (html: string, id = 't', world: 0 | 1 = 0) =>
  name(styled(STANDARDS + html).style(id, world).display);

describe('cascade order', () => {
  it('lets the more specific selector win, and gives :where() no specificity', () => {
    expect(
      display('<style>#t { display: none } .c { display: block }</style><p id=t class=c>x'),
    ).toBe('none');
    expect(
      display('<style>.c { display: none } :where(#t) { display: block }</style><p id=t class=c>x'),
    ).toBe('none');
    expect(
      display(
        '<style>:is(#t, p) { display: none } .c.c { display: block }</style><p id=t class=c>x',
      ),
    ).toBe('none');
  });

  it('lets the later of two equally specific rules win', () => {
    expect(display('<style>p { display: block } p { display: none }</style><p id=t>x')).toBe(
      'none',
    );
  });

  it('ranks !important above specificity, and the style attribute above selectors', () => {
    expect(
      display('<style>p { display: none !important } #t { display: block }</style><p id=t>x'),
    ).toBe('none');
    expect(display('<style>#t#t { display: block }</style><p id=t style="display: none">x')).toBe(
      'none',
    );
    expect(
      display('<style>p { display: none !important }</style><p id=t style="display: block">x'),
    ).toBe('none');
    expect(
      display(
        '<style>p { display: block !important }</style><p id=t style="display: none !important">x',
      ),
    ).toBe('none');
  });

  it('ranks unlayered rules above layered ones, and reverses layers for !important', () => {
    expect(
      display(
        '<style>p { display: none } @layer base { #t#t { display: block } }</style><p id=t>x',
      ),
    ).toBe('none');
    expect(
      display(
        '<style>@layer base { p { display: none !important } } #t { display: block !important }</style><p id=t>x',
      ),
    ).toBe('none');
  });

  it('orders layers by their first declaration, not by where their rules appear', () => {
    const css =
      '@layer low, high; @layer high { p { display: none } } @layer low { #t { display: block } }';
    expect(display(`<style>${css}</style><p id=t>x`)).toBe('none');
    const nested = '@layer outer { @layer inner { #t { display: block } } p { display: none } }';
    expect(display(`<style>${nested}</style><p id=t>x`)).toBe('none');
  });

  it('keeps a declaration a browser accepts over an earlier one, and drops one it rejects', () => {
    expect(
      styled(`${STANDARDS}<style>p { opacity: 0 } p { opacity: garbage }</style><p id=t>x`).style(
        't',
      ).opacity,
    ).toBe(0);
    expect(display('<style>p { display: none } p { display: blocky }</style><p id=t>x')).toBe(
      'none',
    );
  });

  it('rolls back to the user-agent sheet on revert, and to the previous layer on revert-layer', () => {
    expect(display('<style>p { display: none } p { display: revert }</style><p id=t>x')).toBe(
      'block',
    );
    const css = '@layer a { p { display: none } } @layer b { p { display: revert-layer } }';
    expect(display(`<style>${css}</style><p id=t>x`)).toBe('none');
  });

  it('applies the user-agent sheet, including the hidden attribute and its author override', () => {
    expect(display('<p id=t hidden>x')).toBe('none');
    expect(display('<style>[hidden] { display: block }</style><p id=t hidden>x')).toBe('block');
    expect(display('<dialog id=t>x</dialog>')).toBe('none');
  });
});

describe('selectors', () => {
  it('never matches states that need interaction', () => {
    expect(display('<style>p:hover, p:focus, p:target { display: none }</style><p id=t>x')).toBe(
      'block',
    );
    expect(display('<style>p:not(:focus-within) { display: none }</style><p id=t>x')).toBe('none');
  });

  it('evaluates form state from the markup', () => {
    expect(
      display('<style>input:invalid + p { display: none }</style><input required><p id=t>x'),
    ).toBe('none');
    expect(
      display(
        '<style>input:invalid + p { display: none }</style><input required value=v><p id=t>x',
      ),
    ).toBe('block');
  });

  it('matches classes case-insensitively only in quirks mode', () => {
    expect(
      name(styled('<style>.HIDE { display: none }</style><p id=t class=hide>x').style('t').display),
    ).toBe('none');
    expect(display('<style>.HIDE { display: none }</style><p id=t class=hide>x')).toBe('block');
  });

  it('warns about a selector it cannot evaluate and keeps going', () => {
    const { engine, style } = styled(
      `${STANDARDS}<style>p:no-such-state { display: none }</style><p id=t>x`,
    );
    expect(name(style('t').display)).toBe('block');
    expect(engine.warnings.map((warning) => warning.code)).toEqual(['unsupported-selector']);
  });
});

describe('nesting', () => {
  it('resolves &, implicit descendants and nested group rules', () => {
    expect(
      display(
        '<style>.card { & .x { display: none } }</style><div class=card><p id=t class=x>x</div>',
      ),
    ).toBe('none');
    expect(
      display(
        '<style>.card { .x { display: none } }</style><div class=card><p id=t class=x>x</div>',
      ),
    ).toBe('none');
    expect(
      display(
        '<style>.card { > .x { display: none } }</style><div class=card><p id=t class=x>x</div>',
      ),
    ).toBe('none');
    expect(display('<style>p { @media (min-width: 1px) { display: none } }</style><p id=t>x')).toBe(
      'none',
    );
    expect(
      display('<style>.card { .x { display: none } }</style><div><p id=t class=x>x</div>'),
    ).toBe('block');
  });

  it('gives & the specificity of its parent list', () => {
    expect(
      display('<style>#t { display: block } .c { &.c { display: none } }</style><p id=t class=c>x'),
    ).toBe('block');
  });
});

describe('custom properties and substitution', () => {
  it('substitutes inherited custom properties and fallbacks', () => {
    expect(display('<style>:root { --d: none } p { display: var(--d) }</style><p id=t>x')).toBe(
      'none',
    );
    expect(display('<style>p { display: var(--missing, none) }</style><p id=t>x')).toBe('none');
    expect(
      display('<style>p { --a: var(--b); --b: none; display: var(--a) }</style><p id=t>x'),
    ).toBe('none');
  });

  it('treats a failed substitution as unset rather than falling back to an earlier declaration', () => {
    expect(
      display('<style>p { display: none } p { display: var(--missing) }</style><p id=t>x'),
    ).toBe('inline');
  });

  it('treats reference cycles as invalid', () => {
    expect(
      display(
        '<style>p { --a: var(--b); --b: var(--a); display: var(--a, none) }</style><p id=t>x',
      ),
    ).toBe('none');
  });

  it('honours @property registrations', () => {
    const css =
      '@property --d { syntax: "*"; inherits: false; initial-value: none } p { display: var(--d) }';
    expect(display(`<style>${css}</style><p id=t>x`)).toBe('none');
  });

  it('substitutes attr(), env() and if()', () => {
    expect(
      styled(`${STANDARDS}<p id=t data-size=0 style="font-size: attr(data-size px)">x`).style('t')
        .fontSize,
    ).toBe(0);
    expect(
      styled(`${STANDARDS}<p id=t style="font-size: env(safe-area-inset-top)">x`).style('t')
        .fontSize,
    ).toBe(0);
    expect(display('<p id=t style="display: if(media(width > 100px): none; else: block)">x')).toBe(
      'none',
    );
    expect(
      display('<p id=t style="--on: 1; display: if(style(--on: 1): none; else: block)">x'),
    ).toBe('none');
  });
});

describe('conditional rules', () => {
  it('evaluates media queries against the configured viewport', () => {
    const html = '<style>@media (max-width: 600px) { p { display: none } }</style><p id=t>x';
    expect(display(html)).toBe('block');
    expect(
      name(
        styled(STANDARDS + html, {
          environment: { width: 400, height: 800, colorScheme: 'light' },
        }).style('t').display,
      ),
    ).toBe('none');
    expect(
      display(
        '<style>@media screen and (400px < width <= 1280px) { p { display: none } }</style><p id=t>x',
      ),
    ).toBe('none');
    expect(display('<style>@media print { p { display: none } }</style><p id=t>x')).toBe('block');
    expect(display('<style media=print>p { display: none }</style><p id=t>x')).toBe('block');
  });

  it('evaluates @supports for the properties it models', () => {
    expect(
      display('<style>@supports (display: grid) { p { display: none } }</style><p id=t>x'),
    ).toBe('none');
    expect(
      display('<style>@supports not (display: grid) { p { display: none } }</style><p id=t>x'),
    ).toBe('block');
    expect(
      display('<style>@supports (display: nonsense) { p { display: none } }</style><p id=t>x'),
    ).toBe('block');
  });

  it('evaluates undecidable conditions in a second world', () => {
    for (const css of [
      '@container (min-width: 0) { p { display: none } }',
      '@supports (backdrop-filter: blur(1px)) { p { display: none } }',
      '@media (some-future-feature) { p { display: none } }',
    ]) {
      const { engine, style } = styled(`${STANDARDS}<style>${css}</style><p id=t>x`);
      expect(engine.worlds).toBe(2);
      expect(name(style('t', 0).display)).toBe('block');
      expect(name(style('t', 1).display)).toBe('none');
      expect(engine.warnings.map((warning) => warning.code)).toContain('unknown-condition');
    }
  });

  it('ignores @starting-style, which only applies before the first frame', () => {
    expect(display('<style>@starting-style { p { display: none } }</style><p id=t>x')).toBe(
      'block',
    );
  });
});

describe('style sheets', () => {
  it('applies supplied link and @import style sheets, in their layer', () => {
    const stylesheets = {
      'a.css': '@import url("b.css") layer(lib); p { color: red }',
      'b.css': '#t { display: block }',
    };
    const html = `${STANDARDS}<link rel=stylesheet href=a.css><style>p { display: none }</style><p id=t>x`;
    expect(name(styled(html, { stylesheets }).style('t').display)).toBe('none');
  });

  it('warns about style sheets it was not given', () => {
    const { engine } = styled(
      `${STANDARDS}<link rel=stylesheet href=remote.css><style>@import "other.css";</style>`,
    );
    expect(engine.warnings.map((warning) => warning.code)).toEqual([
      'unresolved-stylesheet',
      'unresolved-stylesheet',
    ]);
  });

  it('ignores alternate and disabled style sheets', () => {
    const stylesheets = { 'a.css': 'p { display: none }' };
    for (const link of [
      '<link rel="alternate stylesheet" href=a.css>',
      '<link rel=stylesheet href=a.css disabled>',
    ]) {
      expect(name(styled(`${STANDARDS}${link}<p id=t>x`, { stylesheets }).style('t').display)).toBe(
        'block',
      );
    }
  });
});

describe('values', () => {
  const fontSize = (html: string) => styled(STANDARDS + html).style('t').fontSize;

  it('resolves font-relative, viewport and keyword font sizes', () => {
    expect(fontSize('<div style="font-size: 20px"><p id=t style="font-size: 50%">x</div>')).toBe(
      10,
    );
    expect(fontSize('<div style="font-size: 20px"><p id=t style="font-size: 0.5rem">x</div>')).toBe(
      8,
    );
    expect(fontSize('<p id=t style="font-size: 1vw">x')).toBe(12.8);
    expect(fontSize('<p id=t style="font-size: smaller">x')).toBeCloseTo(16 / 1.2);
    expect(fontSize('<h1><span id=t>x</span></h1>')).toBe(32);
  });

  it('evaluates math functions, censoring NaN and clamping negatives', () => {
    expect(fontSize('<p id=t style="font-size: calc(sin(0deg) * 16px)">x')).toBe(0);
    expect(fontSize('<p id=t style="font-size: clamp(0px, 10vw - 100px, 2px)">x')).toBe(2);
    expect(fontSize('<p id=t style="font-size: max(1px, min(0px, 3px))">x')).toBe(1);
    expect(fontSize('<p id=t style="font-size: calc(0px - 5px)">x')).toBe(0);
    expect(fontSize('<p id=t style="font-size: calc(NaN * 1px)">x')).toBe(0);
    expect(
      fontSize('<p>a</p><p id=t style="font-size: calc(16px - sibling-index() * 8px)">x'),
    ).toBe(0);
  });

  it('reads the size out of the font shorthand', () => {
    expect(fontSize('<p id=t style="font: 0/0 a">x')).toBe(0);
    expect(fontSize('<p id=t style="font: italic bold 2px/1 serif">x')).toBe(2);
  });

  it('accepts unitless lengths only in quirks mode', () => {
    expect(styled('<p id=t style="font-size: 1">x').style('t').fontSize).toBe(1);
    expect(fontSize('<p id=t style="font-size: 1">x')).toBe(16);
  });

  it('applies presentational hints below author rules', () => {
    expect(fontSize('<font size=1><span id=t>x</span></font>')).toBe(10);
    expect(fontSize('<style>font { font-size: 3px }</style><font id=t size=7>x</font>')).toBe(3);
  });

  it('applies the end state of animations that fill forwards', () => {
    const keyframes = '@keyframes fade { from { opacity: 1 } to { opacity: 0 } }';
    const opacity = (animation: string) =>
      styled(
        `${STANDARDS}<style>${keyframes} p { animation: ${animation} }</style><p id=t>x`,
      ).style('t').opacity;
    expect(opacity('fade 0s forwards')).toBe(0);
    expect(opacity('fade 1s')).toBe(1);
    expect(opacity('fade 1s 2 alternate forwards')).toBe(1);
    expect(opacity('fade 1s reverse paused')).toBe(0);
  });

  it('combines overflow values the way computed values do', () => {
    const { style } = styled(`${STANDARDS}<p id=t style="overflow-x: hidden">x`);
    expect([style('t').overflowX, style('t').overflowY]).toEqual(['hidden', 'auto']);
  });
});

describe('robustness', () => {
  it('styles a document at the maximum nesting depth', () => {
    const html = `${STANDARDS}<style>div { display: block }</style>${'<div>'.repeat(1000)}<p id=t>x`;
    expect(name(styled(html).style('t').display)).toBe('block');
  });

  it('survives malformed and hostile style sheets', () => {
    const sheets = [
      'p { display: none',
      '}}}{{{ p { display: none } @media',
      `p { ${'--a: var(--b);'.repeat(50)} display: ${'calc('.repeat(200)}1px${')'.repeat(200)} }`,
      'p { font-size: calc(1px / 0); width: calc(1px * 1px); opacity: calc(1 / 0) }',
      '@layer a.b.c.d.e { @layer { @layer f { p { display: none } } } }',
      `${':is('.repeat(100)}p${')'.repeat(100)} { display: none }`,
      'p { display: var(--a) } :root { --a: var(--a) }',
      '@import url(self.css);',
      'p { animation: x 1s infinite forwards } @keyframes x { 0%, 200% { opacity: 0 } }',
    ];
    for (const css of sheets) {
      expect(() =>
        styled(`${STANDARDS}<style>${css}</style><p id=t>x`, {
          stylesheets: { 'self.css': '@import url(self.css);' },
        }).style('t'),
      ).not.toThrow();
    }
  });
});
