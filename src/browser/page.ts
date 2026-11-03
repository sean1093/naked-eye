/**
 * Browser mode's in-page script: it runs inside the page being extracted and
 * builds the same render tree static mode builds, from the browser's computed
 * styles and real geometry instead of a cascade of its own. `render.ts`, which
 * both modes share, then turns that tree into text and findings, so the two
 * modes return the same text for the same rendering.
 *
 * Everything here runs in the page's main world and may only use DOM APIs and
 * the modules it imports; the thresholds are the only input.
 */
import {
  contrast,
  DARK_CANVAS,
  LIGHT_CANVAS,
  MAX_SHADOW_BLUR,
  MIN_STROKE,
  over,
  type RGBA,
  toHex,
} from '../css/color.js';
import {
  BOXLESS,
  FALLBACK,
  HTML_NAMESPACE,
  NEVER_RENDERED,
  NO_PSEUDO,
  PRIVATE_USE,
  SVG_HIDDEN,
  SVG_NAMESPACE,
  SVG_TEXT,
} from '../elements.js';
import {
  assemble,
  hideFirstLetter,
  type Layout,
  type RenderNode,
  type Space,
  type Verdict,
} from '../render.js';
import type { ExtractResult, HiddenReason, Warning, WarningCode } from '../types.js';
import { MAY_CONTAIN_INVISIBLE } from '../unicode.js';
import { own } from '../util.js';

/** The thresholds browser mode reads; the page itself supplies everything else. */
export interface PageLimits {
  minFontSize: number;
  minOpacity: number;
  minContrast: number;
}

// Node types, read from the node rather than through `instanceof`: the nodes of
// a same-origin frame come from another realm, where the constructors differ.
const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

/** A document's own global object: a frame's styles belong to its realm, not this one. */
type View = Window & typeof globalThis;

const CSS_IDENT = /^-?[_a-zA-Z][\w-]*$/;

/** Overflow values that cut content off where no scrolling can reach it. */
const CUTS_OFF: Record<string, true> = { hidden: true, clip: true };

/** `display` values of the table and ruby internal boxes, and the line structure each adds. */
const INTERNAL: Record<string, Layout> = {
  'table-row': 'row',
  'table-cell': 'cell',
  'table-row-group': 'block',
  'table-header-group': 'block',
  'table-footer-group': 'block',
  'table-column': 'block',
  'table-column-group': 'block',
  'table-caption': 'block',
  'ruby-base': 'inline',
  'ruby-text': 'inline',
  'ruby-base-container': 'inline',
  'ruby-text-container': 'inline',
};

/** Single-keyword `display` values, as the outer and inner value of the two-value syntax. */
const LEGACY_DISPLAY: Record<string, ['block' | 'inline', string]> = {
  block: ['block', 'flow'],
  'flow-root': ['block', 'flow-root'],
  flex: ['block', 'flex'],
  grid: ['block', 'grid'],
  table: ['block', 'table'],
  inline: ['inline', 'flow'],
  'inline-block': ['inline', 'flow-root'],
  'inline-flex': ['inline', 'flex'],
  'inline-grid': ['inline', 'grid'],
  'inline-table': ['inline', 'table'],
  ruby: ['inline', 'ruby'],
  math: ['inline', 'flow'],
};

const SPACE_VALUES: Record<string, Space> = {
  collapse: 'collapse',
  preserve: 'preserve',
  'preserve-breaks': 'preserve-breaks',
  'preserve-spaces': 'preserve-spaces',
  'break-spaces': 'break-spaces',
};

/** `white-space`, for engines that do not expose the `white-space-collapse` longhand. */
const WHITE_SPACE: Record<string, Space> = {
  normal: 'collapse',
  nowrap: 'collapse',
  pre: 'preserve',
  'pre-wrap': 'preserve',
  'pre-line': 'preserve-breaks',
  'break-spaces': 'break-spaces',
};

/** Axes of a `rotate` property written as a keyword. */
const ROTATION_AXIS: Record<string, string> = { x: '1,0,0', y: '0,1,0', z: '0,0,1' };

interface Display {
  kind: 'none' | 'contents' | 'internal' | 'box';
  outer: 'block' | 'inline';
  inner: string;
  /** The internal role, for `kind: 'internal'`. */
  role: string;
}

/** The pseudo-elements browser mode reads styles for. */
type Pseudo = 'before' | 'after' | 'first-line' | 'first-letter';

function parseDisplay(value: string): Display {
  if (value === 'none' || value === 'contents')
    return { kind: value, outer: 'block', inner: 'flow', role: '' };
  if (own(INTERNAL, value) !== undefined)
    return { kind: 'internal', outer: 'block', inner: 'flow', role: value };
  const words = value.split(/\s+/).filter((word) => word !== '' && word !== 'list-item');
  const legacy = own(LEGACY_DISPLAY, words.join(' '));
  if (legacy !== undefined) return { kind: 'box', outer: legacy[0], inner: legacy[1], role: '' };
  return {
    kind: 'box',
    outer: words.includes('inline') ? 'inline' : 'block',
    inner: words.find((word) => word !== 'inline' && word !== 'block') ?? 'flow',
    role: '',
  };
}

/** Boxes `::first-line` and `::first-letter` apply to: block containers. */
function isBlockContainer(display: Display, blockified: boolean): boolean {
  if (display.kind === 'internal')
    return display.role === 'table-cell' || display.role === 'table-caption';
  if (display.kind !== 'box') return false;
  if (display.inner === 'flow-root') return true;
  return display.inner === 'flow' && (blockified || display.outer !== 'inline');
}

/** A rectangle in viewport coordinates; an edge nothing cuts off is infinite. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const OPEN: Rect = {
  left: Number.NEGATIVE_INFINITY,
  top: Number.NEGATIVE_INFINITY,
  right: Number.POSITIVE_INFINITY,
  bottom: Number.POSITIVE_INFINITY,
};

/** What an ancestor cuts off, and which positioned descendants it still reaches. */
interface Clip {
  rect: Rect;
  verdict: Verdict;
  /** The element is a containing block for absolutely positioned descendants. */
  absolute: boolean;
  /** The element is a containing block for fixed descendants. */
  fixed: boolean;
}

/** The background a box paints: a color, or an image that hides what is behind it. */
interface Layer {
  color: RGBA | null;
  image: boolean;
}

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
const CLEAR: Layer = { color: TRANSPARENT, image: false };

/** A box that can paint behind text it is not an ancestor of, in document coordinates. */
interface Painter {
  rect: Rect;
  layer: Layer;
  /** The element whose content it may lie under: its containing block. */
  under: Element;
}

/** The painters of one document, bucketed by grid cell. */
interface PainterIndex {
  cells: Map<string, Painter[]>;
  /** How far a skipped `content-visibility: auto` subtree reaches past the scroll area. */
  deferred: { right: number; bottom: number } | null;
}

/** The side of one grid cell, in CSS pixels: a few viewports wide. */
const CELL = 2048;

/** The cell of painters that may cover any point, however far away. */
const EVERYWHERE = 'all';

/** How many painters one grid cell keeps: the largest, so a crowd of small boxes evicts nothing. */
const CELL_LIMIT = 32;

/** How many backdrops one piece of text is judged against, as in static mode. */
const BACKDROP_LIMIT = 16;

/** How much of a box is painted: its own opacity and any `filter: opacity()`. */
function opacityOf(style: CSSStyleDeclaration): number {
  const own_ = Number.parseFloat(style.getPropertyValue('opacity'));
  const filters = [...style.getPropertyValue('filter').matchAll(/opacity\(([^)]*)\)/g)].reduce(
    (total, match) => {
      const raw = (match[1] as string).trim();
      const amount = Number.parseFloat(raw);
      return total * (Number.isFinite(amount) ? (raw.endsWith('%') ? amount / 100 : amount) : 1);
    },
    1,
  );
  return (Number.isFinite(own_) ? own_ : 1) * filters;
}

/** The painters of a cell that cover the most area, for when a cell holds too many. */
function largest(painters: Painter[]): Painter[] {
  const area = ({ rect }: Painter): number =>
    Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  return [...painters].sort((one, two) => area(two) - area(one)).slice(0, CELL_LIMIT);
}

