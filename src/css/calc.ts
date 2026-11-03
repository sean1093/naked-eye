/**
 * Numeric CSS values: numbers, dimensions, percentages and every math
 * function a browser evaluates (`calc()`, `min()`, `clamp()`, `round()`,
 * trigonometry, `sibling-index()`, ...). An attacker can spell `0` as
 * `calc(sin(0deg) * 16px)`, so the evaluator follows CSS Values 4 rather than
 * recognising a few literal forms.
 */
import {
  type ComponentValue,
  type FunctionNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
} from '@csstools/css-parser-algorithms';
import { TokenType } from '@csstools/css-tokenizer';
import type { Element } from 'domhandler';
import { own } from '../util.js';
import { identOf, significant, splitCommas, tokenOf } from './syntax.js';

export type Expr =
  | { op: 'value'; value: number; unit: string }
  | { op: '+' | '-' | '*' | '/'; a: Expr; b: Expr }
  | { op: 'fn'; name: string; args: (Expr | null)[]; strategy?: string }
  | { op: 'sibling'; which: 'index' | 'count' };

export type Kind = 'number' | 'length' | 'angle' | 'time' | 'resolution';

/** Whether an expression mentions a percentage anywhere. */
export function hasPercentage(expr: Expr): boolean {
  if (expr.op === 'value') return expr.unit === '%';
  if (expr.op === 'fn') return expr.args.some((arg) => arg !== null && hasPercentage(arg));
  if (expr.op === 'sibling') return false;
  return hasPercentage(expr.a) || hasPercentage(expr.b);
}

/** A typed result. A length is `px + pct%`; `unknown` marks a value that needs layout. */
export interface Typed {
  kind: Kind;
  value: number;
  pct: number;
  unknown: boolean;
}

export interface Context {
  /** px per `em`: the element's font size, or its parent's when resolving `font-size`. */
  em: number;
  /** px per `rem`: the root element's font size. */
  rem: number;
  viewportWidth: number;
  viewportHeight: number;
  /** What a percentage means here: part of a length, or a plain number (`opacity: 50%`). */
  percent: 'length' | 'number';
  /** The size a length percentage is taken of, when known. */
  basis?: number;
  element?: Element;
}

const ABSOLUTE: Record<string, number> = {
  px: 1,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  in: 96,
  pt: 4 / 3,
  pc: 16,
};

/** Font-relative units as multiples of `em` (or `rem` for the root-relative form). */
const FONT_RELATIVE: Record<string, [number, 'em' | 'rem']> = {
  em: [1, 'em'],
  rem: [1, 'rem'],
  ex: [0.5, 'em'],
  rex: [0.5, 'rem'],
  ch: [0.5, 'em'],
  rch: [0.5, 'rem'],
  cap: [0.7, 'em'],
  rcap: [0.7, 'rem'],
  ic: [1, 'em'],
  ric: [1, 'rem'],
  lh: [1.2, 'em'],
  rlh: [1.2, 'rem'],
};

const ANGLE: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const TIME: Record<string, number> = { s: 1000, ms: 1 };
const RESOLUTION: Record<string, number> = { dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 };

const CONSTANTS: Record<string, number> = {
  e: Math.E,
  pi: Math.PI,
  infinity: Number.POSITIVE_INFINITY,
  '-infinity': Number.NEGATIVE_INFINITY,
  nan: Number.NaN,
};

const MATH_FUNCTIONS: Record<string, true> = {
  calc: true,
  '-webkit-calc': true,
  '-moz-calc': true,
  min: true,
  max: true,
  clamp: true,
  round: true,
  mod: true,
  rem: true,
  sin: true,
  cos: true,
  tan: true,
  asin: true,
  acos: true,
  atan: true,
  atan2: true,
  pow: true,
  sqrt: true,
  hypot: true,
  log: true,
  exp: true,
  abs: true,
  sign: true,
};

const ROUNDING: Record<string, true> = { nearest: true, up: true, down: true, 'to-zero': true };

/** Viewport-relative units: `[axis, kind]`, where kind is the min or max of the two axes. */
function viewportUnit(unit: string): 'w' | 'h' | 'min' | 'max' | null {
  const base =
    /^[sld]?(v[whib]|vmin|vmax)$/.exec(unit)?.[1] ?? /^cq([whib]|min|max)$/.exec(unit)?.[1];
  if (base === undefined) return null;
  const axis = base.replace(/^v/, '');
  if (axis === 'w' || axis === 'i') return 'w';
  if (axis === 'h' || axis === 'b') return 'h';
  return axis === 'min' ? 'min' : 'max';
}

