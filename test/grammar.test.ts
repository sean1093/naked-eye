import { describe, expect, it } from 'vitest';
import { styled } from './helpers.js';

const STANDARDS = '<!doctype html>';
const style = (css: string, world: 0 | 1 = 0) =>
  styled(`${STANDARDS}<style>${css}</style><p id=t>x`).style('t', world);

describe('declarations a browser rejects fall back to the previous one', () => {
  it.each([
    ['display', 'block', 'block block'],
    ['display', 'none', 'list-item flex'],
    ['display', 'none', '5'],
    ['font-size', '2px', '-1px'],
    ['font-size', '2px', 'bigger'],
    ['font', '2px serif', 'bold'],
    ['font', '2px serif', '12px'],
    ['font', '2px serif', '12px 5'],
    ['transform', 'scale(0)', 'translate(1px) 5'],
    ['transform', 'scale(0)', 'translate(red)'],
    ['rotate', 'x 90deg', '1 2 90deg'],
    ['rotate', 'x 90deg', 'sideways'],
    ['scale', '0', '1 2 3 4'],
    ['width', '0', '-5px'],
    ['width', '0', 'auto auto'],
    ['width', '0', 'none'],
    ['max-width', '0', 'auto'],
    ['overflow', 'hidden', 'hidden hidden hidden'],
    ['clip', 'rect(0 0 0 0)', 'rect(1px 2px 3px)'],
    ['clip', 'rect(0 0 0 0)', 'circle(1px)'],
    ['clip-path', 'inset(50%)', 'inset(1px) circle(1px)'],
    ['clip-path', 'inset(50%)', 'star(5)'],
    ['filter', 'opacity(0)', 'opacity(1, 2)'],
    ['filter', 'opacity(0)', 'opacity(red)'],
    ['white-space', 'pre', 'pre pre'],
    ['white-space', 'pre', '5'],
    ['text-wrap', 'nowrap', 'wiggly'],
    ['text-indent', '-9px', '-9px hanging hanging hanging'],
    ['animation', 'fade forwards', '1s 2s 3s'],
    ['animation', 'fade forwards', 'fade cubic(1)'],
    ['animation', 'fade forwards', 'fade 1 2'],
    ['animation-iteration-count', '2', '-1'],
    ['zoom', '0.5', '-1'],
    ['opacity', '0', '1 2'],
    ['position', 'absolute', 'floating'],
    ['margin-left', '-9px', '1'],
    ['inset', '-9px', '1px 2px 3px 4px 5px'],
    ['inset-block', '-9px', '1px 2px 3px'],
    ['inset-inline-start', '-9px', 'sideways'],
    ['margin-block', '-9px', '1px 2px 3px'],
  ])('%s: %s survives %s', (property, valid, invalid) => {
    const before = style(`p { ${property}: ${valid} }`);
    expect(style(`p { ${property}: ${valid} } p { ${property}: ${invalid} }`)).toEqual(before);
  });
});

describe('math expressions a browser rejects', () => {
  it.each([
    'abs(1px, 2px)',
    'sign(1px, 2px)',
    'calc(sin(1px) * 1px)',
    'calc(asin(1deg) * 1px)',
    'calc(pow(1px, 2) * 1px)',
    'calc(sqrt(1, 2) * 1px)',
    'calc(exp(1, 2) * 1px)',
    'calc(log(1, 2, 3) * 1px)',
    'calc(atan2(1) * 1px)',
    'round(1px, 2px, 3px)',
    'mod(1px)',
    'clamp(1px, 2px)',
    'clamp(none, none, none)',
    'min(1px, 1deg)',
    'calc(1foo)',
    'calc(1s)',
    'calc(1dpi)',
    'calc(1px +)',
    'calc(1px 2px)',
    'calc(* 2)',
    'calc((1px + 2px)',
    'calc(1px / 2px * 3)',
    'calc(sibling-index(1) * 1px)',
    'nonsense(1px)',
  ])('margin-left: %s is rejected', (expression) => {
    expect(style(`p { margin-left: -9px } p { margin-left: ${expression} }`).marginLeft).toBe(-9);
  });
});