const cellKey = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/** Every cell a rectangle touches; one that spans a huge area goes in the shared cell. */
function cellsOf(rect: Rect): string[] {
  if (!Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return [EVERYWHERE];
  const [first, last] = [Math.floor(rect.left / CELL), Math.floor(rect.right / CELL)];
  const [top, bottom] = [Math.floor(rect.top / CELL), Math.floor(rect.bottom / CELL)];
  if ((last - first + 1) * (bottom - top + 1) > 64) return [EVERYWHERE];
  const keys: string[] = [];
  for (let x = first; x <= last; x += 1)
    for (let y = top; y <= bottom; y += 1) keys.push(`${x},${y}`);
  return keys;
}

/** Whether two rectangles share any area. */
const meets = (rect: Rect, box: Rect): boolean =>
  rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;

const centreOf = (rect: Rect | undefined): [number, number] | null =>
  rect === undefined ? null : [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2];

/**
 * The pair `open-quote` and `close-quote` draw, from the computed `quotes`.
 * Only the outermost level is modelled, as in static mode; `none` draws
 * nothing and `auto` draws the English pair every engine defaults to.
 */
function quotePair(value: string): [string, string] {
  if (value === 'none') return ['', ''];
  const strings = spaceTokens(value)
    .filter((token) => /^["']/.test(token))
    .map((token) => token.slice(1, -1));
  const [open, close] = strings;
  return open === undefined || close === undefined ? ['\u201C', '\u201D'] : [open, close];
}

/**
 * A box a reader can scroll: the padding box it shows, and how far its content
 * can still be moved in each direction. Text outside the box but inside that
 * range can be brought into view.
 */
interface Scrollport {
  rect: Rect;
  /** How far the content can move right, down, left and up: the scroll offsets. */
  right: number;
  bottom: number;
  left: number;
  top: number;
  /** The element is a containing block for absolutely positioned descendants. */
  absolute: boolean;
  /** The element is a containing block for fixed descendants. */
  fixed: boolean;
}

/**
 * What draws the glyphs of a run of text, and where a finding about it points.
 * The backdrop is not known yet: it depends on where the text actually lands,
 * so contrast is measured at the text node.
 */
interface Ink {
  /** Every ink that draws the glyphs, with the effective opacity applied; all visible. */
  painted: readonly RGBA[];
  /** The fill, for the finding's detail. */
  fill: RGBA;
  element: Element;
  /** The pseudo-element the finding names, when the ink is a pseudo-element's. */
  selector: string | undefined;
  /** A pseudo-element's own background, which paints behind its own glyphs. */
  own: Layer | null;
  /** Identical inks share one finding, as in static mode. */
  key: string;
}

/** What an element passes down to its content. */
interface Frame {
  /** Everything inside is hidden. */
  subtree: Verdict | null;
  /** Hidden code or metadata: text is dropped without a finding. */
  silent: boolean;
  visibility: Verdict | null;
  font: Verdict | null;
  /** Ink that is fully transparent, which no backdrop can make visible. */
  color: Verdict | null;
  /** The ink whose contrast against its backdrop is still to be measured. */
  ink: Ink | null;
  opacity: number;
  /** The accumulated scale of the ancestors' transforms and zoom. */
  scale: number;
  /** The nearest ancestor's `perspective` distance, for 3D transforms of its children. */
  perspective: number | null;
  /** Ancestors that cut their overflow off, outermost first. */
  clips: readonly Clip[];
  /** Ancestors that can be scrolled, outermost first: their range is reachable. */
  scrollports: readonly Scrollport[];
}

/** World-independent context, as in static mode. */
interface Scope {
  /** Inside `<svg>` but outside any text element, text is not painted: the verdict for it. */
  svgGraphics: Verdict | null;
  svgText: boolean;
  flexItem: boolean;
}

const ROOT_FRAME: Frame = {
  subtree: null,
  silent: false,
  visibility: null,
  font: null,
  color: null,
  ink: null,
  opacity: 1,
  scale: 1,
  perspective: null,
  clips: [],
  scrollports: [],
};

const px = (value: number): string => `${Number.parseFloat(value.toFixed(2))}px`;

/** Splits a comma-separated list at the top level, leaving function arguments alone. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The whitespace-separated tokens of a value, with functions kept whole. */
function spaceTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if ((character === undefined || character === ' ') && depth === 0) {
      const token = value.slice(start, index).trim();
      if (token !== '') tokens.push(token);
      start = index + 1;
    }
  }
  return tokens;
}

/** A `<length-percentage>` of a computed shape, split into its two possible units. */
interface ShapePart {
  px: number;
  pct: number;
}

/**
 * Reads a `<length-percentage>` of a computed shape. Computed values carry
 * only `px` and `%`, so anything else is not decidable here.
 */
function shapePart(value: string | undefined): ShapePart | null {
  if (value === undefined) return null;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return null;
  if (value.endsWith('%')) return { px: 0, pct: amount };
  return value.endsWith('px') || amount === 0 ? { px: amount, pct: 0 } : null;
}

/**
 * A `clip-path` shape that leaves no area: an `inset()` of at least 100% on an
 * axis, a zero radius, or a degenerate polygon. Shapes whose emptiness depends
 * on the box size are not decided. The value is the browser's computed one, so
 * lengths are already in pixels and `rect()` and `xywh()` are `inset()`.
 */
function clipPathDetail(value: string): string | null {
  if (value === '' || value === 'none') return null;
  const shape = /^(\w[\w-]*)\((.*)\)$/.exec(value.replace(/\s+at\s+[^()]*(?=\)?$)/, ''));
  if (shape === null) return null;
  const name = (shape[1] as string).toLowerCase();
  const body = shape[2] as string;
  const words = body.split(/\s+/).filter((word) => word !== '');
  const sides = words.slice(0, words.indexOf('round') === -1 ? undefined : words.indexOf('round'));
  const empty = ((): boolean => {
    if (name === 'inset') {
      const [top, right = top, bottom = top, left = right] = sides;
      const axis = (start: string | undefined, end: string | undefined): boolean => {
        const [one, two] = [shapePart(start), shapePart(end)];
        return one !== null && two !== null && one.pct + two.pct >= 100 && one.px + two.px >= 0;
      };
      return axis(top, bottom) || axis(left, right);
    }
    if (name === 'circle' || name === 'ellipse') {
      const radii = (name === 'circle' ? [sides[0]] : [sides[0], sides[1]]).map(shapePart);
      return radii.some((radius) => radius !== null && radius.px <= 0 && radius.pct <= 0);
    }
    if (name !== 'polygon') return false;
    const points = splitTop(body)
      .map((point) => point.split(/\s+/).map(shapePart))
      .filter(
        (point): point is [ShapePart, ShapePart] =>
          point.length === 2 && point.every((part) => part !== null),
      );
    if (points.length !== splitTop(body).length) return false;
    if (points.length < 3) return true;
    // The shoelace area, when every coordinate is in the same unit.
    const unit = points.every((point) => point.every((part) => part.pct === 0))
      ? 'px'
      : points.every((point) => point.every((part) => part.px === 0))
        ? 'pct'
        : null;
    if (unit === null) return false;
    let area = 0;
    for (const [index, [x1, y1]] of points.entries()) {
      const [x2, y2] = points[(index + 1) % points.length] as (typeof points)[number];
      area += x1[unit] * y2[unit] - x2[unit] * y1[unit];
    }
    return Math.abs(area) < 1e-9;
  })();
  return empty ? `clip-path: ${value}` : null;
}

/** `clip: rect()` that leaves no area. It only applies to absolutely positioned boxes. */
function clipDetail(style: CSSStyleDeclaration): string | null {
  const clip = style.getPropertyValue('clip');
  const position = style.getPropertyValue('position');
  if (clip === '' || clip === 'auto' || (position !== 'absolute' && position !== 'fixed'))
    return null;
  const shape = /^rect\((.*)\)$/.exec(clip);
  if (shape === null) return null;
  const edges = (shape[1] as string).split(/[\s,]+/).filter((edge) => edge !== '');
  if (edges.length !== 4) return null;
  const [top, right, bottom, left] = edges.map((value, index): number | null => {
    // `auto` is the box's own edge: zero for the top and left, unknown otherwise.
    if (value === 'auto') return index === 0 || index === 3 ? 0 : null;
    const amount = Number.parseFloat(value);
    return Number.isFinite(amount) ? amount : null;
  }) as [number | null, number | null, number | null, number | null];
  const empty =
    (top !== null && bottom !== null && bottom <= top) ||
    (left !== null && right !== null && right <= left);
  return empty ? `clip: ${clip}` : null;
}

/**
 * Converts any color the browser understands into sRGB by painting it on a
 * canvas twice, over black and over white, which recovers the alpha exactly
 * instead of through the rounding of one premultiplied pixel.
 */
function createPainter(doc: Document): (value: string) => RGBA | null {
  const cache = new Map<string, RGBA | null>();
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return (raw: string): RGBA | null => {
    const value = raw.trim();
    if (cache.has(value)) return cache.get(value) ?? null;
    let result: RGBA | null = null;
    if (context !== null && value !== '') {
      // A value the engine rejects leaves fillStyle untouched, so two different
      // starting colors read back differently.
      context.fillStyle = '#000000';
      context.fillStyle = value;
      const probe = context.fillStyle;
      context.fillStyle = '#ffffff';
      context.fillStyle = value;
      if (context.fillStyle === probe) {
        const sample = (background: string): Uint8ClampedArray => {
          context.fillStyle = background;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data;
        };
        const onBlack = sample('#000000');
        const onWhite = sample('#ffffff');
        const spread = [0, 1, 2].reduce(
          (sum, index) => sum + ((onWhite[index] as number) - (onBlack[index] as number)),
          0,
        );
        const alpha = Math.min(1, Math.max(0, 1 - spread / (3 * 255)));
        const channel = (index: number): number =>
          alpha === 0 ? 0 : Math.min(1, (onBlack[index] as number) / 255 / alpha);
        result = { r: channel(0), g: channel(1), b: channel(2), a: alpha };
      }
    }
    cache.set(value, result);
    return result;
  };
}

/** Builds the selectors findings carry, in static mode's format. */
function createSelector(hosts: WeakMap<Node, Element>): (node: Node | null) => string {
  const cache = new WeakMap<Element, string>();
  const positions = new WeakMap<Node, Map<Element, [number, number]>>();
  // A shadow root names its host; a template's content and a frame's document
  // name the element that holds them.
  const up = (node: Node): Node | null =>
    node.parentNode ?? (node as Partial<ShadowRoot>).host ?? hosts.get(node) ?? null;
  const positionOf = (node: Element, parent: Node): [number, number] => {
    let known = positions.get(parent);
    if (known === undefined) {
      known = new Map();
      const byName = new Map<string, Element[]>();
      for (const child of (parent as ParentNode).children) {
        const list = byName.get(child.localName);
        if (list === undefined) byName.set(child.localName, [child]);
        else list.push(child);
      }
      for (const list of byName.values()) {
        for (const [index, child] of list.entries()) known.set(child, [index + 1, list.length]);
      }
      positions.set(parent, known);
    }
    return known.get(node) ?? [1, 1];
  };
  const selectorOf = (start: Node | null): string => {
    let node: Node | null = start;
    while (node !== null && node.nodeType !== ELEMENT) node = up(node);
    if (node === null) return ':root';
    const element = node as Element;
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    let selector: string;
    const id = element.getAttribute('id');
    if (id !== null && CSS_IDENT.test(id)) {
      selector = `#${id}`;
    } else {
      const parent = up(element);
      const [index, total] = parent === null ? [1, 1] : positionOf(element, parent);
      const step = total > 1 ? `${element.localName}:nth-of-type(${index})` : element.localName;
      // A document ends the path; a fragment or a frame continues it.
      const nested = parent !== null && (parent.nodeType === ELEMENT || up(parent) !== null);
      selector = nested ? `${selectorOf(parent)} > ${step}` : step;
    }
    cache.set(element, selector);
    return selector;
  };
  return selectorOf;
}