export function isMathFunction(node: ComponentValue): node is FunctionNode {
  return isFunctionNode(node) && MATH_FUNCTIONS[node.getName().toLowerCase()] === true;
}

/** Parses one component value into a numeric expression, or `null` when it is not one. */
export function parseNumeric(node: ComponentValue): Expr | null {
  const token = tokenOf(node);
  if (token !== undefined) {
    if (token[0] === TokenType.Number) return { op: 'value', value: token[4].value, unit: '' };
    if (token[0] === TokenType.Percentage) return { op: 'value', value: token[4].value, unit: '%' };
    if (token[0] === TokenType.Dimension) {
      return { op: 'value', value: token[4].value, unit: token[4].unit.toLowerCase() };
    }
    return null;
  }
  if (isFunctionNode(node)) {
    const name = node.getName().toLowerCase();
    if (name === 'sibling-index' || name === 'sibling-count') {
      return significant(node.value).length === 0
        ? { op: 'sibling', which: name === 'sibling-index' ? 'index' : 'count' }
        : null;
    }
    if (MATH_FUNCTIONS[name] === true) return parseMathFunction(name, node.value);
  }
  return null;
}

function parseMathFunction(name: string, inner: ComponentValue[]): Expr | null {
  if (name === 'calc' || name === '-webkit-calc' || name === '-moz-calc')
    return parseSum(significant(inner));
  const parts = splitCommas(inner).map(significant);
  let strategy: string | undefined;
  if (name === 'round' && parts.length > 0) {
    const first = parts[0] as ComponentValue[];
    const keyword = identOf(first[0]);
    if (first.length === 1 && keyword !== undefined && ROUNDING[keyword] === true) {
      strategy = keyword;
      parts.shift();
    }
  }
  const args: (Expr | null)[] = [];
  for (const part of parts) {
    if (name === 'clamp' && part.length === 1 && identOf(part[0]) === 'none') {
      args.push(null);
      continue;
    }
    const expr = parseSum(part);
    if (expr === null) return null;
    args.push(expr);
  }
  if (args.length === 0 || (args.includes(null) && name !== 'clamp')) return null;
  return strategy === undefined ? { op: 'fn', name, args } : { op: 'fn', name, args, strategy };
}

function delimOf(node: ComponentValue | undefined): string | undefined {
  const token = tokenOf(node);
  return token?.[0] === TokenType.Delim ? token[4].value : undefined;
}

/** `<calc-sum>` over significant tokens; `+` and `-` arrive as delimiters. */
function parseSum(nodes: ComponentValue[]): Expr | null {
  let index = 0;
  const product = (): Expr | null => {
    let left = parseUnit(nodes[index]);
    if (left === null) return null;
    index += 1;
    while (index < nodes.length) {
      const op = delimOf(nodes[index]);
      if (op !== '*' && op !== '/') break;
      const right = parseUnit(nodes[index + 1]);
      if (right === null) return null;
      left = { op, a: left, b: right };
      index += 2;
    }
    return left;
  };
  let left = product();
  if (left === null) return null;
  while (index < nodes.length) {
    const op = delimOf(nodes[index]);
    if (op !== '+' && op !== '-') return null;
    index += 1;
    const right = product();
    if (right === null) return null;
    left = { op, a: left, b: right };
  }
  return left;
}

function parseUnit(node: ComponentValue | undefined): Expr | null {
  if (node === undefined) return null;
  const constant = own(CONSTANTS, identOf(node) ?? '');
  if (constant !== undefined) return { op: 'value', value: constant, unit: '' };
  if (isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenParen) {
    return parseSum(significant(node.value));
  }
  if (isTokenNode(node) || isFunctionNode(node)) return parseNumeric(node);
  return null;
}

function typed(kind: Kind, value: number, pct = 0, unknown = false): Typed {
  return { kind, value, pct, unknown };
}

