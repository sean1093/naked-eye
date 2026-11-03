import { describe, expect, it } from 'vitest';
import { styled } from './helpers.js';

const STANDARDS = '<!doctype html>';
const style = (css: string, extra = '') =>
  styled(`${STANDARDS}<style>${css}</style>${extra}<p id=t>x`).style('t');
const marginLeft = (value: string) => style(`p { margin-left: ${value} }`).marginLeft;

describe('math functions', () => {
  it.each([
    ['calc(1in)', 96],
    ['calc(12pt + 1pc)', 32],
    ['calc(2ch)', 16],
    ['calc(1vmin + 1vmax)', 20.8],
    ['calc(1dvh)', 8],
    ['round(nearest, 1.5px, 1px)', 2],
    ['round(down, 2.5px, 1px)', 2],
    ['round(up, 2.1px, 1px)', 3],
    ['round(to-zero, -2.5px, 1px)', -2],
    ['mod(-5px, 3px)', 1],
    ['rem(-5px, 3px)', -2],
    ['hypot(3px, 4px)', 5],
    ['abs(-3px)', 3],
    ['calc(sign(-3px) * 7px)', -7],
    ['calc(pow(2, 3) * 1px)', 8],
    ['calc(sqrt(16) * 1px)', 4],
    ['calc(log(8, 2) * 1px)', 3],
    ['calc(exp(0) * 1px)', 1],
    ['calc(tan(atan2(1, 1)) * 10px)', 10],
    ['calc(cos(0.5turn) * 10px)', -10],
    ['clamp(none, 5px, 2px)', 2],
    ['calc((1px + 2px) * 3)', 9],
    ['calc(e * 0px + pi * 0px)', 0],
  ])('%s is %dpx', (value, px) => {
    expect(marginLeft(value)).toBeCloseTo(px);
  });

  it('rejects type errors the way browsers do', () => {
    expect(marginLeft('calc(1px * 1px)')).toBe(0);
    expect(marginLeft('calc(1px + 1)')).toBe(0);
    expect(marginLeft('calc(1px / 1px)')).toBe(0);
    expect(marginLeft('5')).toBe(0);
  });

  it('cannot resolve a percentage of an unknown size', () => {
    expect(marginLeft('-100%')).toBe('unknown');
    expect(marginLeft('calc(50% - 50%)')).toBe('unknown');
    expect(marginLeft('max(10px, 50%)')).toBe('unknown');
  });
});