/** The element's own transform, with the individual transform properties applied first. */
function matrixOf(style: CSSStyleDeclaration, view: View): DOMMatrix | null {
  const parts: string[] = [];
  const translate = style.getPropertyValue('translate');
  if (translate !== '' && translate !== 'none') {
    const values = translate.split(/\s+/);
    parts.push(`translate3d(${[0, 1, 2].map((index) => values[index] ?? '0').join(',')})`);
  }
  const rotate = style.getPropertyValue('rotate');
  if (rotate !== '' && rotate !== 'none') {
    const values = rotate.split(/\s+/);
    if (values.length === 1) parts.push(`rotate(${values[0]})`);
    else if (values.length === 2)
      parts.push(`rotate3d(${own(ROTATION_AXIS, values[0] as string) ?? '0,0,1'},${values[1]})`);
    else parts.push(`rotate3d(${values.join(',')})`);
  }
  const scale = style.getPropertyValue('scale');
  if (scale !== '' && scale !== 'none') {
    const values = scale.split(/\s+/);
    const x = values[0] ?? '1';
    parts.push(`scale3d(${x},${values[1] ?? x},${values[2] ?? '1'})`);
  }
  const transform = style.getPropertyValue('transform');
  if (transform !== '' && transform !== 'none') parts.push(transform);
  if (parts.length === 0) return null;
  try {
    return new view.DOMMatrix(parts.join(' '));
  } catch {
    return null;
  }
}

/**
 * How much a transform shrinks text: the derivative of the projection at the
 * box's origin, so that a perspective division counts, reduced to the smaller
 * of the two axis scale factors. Zero when the matrix collapses the plane to a
 * line, or puts the box at or behind the viewer.
 */
function scaleOfMatrix(matrix: DOMMatrix, perspective: number | null, view: View): number {
  let total = matrix;
  if (perspective !== null && perspective > 0) {
    const lens = new view.DOMMatrix();
    lens.m34 = -1 / perspective;
    total = lens.multiply(matrix);
  }
  const w = total.m44;
  if (w <= 0) return 0;
  const a = (total.m11 * w - total.m41 * total.m14) / (w * w);
  const b = (total.m12 * w - total.m42 * total.m14) / (w * w);
  const c = (total.m21 * w - total.m41 * total.m24) / (w * w);
  const d = (total.m22 * w - total.m42 * total.m24) / (w * w);
  if (Math.abs(a * d - b * c) < 1e-9) return 0;
  return Math.min(Math.hypot(a, b), Math.hypot(c, d));
}

/** The flat-tree parent: the slot an element is assigned to, or the shadow host. */
function flatParent(node: Node): Element | null {
  const slot = (node as Partial<Element>).assignedSlot;
  if (slot != null) return slot;
  const parent = node.parentNode;
  if (parent === null) return null;
  if (parent.nodeType === ELEMENT) return parent as Element;
  return (parent as Partial<ShadowRoot>).host ?? null;
}

class Extractor {
  /** Fragments and documents that are not reachable through `parentNode`. */
  private readonly hosts = new WeakMap<Node, Element>();
  private readonly selectorOf = createSelector(this.hosts);
  private readonly backgrounds = new WeakMap<Element, RGBA | null>();
  private readonly painters = new WeakMap<Document, PainterIndex>();
  private readonly textClips = new WeakMap<Element, RGBA | null | undefined>();
  private readonly canvases = new WeakMap<Document, RGBA | null>();
  private readonly areas = new WeakMap<Document, Rect>();
  private readonly ranges = new WeakMap<Document, Range>();
  private readonly warnings: Warning[] = [];
  private readonly paint: (value: string) => RGBA | null;

  constructor(
    private readonly limits: PageLimits,
    private readonly top: Document,
  ) {
    this.paint = createPainter(top);
  }

  extract(): ExtractResult {
    const tree = this.build(
      this.top.childNodes,
      ROOT_FRAME,
      { svgGraphics: null, svgText: false, flexItem: false },
      null,
    );
    const { text, hidden, generated } = assemble(tree);
    return { text, hidden, generated, warnings: this.warnings };
  }

  private warn(code: WarningCode, message: string): void {
    if (!this.warnings.some((warning) => warning.code === code && warning.message === message))
      this.warnings.push({ code, message });
  }

  private verdict(reason: HiddenReason, node: Node | null, detail: string): Verdict {
    return { reason, selector: this.selectorOf(node), detail };
  }

  /**
   * `null` only for an element of a document with no browsing context, which a
   * `<template>`'s contents belong to: nothing there is ever rendered.
   */
  private styleOf(element: Element, pseudo?: Pseudo): CSSStyleDeclaration | null {
    const view = element.ownerDocument.defaultView;
    return view === null ? null : view.getComputedStyle(element, pseudo ? `::${pseudo}` : null);
  }

  /** The part of a document a reader can reach, in viewport coordinates. */
  private areaOf(doc: Document): Rect {
    const known = this.areas.get(doc);
    if (known !== undefined) return known;
    const root = doc.documentElement;
    const view = doc.defaultView;
    const styles = [root, doc.body].map((element) =>
      element === null || view === null ? null : view.getComputedStyle(element),
    );
    // Content pushed past the right or bottom edge can be scrolled to, unless
    // the root or the body cuts that axis off.
    const cutsOff = (axis: string): boolean =>
      styles.some(
        (style) => style !== null && own(CUTS_OFF, style.getPropertyValue(axis)) === true,
      );
    // A skipped `content-visibility: auto` subtree is size-contained, so the
    // scroll area stops short of it although scrolling there renders it; what
    // it would add is its own rectangles, and a page that clips still clips.
    const deferred = this.paintersIn(doc).deferred;
    const width = cutsOff('overflow-x')
      ? root.clientWidth
      : Math.max(root.scrollWidth, root.clientWidth, deferred?.right ?? 0);
    const height = cutsOff('overflow-y')
      ? root.clientHeight
      : Math.max(root.scrollHeight, root.clientHeight, deferred?.bottom ?? 0);
    const [x, y] = [view?.scrollX ?? 0, view?.scrollY ?? 0];
    const area: Rect = { left: -x, top: -y, right: width - x, bottom: height - y };
    this.areas.set(doc, area);
    return area;
  }

  /** Whether a `background-image` hides what is behind it. A gradient of fully transparent stops does not. */
  private obscures(value: string): boolean {
    if (value === '' || value === 'none') return false;
    if (value.includes('url(')) return true;
    let colors = 0;
    for (const layer of splitTop(value)) {
      const open = layer.indexOf('(');
      if (open === -1 || !layer.endsWith(')')) return true;
      for (const stop of splitTop(layer.slice(open + 1, -1))) {
        // Drop the trailing positions of a colour stop, then read what is left.
        const color = this.paint(stop.replace(/(\s+(-?[\d.]+[a-z%]*|calc\(.*\)))+$/, ''));
        if (color === null) continue;
        colors += 1;
        if (color.a > 0) return true;
      }
    }
    return colors === 0;
  }

  /**
   * The background a box paints: none when it is clipped to the text, which
   * draws the glyphs instead, or when the box is invisible.
   */
  private layerOf(style: CSSStyleDeclaration): Layer {
    if (
      style.getPropertyValue('background-clip') === 'text' ||
      style.getPropertyValue('visibility') !== 'visible'
    )
      return CLEAR;
    return {
      color: this.paint(style.getPropertyValue('background-color')),
      image: this.obscures(style.getPropertyValue('background-image')),
    };
  }

  /** The same, for an element, after the background propagation to the canvas. */
  private paintLayerOf(element: Element, style: CSSStyleDeclaration): Layer {
    const doc = element.ownerDocument;
    // The root's background is the canvas; a transparent root propagates the
    // body's there instead, and the body then paints none of its own.
    if (element === doc.documentElement) return CLEAR;
    if (element === doc.body && this.rootIsClear(doc)) return CLEAR;
    return this.layerOf(style);
  }

  /** Whether the root element paints nothing, so that the body's background reaches the canvas. */
  private rootIsClear(doc: Document): boolean {
    const style = this.styleOf(doc.documentElement);
    if (style === null) return true;
    if (style.getPropertyValue('background-clip') === 'text') return true;
    const color = this.paint(style.getPropertyValue('background-color'));
    return !this.obscures(style.getPropertyValue('background-image')) && color?.a === 0;
  }

