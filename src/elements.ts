/**
 * Facts about HTML and SVG elements that both extraction modes need: which
 * elements never render, which never generate a box, and which generate no
 * pseudo-elements. Static mode reads them while walking the parsed document;
 * browser mode reads the same tables inside the page, so the two modes agree
 * about what a browser puts on screen.
 */
import type { HiddenReason } from './types.js';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Hidden by the user-agent sheet: their text is reported as never rendered. */
export const NEVER_RENDERED: Record<string, true> = {
  template: true,
  noscript: true,
  datalist: true,
  noembed: true,
  noframes: true,
  rp: true,
  area: true,
  base: true,
  basefont: true,
  link: true,
  meta: true,
  param: true,
};

/** Elements whose children are fallback content that does not render. */
export const FALLBACK: Record<string, true> = {
  iframe: true,
  frame: true,
  object: true,
  video: true,
  audio: true,
  canvas: true,
  progress: true,
  meter: true,
};

/** SVG elements whose content is never painted where it stands. */
export const SVG_HIDDEN: Record<string, true> = {
  clipPath: true,
  defs: true,
  desc: true,
  filter: true,
  linearGradient: true,
  marker: true,
  mask: true,
  metadata: true,
  pattern: true,
  radialGradient: true,
  symbol: true,
  title: true,
};

/** Elements without a content box, which generate no `::before` or `::after`. */
export const NO_PSEUDO: Record<string, true> = {
  area: true,
  audio: true,
  base: true,
  br: true,
  canvas: true,
  col: true,
  embed: true,
  iframe: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  meter: true,
  object: true,
  param: true,
  progress: true,
  select: true,
  textarea: true,
  video: true,
  wbr: true,
};

/** SVG text content elements: text inside them is painted. */
export const SVG_TEXT: Record<string, true> = { text: true, tspan: true, textPath: true };

/** Private Use Area code points: icon-font glyphs, pictures rather than text. */
export const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/** Reasons after which the hidden elements generate no boxes, so they add no line structure. */
export const BOXLESS: Partial<Record<HiddenReason, true>> = {
  unslotted: true,
  'display-none': true,
  'not-rendered': true,
  collapsed: true,
};