function leaf(expr: { value: number; unit: string }, ctx: Context): Typed | null {
  const { value, unit } = expr;
  if (unit === '') return typed('number', value);
  if (unit === '%') {
    if (ctx.percent === 'number') return typed('number', value / 100);
    if (ctx.basis !== undefined) return typed('length', (value / 100) * ctx.basis);
    return typed('length', 0, value);
  }
  const absolute = own(ABSOLUTE, unit);
  if (absolute !== undefined) return typed('length', value * absolute);
  const font = own(FONT_RELATIVE, unit);
  if (font !== undefined)
    return typed('length', value * font[0] * (font[1] === 'em' ? ctx.em : ctx.rem));
  const viewport = viewportUnit(unit);
  if (viewport !== null) {
    const w = ctx.viewportWidth / 100;
    const h = ctx.viewportHeight / 100;
    const size =
      viewport === 'w'
        ? w
        : viewport === 'h'
          ? h
          : viewport === 'min'
            ? Math.min(w, h)
            : Math.max(w, h);
    return typed('length', value * size);
  }
  const angle = own(ANGLE, unit);
  if (angle !== undefined) return typed('angle', value * angle);
  const time = own(TIME, unit);
  if (time !== undefined) return typed('time', value * time);
  const resolution = own(RESOLUTION, unit);
  return resolution === undefined ? null : typed('resolution', value * resolution);
}

function siblingPosition(element: Element | undefined, which: 'index' | 'count'): number | null {
  const parent = element?.parent;
  if (element === undefined || parent === null || parent === undefined) return null;
  const siblings = parent.children.filter((child) => child.type === 'tag');
  return which === 'count' ? siblings.length : siblings.indexOf(element) + 1;
}

function sameKind(values: Typed[]): boolean {
  return values.every((value) => value.kind === (values[0] as Typed).kind);
}

function roundTo(strategy: string, a: number, b: number): number {
  if (b === 0) return Number.NaN;
  const lower = Math.floor(a / b) * b;
  const upper = Math.ceil(a / b) * b;
  if (strategy === 'up') return upper;
  if (strategy === 'down') return lower;
  if (strategy === 'to-zero') return Math.abs(lower) < Math.abs(upper) ? lower : upper;
  return a - lower < upper - a ? lower : upper;
}

function evaluateFunction(expr: Extract<Expr, { op: 'fn' }>, ctx: Context): Typed | null {
  const { name } = expr;
  const args: (Typed | null)[] = [];
  for (const arg of expr.args) {
    if (arg === null) {
      args.push(null);
      continue;
    }
    const value = evaluate(arg, ctx);
    if (value === null) return null;
    args.push(value);
  }
  const present = args.filter((arg): arg is Typed => arg !== null);
  if (!sameKind(present)) return null;
  const first = present[0] as Typed;
  const unknown = present.some((arg) => arg.unknown || arg.pct !== 0);
  const result = (value: number, kind: Kind = first.kind): Typed => typed(kind, value, 0, unknown);
  const numbers = present.map((arg) => arg.value);

  switch (name) {
    case 'min':
      return result(Math.min(...numbers));
    case 'max':
      return result(Math.max(...numbers));
    case 'clamp': {
      if (args.length !== 3) return null;
      const [low, center, high] = args;
      if (center === null || center === undefined) return null;
      let value = center.value;
      if (high !== null && high !== undefined) value = Math.min(value, high.value);
      if (low !== null && low !== undefined) value = Math.max(value, low.value);
      return result(value);
    }
    case 'abs':
      return args.length === 1 ? result(Math.abs(first.value)) : null;
    case 'sign':
      return args.length === 1 ? result(Math.sign(first.value), 'number') : null;
    case 'round': {
      if (args.length > 2) return null;
      return result(
        roundTo(expr.strategy ?? 'nearest', first.value, (present[1]?.value ?? 1) as number),
      );
    }
    case 'mod':
    case 'rem': {
      if (present.length !== 2) return null;
      const [a, b] = numbers as [number, number];
      const remainder = a % b;
      return result(
        name === 'rem' || remainder === 0 || Math.sign(a) === Math.sign(b)
          ? remainder
          : remainder + b,
      );
    }
    case 'hypot':
      return result(Math.hypot(...numbers));
    default:
      break;
  }

  // The remaining functions take numbers (or, for the trigonometric ones, angles).
  if (name === 'sin' || name === 'cos' || name === 'tan') {
    if (present.length !== 1 || (first.kind !== 'number' && first.kind !== 'angle')) return null;
    const radians = first.kind === 'angle' ? (first.value * Math.PI) / 180 : first.value;
    return result(Math[name](radians), 'number');
  }
  if (first.kind !== 'number') return null;
  switch (name) {
    case 'asin':
    case 'acos':
    case 'atan':
      return present.length === 1
        ? result((Math[name](first.value) * 180) / Math.PI, 'angle')
        : null;
    case 'atan2':
      return present.length === 2
        ? result((Math.atan2(first.value, numbers[1] as number) * 180) / Math.PI, 'angle')
        : null;
    case 'pow':
      return present.length === 2 ? result(first.value ** (numbers[1] as number)) : null;
    case 'sqrt':
      return present.length === 1 ? result(Math.sqrt(first.value)) : null;
    case 'exp':
      return present.length === 1 ? result(Math.exp(first.value)) : null;
    case 'log':
      if (present.length === 1) return result(Math.log(first.value));
      return present.length === 2
        ? result(Math.log(first.value) / Math.log(numbers[1] as number))
        : null;
    default:
      return null;
  }
}