  /** The page canvas: the root's background, or the body's when the root paints none. */
  private canvasOf(doc: Document): RGBA | null {
    const known = this.canvases.get(doc);
    if (known !== undefined) return known;
    const root = doc.documentElement;
    const style = this.styleOf(root);
    const source = this.rootIsClear(doc) && doc.body !== null ? doc.body : root;
    const sourceStyle = source === root ? style : this.styleOf(source);
    let result: RGBA | null = null;
    if (style !== null && sourceStyle !== null) {
      // `color-scheme` lists the schemes the page supports; the browser uses
      // the reader's preferred one when it is listed, the first otherwise.
      const supported = style
        .getPropertyValue('color-scheme')
        .split(/\s+/)
        .filter((word) => word === 'light' || word === 'dark');
      const prefersDark =
        supported.includes('dark') &&
        (!supported.includes('light') ||
          this.viewOf(root).matchMedia('(prefers-color-scheme: dark)').matches);
      const base = prefersDark ? DARK_CANVAS : LIGHT_CANVAS;
      const color = this.paint(sourceStyle.getPropertyValue('background-color'));
      const image = this.obscures(sourceStyle.getPropertyValue('background-image'));
      const clipped = sourceStyle.getPropertyValue('background-clip') === 'text';
      result = image
        ? null
        : color === null
          ? null
          : clipped || color.a === 0
            ? base
            : over(color, base);
    }
    this.canvases.set(doc, result);
    return result;
  }

  /**
   * The opaque color behind an element's own content: its background and its
   * flat-tree ancestors' composited over the canvas, with the background of a
   * table cell's column in its place. `null` when an image or an unreadable
   * color is in the way: contrast is then unknown.
   */
  private backgroundOf(element: Element): RGBA | null {
    if (this.backgrounds.has(element)) return this.backgrounds.get(element) ?? null;
    const doc = element.ownerDocument;
    const style = this.styleOf(element);
    let result: RGBA | null = null;
    if (element === doc.documentElement) result = this.canvasOf(doc);
    else if (style !== null) {
      const parent = flatParent(element) ?? doc.documentElement;
      // A column's background paints above the table's and below the cell's.
      const column = this.columnOf(element);
      const below = this.backgroundOf(parent);
      result = this.layerOver(
        this.paintLayerOf(element, style),
        column === null ? below : this.layerOver(column, below, 1),
        1,
      );
    }
    this.backgrounds.set(element, result);
    return result;
  }

  /** Composites one background layer over the backdrop; `null` when it hides what is below. */
  private layerOver(layer: Layer, backdrop: RGBA | null, fade: number): RGBA | null {
    if (backdrop === null || layer.image || layer.color === null) return null;
    const alpha = layer.color.a * fade;
    return alpha === 0 ? backdrop : over({ ...layer.color, a: alpha }, backdrop);
  }

  /** The `<col>` or `<colgroup>` background that paints behind a table cell. */
  private columnOf(element: Element): Layer | null {
    const name = element.localName;
    if (element.namespaceURI !== HTML_NAMESPACE || (name !== 'td' && name !== 'th')) return null;
    const cell = element as HTMLTableCellElement;
    const table = cell.closest('table');
    if (table === null) return null;
    let index = 0;
    for (const group of table.querySelectorAll('colgroup, col')) {
      if (group.localName === 'colgroup' && group.querySelector('col') !== null) continue;
      const span = Number.parseInt(group.getAttribute('span') ?? '1', 10);
      index += Number.isFinite(span) && span > 0 ? span : 1;
      if (index > cell.cellIndex) {
        const style = this.styleOf(group);
        return style === null ? null : this.paintLayerOf(group, style);
      }
    }
    return null;
  }

  /**
   * Every box of a document that can paint behind text it is not an ancestor
   * of: a positioned box with a background and a positioned `::before` or
   * `::after`, each with the rectangle it covers in document coordinates and
   * the element whose content it may lie under, its containing block, as in
   * static mode. Collected once per document by walking the flat tree, so a
   * box inside a shadow root counts, and bucketed into a grid of cells so that
   * a text node only looks at the painters near it.
   */
  private paintersIn(doc: Document): PainterIndex {
    const known = this.painters.get(doc);
    if (known !== undefined) return known;
    const index: PainterIndex = { cells: new Map(), deferred: null };
    this.painters.set(doc, index);
    const view = doc.defaultView;
    if (view === null) return index;
    const [scrollX, scrollY] = [view.scrollX, view.scrollY];
    const [edgeX, edgeY] = [view.innerWidth, view.innerHeight];
    const add = (box: Rect, layer: Layer, fixed: boolean, under: Element, fade: number): void => {
      const alpha = (layer.color?.a ?? 1) * fade;
      // Faded below what text would need to be seen, a box paints nothing, image or not.
      if (fade < this.limits.minOpacity || (!layer.image && alpha === 0)) return;
      // A fixed box that fills the viewport stays behind the text at every
      // scroll offset, so it covers the whole document; a smaller one only
      // covers where it sits.
      const spans = fixed && box.left <= 0 && box.top <= 0;
      const wide = spans && box.right >= edgeX;
      const tall = spans && box.bottom >= edgeY;
      const painter: Painter = {
        rect: {
          left: wide ? OPEN.left : box.left + scrollX,
          top: tall ? OPEN.top : box.top + scrollY,
          right: wide ? OPEN.right : box.right + scrollX,
          bottom: tall ? OPEN.bottom : box.bottom + scrollY,
        },
        layer: layer.image
          ? layer
          : { color: { ...(layer.color as RGBA), a: alpha }, image: false },
        under,
      };
      for (const key of cellsOf(painter.rect)) {
        const list = index.cells.get(key);
        if (list === undefined) index.cells.set(key, [painter]);
        else if (list.push(painter) > CELL_LIMIT * 2) index.cells.set(key, largest(list));
      }
    };
    const visit = (element: Element, fade: number, deferred: boolean): void => {
      const style = this.styleOf(element);
      if (style === null || style.getPropertyValue('display') === 'none') return;
      const alpha = fade * opacityOf(style);
      const position = style.getPropertyValue('position');
      // A skipped subtree is size-contained, so the document's scroll area
      // does not cover it although scrolling there renders it.
      const skipped = deferred || style.getPropertyValue('content-visibility') === 'auto';
      if (skipped) {
        const box = element.getBoundingClientRect();
        index.deferred = {
          right: Math.max(index.deferred?.right ?? 0, box.right + scrollX),
          bottom: Math.max(index.deferred?.bottom ?? 0, box.bottom + scrollY),
        };
      }
      if (alpha > 0) {
        if (position === 'absolute' || position === 'fixed') {
          const under = this.containingBlockOf(flatParent(element), position === 'fixed');
          if (under !== null)
            add(
              element.getBoundingClientRect(),
              this.paintLayerOf(element, style),
              position === 'fixed',
              under,
              alpha,
            );
        }
        if (element.namespaceURI === HTML_NAMESPACE && own(NO_PSEUDO, element.localName) !== true) {
          for (const which of ['before', 'after'] as const) {
            const overlay = this.overlayOf(element, which);
            if (overlay !== null)
              add(overlay.box, overlay.layer, overlay.fixed, overlay.under, alpha);
          }
        }
      }
      for (const child of this.flatChildren(element)) visit(child, alpha, skipped);
    };
    for (const child of doc.children) visit(child, 1, false);
    return index;
  }

  /** An element's children in the flat tree: a host's shadow content, a slot's assigned nodes. */
  private flatChildren(element: Element): Element[] {
    const shadow = element.shadowRoot;
    if (shadow !== null) return [...shadow.children];
    if (element.localName === 'slot' && element.getRootNode() !== element.ownerDocument) {
      const assigned = (element as HTMLSlotElement)
        .assignedNodes()
        .filter((node): node is Element => node.nodeType === ELEMENT);
      if (assigned.length > 0) return assigned;
    }
    return [...element.children];
  }

  /**
   * A positioned `::before` or `::after`, the box it covers and the element
   * whose content it may lie under: the usual overlay behind a hero's text.
   * Its containing block is where its resolved insets are measured from.
   */
  private overlayOf(
    element: Element,
    which: 'before' | 'after',
  ): { box: Rect; layer: Layer; fixed: boolean; under: Element } | null {
    const pseudo = this.styleOf(element, which);
    if (pseudo === null) return null;
    const content = pseudo.getPropertyValue('content');
    const position = pseudo.getPropertyValue('position');
    if (
      content === '' ||
      content === 'none' ||
      pseudo.getPropertyValue('display') === 'none' ||
      (position !== 'absolute' && position !== 'fixed')
    )
      return null;
    const layer = this.layerOf(pseudo);
    if (!layer.image && layer.color?.a === 0) return null;
    // A pseudo-element's containing block search starts at its own element.
    const under = this.containingBlockOf(element, position === 'fixed');
    const container = under === null ? null : this.paddingBoxOf(under);
    if (under === null || container === null) return null;
    const inset = (name: string): number => {
      const value = Number.parseFloat(pseudo.getPropertyValue(name));
      return Number.isFinite(value) ? value : 0;
    };
    const box: Rect = {
      left: container.left + inset('left'),
      top: container.top + inset('top'),
      right: container.right - inset('right'),
      bottom: container.bottom - inset('bottom'),
    };
    return { box, layer, fixed: position === 'fixed', under };
  }

  /**
   * The element whose content a positioned box may paint under: its containing
   * block. A fixed box is laid out against the viewport, so it belongs to the
   * root element unless a transform makes an ancestor its containing block.
   */
  private containingBlockOf(start: Element | null, fixed: boolean): Element | null {
    for (let node: Element | null = start; node !== null; node = flatParent(node)) {
      const style = this.styleOf(node);
      if (style === null) break;
      const transformed =
        style.getPropertyValue('transform') !== 'none' ||
        style.getPropertyValue('filter') !== 'none' ||
        style.getPropertyValue('perspective') !== 'none';
      if (transformed || (!fixed && style.getPropertyValue('position') !== 'static')) return node;
    }
    return (start ?? this.top.documentElement).ownerDocument.documentElement;
  }

  /** The box a container's content is laid out in. */
  private paddingBoxOf(element: Element): Rect | null {
    const style = this.styleOf(element);
    if (style === null) return null;
    const box = element.getBoundingClientRect();
    const edge = (name: string): number => Number.parseFloat(style.getPropertyValue(name)) || 0;
    return {
      left: box.left + edge('border-left-width'),
      top: box.top + edge('border-top-width'),
      right: box.right - edge('border-right-width'),
      bottom: box.bottom - edge('border-bottom-width'),
    };
  }

