/**
 * Geometry decisions static mode can make without layout: transforms reduced
 * to a 2D affine matrix, clip rectangles, clip-path shapes, and which boxes
 * clip their overflow.
 */
import type { ComponentValue } from '@csstools/css-parser-algorithms';
import { type Context, evaluate, parseNumeric } from './css/calc.js';
import type { ResolvedTransform, Style } from './css/cascade.js';
import { identOf, significant, splitCommas } from './css/syntax.js';

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** An unknown argument (a percentage of the box) contributes nothing. */
function known(value: number | 'unknown' | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

function matrixOf({ name, args }: ResolvedTransform): Affine {
  const [x, y] = args;
  switch (name) {
    case 'translate':
    case 'translate3d':
      return { ...IDENTITY, e: known(x, 0), f: known(y, 0) };
    case 'translatex':
      return { ...IDENTITY, e: known(x, 0) };
    case 'translatey':
      return { ...IDENTITY, f: known(x, 0) };
    case 'scale':
    case 'scale3d': {
      const sx = known(x, 1);
      return { ...IDENTITY, a: sx, d: known(y, sx) };
    }
    case 'scalex':
      return { ...IDENTITY, a: known(x, 1) };
    case 'scaley':
      return { ...IDENTITY, d: known(x, 1) };
    case 'rotate':
    case 'rotatez': {
      const angle = radians(known(x, 0));
      return {
        ...IDENTITY,
        a: Math.cos(angle),
        b: Math.sin(angle),
        c: -Math.sin(angle),
        d: Math.cos(angle),
      };
    }
    // Without perspective, rotating about the x or y axis squashes the other axis.
    case 'rotatex':
      return { ...IDENTITY, d: Math.cos(radians(known(x, 0))) };
    case 'rotatey':
      return { ...IDENTITY, a: Math.cos(radians(known(x, 0))) };
    case 'skew':
      return { ...IDENTITY, b: Math.tan(radians(known(y, 0))), c: Math.tan(radians(known(x, 0))) };
    case 'skewx':
      return { ...IDENTITY, c: Math.tan(radians(known(x, 0))) };
    case 'skewy':
      return { ...IDENTITY, b: Math.tan(radians(known(x, 0))) };
    case 'matrix':
      return args.length === 6
        ? {
            a: known(args[0], 1),
            b: known(args[1], 0),
            c: known(args[2], 0),
            d: known(args[3], 1),
            e: known(args[4], 0),
            f: known(args[5], 0),
          }
        : IDENTITY;
    case 'matrix3d':
      return args.length === 16
        ? {
            a: known(args[0], 1),
            b: known(args[1], 0),
            c: known(args[4], 0),
            d: known(args[5], 1),
            e: known(args[12], 0),
            f: known(args[13], 0),
          }
        : IDENTITY;
    default:
      return IDENTITY;
  }
}

/** The element's own transform, functions applied left to right. */
export function transformOf(style: Style): Affine {
  return style.transform.reduce((matrix, fn) => multiply(matrix, matrixOf(fn)), IDENTITY);
}

/**
 * How much a transform shrinks text: the smaller of the two axis scale
 * factors, or 0 when the matrix collapses the plane to a line.
 */
export function scaleOf(matrix: Affine): number {
  if (Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-9) return 0;
  return Math.min(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
}

/** Boxes whose width and height apply: anything but an inline, non-replaced box. */
export function isSized(style: Style, blockified: boolean): boolean {
  const { display } = style;
  if (display.kind === 'internal') return true;
  if (display.kind !== 'box') return false;
  return blockified || display.outer !== 'inline' || display.inner !== 'flow';
}

const clips = (overflow: Style['overflowX']): boolean => overflow !== 'visible';

/**
 * A box no more than one pixel wide or tall that does not let its content
 * overflow. Size containment without an intrinsic size collapses the block
 * size, and paint containment clips like `overflow: clip`.
 */
export function zeroSizeDetail(style: Style, blockified: boolean): string | null {
  if (!isSized(style, blockified)) return null;
  const tiny = (value: Style['width']): boolean => typeof value === 'number' && value <= 1;
  const clipsX = clips(style.overflowX) || style.contain.paint;
  const clipsY = clips(style.overflowY) || style.contain.paint;
  const overflow = (axis: Style['overflowX']): string =>
    clips(axis) ? `overflow: ${axis}` : 'contain: paint';
  if (clipsX && (tiny(style.width) || tiny(style.maxWidth))) {
    const value = tiny(style.width) ? `width: ${style.width}px` : `max-width: ${style.maxWidth}px`;
    return `${value}; ${overflow(style.overflowX)}`;
  }
  if (clipsY && (tiny(style.height) || tiny(style.maxHeight))) {
    const value = tiny(style.height)
      ? `height: ${style.height}px`
      : `max-height: ${style.maxHeight}px`;
    return `${value}; ${overflow(style.overflowY)}`;
  }
  if (clipsY && style.contain.size && style.height === 'auto' && !style.intrinsicHeight) {
    return `contain: size; ${overflow(style.overflowY)}`;
  }
  return null;
}

/** `clip: rect()` that leaves no area. It only applies to absolutely positioned boxes. */
export function clipDetail(style: Style): string | null {
  if (style.clip === 'auto' || (style.position !== 'absolute' && style.position !== 'fixed'))
    return null;
  const [top, right, bottom, left] = style.clip;
  const edge = (value: unknown, auto: number | null): number | null =>
    typeof value === 'number' ? value : value === 'auto' ? auto : null;
  const t = edge(top, 0);
  const l = edge(left, 0);
  const b = edge(bottom, null);
  const r = edge(right, null);
  const empty = (t !== null && b !== null && b <= t) || (l !== null && r !== null && r <= l);
  if (!empty) return null;
  const show = (value: unknown): string =>
    typeof value === 'number' ? `${value}px` : String(value);
  return `clip: rect(${[top, right, bottom, left].map(show).join(', ')})`;
}

type Part = { px: number; pct: number };

/** A length-percentage as `px + pct%`, or `null` when it cannot be read. */
function parts(node: ComponentValue | undefined, ctx: Context): Part | null {
  if (node === undefined) return null;
  const expr = parseNumeric(node);
  if (expr === null) return null;
  if (expr.op === 'value' && expr.unit === '') return expr.value === 0 ? { px: 0, pct: 0 } : null;
  const value = evaluate(expr, { ...ctx, percent: 'length' });
  if (value === null || value.kind !== 'length' || value.unknown) return null;
  return { px: value.value, pct: value.pct };
}

const isZero = (value: Part | null): boolean => value !== null && value.px <= 0 && value.pct <= 0;

/** Whether a span from `start` to `end` is empty, when both are in the same unit. */
function collapses(start: Part | null, end: Part | null): boolean {
  if (start === null || end === null) return false;
  if (start.pct === 0 && end.pct === 0) return end.px <= start.px;
  if (start.px === 0 && end.px === 0) return end.pct <= start.pct;
  return false;
}

/**
 * The area of a `polygon()` when every coordinate is in the same unit (all px
 * or all percentages), or `null` when that is not knowable without layout.
 */
function polygonArea(args: ComponentValue[], ctx: Context): number | null {
  const points: [Part, Part][] = [];
  for (const point of splitCommas(args).map(significant)) {
    if (point.length === 1 && identOf(point[0]) !== undefined) continue;
    const x = parts(point[0], ctx);
    const y = parts(point[1], ctx);
    if (point.length !== 2 || x === null || y === null) return null;
    points.push([x, y]);
  }
  const allPx = points.every(([x, y]) => x.pct === 0 && y.pct === 0);
  const allPct = points.every(([x, y]) => x.px === 0 && y.px === 0);
  if (points.length === 0 || (!allPx && !allPct)) return null;
  const coordinate = (value: Part): number => (allPx ? value.px : value.pct);
  let area = 0;
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length] as [Part, Part];
    area += coordinate(x) * coordinate(nextY) - coordinate(nextX) * coordinate(y);
  });
  return Math.abs(area) < 1e-9 ? 0 : Math.abs(area) / 2;
}