/**
 * Evaluates an expression. `null` means a type error (the declaration is
 * invalid); a result with `unknown` set means the value depends on layout.
 */
export function evaluate(expr: Expr, ctx: Context): Typed | null {
  switch (expr.op) {
    case 'value':
      return leaf(expr, ctx);
    case 'sibling': {
      const position = siblingPosition(ctx.element, expr.which);
      return position === null ? typed('number', 1, 0, true) : typed('number', position);
    }
    case 'fn':
      return evaluateFunction(expr, ctx);
    default: {
      const a = evaluate(expr.a, ctx);
      const b = evaluate(expr.b, ctx);
      if (a === null || b === null) return null;
      const unknown = a.unknown || b.unknown;
      if (expr.op === '+' || expr.op === '-') {
        if (a.kind !== b.kind) return null;
        const sign = expr.op === '+' ? 1 : -1;
        return typed(a.kind, a.value + sign * b.value, a.pct + sign * b.pct, unknown);
      }
      // A zero percentage part stays zero: NaN or infinity times nothing is nothing.
      const scaled = (pct: number, factor: number): number => (pct === 0 ? 0 : pct * factor);
      if (expr.op === '*') {
        if (a.kind === 'number')
          return typed(b.kind, a.value * b.value, scaled(b.pct, a.value), unknown);
        if (b.kind === 'number')
          return typed(a.kind, a.value * b.value, scaled(a.pct, b.value), unknown);
        return null;
      }
      if (b.kind !== 'number') return null;
      return typed(a.kind, a.value / b.value, scaled(a.pct, 1 / b.value), unknown);
    }
  }
}

/** Top-level censoring: NaN becomes 0 and infinities clamp, as CSS Values 4 requires. */
function censor(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value));
}

export type Resolved = number | 'unknown';

/**
 * Resolves an expression as a length in px. `null` when it is not a length
 * (a unitless number is accepted when it is zero, or when `quirky` applies).
 */
export function resolveLength(expr: Expr, ctx: Context, quirky = false): Resolved | null {
  if (expr.op === 'value' && expr.unit === '') {
    return expr.value === 0 || quirky ? expr.value : null;
  }
  const value = evaluate(expr, { ...ctx, percent: 'length' });
  if (value === null || value.kind !== 'length') return null;
  if (value.unknown || value.pct !== 0) return 'unknown';
  return censor(value.value);
}

/** Resolves a `<number>` or, where allowed, a percentage of 1. */
export function resolveNumber(expr: Expr, ctx: Context): Resolved | null {
  const value = evaluate(expr, { ...ctx, percent: 'number' });
  if (value === null || value.kind !== 'number') return null;
  return value.unknown ? 'unknown' : censor(value.value);
}

export function resolveAngle(expr: Expr, ctx: Context): Resolved | null {
  if (expr.op === 'value' && expr.unit === '' && expr.value === 0) return 0;
  const value = evaluate(expr, ctx);
  if (value === null || value.kind !== 'angle') return null;
  return value.unknown ? 'unknown' : censor(value.value);
}

export function resolveTime(expr: Expr, ctx: Context): Resolved | null {
  const value = evaluate(expr, ctx);
  if (value === null || value.kind !== 'time') return null;
  return value.unknown ? 'unknown' : censor(value.value);
}

export function resolveResolution(expr: Expr, ctx: Context): Resolved | null {
  const value = evaluate(expr, ctx);
  if (value === null || value.kind !== 'resolution') return null;
  return value.unknown ? 'unknown' : censor(value.value);
}