  /**
   * The colors that may lie behind a piece of text, at most `BACKDROP_LIMIT`:
   * the composite of its flat-tree ancestors, and that composite with a
   * painter slipped in under the ancestor it belongs to. Text is kept when it
   * contrasts with any of them, as in static mode. `null` when an image or an
   * unreadable color is among them: contrast is then unknown.
   *
   * A painter only counts for text inside its containing block, and only the
   * backgrounds between that block and the text are painted over it, so an
   * opaque background in between hides it, as it does on screen.
   */
  private backdropsFor(element: Element, point: [number, number] | null): RGBA[] | null {
    const base = this.backgroundOf(element);
    if (base === null || point === null) return base === null ? null : [base];
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const spot: [number, number] = [
      point[0] + (view?.scrollX ?? 0),
      point[1] + (view?.scrollY ?? 0),
    ];
    const index = this.paintersIn(doc);
    const nearby = [
      ...(index.cells.get(cellKey(spot[0], spot[1])) ?? []),
      ...(index.cells.get(EVERYWHERE) ?? []),
    ];
    if (nearby.length === 0) return [base];
    const chain: Element[] = [];
    for (let node: Element | null = element; node !== null; node = flatParent(node))
      chain.push(node);
    const result = [base];
    const seen = new Set([toHex(base)]);
    for (const { rect, layer, under } of nearby) {
      const depth = chain.indexOf(under);
      if (
        depth === -1 ||
        spot[0] < rect.left ||
        spot[0] > rect.right ||
        spot[1] < rect.top ||
        spot[1] > rect.bottom
      )
        continue;
      let composite = this.layerOver(layer, this.backgroundOf(under), 1);
      // The backgrounds between the containing block and the text paint over it.
      for (let step = depth - 1; step >= 0 && composite !== null; step -= 1) {
        const box = chain[step] as Element;
        const style = this.styleOf(box);
        composite =
          style === null ? null : this.layerOver(this.paintLayerOf(box, style), composite, 1);
      }
      if (composite === null) return null;
      const key = toHex(composite);
      if (result.length < BACKDROP_LIMIT && !seen.has(key)) {
        seen.add(key);
        result.push(composite);
      }
    }
    return result;
  }

  /**
   * The ink a background clipped to the text paints the glyphs with, taken
   * from the element or an ancestor: `null` for an image or an unreadable
   * color, `undefined` when there is none.
   */
  private textClipOf(element: Element): RGBA | null | undefined {
    if (this.textClips.has(element)) return this.textClips.get(element);
    const style = this.styleOf(element);
    let ink: RGBA | null | undefined;
    const parent = flatParent(element);
    if (style === null) ink = undefined;
    else if (style.getPropertyValue('background-clip') === 'text') {
      const image = this.obscures(style.getPropertyValue('background-image'));
      const color = this.paint(style.getPropertyValue('background-color'));
      if (image) ink = null;
      else if (color === null || color.a !== 0) ink = color;
      else ink = parent === null ? undefined : this.textClipOf(parent);
    } else ink = parent === null ? undefined : this.textClipOf(parent);
    this.textClips.set(element, ink);
    return ink;
  }