describe('modeled properties', () => {
  it('resolves offsets, sizes and indents, and expands their shorthands', () => {
    const value = style(
      'p { position: absolute; inset: -9999px auto auto 1em; width: 0; max-height: 0; text-indent: -2em }',
    );
    expect([value.position, value.top, value.right, value.left]).toEqual([
      'absolute',
      -9999,
      'auto',
      16,
    ]);
    expect([value.width, value.maxHeight, value.textIndent]).toEqual([0, 0, -32]);
    const logical = style(
      'p { inset-inline-start: -5px; inset-block: 3px 4px; margin: 1px 2px 3px -4px }',
    );
    expect([
      logical.left,
      logical.top,
      logical.bottom,
      logical.marginTop,
      logical.marginLeft,
    ]).toEqual([-5, 3, 4, 1, -4]);
    expect(style('p { margin-inline: -7px 0; margin-block-start: 6px }').marginLeft).toBe(-7);
  });

  it('treats intrinsic sizes as non-zero', () => {
    expect(style('p { width: fit-content; height: min-content }').width).toBe('intrinsic');
  });

  it('resolves transform functions and the individual transform properties', () => {
    const value = style(
      'p { transform: translateX(-2em) rotate(0.25turn) scale(0); translate: 10px; scale: 50%; rotate: x 90deg }',
    );
    expect(value.transform).toEqual([
      { name: 'translate3d', args: [10, 0, 0] },
      { name: 'rotatex', args: [90] },
      { name: 'scale', args: [0.5, 0.5] },
      { name: 'translatex', args: [-32] },
      { name: 'rotate', args: [90] },
      { name: 'scale', args: [0] },
    ]);
    expect(style('p { transform: translate(-50%) }').transform).toEqual([
      { name: 'translate', args: ['unknown'] },
    ]);
    expect(style('p { transform: none }').transform).toEqual([]);
    expect(style('p { transform: scale(0) } p { transform: wobble(1) }').transform).toEqual([
      { name: 'scale', args: [0] },
    ]);
  });

  it('parses clip rectangles and clip paths', () => {
    expect(style('p { clip: rect(0 0 0 0) }').clip).toEqual([0, 0, 0, 0]);
    expect(style('p { clip: rect(1px, auto, 2px, 3px) }').clip).toEqual([1, 'auto', 2, 3]);
    const path = style('p { clip-path: inset(50%) border-box }').clipPath;
    expect(typeof path === 'object' && path.shape).toBe('inset');
    expect(style('p { clip-path: url(#mask) }').clipPath).toBe('other');
    expect(
      style('p { clip-path: inset(50%) } p { clip-path: circle(0) circle(0) }').clipPath,
    ).not.toBe('none');
  });

  it('multiplies filter opacities and clamps opacity', () => {
    expect(style('p { filter: blur(1px) opacity(50%) opacity(0.5) }').filterOpacity).toBe(0.25);
    expect(style('p { opacity: 150% }').opacity).toBe(1);
    expect(style('p { opacity: -1 }').opacity).toBe(0);
    expect(
      style('p { filter: opacity(0) } p { filter: opacity(0.5) nonsense(1) }').filterOpacity,
    ).toBe(0);
  });

  it('treats zoom: 0 as no zoom and keeps small zoom factors', () => {
    expect(style('p { zoom: 0 }').zoom).toBe(1);
    expect(style('p { zoom: 1% }').zoom).toBe(0.01);
    expect(style('p { zoom: normal }').zoom).toBe(1);
  });

  it('expands white-space into its longhands', () => {
    const pre = style('p { white-space: pre }');
    expect([pre.whiteSpaceCollapse, pre.textWrapMode]).toEqual(['preserve', 'nowrap']);
    const modern = style('p { white-space: preserve-breaks wrap }');
    expect([modern.whiteSpaceCollapse, modern.textWrapMode]).toEqual(['preserve-breaks', 'wrap']);
    expect(style('p { text-wrap: nowrap balance }').textWrapMode).toBe('nowrap');
  });

  it('parses display in its single- and multi-keyword forms', () => {
    expect(style('p { display: inline flow-root }').display).toEqual({
      kind: 'box',
      outer: 'inline',
      inner: 'flow-root',
      listItem: false,
    });
    expect(style('p { display: list-item block }').display).toEqual({
      kind: 'box',
      outer: 'block',
      inner: 'flow',
      listItem: true,
    });
    expect(style('p { display: table-cell }').display).toEqual({
      kind: 'internal',
      role: 'table-cell',
    });
    expect(style('p { display: -webkit-box }').display).toEqual({
      kind: 'box',
      outer: 'block',
      inner: 'flex',
      listItem: false,
    });
    expect(style('p { display: none } p { display: block grid flex }').display).toEqual({
      kind: 'none',
    });
  });

  it('inherits what CSS inherits and nothing else', () => {
    const child = styled(
      `${STANDARDS}<div style="visibility: hidden; opacity: 0; font-size: 2px; text-indent: -9px; position: absolute"><p id=t>x</div>`,
    ).style('t');
    expect([child.visibility, child.fontSize, child.textIndent]).toEqual(['hidden', 2, -9]);
    expect([child.opacity, child.position]).toEqual([1, 'static']);
    const explicit = styled(
      `${STANDARDS}<div style="opacity: 0.5"><p id=t style="opacity: inherit; visibility: initial">x</div>`,
    ).style('t');
    expect([explicit.opacity, explicit.visibility]).toEqual([0.5, 'visible']);
  });
});

describe('substitution', () => {
  const fontSize = (html: string) => styled(STANDARDS + html).style('t').fontSize;

  it('reads attr() as a typed value or a string', () => {
    expect(fontSize('<p id=t data-v="1px" style="font-size: attr(data-v type(<length>))">x')).toBe(
      1,
    );
    expect(
      fontSize(
        '<p id=t data-v="3" style="font-size: attr(data-v number); font-size: calc(attr(data-v number) * 1px)">x',
      ),
    ).toBe(3);
    expect(
      fontSize(
        '<div style="font-size: 10px"><p id=t data-v="50" style="font-size: attr(data-v %)">x</div>',
      ),
    ).toBe(5);
    expect(fontSize('<p id=t style="font-size: attr(data-missing px, 2px)">x')).toBe(2);
    expect(fontSize('<p id=t data-v="2px" style="font-size: attr(data-v)">x')).toBe(16);
  });

  it('falls back from unknown environment variables', () => {
    expect(fontSize('<p id=t style="font-size: env(no-such-thing, 3px)">x')).toBe(3);
    expect(fontSize('<p id=t style="font-size: env(no-such-thing)">x')).toBe(16);
  });

  it('chooses the first if() branch that holds', () => {
    expect(
      fontSize('<p id=t style="font-size: if(supports(display: grid): 1px; else: 2px)">x'),
    ).toBe(1);
    expect(
      fontSize(
        '<p id=t style="font-size: if(media(print): 1px; media((width > 1px) and (height > 1px)): 2px)">x',
      ),
    ).toBe(2);
    expect(fontSize('<p id=t style="font-size: if(media(print): 1px)">x')).toBe(16);
    expect(
      fontSize('<p id=t style="--x: 1; font-size: if(not style(--x: 2): 3px; else: 4px)">x'),
    ).toBe(3);
  });

  it('accepts an empty var() fallback', () => {
    expect(fontSize('<p id=t style="font-size: var(--missing,) 5px">x')).toBe(5);
  });
});
