/**
 * Conditional rules: `@media`, `@supports` and the conditions of `if()`.
 *
 * Results are three-valued. A condition the engine cannot decide (an unknown
 * media feature, a property it does not model) is `unknown` rather than a
 * guess, and the extractor evaluates the rules under it both ways.
 */
import {
  type ComponentValue,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
} from '@csstools/css-parser-algorithms';
import { TokenType } from '@csstools/css-tokenizer';
import { own } from '../util.js';
import {
  type Context,
  parseNumeric,
  resolveLength,
  resolveNumber,
  resolveResolution,
} from './calc.js';
import { identOf, paren, significant, splitCommas, stringOf, tokenOf } from './syntax.js';

export type Truth = boolean | 'unknown';

export interface Environment {
  /** Viewport size in CSS px. */
  width: number;
  height: number;
  colorScheme: 'light' | 'dark';
}

export function not(value: Truth): Truth {
  return value === 'unknown' ? value : !value;
}

function and(a: Truth, b: Truth): Truth {
  if (a === false || b === false) return false;
  return a === 'unknown' || b === 'unknown' ? 'unknown' : true;
}

function or(a: Truth, b: Truth): Truth {
  if (a === true || b === true) return true;
  return a === 'unknown' || b === 'unknown' ? 'unknown' : false;
}

function isParenBlock(node: ComponentValue | undefined): boolean {
  return (
    node !== undefined && isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenParen
  );
}

/**
 * A boolean expression of `not`, `and` and `or` over terms in parentheses or
 * functions. `leaf` decides a term that is not itself a nested expression.
 * `null` means a syntax error.
 */
export function evaluateCondition(
  nodes: readonly ComponentValue[],
  leaf: (node: ComponentValue) => Truth,
): Truth | null {
  const list = significant(nodes);
  const term = (node: ComponentValue | undefined): Truth | null => {
    if (node === undefined) return null;
    if (isSimpleBlockNode(node) && isParenBlock(node)) {
      const inner = significant(node.value);
      const head = inner[0];
      if (
        head !== undefined &&
        (isParenBlock(head) || isFunctionNode(head) || identOf(head) === 'not')
      ) {
        const nested = evaluateCondition(inner, leaf);
        if (nested !== null) return nested;
      }
      return leaf(node);
    }
    return isFunctionNode(node) ? leaf(node) : null;
  };

  if (identOf(list[0]) === 'not') {
    if (list.length !== 2) return null;
    const value = term(list[1]);
    return value === null ? null : not(value);
  }
  let result = term(list[0]);
  if (result === null) return null;
  let joiner: string | undefined;
  for (let index = 1; index < list.length; index += 2) {
    const keyword = identOf(list[index]);
    if ((keyword !== 'and' && keyword !== 'or') || (joiner !== undefined && joiner !== keyword))
      return null;
    joiner = keyword;
    const value = term(list[index + 1]);
    if (value === null) return null;
    result = keyword === 'and' ? and(result, value) : or(result, value);
  }
  return result;
}

const MEDIA_TYPES: Record<string, boolean> = {
  all: true,
  screen: true,
  print: false,
  speech: false,
  tty: false,
  tv: false,
  projection: false,
  handheld: false,
  braille: false,
  embossed: false,
  aural: false,
};

/** Discrete features of a desktop browser with default preferences. */
function discreteFeatures(env: Environment): Record<string, string> {
  return {
    orientation: env.height >= env.width ? 'portrait' : 'landscape',
    'prefers-color-scheme': env.colorScheme,
    'prefers-reduced-motion': 'no-preference',
    'prefers-reduced-transparency': 'no-preference',
    'prefers-reduced-data': 'no-preference',
    'prefers-contrast': 'no-preference',
    'forced-colors': 'none',
    'inverted-colors': 'none',
    hover: 'hover',
    'any-hover': 'hover',
    pointer: 'fine',
    'any-pointer': 'fine',
    'color-gamut': 'srgb',
    'dynamic-range': 'standard',
    'video-dynamic-range': 'standard',
    scripting: 'enabled',
    update: 'fast',
    'overflow-block': 'scroll',
    'overflow-inline': 'scroll',
    'display-mode': 'browser',
    'device-posture': 'continuous',
  };
}

/** False in a boolean context: `(prefers-reduced-motion)` is false at `no-preference`. */
const FALSY_KEYWORDS: Record<string, true> = { none: true, 'no-preference': true };

type Range = { kind: 'length' | 'number' | 'resolution' | 'ratio'; value: number };