  /**
   * The inks that draw an element's glyphs: the fill, a stroke thick enough
   * to be legible, shadows sharp enough to be legible, and a background
   * clipped to the text. One unreadable color makes the whole set unknown.
   */
  private inksOf(element: Element, style: CSSStyleDeclaration, scale: number): (RGBA | null)[] {
    const inks: (RGBA | null)[] = [];
    const amount = (name: string, fallback: number): number => {
      const parsed = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const withAlpha = (ink: RGBA | null, alpha: number): RGBA | null =>
      ink === null ? null : { ...ink, a: ink.a * alpha };
    if (element.namespaceURI === SVG_NAMESPACE) {
      const fill = style.getPropertyValue('fill');
      if (fill !== 'none') inks.push(withAlpha(this.paint(fill), amount('fill-opacity', 1)));
      const stroke = style.getPropertyValue('stroke');
      if (stroke !== 'none' && amount('stroke-width', 0) * scale >= MIN_STROKE)
        inks.push(withAlpha(this.paint(stroke), amount('stroke-opacity', 1)));
      return inks;
    }
    const fill = style.getPropertyValue('-webkit-text-fill-color');
    inks.push(this.paint(fill === '' ? style.getPropertyValue('color') : fill));
    // A hairline stroke, or a shadow blurred far wider than the glyphs, draws nothing legible.
    if (amount('-webkit-text-stroke-width', 0) * scale >= MIN_STROKE)
      inks.push(this.paint(style.getPropertyValue('-webkit-text-stroke-color')));
    const shadows = style.getPropertyValue('text-shadow');
    if (shadows !== '' && shadows !== 'none') {
      const limit = amount('font-size', 0) * MAX_SHADOW_BLUR;
      for (const shadow of splitTop(shadows)) {
        const tokens = spaceTokens(shadow);
        const lengths = tokens.filter((token) => /^-?[\d.]+px$/.test(token));
        if (Number.parseFloat(lengths[2] ?? '0') > limit) continue;
        const color = tokens.map((token) => this.paint(token)).find((read) => read !== null);
        inks.push(color ?? null);
      }
    }
    const clip = this.textClipOf(element);
    if (clip !== undefined) inks.push(clip);
    return inks;
  }

  /**
   * Ink that is fully transparent is invisible over any backdrop, known or
   * not; ink that paints has to wait for the backdrop under the text it draws.
   */
  private inkOf(
    element: Element,
    style: CSSStyleDeclaration,
    frame: Frame,
    parent: Frame,
    selector: string | undefined,
    ownBackground: boolean,
  ): Pick<Frame, 'color' | 'ink'> {
    const inks = this.inksOf(element, style, frame.scale);
    if (inks.includes(null)) return { color: null, ink: null };
    const fill = inks[0] ?? TRANSPARENT;
    const painted = (inks as RGBA[])
      .map((ink) => ({ ...ink, a: ink.a * frame.opacity }))
      .filter((ink) => ink.a > 0);
    if (painted.length === 0) {
      const detail = `text color ${toHex(fill)} is fully transparent`;
      const color =
        parent.color?.reason === 'transparent-text' && parent.color.detail === detail
          ? parent.color
          : selector === undefined
            ? this.verdict('transparent-text', element, detail)
            : { reason: 'transparent-text' as const, selector, detail };
      return { color, ink: null };
    }
    const key = `${toHex(fill)}|${painted.map(toHex).join(',')}`;
    // A pseudo-element paints its own background behind its own glyphs.
    const box = ownBackground ? this.layerOf(style) : null;
    // An element that paints nothing of its own stands on the same backdrop as
    // its parent, so it shares the parent's finding, as in static mode.
    const inherit =
      parent.ink !== null &&
      parent.ink.key === key &&
      selector === undefined &&
      this.paintsNothing(element, style);
    const ink = inherit ? (parent.ink as Ink) : { painted, fill, element, selector, own: box, key };
    return { color: null, ink };
  }

  /** Whether an element adds no background of its own to what is behind it. */
  private paintsNothing(element: Element, style: CSSStyleDeclaration): boolean {
    const layer = this.paintLayerOf(element, style);
    if (layer.image || layer.color === null || layer.color.a !== 0) return false;
    const name = element.localName;
    return name !== 'td' && name !== 'th';
  }

  /**
   * A box of no more than one pixel that does not let its content overflow.
   * Measured, so padding, minimum sizes and intrinsic sizes already count.
   * Scrollable overflow counts as cutting off here: a scrollport of zero size
   * shows nothing, whatever the scroll offset.
   */
  private zeroSizeDetail(element: Element, style: CSSStyleDeclaration): string | null {
    if (element.namespaceURI !== HTML_NAMESPACE) return null;
    const contained = /\b(strict|content|paint)\b/.test(style.getPropertyValue('contain'));
    const source = (axis: string): string | null => {
      const overflow = style.getPropertyValue(axis);
      if (overflow !== 'visible' && overflow !== '') return `overflow: ${overflow}`;
      return contained ? 'contain: paint' : null;
    };
    const horizontal = source('overflow-x');
    if (horizontal !== null && element.clientWidth <= 1)
      return `width: ${element.clientWidth}px; ${horizontal}`;
    const vertical = source('overflow-y');
    if (vertical !== null && element.clientHeight <= 1)
      return `height: ${element.clientHeight}px; ${vertical}`;
    return null;
  }

  /**
   * The area an element leaves for its content, when it cuts its overflow off.
   * `overflow` has no effect on an inline, non-replaced box, so only a box
   * whose size applies can cut anything off.
   */
  private clipOf(element: Element, style: CSSStyleDeclaration, transformed: boolean): Clip | null {
    const contained = /\b(strict|content|paint)\b/.test(style.getPropertyValue('contain'));
    const source = (axis: string): string | null => {
      const overflow = style.getPropertyValue(axis);
      if (own(CUTS_OFF, overflow) === true) return `${axis}: ${overflow}`;
      return contained ? 'contain: paint' : null;
    };
    const [cutsX, cutsY] = [source('overflow-x'), source('overflow-y')];
    if (cutsX === null && cutsY === null) return null;
    const box = element.getBoundingClientRect();
    const edge = (name: string): number => Number.parseFloat(style.getPropertyValue(name)) || 0;
    const position = style.getPropertyValue('position');
    return {
      // Overflow is cut off at the padding box.
      rect: {
        left: cutsX === null ? OPEN.left : box.left + edge('border-left-width'),
        right: cutsX === null ? OPEN.right : box.right - edge('border-right-width'),
        top: cutsY === null ? OPEN.top : box.top + edge('border-top-width'),
        bottom: cutsY === null ? OPEN.bottom : box.bottom - edge('border-bottom-width'),
      },
      verdict: this.verdict('clipped', element, cutsX ?? (cutsY as string)),
      absolute: position !== 'static' || transformed || contained,
      fixed: transformed || contained,
    };
  }

  /**
   * A box a reader can scroll, and how far its content can still be moved.
   * `overflow: hidden` is excluded: a script can scroll it, a reader cannot.
   */
  private scrollportOf(
    element: Element,
    style: CSSStyleDeclaration,
    transformed: boolean,
  ): Scrollport | null {
    const scrolls = (axis: string): boolean => {
      const overflow = style.getPropertyValue(axis);
      return overflow === 'auto' || overflow === 'scroll';
    };
    const [x, y] = [scrolls('overflow-x'), scrolls('overflow-y')];
    if (!x && !y) return null;
    const box = element.getBoundingClientRect();
    const edge = (name: string): number => Number.parseFloat(style.getPropertyValue(name)) || 0;
    return {
      rect: {
        left: box.left + edge('border-left-width'),
        top: box.top + edge('border-top-width'),
        right: box.right - edge('border-right-width'),
        bottom: box.bottom - edge('border-bottom-width'),
      },
      left: x ? element.scrollLeft : 0,
      right: x ? element.scrollWidth - element.clientWidth - element.scrollLeft : 0,
      top: y ? element.scrollTop : 0,
      bottom: y ? element.scrollHeight - element.clientHeight - element.scrollTop : 0,
      absolute: style.getPropertyValue('position') !== 'static' || transformed,
      fixed: transformed,
    };
  }

  /** The rectangles a text node actually covers, the empty ones left out. */
  private rectsOf(node: Text): DOMRect[] {
    const doc = node.ownerDocument;
    let range = this.ranges.get(doc);
    if (range === undefined) {
      range = doc.createRange();
      this.ranges.set(doc, range);
    }
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  }

  /**
   * Where a piece of content is actually drawn. Content whose every rectangle
   * falls outside what a reader can reach is hidden: cut off by an ancestor
   * when it is still inside the page, moved out of the page otherwise.
   *
   * A scrollable ancestor is reach, not a boundary: the content's rectangle is
   * first grown by how far that box can still scroll, and what is then inside
   * its scrollport is judged at the scrollport's own place in the page.
   */
  private placementOf(node: Node, rects: readonly Rect[], frame: Frame): Verdict | null {
    if (rects.length === 0) return null;
    const doc = node.ownerDocument ?? (node as Document);
    const area = this.areaOf(doc);
    let reachable: Rect[] = [...rects];
    for (const port of [...frame.scrollports].reverse()) {
      const grown = reachable
        .map((rect) => ({
          left: rect.left - port.right,
          right: rect.right + port.left,
          top: rect.top - port.bottom,
          bottom: rect.bottom + port.top,
        }))
        .filter((rect) => meets(rect, port.rect));
      if (grown.length === 0) break;
      // Once scrolled into view the content sits inside the scrollport, so the
      // scrollport is what the rest of the page has to show.
      reachable = [port.rect];
    }
    if (
      reachable.some(
        (rect) => meets(rect, area) && frame.clips.every((clip) => meets(rect, clip.rect)),
      )
    )
      return null;
    // Outside the page beats an ancestor that also cuts it off: being out of
    // reach is the stronger statement, and the one static mode makes too.
    if (reachable.every((rect) => !meets(rect, area))) {
      const first = rects[0] as Rect;
      return this.verdict(
        'off-screen',
        node.nodeType === ELEMENT ? node : node.parentNode,
        `drawn at ${px(first.left)}, ${px(first.top)}, outside the page`,
      );
    }
    const innermost = [...frame.clips]
      .reverse()
      .find((clip) => reachable.every((rect) => !meets(rect, clip.rect)));
    return innermost?.verdict ?? null;
  }

  /** The frame an element passes to its content. `selector` names a pseudo-element. */
  private enter(
    element: Element,
    style: CSSStyleDeclaration,
    display: Display,
    parent: Frame,
    scope: Scope,
    selector?: string,
  ): Frame {
    const name = element.localName;
    const namespace = element.namespaceURI;
    // Code and document metadata, not text: dropped without a finding, hidden or not.
    const code =
      name === 'script' ||
      name === 'style' ||
      (namespace === HTML_NAMESPACE && (name === 'head' || name === 'title'));
    if (parent.subtree !== null)
      return code && !parent.silent ? { ...parent, silent: true } : parent;
    const at = (reason: HiddenReason, detail: string): Verdict =>
      selector === undefined ? this.verdict(reason, element, detail) : { reason, selector, detail };
    const frame: Frame = { ...parent };
    const hide = (reason: HiddenReason, detail: string): Frame => ({
      ...frame,
      subtree: at(reason, detail),
    });

    if (namespace === SVG_NAMESPACE && own(SVG_HIDDEN, name) === true)
      return hide('not-rendered', `SVG <${name}> content`);
    // Checked before `display`, unlike static mode: Chromium reports the
    // author's `display` for `<noscript>` when scripting is on, and renders
    // nothing anyway. These elements never render their text in any engine.
    if (namespace === HTML_NAMESPACE && own(NEVER_RENDERED, name) === true)
      return hide('not-rendered', `<${name}> content`);
    if (display.kind === 'none') {
      if (code) return { ...hide('not-rendered', `<${name}>`), silent: true };
      if (element.hasAttribute('hidden')) return hide('display-none', 'hidden attribute');
      if (name === 'dialog') return hide('display-none', 'closed <dialog>');
      if (element.hasAttribute('popover')) return hide('display-none', 'popover that is not open');
      return hide('display-none', 'display: none');
    }

    const visibility = style.getPropertyValue('visibility');
    frame.visibility =
      visibility === 'visible' || visibility === ''
        ? null
        : (parent.visibility ?? at('visibility-hidden', `visibility: ${visibility}`));

    const boxed = display.kind !== 'contents';
    const position = style.getPropertyValue('position');
    const blockified = scope.flexItem || position === 'absolute' || position === 'fixed';
    const sized =
      boxed &&
      (display.kind === 'internal' ||
        blockified ||
        display.outer !== 'inline' ||
        display.inner !== 'flow');

    if (boxed) {
      const filters = style.getPropertyValue('filter');
      const filterOpacity = [...filters.matchAll(/opacity\(([^)]*)\)/g)].reduce((total, match) => {
        const raw = (match[1] as string).trim();
        const parsed = Number.parseFloat(raw);
        return total * (Number.isFinite(parsed) ? (raw.endsWith('%') ? parsed / 100 : parsed) : 1);
      }, 1);
      const own_ = Number.parseFloat(style.getPropertyValue('opacity'));
      const opacity = Number.isFinite(own_) ? own_ : 1;
      frame.opacity = parent.opacity * opacity * filterOpacity;
      if (frame.opacity < this.limits.minOpacity) {
        const detail =
          filterOpacity < 1 && opacity === 1
            ? `filter: opacity(${filterOpacity})`
            : `opacity: ${Number.parseFloat(frame.opacity.toFixed(3))}`;
        return hide('opacity', detail);
      }
    }

    if (sized) {
      const zero = this.zeroSizeDetail(element, style);
      if (zero !== null) return hide('zero-size', zero);
      const clip = clipDetail(style);
      if (clip !== null) return hide('clipped', clip);
    }
    if (boxed) {
      const path = clipPathDetail(style.getPropertyValue('clip-path'));
      if (path !== null) return hide('clipped', path);
    }

    // SVG elements are transformable whatever their display; inline HTML boxes are not.
    const matrix =
      sized || namespace === SVG_NAMESPACE ? matrixOf(style, this.viewOf(element)) : null;
    const perspective = Number.parseFloat(style.getPropertyValue('perspective'));
    frame.perspective = Number.isFinite(perspective) ? perspective : null;
    const zoom = Number.parseFloat(style.getPropertyValue('zoom'));
    frame.scale =
      parent.scale *
      (Number.isFinite(zoom) ? zoom : 1) *
      (matrix === null ? 1 : scaleOfMatrix(matrix, parent.perspective, this.viewOf(element)));

    if (boxed && style.getPropertyValue('content-visibility') === 'hidden') {
      const detail =
        element.getAttribute('hidden')?.toLowerCase() === 'until-found'
          ? 'hidden="until-found"'
          : 'content-visibility: hidden';
      return hide('content-visibility', detail);
    }

    const size = Number.parseFloat(style.getPropertyValue('font-size')) * frame.scale;
    frame.font =
      Number.isFinite(size) && size < this.limits.minFontSize
        ? (parent.font ?? at('font-size', `font-size: ${px(size)}`))
        : null;

    // Only `::before` and `::after` reach here with a selector, and their
    // background is their own box, not a view of the element's.
    const { color, ink } = this.inkOf(
      element,
      style,
      frame,
      parent,
      selector,
      selector !== undefined,
    );
    frame.color = color;
    frame.ink = ink;

    // The root element's own overflow is what bounds the document's scrollable
    // area, which `areaOf` already measures, so it adds no clip of its own.
    if (boxed && selector === undefined && element !== element.ownerDocument.documentElement) {
      const transformed =
        matrix !== null ||
        style.getPropertyValue('filter') !== 'none' ||
        style.getPropertyValue('perspective') !== 'none' ||
        /transform|filter|perspective/.test(style.getPropertyValue('will-change'));
      // A positioned box escapes the ancestors that are not its containing block.
      const inherited =
        position === 'fixed'
          ? parent.clips.filter((clip) => clip.fixed)
          : position === 'absolute'
            ? parent.clips.filter((clip) => clip.absolute)
            : parent.clips;
      // Overflow applies to an SVG element whatever its display, as transforms do.
      const clip =
        sized || namespace === SVG_NAMESPACE ? this.clipOf(element, style, transformed) : null;
      frame.clips = clip === null ? inherited : [...inherited, clip];
      // A positioned box does not scroll with an ancestor that is not its
      // containing block, so it does not borrow that scroller's range either.
      const scrollers =
        position === 'fixed'
          ? parent.scrollports.filter((port) => port.fixed)
          : position === 'absolute'
            ? parent.scrollports.filter((port) => port.absolute)
            : parent.scrollports;
      const port = sized ? this.scrollportOf(element, style, transformed) : null;
      frame.scrollports = port === null ? scrollers : [...scrollers, port];
    }
    return frame;
  }