describe('values browsers accept are accepted', () => {
  it('reads system fonts and long font shorthands', () => {
    expect(style('p { font: menu }').fontSize).toBe(13);
    expect(
      style('p { font: oblique 10deg small-caps 900 condensed 3px/1.5 "Fancy", serif }').fontSize,
    ).toBe(3);
  });

  it('accepts every display form', () => {
    expect(style('p { display: inline list-item }').display).toEqual({
      kind: 'box',
      outer: 'inline',
      inner: 'flow',
      listItem: true,
    });
    expect(style('p { display: ruby }').display).toEqual({
      kind: 'box',
      outer: 'inline',
      inner: 'ruby',
      listItem: false,
    });
    expect(style('p { display: contents }').display).toEqual({ kind: 'contents' });
  });

  it('accepts the remaining keyword forms', () => {
    const value = style(
      'p { overflow: clip visible; position: -webkit-sticky; text-indent: -5px hanging each-line; zoom: reset }',
    );
    expect([
      value.overflowX,
      value.overflowY,
      value.position,
      value.textIndent,
      value.zoom,
    ]).toEqual(['clip', 'visible', 'sticky', -5, 1]);
    expect(style('p { overflow: overlay }').overflowY).toBe('auto');
  });

  it('accepts rotations about an arbitrary axis and perspective(none)', () => {
    expect(style('p { rotate: x 90deg } p { rotate: 0 0 1 90deg }').transform).toEqual([]);
    expect(style('p { transform: perspective(none) }').transform).toEqual([
      { name: 'perspective', args: [0] },
    ]);
  });

  it('accepts clip paths with only a geometry box, or a path', () => {
    expect(style('p { clip-path: padding-box }').clipPath).toBe('other');
    const path = style('p { clip-path: path("M0 0") }').clipPath;
    expect(typeof path === 'object' && path.shape).toBe('path');
  });

  it('applies animation longhands, including string names and alternate directions', () => {
    const keyframes =
      '@keyframes "fade" { 0%, 50% { opacity: 1 } 100% { opacity: 0 } } @keyframes bad { 120% { opacity: 0 } }';
    const opacity = (css: string) => style(`${keyframes} p { ${css} }`).opacity;
    expect(opacity('animation-name: "fade"; animation-fill-mode: both')).toBe(0);
    expect(
      opacity(
        'animation-name: fade; animation-fill-mode: forwards; animation-iteration-count: 2; animation-direction: alternate-reverse',
      ),
    ).toBe(0);
    expect(
      opacity('animation-name: fade; animation-fill-mode: forwards; animation-direction: reverse'),
    ).toBe(1);
    expect(opacity('animation: fade 1s infinite forwards')).toBe(1);
    expect(opacity('animation: fade 1s 0 forwards')).toBe(1);
    expect(opacity('animation: bad 1s forwards')).toBe(1);
    expect(opacity('animation: none, fade 1s forwards ease-in-out steps(2)')).toBe(0);
  });

  it('substitutes custom properties into shorthands', () => {
    const value = style(
      ':root { --o: -9999px auto auto 3px; --f: 2px serif; --w: pre; --a: fade 0s forwards } @keyframes fade { to { opacity: 0 } } p { inset: var(--o); font: var(--f); white-space: var(--w); animation: var(--a) }',
    );
    expect([
      value.top,
      value.left,
      value.fontSize,
      value.whiteSpaceCollapse,
      value.opacity,
    ]).toEqual([-9999, 3, 2, 'preserve', 0]);
  });

  it('applies CSS-wide keywords to every longhand of a shorthand', () => {
    const html = `${STANDARDS}<div style="font-size: 4px; overflow: hidden"><p id=t style="font: inherit; overflow: inherit; margin: initial">x</div>`;
    const value = styled(html).style('t');
    expect([value.fontSize, value.overflowX, value.marginLeft]).toEqual([4, 'hidden', 0]);
  });
});