function rangeFeatures(env: Environment): Record<string, Range> {
  return {
    width: { kind: 'length', value: env.width },
    height: { kind: 'length', value: env.height },
    'device-width': { kind: 'length', value: env.width },
    'device-height': { kind: 'length', value: env.height },
    'aspect-ratio': { kind: 'ratio', value: env.width / env.height },
    'device-aspect-ratio': { kind: 'ratio', value: env.width / env.height },
    resolution: { kind: 'resolution', value: 1 },
    '-webkit-device-pixel-ratio': { kind: 'number', value: 1 },
    'device-pixel-ratio': { kind: 'number', value: 1 },
    color: { kind: 'number', value: 8 },
    'color-index': { kind: 'number', value: 0 },
    monochrome: { kind: 'number', value: 0 },
    grid: { kind: 'number', value: 0 },
  };
}

/** Parses the value side of a range comparison. */
function rangeValue(nodes: ComponentValue[], kind: Range['kind'], ctx: Context): number | null {
  if (kind === 'ratio' || kind === 'number') {
    const parts = nodes.filter((node) => !(isTokenNode(node) && stringOf(node) === '/'));
    const numbers = parts.map((node) => {
      const expr = parseNumeric(node);
      const value = expr === null ? null : resolveNumber(expr, ctx);
      return typeof value === 'number' ? value : null;
    });
    if (numbers.includes(null) || numbers.length === 0 || numbers.length > 2) return null;
    if (kind === 'number' && numbers.length !== 1) return null;
    return numbers.length === 2
      ? (numbers[0] as number) / (numbers[1] as number)
      : (numbers[0] as number);
  }
  if (nodes.length !== 1) return null;
  const expr = parseNumeric(nodes[0] as ComponentValue);
  if (expr === null) return null;
  if (kind === 'resolution') {
    if (identOf(nodes[0]) === 'infinite') return Number.POSITIVE_INFINITY;
    const value = resolveResolution(expr, ctx);
    return typeof value === 'number' ? value : null;
  }
  const value = resolveLength(expr, ctx);
  return typeof value === 'number' ? value : null;
}

function compare(actual: number, op: string, target: number, flipped: boolean): boolean {
  const [left, right] = flipped ? [target, actual] : [actual, target];
  switch (op) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      return Math.abs(left - right) < 1e-9;
  }
}

/** Splits the inside of a range feature on its comparison operators. */
function splitRange(nodes: ComponentValue[]): (ComponentValue[] | string)[] {
  const parts: (ComponentValue[] | string)[] = [[]];
  for (let index = 0; index < nodes.length; index += 1) {
    const token = tokenOf(nodes[index]);
    const delim = token?.[0] === TokenType.Delim ? (token[4].value as string) : undefined;
    if (delim === '<' || delim === '>' || delim === '=') {
      const next = tokenOf(nodes[index + 1]);
      const equals = delim !== '=' && next?.[0] === TokenType.Delim && next[4].value === '=';
      parts.push(equals ? `${delim}=` : delim, []);
      if (equals) index += 1;
      continue;
    }
    (parts[parts.length - 1] as ComponentValue[]).push(nodes[index] as ComponentValue);
  }
  return parts;
}

function mediaFeature(block: ComponentValue, env: Environment): Truth {
  if (!isSimpleBlockNode(block)) return 'unknown';
  const nodes = significant(block.value);
  const ctx: Context = {
    em: 16,
    rem: 16,
    viewportWidth: env.width,
    viewportHeight: env.height,
    percent: 'length',
  };
  const discrete = discreteFeatures(env);
  const ranges = rangeFeatures(env);

  const name = identOf(nodes[0]);
  if (name !== undefined && nodes.length === 1) {
    const value = own(discrete, name);
    if (value !== undefined) return own(FALSY_KEYWORDS, value) !== true;
    const range = own(ranges, name);
    return range === undefined ? 'unknown' : range.value !== 0;
  }

  if (
    name !== undefined &&
    isTokenNode(nodes[1] as ComponentValue) &&
    tokenOf(nodes[1])?.[0] === TokenType.Colon
  ) {
    const rest = nodes.slice(2);
    const prefix = /^(min|max)-(.+)$/.exec(name);
    const feature = prefix?.[2] ?? name;
    const value = own(discrete, feature);
    if (value !== undefined && prefix === null) {
      return rest.length === 1 && identOf(rest[0]) === value;
    }
    const range = own(ranges, feature.replace(/^-webkit-(min|max)-/, '-webkit-'));
    const webkit = /^-webkit-(min|max)-device-pixel-ratio$/.exec(name);
    if (range === undefined && webkit === null) return 'unknown';
    const target = rangeValue(rest, (range ?? { kind: 'number' }).kind, ctx);
    if (target === null) return false;
    const actual = range?.value ?? 1;
    const bound = prefix?.[1] ?? webkit?.[1];
    if (bound === 'min') return actual >= target;
    if (bound === 'max') return actual <= target;
    return compare(actual, '=', target, false);
  }

  const parts = splitRange(nodes);
  if (parts.length !== 3 && parts.length !== 5) return 'unknown';
  const featureIndex = parts.findIndex(
    (part) =>
      Array.isArray(part) &&
      part.length === 1 &&
      identOf(part[0]) !== undefined &&
      own(ranges, identOf(part[0]) as string) !== undefined,
  );
  if (featureIndex === -1) return 'unknown';
  const range = own(
    ranges,
    identOf((parts[featureIndex] as ComponentValue[])[0]) as string,
  ) as Range;
  let result = true;
  for (let side = 0; side < parts.length; side += 2) {
    if (side === featureIndex) continue;
    const target = rangeValue(parts[side] as ComponentValue[], range.kind, ctx);
    const op = parts[side < featureIndex ? side + 1 : side - 1] as string;
    if (target === null || typeof op !== 'string') return false;
    result &&= compare(range.value, op, target, side < featureIndex);
  }
  return result;
}