  private viewOf(element: Element): View {
    return element.ownerDocument.defaultView ?? (this.top.defaultView as View);
  }

  private layoutOf(
    element: Element,
    style: CSSStyleDeclaration,
    display: Display,
    scope: Scope,
  ): Layout {
    const layout = this.layoutOfDisplay(display, style.getPropertyValue('position'), scope);
    // innerText separates a <p> by a blank line, but only when it is block-level.
    return element.localName === 'p' && layout === 'block' ? 'paragraph' : layout;
  }

  private layoutOfDisplay(display: Display, position: string, scope: Scope): Layout {
    if (display.kind === 'internal') return own(INTERNAL, display.role) ?? 'block';
    if (display.kind !== 'box') return 'inline';
    const blockified = scope.flexItem || position === 'absolute' || position === 'fixed';
    return blockified || display.outer === 'block' ? 'block' : 'inline';
  }

  /** The verdict for text directly inside an element with this frame. */
  private textVerdict(node: Text, frame: Frame, scope: Scope): Verdict | null {
    const graphics = scope.svgText ? null : scope.svgGraphics;
    if (frame.subtree !== null) return frame.subtree;
    if (graphics !== null) return graphics;
    // White space has no rectangle worth placing, but the styles around it
    // still draw it, and an engine renders none of it when they hide it.
    const blank = node.data.trim() === '';
    const rects = blank ? [] : this.rectsOf(node);
    return (
      this.placementOf(node, rects, frame) ??
      frame.visibility ??
      frame.font ??
      frame.color ??
      (blank ? null : this.contrastVerdict(frame.ink, centreOf(rects[0])))
    );
  }

  /** Text drawn too close to every color that may lie behind it to be read. */
  private contrastVerdict(ink: Ink | null, point: [number, number] | null): Verdict | null {
    if (ink === null) return null;
    let backdrops = this.backdropsFor(ink.element, point);
    if (backdrops === null) return null;
    if (ink.own !== null) {
      // The pseudo-element's own background lies between its glyphs and everything else.
      if (ink.own.image || ink.own.color === null) return null;
      const paint = ink.own.color;
      if (paint.a >= 1) backdrops = [paint];
      else if (paint.a > 0) backdrops = backdrops.map((backdrop) => over(paint, backdrop));
    }
    let best = 0;
    for (const backdrop of backdrops) {
      for (const paint of ink.painted)
        best = Math.max(best, contrast(over(paint, backdrop), backdrop));
      if (best >= this.limits.minContrast) return null;
    }
    const behind = backdrops[0] as RGBA;
    const detail = `${toHex(ink.fill)} on ${toHex(behind)}, contrast ${best.toFixed(2)}:1`;
    return ink.selector === undefined
      ? this.verdict('low-contrast', ink.element, detail)
      : { reason: 'low-contrast', selector: ink.selector, detail };
  }

  build(
    nodes: Iterable<Node>,
    frame: Frame,
    scope: Scope,
    parentStyle: CSSStyleDeclaration | null,
  ): RenderNode[] {
    const out: RenderNode[] = [];
    const space: Space =
      parentStyle === null
        ? 'collapse'
        : (own(SPACE_VALUES, parentStyle.getPropertyValue('white-space-collapse')) ??
          own(WHITE_SPACE, parentStyle.getPropertyValue('white-space')) ??
          'collapse');
    for (const node of nodes) {
      if (node.nodeType === COMMENT) {
        out.push({
          kind: 'text',
          text: node.nodeValue ?? '',
          space: 'collapse',
          hidden: this.verdict('comment', node.parentNode, 'HTML comment'),
        });
        continue;
      }
      if (node.nodeType === TEXT) {
        if (frame.silent) continue;
        const text = node as Text;
        const hidden = this.textVerdict(text, frame, scope);
        const origin =
          hidden === null && MAY_CONTAIN_INVISIBLE.test(text.data)
            ? this.selectorOf(text.parentNode)
            : undefined;
        out.push(
          origin === undefined
            ? { kind: 'text', text: text.data, space, hidden }
            : { kind: 'text', text: text.data, space, hidden, origin },
        );
        continue;
      }
      if (node.nodeType !== ELEMENT) continue;
      out.push(this.element(node as Element, frame, scope));
    }
    return out;
  }

  private element(element: Element, parentFrame: Frame, scope: Scope): RenderNode {
    const style = this.styleOf(element);
    if (style === null)
      return {
        kind: 'box',
        layout: 'inline',
        children: this.build(element.childNodes, parentFrame, scope, null),
      };
    const display = parseDisplay(style.getPropertyValue('display'));
    const frame = this.enter(element, style, display, parentFrame, scope);
    const boxless = frame.subtree !== null && BOXLESS[frame.subtree.reason] === true;
    const namespace = element.namespaceURI;
    const layout: Layout = boxless
      ? 'inline'
      : namespace === SVG_NAMESPACE
        ? 'inline'
        : this.layoutOf(element, style, display, scope);

    if (element.localName === 'br' && namespace !== SVG_NAMESPACE)
      return frame.subtree === null
        ? { kind: 'break' }
        : { kind: 'box', layout: 'inline', children: [] };

    const inner: Scope = {
      svgGraphics: scope.svgGraphics,
      svgText: scope.svgText,
      flexItem: display.kind === 'box' && (display.inner === 'flex' || display.inner === 'grid'),
    };
    if (namespace === SVG_NAMESPACE) {
      if (own(SVG_TEXT, element.localName) === true) inner.svgText = true;
      else if (element.localName === 'foreignObject') {
        inner.svgGraphics = null;
        inner.svgText = false;
      } else if (element.localName === 'svg' && !scope.svgText)
        inner.svgGraphics = this.verdict(
          'not-rendered',
          element,
          'SVG text outside a text element',
        );
    }

    // The first formatted line and the first letter take their own styles,
    // which can hide text the block's own styles show.
    const container = frame.subtree === null && isBlockContainer(display, scope.flexItem);
    const line = container ? this.startVerdict(element, frame, scope, 'first-line') : null;
    const inherited = line === null ? frame : { ...frame, subtree: line };

    const hideChildren = (reason: HiddenReason, detail: string): Frame =>
      inherited.subtree === null
        ? { ...inherited, subtree: this.verdict(reason, element, detail) }
        : inherited;

    const children = this.childrenOf(element, style, inherited, inner, hideChildren);
    if (!boxless && namespace === HTML_NAMESPACE && own(NO_PSEUDO, element.localName) !== true) {
      const before = this.pseudo(element, 'before', inherited, inner);
      const after = this.pseudo(element, 'after', inherited, inner);
      if (before !== null) children.unshift(before);
      if (after !== null) children.push(after);
    }
    const letter = container ? this.startVerdict(element, inherited, scope, 'first-letter') : null;
    if (letter !== null) hideFirstLetter(children, letter);
    return { kind: 'box', layout, children };
  }

  /**
   * The verdict `::first-line` or `::first-letter` styles give a block's text,
   * when they hide text the block's own styles show. As in static mode the
   * whole block is judged by them, since a short block is one line.
   *
   * Only fonts, colors and visibility apply to these boxes, and opacity to
   * `::first-letter`: a browser ignores display, position, margins, transforms
   * and clipping on them, and some engines still report them here.
   */
  private startVerdict(
    element: Element,
    frame: Frame,
    scope: Scope,
    which: 'first-line' | 'first-letter',
  ): Verdict | null {
    if (element.namespaceURI !== HTML_NAMESPACE) return null;
    if (this.inkVerdict(element, frame, scope) !== null) return null;
    const style = this.styleOf(element, which);
    if (style === null) return null;
    const selector = `${this.selectorOf(element)}::${which}`;
    const visibility = style.getPropertyValue('visibility');
    if (visibility !== 'visible' && visibility !== '')
      return { reason: 'visibility-hidden', selector, detail: `visibility: ${visibility}` };
    const size = Number.parseFloat(style.getPropertyValue('font-size')) * frame.scale;
    if (Number.isFinite(size) && size < this.limits.minFontSize)
      return { reason: 'font-size', selector, detail: `font-size: ${px(size)}` };
    const read = Number.parseFloat(style.getPropertyValue('opacity'));
    const opacity = which === 'first-letter' && Number.isFinite(read) ? read : 1;
    if (frame.opacity * opacity < this.limits.minOpacity)
      return { reason: 'opacity', selector, detail: `opacity: ${opacity}` };
    const inked: Frame = { ...frame, opacity: frame.opacity * opacity };
    // An engine reports the element's own background for a `::first-line` that
    // declares none, so only a background that differs is the pseudo's own.
    const own_ = this.styleOf(element);
    const declared =
      own_ === null ||
      style.getPropertyValue('background-color') !== own_.getPropertyValue('background-color') ||
      style.getPropertyValue('background-image') !== own_.getPropertyValue('background-image');
    const { color, ink } = this.inkOf(element, style, inked, frame, selector, declared);
    const box = element.getBoundingClientRect();
    return color ?? this.contrastVerdict(ink, centreOf(box));
  }