describe('substitution edge cases', () => {
  const size = (body: string) => styled(`${STANDARDS}${body}`).style('t').fontSize;

  it.each([
    ['<p id=t data-v="x" style="font-size: attr(data-v raw-string)">x', 16],
    ['<p id=t data-v="red" style="font-size: attr(data-v type(<length>), 3px)">x', 16],
    ['<p id=t data-v="" style="font-size: attr(data-v type(<length>), 3px)">x', 3],
    ['<p id=t data-v="1 2" style="font-size: attr(data-v px, 3px)">x', 3],
    ['<p id=t data-v="9" style="font-size: attr(data-v %)">x', 1.44],
    ['<p id=t style="font-size: attr(5 px)">x', 16],
    ['<p id=t style="font-size: var(no-dashes, 3px)">x', 16],
    ['<p id=t style="font-size: env(preferred-text-scale)">x', 16],
    ['<p id=t style="font-size: calc(env(preferred-text-scale) * 3px)">x', 3],
    ['<p id=t style="font-size: if(media(print) 1px)">x', 16],
    ['<p id=t style="font-size: if(unknown(): 1px; else: 2px)">x', 2],
    ['<p id=t style="font-size: if(style(--unset): 1px; else: 2px)">x', 2],
    ['<p id=t style="--set: ; font-size: if(style(--set): 1px; else: 2px)">x', 1],
    ['<p id=t style="font-size: if(style(color: red): 1px; else: 2px)">x', 2],
    ['<p id=t style="font-size: if(not media(width < 1px): 1px)">x', 1],
    [`<p id=t style="font-size: ${'max('.repeat(40)}1px${')'.repeat(40)}">x`, 1],
    [`<p id=t style="font-size: ${'calc(var(--x, '.repeat(40)}1px${'))'.repeat(40)}">x`, 16],
  ])('%s gives %dpx', (body, px) => {
    expect(size(body)).toBeCloseTo(px);
  });
});

describe('presentational hints', () => {
  it.each([
    ['<font id=t size=+2>x</font>', 'fontSize', 24],
    ['<font id=t size=-9>x</font>', 'fontSize', 10],
    ['<font id=t size=abc>x</font>', 'fontSize', 16],
    ['<table><tr><td id=t nowrap>x</td></tr></table>', 'textWrapMode', 'nowrap'],
    ['<pre id=t wrap>x</pre>', 'textWrapMode', 'wrap'],
  ])('%s sets %s to %s', (body, key, value) => {
    expect(styled(`${STANDARDS}${body}`).style('t')[key as 'fontSize']).toBe(value);
  });
});

describe('at-rules', () => {
  it('evaluates @scope rules in the second world', () => {
    const html = `${STANDARDS}<style>@scope (.card) { p { display: none } } .x { @scope (.card) { display: none } }</style><div class=card><p id=t>x</p></div><p id=u>y`;
    const { style: get, engine } = styled(html);
    expect(engine.worlds).toBe(2);
    expect([get('t', 0).display.kind, get('t', 1).display.kind, get('u', 1).display.kind]).toEqual([
      'box',
      'none',
      'box',
    ]);
  });

  it('applies @import with layer, supports() and media conditions', () => {
    const stylesheets = { 'a.css': 'p { display: none }' };
    const load = (css: string) =>
      styled(`${STANDARDS}<style>${css}</style><p id=t>x`, { stylesheets }).style('t').display.kind;
    expect(load('@import "a.css" layer supports(display: grid) screen;')).toBe('none');
    expect(load('@import url(a.css) supports(display: nonsense);')).toBe('box');
    expect(load('@import url("a.css") print;')).toBe('box');
    expect(load('p { color: red } @import "a.css";')).toBe('box');
    expect(load('@import "a.css" layer(base); p { display: block }')).toBe('box');
  });

  it('ignores unknown at-rules and malformed layers', () => {
    expect(
      style(
        '@font-face { font-family: x } @layer 1bad { p { display: none } } @unknown { p { display: none } }',
      ).display.kind,
    ).toBe('box');
  });
});
