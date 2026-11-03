import { describe, expect, it } from 'vitest';
import { extractVisible } from '../src/index.js';

const reasonFor = (color: string): string | undefined =>
  extractVisible(`<!doctype html><p style="color: white; color: ${color}">x</p>`).hidden[0]?.reason;

describe('colors a browser rejects fall back to the previous declaration', () => {
  it.each([
    '#ff',
    '#fffff',
    '#ggg',
    'whitish',
    'rgb(1 2)',
    'rgb(1, 2 3)',
    'rgb(1 2 3 /)',
    'rgb(1 2 3 / 4 5)',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1px 2 3)',
    'hsl(red 0 0)',
    'color(unknownspace 1 1 1)',
    'color(srgb 1 1)',
    'color(1 1 1)',
    'light-dark(white)',
    'color-mix(white, black)',
    'color-mix(in srgb, white, nope)',
    'color-mix(in srgb, white 0%, black 0%)',
    'notacolor(1 2 3)',
    'white black',
  ])('%s', (color) => {
    expect(reasonFor(color)).toBe('low-contrast');
  });
});

describe('colors a browser accepts', () => {
  it.each([
    ['hwb(0 60% 60%)', undefined],
    ['rgb(0 0 0 / 50%)', undefined],
    ['rgba(0, 0, 0, .5)', undefined],
    ['color-mix(in srgb, white 50%, black)', undefined],
    ['color-mix(in oklab, white 95%, black)', 'low-contrast'],
    ['color-mix(in lab, black 50%, white 50%)', undefined],
    ['color-mix(in srgb, transparent, transparent)', 'transparent-text'],
    ['color(xyz 0 0 0)', undefined],
    ['CanvasText', undefined],
    ['GrayText', undefined],
    ['currentcolor', undefined],
    ['lab(50% 0% 0%)', undefined],
    ['lch(100% 0% 0)', 'low-contrast'],
    ['oklab(100% 0% 0%)', 'low-contrast'],
    ['oklch(100% 0% 0deg)', 'low-contrast'],
    ['hsl(0deg 0 100)', 'low-contrast'],
  ])('%s gives %s', (color, reason) => {
    expect(reasonFor(color)).toBe(reason);
  });

  it('reports colors it parses but cannot evaluate', () => {
    for (const color of [
      'contrast-color(white)',
      'device-cmyk(0 0 0 0)',
      'color-mix(in srgb, currentcolor, white)',
    ]) {
      const result = extractVisible(`<!doctype html><p style="color: ${color}">kept</p>`);
      expect(result.text).toBe('kept');
      expect(result.warnings.map((warning) => warning.code)).toEqual(['unsupported-color']);
    }
  });

  it('reads backgrounds and strokes from their shorthands and longhands', () => {
    const text = (style: string) => extractVisible(`<!doctype html><p style="${style}">x</p>`).text;
    expect(text('background: url(a.png) no-repeat white; color: white')).toBe('x');
    expect(text('background: none, black; color: black')).toBe('');
    expect(text('background-image: none, linear-gradient(red, blue); color: white')).toBe('x');
    expect(text('background-image: image-set("a.png" 1x); color: white')).toBe('x');
    expect(
      text('color: transparent; -webkit-text-stroke-width: thin; -webkit-text-stroke-color: black'),
    ).toBe('x');
    expect(text('color: transparent; -webkit-text-stroke: thick')).toBe('');
    expect(text('color: white; text-shadow: 1px 1px 2px black, 0 0 transparent')).toBe('x');
  });
});