/** A media condition as used inside `if(media(...))`. */
export function evaluateMediaCondition(nodes: readonly ComponentValue[], env: Environment): Truth {
  return evaluateCondition(nodes, (node) => mediaFeature(node, env)) ?? false;
}

function evaluateMediaQuery(nodes: ComponentValue[], env: Environment): Truth {
  const list = significant(nodes);
  if (list.length === 0) return true;
  const head = identOf(list[0]);
  const second = list[1];
  const startsWithType =
    head !== undefined && !(head === 'not' && second !== undefined && isParenBlock(second));
  if (!startsWithType) return evaluateCondition(list, (node) => mediaFeature(node, env)) ?? false;

  let index = 0;
  let negate = false;
  if (head === 'not' || head === 'only') {
    negate = head === 'not';
    index = 1;
  }
  const type = identOf(list[index]);
  if (type === undefined || type === 'and' || type === 'or' || type === 'not' || type === 'only')
    return false;
  let result: Truth = own(MEDIA_TYPES, type) ?? false;
  if (index + 1 < list.length) {
    if (identOf(list[index + 1]) !== 'and') return false;
    const condition = list.slice(index + 2);
    const value = evaluateCondition(condition, (node) => mediaFeature(node, env));
    if (value === null || condition.some((node) => identOf(node) === 'or')) return false;
    result = and(result, value);
  }
  return negate ? not(result) : result;
}

/** A media query list, as in `@media` or a `media` attribute. Empty means all. */
export function evaluateMediaQueryList(nodes: readonly ComponentValue[], env: Environment): Truth {
  if (significant(nodes).length === 0) return true;
  return splitCommas(nodes).reduce<Truth>(
    (result, query) => or(result, evaluateMediaQuery(query, env)),
    false,
  );
}

/**
 * The argument of `supports()` in `@import` and `if()`, which may be a bare
 * declaration: `supports(display: grid)`. Wrapped in parentheses, it is an
 * ordinary supports condition.
 */
export function supportsArgument(nodes: ComponentValue[]): ComponentValue[] {
  const inner = significant(nodes);
  const head = tokenOf(inner[0]);
  const declaration = head?.[0] === TokenType.Ident && tokenOf(inner[1])?.[0] === TokenType.Colon;
  return declaration ? [paren(nodes)] : nodes;
}

/**
 * An `@supports` condition. `declaration` decides `(property: value)`;
 * `selector` decides `selector(...)`. Other functions are unknown.
 */
export function evaluateSupports(
  nodes: readonly ComponentValue[],
  declaration: (name: string, value: ComponentValue[]) => Truth,
  selector: (text: ComponentValue[]) => Truth,
): Truth {
  const value = evaluateCondition(nodes, (node) => {
    if (isFunctionNode(node)) {
      return node.getName().toLowerCase() === 'selector' ? selector(node.value) : 'unknown';
    }
    if (!isSimpleBlockNode(node)) return 'unknown';
    const inner = significant(node.value);
    const property = tokenOf(inner[0]);
    if (property?.[0] !== TokenType.Ident || tokenOf(inner[1])?.[0] !== TokenType.Colon)
      return 'unknown';
    const raw = property[4].value as string;
    const start = node.value.indexOf(inner[1] as ComponentValue) + 1;
    return declaration(raw.startsWith('--') ? raw : raw.toLowerCase(), node.value.slice(start));
  });
  return value ?? false;
}