  /**
   * The verdict a frame gives text, read at the element's own box: everything
   * but where the text lands, which belongs to the text node.
   */
  private inkVerdict(element: Element, frame: Frame, scope: Scope): Verdict | null {
    const graphics = scope.svgText ? null : scope.svgGraphics;
    const box = element.getBoundingClientRect();
    const point: [number, number] | null =
      box.width > 0 && box.height > 0 ? [box.left + box.width / 2, box.top + box.height / 2] : null;
    return (
      frame.subtree ??
      graphics ??
      frame.visibility ??
      frame.font ??
      frame.color ??
      this.contrastVerdict(frame.ink, point)
    );
  }

  /** The flat-tree children of an element, with the parts a browser does not render. */
  private childrenOf(
    element: Element,
    style: CSSStyleDeclaration,
    frame: Frame,
    scope: Scope,
    hideChildren: (reason: HiddenReason, detail: string) => Frame,
  ): RenderNode[] {
    const name = element.localName;
    const shadow = element.shadowRoot;
    if (shadow !== null) {
      // A shadow host renders its shadow tree; light children appear only through slots.
      const children = this.build(shadow.childNodes, frame, scope, style);
      const unslotted = [...element.childNodes].filter(
        (child) => (child as Partial<Element>).assignedSlot == null,
      );
      if (unslotted.length > 0)
        children.push(
          ...this.build(
            unslotted,
            hideChildren('unslotted', 'light content no <slot> accepts'),
            scope,
            style,
          ),
        );
      return children;
    }
    if (name === 'slot' && element.getRootNode() !== element.ownerDocument) {
      const assigned = (element as HTMLSlotElement).assignedNodes();
      const children = this.build(
        assigned.length === 0 ? element.childNodes : assigned,
        frame,
        scope,
        style,
      );
      if (assigned.length > 0)
        children.push(
          ...this.build(
            element.childNodes,
            hideChildren('not-rendered', 'fallback content of a filled <slot>'),
            scope,
            style,
          ),
        );
      return children;
    }
    if (name === 'template') {
      const content = (element as HTMLTemplateElement).content;
      this.hosts.set(content, element);
      return this.build(
        content.childNodes,
        hideChildren('not-rendered', '<template> content'),
        scope,
        style,
      );
    }
    if (own(FALLBACK, name) === true && element.namespaceURI !== SVG_NAMESPACE) {
      const children = this.build(
        element.childNodes,
        hideChildren('not-rendered', `fallback content of <${name}>`),
        scope,
        style,
      );
      if (name === 'iframe' || name === 'frame')
        children.push(...this.frame(element, frame, scope));
      return children;
    }
    if (name === 'details' && !element.hasAttribute('open')) {
      const summary = [...element.children].find((child) => child.localName === 'summary');
      const collapsed = hideChildren('collapsed', 'closed <details>');
      return [...element.childNodes].flatMap((child) =>
        this.build([child], child === summary ? frame : collapsed, scope, style),
      );
    }
    if (name === 'select') {
      const select = element as HTMLSelectElement;
      if (!select.multiple && select.size <= 1) {
        const shown = select.selectedOptions[0] ?? select.options[0];
        const collapsed = hideChildren('collapsed', 'unselected option of a drop-down <select>');
        return this.buildOptions(element.childNodes, shown, frame, collapsed, scope, style);
      }
    }
    return this.build(element.childNodes, frame, scope, style);
  }

  /**
   * The document of a same-origin frame, as a box of its own. The holder is
   * judged first: a frame a reader cannot see hides everything inside it, and
   * an invisible `<iframe srcdoc>` is the classic injection carrier.
   */
  private frame(element: Element, frame: Frame, scope: Scope): RenderNode[] {
    if (frame.subtree !== null) return [];
    const holder = element as HTMLIFrameElement;
    let doc: Document | null = null;
    try {
      doc = holder.contentDocument;
    } catch {
      doc = null;
    }
    if (doc === null) {
      if (holder.contentWindow !== null)
        this.warn(
          'cross-origin-frame',
          `The frame ${this.selectorOf(element)} (${holder.getAttribute('src') ?? 'about:blank'}) is cross-origin and could not be read`,
        );
      return [];
    }
    const box = element.getBoundingClientRect();
    const hidden =
      frame.visibility ??
      (box.width <= 0 || box.height <= 0
        ? this.verdict('zero-size', element, `the frame is ${px(box.width)} by ${px(box.height)}`)
        : this.placementOf(element, [box], frame));
    this.hosts.set(doc, element);
    const inside: Frame = {
      ...frame,
      // The frame's own document has its own area, scroll and clipping.
      clips: [],
      scrollports: [],
      subtree: hidden ?? frame.subtree,
    };
    return [
      {
        kind: 'box',
        layout: 'block',
        children: this.build(doc.childNodes, inside, scope, null),
      },
    ];
  }

  private buildOptions(
    nodes: Iterable<Node>,
    shown: Element | undefined,
    frame: Frame,
    collapsed: Frame,
    scope: Scope,
    style: CSSStyleDeclaration,
  ): RenderNode[] {
    return [...nodes].flatMap((node): RenderNode[] => {
      if (node.nodeType === ELEMENT && (node as Element).localName === 'optgroup')
        return [
          {
            kind: 'box',
            layout: 'inline',
            children: this.buildOptions(node.childNodes, shown, frame, collapsed, scope, style),
          },
        ];
      return this.build([node], node === shown ? frame : collapsed, scope, style);
    });
  }

  /**
   * `::before` or `::after`, as a box holding its generated text. Icon-font
   * glyphs in the Private Use Area are pictures, not text, and are dropped.
   */
  private pseudo(
    element: Element,
    which: 'before' | 'after',
    frame: Frame,
    scope: Scope,
  ): RenderNode | null {
    const style = this.styleOf(element, which);
    if (style === null) return null;
    const generated = this.contentOf(element, style);
    const text = generated?.replace(PRIVATE_USE, '') ?? '';
    if (text === '') return null;
    const selector = `${this.selectorOf(element)}::${which}`;
    const display = parseDisplay(style.getPropertyValue('display'));
    const pseudoFrame = this.enter(element, style, display, frame, scope, selector);
    const layout =
      pseudoFrame.subtree !== null && BOXLESS[pseudoFrame.subtree.reason] === true
        ? 'inline'
        : this.layoutOfDisplay(display, style.getPropertyValue('position'), scope);
    // A pseudo-element has no box to select, so its backdrop is read at the
    // middle of the element it belongs to.
    const hidden = this.inkVerdict(element, pseudoFrame, scope);
    return {
      kind: 'box',
      layout,
      children: [
        {
          kind: 'text',
          text,
          space:
            own(SPACE_VALUES, style.getPropertyValue('white-space-collapse')) ??
            own(WHITE_SPACE, style.getPropertyValue('white-space')) ??
            'collapse',
          hidden,
          origin: selector,
          generated: selector,
        },
      ],
    };
  }

  /**
   * The text a computed `content` value puts on screen. Engines leave `attr()`
   * and the quote keywords in the computed value, so both are resolved here;
   * counters and images are reported in `warnings` rather than rendered, as in
   * static mode.
   */
  private contentOf(element: Element, style: CSSStyleDeclaration): string | null {
    const text = style.getPropertyValue('content').trim();
    if (text === '' || text === 'none' || text === 'normal') return null;
    const parts: string[] = [];
    let index = 0;
    const unsupported = (what: string): void =>
      this.warn(
        'unsupported-content',
        `${what} in ::before or ::after content of <${element.localName}> was not rendered`,
      );
    while (index < text.length) {
      const character = text[index] as string;
      if (character === ' ') {
        index += 1;
        continue;
      }
      // Only what precedes `/` renders: the rest is alternative text.
      if (character === '/') break;
      if (character === '"' || character === "'") {
        let out = '';
        index += 1;
        while (index < text.length && text[index] !== character) {
          if (text[index] === '\\') {
            const hex = /^\\([\da-fA-F]{1,6})[ ]?/.exec(text.slice(index));
            if (hex === null) {
              out += text[index + 1] ?? '';
              index += 2;
            } else {
              out += String.fromCodePoint(Number.parseInt(hex[1] as string, 16));
              index += hex[0].length;
            }
            continue;
          }
          out += text[index];
          index += 1;
        }
        index += 1;
        parts.push(out);
        continue;
      }
      const word = /^[\w-]+/.exec(text.slice(index));
      if (word === null) return null;
      const name = word[0].toLowerCase();
      index += word[0].length;
      if (text[index] !== '(') {
        if (name === 'open-quote' || name === 'close-quote')
          parts.push(quotePair(style.getPropertyValue('quotes'))[name === 'open-quote' ? 0 : 1]);
        else if (name !== 'no-open-quote' && name !== 'no-close-quote') return null;
        continue;
      }
      let depth = 0;
      const start = index;
      while (index < text.length) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')' && --depth === 0) break;
        index += 1;
      }
      const args = text.slice(start + 1, index);
      index += 1;
      if (name === 'attr') {
        const [attribute, ...rest] = splitTop(args);
        const key = (attribute ?? '').split(/\s+/)[0] ?? '';
        const fallback = rest
          .join(',')
          .trim()
          .replace(/^["'](.*)["']$/, '$1');
        parts.push(element.getAttribute(key) ?? fallback);
        continue;
      }
      if (name.startsWith('counter') || name.startsWith('target-counter')) unsupported('A counter');
      else if (name === 'url' || name.includes('image') || name.endsWith('gradient'))
        unsupported('An image');
      else unsupported(`${name}()`);
    }
    return parts.join('');
  }
}

/** Extracts the visible text of the page this script runs in. */
export function run(limits: PageLimits): ExtractResult {
  return new Extractor(limits, document).extract();
}