/**
 * A clip-path basic shape that leaves no area: `inset()` of at least 100% on
 * an axis, a zero radius, a degenerate polygon, an empty `rect()` or `xywh()`.
 * Shapes whose emptiness depends on the box size are not decided.
 */
export function clipPathDetail(style: Style, ctx: Context): string | null {
  const path = style.clipPath;
  if (typeof path === 'string') return null;
  const { shape } = path;
  const before = (word: string) => {
    const nodes = significant(path.args);
    const index = nodes.findIndex((node) => identOf(node) === word);
    return index === -1 ? nodes : nodes.slice(0, index);
  };
  let empty = false;
  if (shape === 'inset') {
    const values = before('round').map((node) => parts(node, ctx));
    const [top = null, right = top, bottom = top, left = right] = values;
    const covers = (a: typeof top, b: typeof top): boolean =>
      a !== null && b !== null && a.pct + b.pct >= 100 && a.px + b.px >= 0;
    empty = covers(top, bottom) || covers(left, right);
  } else if (shape === 'circle') {
    empty = isZero(parts(before('at')[0], ctx));
  } else if (shape === 'ellipse') {
    const [rx, ry] = before('at').map((node) => parts(node, ctx));
    empty = isZero(rx ?? null) || isZero(ry ?? null);
  } else if (shape === 'rect') {
    // `auto` is the box edge: 0 for the top and left, 100% for the bottom and right.
    const edges = before('round').map((node, index) =>
      identOf(node) === 'auto'
        ? { px: 0, pct: index === 1 || index === 2 ? 100 : 0 }
        : parts(node, ctx),
    );
    const [top = null, right = null, bottom = null, left = null] = edges;
    empty = collapses(top, bottom) || collapses(left, right);
  } else if (shape === 'xywh') {
    const [, , width, height] = before('round').map((node) => parts(node, ctx));
    empty = isZero(width ?? null) || isZero(height ?? null);
  } else if (shape === 'polygon') {
    empty = polygonArea(path.args, ctx) === 0;
  }
  return empty
    ? `clip-path: ${shape}(${path.args
        .map((node) => node.toString())
        .join('')
        .trim()})`
    : null;
}
