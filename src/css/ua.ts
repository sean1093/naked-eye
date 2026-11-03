/**
 * The subset of the HTML specification's user-agent style sheet
 * (https://html.spec.whatwg.org/multipage/rendering.html) that decides
 * whether, and how, text renders. Author rules override it exactly as they
 * override a browser's own sheet: `[hidden] { display: block }` shows hidden
 * content in a browser, so it does here too.
 *
 * Scripting is assumed enabled, as in a browser that a human uses, so
 * `<noscript>` content does not render.
 */
import { type Declaration, parseComponentValues } from './syntax.js';

export const UA_STYLESHEET = `
[hidden]:not([hidden="until-found" i]):not(embed) { display: none; }
[hidden="until-found" i]:not(embed) { content-visibility: hidden; }
embed[hidden] { display: inline; height: 0; width: 0; }
input[type="hidden" i] { display: none !important; }
area, base, basefont, datalist, head, link, meta, noembed, noframes, param, rp, script, style, template, title { display: none; }
noscript { display: none !important; }
audio:not([controls]) { display: none !important; }

html, body { display: block; }
address, blockquote, center, dialog, div, figure, figcaption, footer, form, header, hr, legend, listing, main, p, plaintext, pre, search, xmp { display: block; }
article, aside, h1, h2, h3, h4, h5, h6, hgroup, nav, section { display: block; }
dir, dd, dl, dt, menu, ol, ul { display: block; }
li { display: list-item; }
dialog:not([open]) { display: none; }
[popover]:not(:popover-open):not(dialog[open]) { display: none; }
slot { display: contents; }
fieldset, details, summary { display: block; }
details > summary:first-of-type { display: list-item; }
ruby { display: ruby; }
rt { display: ruby-text; }
input, select, button, textarea, marquee, meter, progress { display: inline-block; }
option, optgroup { display: block; }

table { display: table; }
caption { display: table-caption; }
colgroup, colgroup[hidden] { display: table-column-group; }
col, col[hidden] { display: table-column; }
thead, thead[hidden] { display: table-header-group; }
tbody, tbody[hidden] { display: table-row-group; }
tfoot, tfoot[hidden] { display: table-footer-group; }
tr, tr[hidden] { display: table-row; }
td, th { display: table-cell; }
colgroup[hidden], col[hidden], thead[hidden], tbody[hidden], tfoot[hidden], tr[hidden] { visibility: collapse; }

h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.17em; }
h4 { font-size: 1em; }
h5 { font-size: 0.83em; }
h6 { font-size: 0.67em; }
small, sub, sup { font-size: smaller; }
big { font-size: larger; }
input, select, button, textarea { font-size: 13.333px; }

pre, listing, xmp, plaintext { white-space: pre; }
textarea { white-space: pre-wrap; }
nobr { white-space: nowrap; }
`;

/** `<font size>`: the legacy font size scale, 1 to 7. */
const LEGACY_FONT_SIZES = [
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
];

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** SVG presentation attributes that map to modeled properties. */
const SVG_PRESENTATION = ['opacity', 'visibility', 'display', 'font-size', 'clip-path'];

/** Units the SVG `transform` attribute leaves implicit: user units are px, angles are degrees. */
const SVG_TRANSFORM_UNITS: Record<string, string[]> = {
  translate: ['px', 'px'],
  scale: ['', ''],
  rotate: ['deg'],
  skewx: ['deg'],
  skewy: ['deg'],
  matrix: ['', '', '', '', '', ''],
};

/**
 * The SVG `transform` attribute as a CSS `transform` value: numbers without
 * units, separated by spaces or commas. `rotate(a, cx, cy)` keeps its angle.
 */
function svgTransform(value: string): string | null {
  const functions: string[] = [];
  const pattern = /\s*([a-zA-Z]+)\s*\(([^)]*)\)\s*,?/gy;
  let match: RegExpExecArray | null = pattern.exec(value);
  let consumed = 0;
  while (match !== null) {
    consumed = pattern.lastIndex;
    const name = (match[1] as string).toLowerCase();
    const units = SVG_TRANSFORM_UNITS[name];
    const numbers = (match[2] as string)
      .trim()
      .split(/[\s,]+/)
      .filter((part) => part !== '');
    if (
      units === undefined ||
      numbers.length === 0 ||
      numbers.some((part) => !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(part))
    )
      return null;
    const used = name === 'rotate' ? numbers.slice(0, 1) : numbers;
    if (used.length > units.length || (name === 'matrix' && used.length !== 6)) return null;
    functions.push(
      `${name}(${used.map((part, index) => `${part}${units[index] ?? ''}`).join(', ')})`,
    );
    match = pattern.exec(value);
  }
  return functions.length === 0 || value.slice(consumed).trim() !== '' ? null : functions.join(' ');
}

interface HintTarget {
  name: string;
  namespace?: string | undefined;
  attribs: Record<string, string>;
}

/**
 * Presentational hints: HTML and SVG attributes that map to CSS, applied
 * below every author rule. Attribute values are attacker-controlled, so each
 * one becomes exactly one declaration: `display="none; x: y"` is an invalid
 * display, never a second declaration.
 */
export function presentationalHints({ name, namespace, attribs }: HintTarget): Declaration[] {
  const hints: Declaration[] = [];
  const add = (property: string, css: string): void => {
    hints.push({ name: property, value: parseComponentValues(css), important: false });
  };
  if (namespace === SVG_NAMESPACE) {
    for (const property of SVG_PRESENTATION) {
      const value = attribs[property];
      if (value === undefined) continue;
      const unitless = property === 'font-size' && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(value);
      add(property, unitless ? `${value.trim()}px` : value);
    }
    if (attribs.transform !== undefined) {
      const transform = svgTransform(attribs.transform);
      if (transform !== null) add('transform', transform);
    }
    return hints;
  }
  if (name === 'font' && attribs.size !== undefined) {
    const match = /^\s*([+-]?)(\d+)/.exec(attribs.size);
    if (match !== null) {
      const value = Number(match[2]);
      const size = match[1] === '+' ? 3 + value : match[1] === '-' ? 3 - value : value;
      add('font-size', LEGACY_FONT_SIZES[Math.min(7, Math.max(1, size)) - 1] as string);
    }
  }
  if ((name === 'td' || name === 'th') && attribs.nowrap !== undefined)
    add('white-space', 'nowrap');
  if (name === 'pre' && attribs.wrap !== undefined) add('white-space', 'pre-wrap');
  return hints;
}
