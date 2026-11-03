/**
 * The CSS properties that decide whether text is visible, and their value
 * grammars. A declaration a browser would reject must be rejected here too,
 * because a rejected declaration falls back to the next one in the cascade:
 * accepting `opacity: garbage` would hide an earlier `opacity: 0`.
 *
 * Grammars that are large or still growing (filters, transforms, clip paths)
 * are accepted leniently by function name, so that no value a browser
 * accepts is ever rejected here.
 */
import {
  type ComponentValue,
  isFunctionNode,
  isSimpleBlockNode,
} from '@csstools/css-parser-algorithms';
import { TokenType } from '@csstools/css-tokenizer';
import { own } from '../util.js';
import { type Context, type Expr, evaluate, isMathFunction, parseNumeric } from './calc.js';
import { identOf, isToken, significant, splitCommas, stringOf, tokenOf } from './syntax.js';

export type Display =
  | { kind: 'none' }
  | { kind: 'contents' }
  | { kind: 'box'; outer: 'block' | 'inline' | 'run-in'; inner: string; listItem: boolean }
  | { kind: 'internal'; role: string };

export type FontSize =
  | { kind: 'px'; px: number }
  | { kind: 'scale'; factor: number }
  | { kind: 'length'; expr: Expr };
export type Size = 'auto' | 'none' | 'intrinsic' | Expr;
export type Offset = 'auto' | Expr;
export type Overflow = 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
export interface TransformFunction {
  name: string;
  args: Expr[];
}
export type ClipPath = 'none' | 'other' | { shape: string; args: ComponentValue[] };

/** A typed value for each modeled longhand. */
export interface Values {
  display: Display;
  visibility: 'visible' | 'hidden' | 'collapse';
  'content-visibility': 'visible' | 'auto' | 'hidden';
  opacity: Expr;
  filter: Expr[];
  'font-size': FontSize;
  zoom: Expr | 'normal';
  transform: TransformFunction[];
  scale: Expr[] | 'none';
  translate: Expr[] | 'none';
  rotate: { axis: 'x' | 'y' | 'z' | 'other'; angle: Expr } | 'none';
  width: Size;
  height: Size;
  'max-width': Size;
  'max-height': Size;
  'overflow-x': Overflow;
  'overflow-y': Overflow;
  clip: 'auto' | Offset[];
  'clip-path': ClipPath;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  top: Offset;
  right: Offset;
  bottom: Offset;
  left: Offset;
  'margin-left': Offset;
  'margin-top': Offset;
  'text-indent': Expr;
  'white-space-collapse':
    | 'collapse'
    | 'preserve'
    | 'preserve-breaks'
    | 'preserve-spaces'
    | 'break-spaces';
  'text-wrap-mode': 'wrap' | 'nowrap';
  'animation-name': (string | null)[];
  'animation-fill-mode': string[];
  'animation-iteration-count': (number | 'infinite')[];
  'animation-direction': string[];
  'animation-play-state': string[];
  /** Size containment sizes a box as if it were empty; paint containment clips to it. */
  contain: { size: boolean; paint: boolean };
  /** Whether `contain-intrinsic-*` gives the box a block size other than nothing. */
  'contain-intrinsic-height': boolean;
  'min-width': Size;
  'min-height': Size;
  'padding-top': Expr;
  'padding-right': Expr;
  'padding-bottom': Expr;
  'padding-left': Expr;
  /** The `perspective` property: the distance children's 3D transforms are viewed from. */
  perspective: Expr | 'none';
}

export type Longhand = keyof Values;

interface Definition<K extends Longhand> {
  inherited: boolean;
  initial: Values[K];
  parse: (nodes: ComponentValue[], quirks: boolean) => Values[K] | null;
}

type Definitions = { [K in Longhand]: Definition<K> };

const ZERO: Expr = { op: 'value', value: 0, unit: '' };
const ONE: Expr = { op: 'value', value: 1, unit: '' };

/** A context for parse-time type checks only. */
const CHECK: Context = {
  em: 16,
  rem: 16,
  viewportWidth: 1280,
  viewportHeight: 800,
  percent: 'length',
};

function single(nodes: ComponentValue[]): ComponentValue | null {
  return nodes.length === 1 ? (nodes[0] as ComponentValue) : null;
}

function keyword<T extends string>(allowed: readonly T[]) {
  return (nodes: ComponentValue[]): T | null => {
    const word = identOf(single(nodes) ?? undefined);
    return word !== undefined && (allowed as readonly string[]).includes(word) ? (word as T) : null;
  };
}

function kindOf(expr: Expr, percent: Context['percent'] = 'length'): string | null {
  const value = evaluate(expr, { ...CHECK, percent });
  return value === null ? null : value.kind;
}

/**
 * A `<length-percentage>`. Unitless numbers are accepted when they are zero,
 * or anywhere in quirks mode for the properties that have the unitless-length
 * quirk.
 */
function lengthPercentage(
  node: ComponentValue | undefined,
  quirky: boolean,
  nonNegative = false,
): Expr | null {
  if (node === undefined) return null;
  const expr = parseNumeric(node);
  if (expr === null) return null;
  const literal = expr.op === 'value';
  if (literal && expr.unit === '') {
    if (expr.value !== 0 && !(quirky && !isMathFunction(node))) return null;
    if (nonNegative && expr.value < 0) return null;
    return { op: 'value', value: expr.value, unit: 'px' };
  }
  if (kindOf(expr) !== 'length') return null;
  if (nonNegative && literal && expr.value < 0) return null;
  return expr;
}

function numberOrPercentage(node: ComponentValue | undefined): Expr | null {
  if (node === undefined) return null;
  const expr = parseNumeric(node);
  return expr !== null && kindOf(expr, 'number') === 'number' ? expr : null;
}

function angle(node: ComponentValue | undefined): Expr | null {
  if (node === undefined) return null;
  const expr = parseNumeric(node);
  if (expr === null) return null;
  if (expr.op === 'value' && expr.unit === '' && expr.value === 0) return expr;
  return kindOf(expr) === 'angle' ? expr : null;
}

const OUTER = ['block', 'inline', 'run-in'];
const INNER = ['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby', 'math'];
const INTERNAL = [
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-cell',
  'table-column-group',
  'table-column',
  'table-caption',
  'ruby-base',
  'ruby-text',
  'ruby-base-container',
  'ruby-text-container',
];
const LEGACY_DISPLAY: Record<string, [string, string]> = {
  'inline-block': ['inline', 'flow-root'],
  'inline-table': ['inline', 'table'],
  'inline-flex': ['inline', 'flex'],
  'inline-grid': ['inline', 'grid'],
  '-webkit-box': ['block', 'flex'],
  '-webkit-inline-box': ['inline', 'flex'],
  '-webkit-flex': ['block', 'flex'],
  '-webkit-inline-flex': ['inline', 'flex'],
  '-moz-box': ['block', 'flex'],
  '-moz-inline-box': ['inline', 'flex'],
  '-ms-flexbox': ['block', 'flex'],
  '-ms-inline-flexbox': ['inline', 'flex'],
  '-ms-grid': ['block', 'grid'],
  '-ms-inline-grid': ['inline', 'grid'],
};

function parseDisplay(nodes: ComponentValue[]): Display | null {
  const words = nodes.map((node) => identOf(node));
  if (words.length === 0 || words.length > 3 || words.includes(undefined)) return null;
  const [first] = words as string[];
  if (words.length === 1) {
    if (first === 'none') return { kind: 'none' };
    if (first === 'contents') return { kind: 'contents' };
    if (INTERNAL.includes(first as string)) return { kind: 'internal', role: first as string };
    const legacy = own(LEGACY_DISPLAY, first as string);
    if (legacy !== undefined)
      return {
        kind: 'box',
        outer: legacy[0] as 'block' | 'inline',
        inner: legacy[1],
        listItem: false,
      };
  }
  let outer: string | undefined;
  let inner: string | undefined;
  let listItem = false;
  for (const word of words as string[]) {
    if (OUTER.includes(word) && outer === undefined) outer = word;
    else if (INNER.includes(word) && inner === undefined) inner = word;
    else if (word === 'list-item' && !listItem) listItem = true;
    else return null;
  }
  if (listItem && inner !== undefined && inner !== 'flow' && inner !== 'flow-root') return null;
  return {
    kind: 'box',
    outer: (outer ?? (inner === 'ruby' ? 'inline' : 'block')) as 'block' | 'inline' | 'run-in',
    inner: inner ?? 'flow',
    listItem,
  };
}

const FONT_KEYWORDS: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};

function parseFontSize(nodes: ComponentValue[], quirks: boolean): FontSize | null {
  const node = single(nodes);
  if (node === null) return null;
  const word = identOf(node);
  if (word !== undefined) {
    const px = own(FONT_KEYWORDS, word);
    if (px !== undefined) return { kind: 'px', px };
    if (word === 'smaller') return { kind: 'scale', factor: 1 / 1.2 };
    if (word === 'larger') return { kind: 'scale', factor: 1.2 };
    if (word === 'math') return { kind: 'scale', factor: 1 };
    return null;
  }
  const expr = lengthPercentage(node, quirks, true);
  return expr === null ? null : { kind: 'length', expr };
}

const SYSTEM_FONTS = ['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar'];
const FONT_PREFIX_KEYWORDS = [
  'normal',
  'italic',
  'oblique',
  'small-caps',
  'bold',
  'bolder',
  'lighter',
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
];

/** The `font` shorthand; only the size matters here. */
function parseFont(nodes: ComponentValue[]): { 'font-size': FontSize } | null {
  const word = identOf(single(nodes) ?? undefined);
  if (word !== undefined && SYSTEM_FONTS.includes(word))
    return { 'font-size': { kind: 'px', px: 13 } };
  let index = 0;
  // Style (with an optional oblique angle), variant, weight and width: at most five tokens.
  for (; index < nodes.length && index < 5; index += 1) {
    const node = nodes[index] as ComponentValue;
    const ident = identOf(node);
    if (ident !== undefined && FONT_PREFIX_KEYWORDS.includes(ident)) continue;
    const token = tokenOf(node);
    // A font-weight number (1..1000) or an oblique angle may precede the size.
    if (token?.[0] === TokenType.Number && token[4].value >= 1 && token[4].value <= 1000) continue;
    if (token?.[0] === TokenType.Dimension && angle(node) !== null) continue;
    break;
  }
  const size = parseFontSize(nodes.slice(index, index + 1), false);
  if (size === null) return null;
  let rest = nodes.slice(index + 1);
  if (isToken(rest[0], TokenType.Delim) && stringOf(rest[0]) === '/') rest = rest.slice(2);
  const family = rest.filter((node) => !isToken(node, TokenType.Comma));
  if (
    family.length === 0 ||
    !family.every((node) => identOf(node) !== undefined || isToken(node, TokenType.String))
  ) {
    return null;
  }
  return { 'font-size': size };
}

/** Argument kinds per transform function: `L` length, `P` length-percentage, `N` number or percentage, `A` angle, `#` plain number. */
const TRANSFORM_FUNCTIONS: Record<string, string[]> = {
  matrix: ['######'],
  matrix3d: ['################'],
  translate: ['P', 'PP'],
  translatex: ['P'],
  translatey: ['P'],
  translatez: ['L'],
  translate3d: ['PPL'],
  scale: ['N', 'NN'],
  scalex: ['N'],
  scaley: ['N'],
  scalez: ['N'],
  scale3d: ['NNN'],
  rotate: ['A'],
  rotatex: ['A'],
  rotatey: ['A'],
  rotatez: ['A'],
  rotate3d: ['###A'],
  skew: ['A', 'AA'],
  skewx: ['A'],
  skewy: ['A'],
  perspective: ['L'],
};

function transformArgument(node: ComponentValue, kind: string): Expr | null {
  switch (kind) {
    case 'L': {
      if (identOf(node) === 'none') return ZERO;
      const expr = lengthPercentage(node, false);
      return expr !== null && !(expr.op === 'value' && expr.unit === '%') ? expr : null;
    }
    case 'P':
      return lengthPercentage(node, false);
    case 'N':
      return numberOrPercentage(node);
    case 'A':
      return angle(node);
    default: {
      const expr = parseNumeric(node);
      return expr !== null &&
        kindOf(expr, 'number') === 'number' &&
        !(expr.op === 'value' && expr.unit === '%')
        ? expr
        : null;
    }
  }
}

/**
 * A transform list. Arguments are comma-separated and checked against each
 * function's grammar: `scale(1 1)` is rejected by browsers, and accepting it
 * would mask an earlier `scale(0)`.
 */
function parseTransform(nodes: ComponentValue[]): TransformFunction[] | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return [];
  if (nodes.length === 0) return null;
  const functions: TransformFunction[] = [];
  for (const node of nodes) {
    if (!isFunctionNode(node)) return null;
    const name = node.getName().toLowerCase();
    const forms = own(TRANSFORM_FUNCTIONS, name);
    if (forms === undefined) return null;
    const parts = splitCommas(node.value).map(significant);
    const form = forms.find((candidate) => candidate.length === parts.length);
    if (form === undefined || parts.some((part) => part.length !== 1)) return null;
    const args = parts.map((part, index) =>
      transformArgument(part[0] as ComponentValue, form[index] as string),
    );
    if (args.includes(null)) return null;
    functions.push({ name, args: args as Expr[] });
  }
  return functions;
}

function parseIndividual(
  nodes: ComponentValue[],
  each: (node: ComponentValue) => Expr | null,
): Expr[] | 'none' | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return 'none';
  if (nodes.length === 0 || nodes.length > 3) return null;
  const values = nodes.map(each);
  return values.includes(null) ? null : (values as Expr[]);
}

function parseRotate(nodes: ComponentValue[]): Values['rotate'] | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return 'none';
  const angles = nodes.map(angle);
  // A unitless zero is a valid angle, but in `0 0 1 90deg` it is an axis component.
  const dimension = angles.findIndex(
    (value, at) => value !== null && tokenOf(nodes[at])?.[0] !== TokenType.Number,
  );
  const index = dimension === -1 ? angles.findIndex((value) => value !== null) : dimension;
  if (index === -1) return null;
  const rest = nodes.filter((_, position) => position !== index);
  const axisWord = identOf(rest[0]);
  if (rest.length === 0) return { axis: 'z', angle: angles[index] as Expr };
  if (rest.length === 1 && (axisWord === 'x' || axisWord === 'y' || axisWord === 'z')) {
    return { axis: axisWord, angle: angles[index] as Expr };
  }
  if (rest.length === 3 && rest.every((node) => tokenOf(node)?.[0] === TokenType.Number)) {
    return { axis: 'other', angle: angles[index] as Expr };
  }
  return null;
}

const INTRINSIC = [
  'min-content',
  'max-content',
  'fit-content',
  'stretch',
  '-webkit-fill-available',
  '-moz-available',
  '-webkit-min-content',
  '-webkit-max-content',
  '-webkit-fit-content',
];

function parseSize(empty: 'auto' | 'none') {
  return (nodes: ComponentValue[], quirks: boolean): Size | null => {
    const node = single(nodes);
    if (node === null) return null;
    const word = identOf(node);
    if (word !== undefined) {
      if (word === empty) return empty;
      return INTRINSIC.includes(word) ? 'intrinsic' : null;
    }
    if (isFunctionNode(node)) {
      const name = node.getName().toLowerCase();
      if (name === 'fit-content' || name === 'calc-size' || name === 'anchor-size')
        return 'intrinsic';
    }
    return lengthPercentage(node, quirks, true);
  };
}

const OVERFLOW: Record<string, Overflow> = {
  visible: 'visible',
  hidden: 'hidden',
  clip: 'clip',
  scroll: 'scroll',
  auto: 'auto',
  overlay: 'auto',
};

function parseOverflowKeyword(nodes: ComponentValue[]): Overflow | null {
  return own(OVERFLOW, identOf(single(nodes) ?? undefined) ?? '') ?? null;
}

function parseOffset(nodes: ComponentValue[], quirks: boolean): Offset | null {
  const node = single(nodes);
  if (node === null) return null;
  if (identOf(node) === 'auto') return 'auto';
  if (isFunctionNode(node) && node.getName().toLowerCase() === 'anchor') return 'auto';
  return lengthPercentage(node, quirks);
}

function parseClip(nodes: ComponentValue[], quirks: boolean): Values['clip'] | null {
  const node = single(nodes);
  if (node === null) return null;
  if (identOf(node) === 'auto') return 'auto';
  if (!isFunctionNode(node) || node.getName().toLowerCase() !== 'rect') return null;
  const parts = significant(node.value).filter((part) => !isToken(part, TokenType.Comma));
  if (parts.length !== 4) return null;
  const edges = parts.map((part) => parseOffset([part], quirks));
  return edges.includes(null) ? null : (edges as Offset[]);
}

const SHAPES = ['inset', 'circle', 'ellipse', 'polygon', 'path', 'shape', 'rect', 'xywh'];
const GEOMETRY_BOXES = [
  'margin-box',
  'border-box',
  'padding-box',
  'content-box',
  'fill-box',
  'stroke-box',
  'view-box',
];

function parseClipPath(nodes: ComponentValue[]): ClipPath | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return 'none';
  if (nodes.length === 0 || nodes.length > 2) return null;
  let shape: ClipPath | null = null;
  for (const node of nodes) {
    const word = identOf(node);
    if (word !== undefined && GEOMETRY_BOXES.includes(word)) continue;
    const token = tokenOf(node);
    if (
      token?.[0] === TokenType.URL ||
      (isFunctionNode(node) && node.getName().toLowerCase() === 'url')
    ) {
      shape = 'other';
      continue;
    }
    if (!isFunctionNode(node) || !SHAPES.includes(node.getName().toLowerCase()) || shape !== null)
      return null;
    shape = { shape: node.getName().toLowerCase(), args: node.value };
  }
  return shape ?? 'other';
}

const FILTER_FUNCTIONS = [
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  'url',
];

function parseFilter(nodes: ComponentValue[]): Expr[] | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return [];
  if (nodes.length === 0) return null;
  const opacities: Expr[] = [];
  for (const node of nodes) {
    if (tokenOf(node)?.[0] === TokenType.URL) continue;
    if (!isFunctionNode(node) || !FILTER_FUNCTIONS.includes(node.getName().toLowerCase()))
      return null;
    if (node.getName().toLowerCase() !== 'opacity') continue;
    const args = significant(node.value);
    if (args.length > 1) return null;
    const amount = args.length === 0 ? ONE : numberOrPercentage(args[0]);
    if (amount === null) return null;
    opacities.push(amount);
  }
  return opacities;
}

const WHITE_SPACE: Record<string, [Values['white-space-collapse'], Values['text-wrap-mode']]> = {
  normal: ['collapse', 'wrap'],
  pre: ['preserve', 'nowrap'],
  nowrap: ['collapse', 'nowrap'],
  'pre-wrap': ['preserve', 'wrap'],
  'break-spaces': ['break-spaces', 'wrap'],
  'pre-line': ['preserve-breaks', 'wrap'],
};
const COLLAPSE = [
  'collapse',
  'preserve',
  'preserve-breaks',
  'preserve-spaces',
  'break-spaces',
  'discard',
];

function parseWhiteSpace(nodes: ComponentValue[]): Partial<Values> | null {
  const word = identOf(single(nodes) ?? undefined);
  const legacy = word === undefined ? undefined : own(WHITE_SPACE, word);
  if (legacy !== undefined)
    return { 'white-space-collapse': legacy[0], 'text-wrap-mode': legacy[1] };
  const result: Partial<Values> = {};
  for (const node of nodes) {
    const part = identOf(node);
    if (part === undefined) return null;
    if (COLLAPSE.includes(part) && result['white-space-collapse'] === undefined) {
      result['white-space-collapse'] = (
        part === 'discard' ? 'collapse' : part
      ) as Values['white-space-collapse'];
    } else if ((part === 'wrap' || part === 'nowrap') && result['text-wrap-mode'] === undefined) {
      result['text-wrap-mode'] = part;
    } else if (
      part !== 'none' &&
      part !== 'discard-before' &&
      part !== 'discard-after' &&
      part !== 'discard-inner'
    ) {
      return null;
    }
  }
  if (nodes.length === 0) return null;
  // A shorthand sets every longhand: the ones not given return to their initial values.
  return { 'white-space-collapse': 'collapse', 'text-wrap-mode': 'wrap', ...result };
}

const FILL_MODES = ['none', 'forwards', 'backwards', 'both'];
const DIRECTIONS = ['normal', 'reverse', 'alternate', 'alternate-reverse'];
const PLAY_STATES = ['running', 'paused'];
const EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'];

interface Animation {
  name: string | null;
  fill: string;
  count: number | 'infinite';
  direction: string;
  state: string;
}

function parseAnimationItem(nodes: ComponentValue[]): Animation | null {
  const item: Partial<Animation> = {};
  let times = 0;
  for (const node of nodes) {
    const word = identOf(node);
    const token = tokenOf(node);
    if (token?.[0] === TokenType.Dimension || (isFunctionNode(node) && isMathFunction(node))) {
      if (++times > 2) return null;
      continue;
    }
    if (isFunctionNode(node)) {
      const name = node.getName().toLowerCase();
      if (name === 'cubic-bezier' || name === 'steps' || name === 'linear') continue;
      return null;
    }
    if (token?.[0] === TokenType.Number && item.count === undefined) {
      item.count = token[4].value;
      continue;
    }
    if (word !== undefined) {
      if (word === 'infinite' && item.count === undefined) item.count = 'infinite';
      else if (EASINGS.includes(word)) continue;
      else if (FILL_MODES.includes(word) && item.fill === undefined && word !== 'none')
        item.fill = word;
      else if (DIRECTIONS.includes(word) && item.direction === undefined) item.direction = word;
      else if (PLAY_STATES.includes(word) && item.state === undefined) item.state = word;
      else if (item.name === undefined)
        item.name = word === 'none' ? null : (stringOf(node) as string);
      else if (word === 'none' && item.fill === undefined) item.fill = 'none';
      else return null;
      continue;
    }
    if (token?.[0] === TokenType.String && item.name === undefined) {
      item.name = token[4].value;
      continue;
    }
    return null;
  }
  return {
    name: item.name ?? null,
    fill: item.fill ?? 'none',
    count: item.count ?? 1,
    direction: item.direction ?? 'normal',
    state: item.state ?? 'running',
  };
}

function parseAnimation(nodes: ComponentValue[]): Partial<Values> | null {
  const items = splitCommas(nodes).map((part) => parseAnimationItem(significant(part)));
  if (items.includes(null)) return null;
  const list = items as Animation[];
  return {
    'animation-name': list.map((item) => item.name),
    'animation-fill-mode': list.map((item) => item.fill),
    'animation-iteration-count': list.map((item) => item.count),
    'animation-direction': list.map((item) => item.direction),
    'animation-play-state': list.map((item) => item.state),
  };
}

function listOf<T>(each: (node: ComponentValue) => T | null) {
  return (nodes: ComponentValue[]): T[] | null => {
    const values = splitCommas(nodes).map((part) => {
      const parts = significant(part);
      return parts.length === 1 ? each(parts[0] as ComponentValue) : null;
    });
    return values.includes(null) ? null : (values as T[]);
  };
}

function listKeyword(allowed: string[]) {
  return listOf((node) => {
    const word = identOf(node);
    return word !== undefined && allowed.includes(word) ? word : null;
  });
}

export const LONGHANDS: Definitions = {
  display: {
    inherited: false,
    initial: { kind: 'box', outer: 'inline', inner: 'flow', listItem: false },
    parse: parseDisplay,
  },
  visibility: {
    inherited: true,
    initial: 'visible',
    parse: keyword(['visible', 'hidden', 'collapse'] as const),
  },
  'content-visibility': {
    inherited: false,
    initial: 'visible',
    parse: keyword(['visible', 'auto', 'hidden'] as const),
  },
  opacity: {
    inherited: false,
    initial: ONE,
    parse: (nodes) => numberOrPercentage(single(nodes) ?? undefined),
  },
  filter: { inherited: false, initial: [], parse: parseFilter },
  'font-size': { inherited: true, initial: { kind: 'px', px: 16 }, parse: parseFontSize },
  zoom: {
    inherited: false,
    initial: 'normal',
    parse: (nodes) => {
      const word = identOf(single(nodes) ?? undefined);
      if (word === 'normal' || word === 'reset') return 'normal';
      const value = numberOrPercentage(single(nodes) ?? undefined);
      return value !== null && !(value.op === 'value' && value.value < 0) ? value : null;
    },
  },
  transform: { inherited: false, initial: [], parse: parseTransform },
  scale: {
    inherited: false,
    initial: 'none',
    parse: (nodes) => parseIndividual(nodes, (node) => numberOrPercentage(node)),
  },
  translate: {
    inherited: false,
    initial: 'none',
    parse: (nodes) => parseIndividual(nodes, (node) => lengthPercentage(node, false)),
  },
  rotate: { inherited: false, initial: 'none', parse: parseRotate },
  width: { inherited: false, initial: 'auto', parse: parseSize('auto') },
  height: { inherited: false, initial: 'auto', parse: parseSize('auto') },
  'max-width': { inherited: false, initial: 'none', parse: parseSize('none') },
  'max-height': { inherited: false, initial: 'none', parse: parseSize('none') },
  'overflow-x': { inherited: false, initial: 'visible', parse: parseOverflowKeyword },
  'overflow-y': { inherited: false, initial: 'visible', parse: parseOverflowKeyword },
  clip: { inherited: false, initial: 'auto', parse: parseClip },
  'clip-path': { inherited: false, initial: 'none', parse: parseClipPath },
  position: {
    inherited: false,
    initial: 'static',
    parse: (nodes) => {
      const word = identOf(single(nodes) ?? undefined);
      if (word === '-webkit-sticky') return 'sticky';
      return keyword(['static', 'relative', 'absolute', 'fixed', 'sticky'] as const)(nodes);
    },
  },
  top: { inherited: false, initial: 'auto', parse: parseOffset },
  right: { inherited: false, initial: 'auto', parse: parseOffset },
  bottom: { inherited: false, initial: 'auto', parse: parseOffset },
  left: { inherited: false, initial: 'auto', parse: parseOffset },
  'margin-left': { inherited: false, initial: ZERO, parse: parseOffset },
  'margin-top': { inherited: false, initial: ZERO, parse: parseOffset },
  'text-indent': {
    inherited: true,
    initial: ZERO,
    parse: (nodes, quirks) => {
      const lengths = nodes.filter(
        (node) => !['hanging', 'each-line'].includes(identOf(node) ?? ''),
      );
      return lengths.length === 1 && nodes.length - lengths.length <= 2
        ? lengthPercentage(lengths[0], quirks)
        : null;
    },
  },
  'white-space-collapse': {
    inherited: true,
    initial: 'collapse',
    parse: (nodes) => {
      const word = identOf(single(nodes) ?? undefined);
      if (word === 'discard') return 'collapse';
      return keyword([
        'collapse',
        'preserve',
        'preserve-breaks',
        'preserve-spaces',
        'break-spaces',
      ] as const)(nodes);
    },
  },
  'text-wrap-mode': {
    inherited: true,
    initial: 'wrap',
    parse: keyword(['wrap', 'nowrap'] as const),
  },
  'animation-name': {
    inherited: false,
    initial: [null],
    parse: listOf((node) => {
      const token = tokenOf(node);
      if (token?.[0] === TokenType.String) return token[4].value as string;
      if (token?.[0] !== TokenType.Ident) return null;
      return identOf(node) === 'none' ? '' : (token[4].value as string);
    }),
  },
  'animation-fill-mode': { inherited: false, initial: ['none'], parse: listKeyword(FILL_MODES) },
  'animation-iteration-count': {
    inherited: false,
    initial: [1],
    parse: listOf((node) => {
      if (identOf(node) === 'infinite') return 'infinite' as const;
      const token = tokenOf(node);
      return token?.[0] === TokenType.Number && token[4].value >= 0
        ? (token[4].value as number)
        : null;
    }),
  },
  'animation-direction': { inherited: false, initial: ['normal'], parse: listKeyword(DIRECTIONS) },
  'animation-play-state': {
    inherited: false,
    initial: ['running'],
    parse: listKeyword(PLAY_STATES),
  },
  contain: { inherited: false, initial: { size: false, paint: false }, parse: parseContain },
  'contain-intrinsic-height': { inherited: false, initial: false, parse: parseIntrinsicSize },
  'min-width': { inherited: false, initial: 'auto', parse: parseSize('auto') },
  'min-height': { inherited: false, initial: 'auto', parse: parseSize('auto') },
  'padding-top': {
    inherited: false,
    initial: ZERO,
    parse: (nodes, quirks) => lengthPercentage(single(nodes) ?? undefined, quirks, true),
  },
  'padding-right': {
    inherited: false,
    initial: ZERO,
    parse: (nodes, quirks) => lengthPercentage(single(nodes) ?? undefined, quirks, true),
  },
  'padding-bottom': {
    inherited: false,
    initial: ZERO,
    parse: (nodes, quirks) => lengthPercentage(single(nodes) ?? undefined, quirks, true),
  },
  'padding-left': {
    inherited: false,
    initial: ZERO,
    parse: (nodes, quirks) => lengthPercentage(single(nodes) ?? undefined, quirks, true),
  },
  perspective: {
    inherited: false,
    initial: 'none',
    parse: (nodes) =>
      identOf(single(nodes) ?? undefined) === 'none'
        ? 'none'
        : lengthPercentage(single(nodes) ?? undefined, false, true),
  },
};

const CONTAINMENT = ['size', 'inline-size', 'layout', 'style', 'paint'];

function parseContain(nodes: ComponentValue[]): Values['contain'] | null {
  const words = nodes.map((node) => identOf(node));
  if (words.length === 1) {
    if (words[0] === 'none') return { size: false, paint: false };
    if (words[0] === 'strict') return { size: true, paint: true };
    if (words[0] === 'content') return { size: false, paint: true };
  }
  if (words.length === 0 || words.some((word) => word === undefined || !CONTAINMENT.includes(word)))
    return null;
  if (
    new Set(words).size !== words.length ||
    (words.includes('size') && words.includes('inline-size'))
  )
    return null;
  return { size: words.includes('size'), paint: words.includes('paint') };
}

/** `none`, or `[auto] <length>` for the block axis: anything but `none` gives the box a size. */
function parseIntrinsicSize(nodes: ComponentValue[]): boolean | null {
  if (identOf(single(nodes) ?? undefined) === 'none') return false;
  const lengths = nodes.filter((node) => identOf(node) !== 'auto');
  if (lengths.length !== 1 || nodes.length - lengths.length > 1) return null;
  return lengthPercentage(lengths[0], false, true) === null ? null : true;
}

/** Properties whose unitless lengths are px in quirks mode. */
const QUIRKY: Record<string, true> = {
  'min-width': true,
  'min-height': true,
  'padding-top': true,
  'padding-right': true,
  'padding-bottom': true,
  'padding-left': true,
  'font-size': true,
  width: true,
  height: true,
  'max-width': true,
  'max-height': true,
  top: true,
  right: true,
  bottom: true,
  left: true,
  'margin-left': true,
  'margin-top': true,
  'text-indent': true,
  clip: true,
};

function boxSides(
  nodes: ComponentValue[],
  quirks: boolean,
): [Offset, Offset, Offset, Offset] | null {
  if (nodes.length === 0 || nodes.length > 4) return null;
  const values = nodes.map((node) => parseOffset([node], quirks));
  if (values.includes(null)) return null;
  const [top, right = top, bottom = top, left = right] = values as Offset[];
  return [top as Offset, right as Offset, bottom as Offset, left as Offset];
}

/** Shorthands expand to the modeled longhands they set; unmodeled parts are validated loosely. */
export const SHORTHANDS: Record<
  string,
  (nodes: ComponentValue[], quirks: boolean) => Partial<Values> | null
> = {
  font: (nodes) => parseFont(nodes),
  overflow: (nodes) => {
    if (nodes.length === 0 || nodes.length > 2) return null;
    const x = parseOverflowKeyword(nodes.slice(0, 1));
    const y = nodes.length === 2 ? parseOverflowKeyword(nodes.slice(1)) : x;
    return x === null || y === null ? null : { 'overflow-x': x, 'overflow-y': y };
  },
  inset: (nodes, quirks) => {
    const sides = boxSides(nodes, quirks);
    return sides === null
      ? null
      : { top: sides[0], right: sides[1], bottom: sides[2], left: sides[3] };
  },
  'inset-block': (nodes, quirks) => {
    const sides = boxSides(
      nodes.length === 1 ? [nodes[0] as ComponentValue, nodes[0] as ComponentValue] : nodes,
      quirks,
    );
    return sides === null || nodes.length > 2 ? null : { top: sides[0], bottom: sides[1] };
  },
  'inset-inline': (nodes, quirks) => {
    const sides = boxSides(
      nodes.length === 1 ? [nodes[0] as ComponentValue, nodes[0] as ComponentValue] : nodes,
      quirks,
    );
    return sides === null || nodes.length > 2 ? null : { left: sides[0], right: sides[1] };
  },
  'inset-block-start': (nodes, quirks) =>
    ({ top: parseOffset(nodes, quirks) ?? null }) as Partial<Values> | null,
  'inset-block-end': (nodes, quirks) =>
    ({ bottom: parseOffset(nodes, quirks) ?? null }) as Partial<Values> | null,
  'inset-inline-start': (nodes, quirks) =>
    ({ left: parseOffset(nodes, quirks) ?? null }) as Partial<Values> | null,
  'inset-inline-end': (nodes, quirks) =>
    ({ right: parseOffset(nodes, quirks) ?? null }) as Partial<Values> | null,
  margin: (nodes, quirks) => {
    const sides = boxSides(nodes, quirks);
    return sides === null ? null : { 'margin-top': sides[0], 'margin-left': sides[3] };
  },
  'margin-block': (nodes, quirks) =>
    nodes.length > 2
      ? null
      : ({ 'margin-top': parseOffset(nodes.slice(0, 1), quirks) } as Partial<Values>),
  'margin-inline': (nodes, quirks) =>
    nodes.length > 2
      ? null
      : ({ 'margin-left': parseOffset(nodes.slice(0, 1), quirks) } as Partial<Values>),
  'margin-block-start': (nodes, quirks) =>
    ({ 'margin-top': parseOffset(nodes, quirks) }) as Partial<Values>,
  'margin-inline-start': (nodes, quirks) =>
    ({ 'margin-left': parseOffset(nodes, quirks) }) as Partial<Values>,
  'white-space': (nodes) => parseWhiteSpace(nodes),
  'text-wrap': (nodes) => {
    let mode: Values['text-wrap-mode'] | undefined;
    for (const node of nodes) {
      const word = identOf(node);
      if (word === 'wrap' || word === 'nowrap') mode = word;
      else if (!['auto', 'balance', 'pretty', 'stable', 'avoid-orphans'].includes(word ?? ''))
        return null;
    }
    return nodes.length === 0 ? null : { 'text-wrap-mode': mode ?? 'wrap' };
  },
  animation: (nodes) => parseAnimation(nodes),
  padding: (nodes, quirks) => {
    if (nodes.length === 0 || nodes.length > 4) return null;
    const values = nodes.map((node) => lengthPercentage(node, quirks, true));
    if (values.includes(null)) return null;
    const [top, right = top, bottom = top, left = right] = values as Expr[];
    return {
      'padding-top': top,
      'padding-right': right,
      'padding-bottom': bottom,
      'padding-left': left,
    } as Partial<Values>;
  },
  'padding-block': (nodes, quirks) => {
    const values = nodes.map((node) => lengthPercentage(node, quirks, true));
    if (values.length === 0 || values.length > 2 || values.includes(null)) return null;
    return {
      'padding-top': values[0],
      'padding-bottom': values[1] ?? values[0],
    } as Partial<Values>;
  },
  'padding-inline': (nodes, quirks) => {
    const values = nodes.map((node) => lengthPercentage(node, quirks, true));
    if (values.length === 0 || values.length > 2 || values.includes(null)) return null;
    return {
      'padding-left': values[0],
      'padding-right': values[1] ?? values[0],
    } as Partial<Values>;
  },
  'contain-intrinsic-size': (nodes) => {
    // One or two of `none`, `<length>` or `auto <length>`: width, then height.
    const groups: ComponentValue[][] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index] as ComponentValue;
      if (identOf(node) === 'auto' && index + 1 < nodes.length) {
        groups.push([node, nodes[index + 1] as ComponentValue]);
        index += 1;
      } else groups.push([node]);
    }
    const sizes = groups.map(parseIntrinsicSize);
    if (sizes.length === 0 || sizes.length > 2 || sizes.includes(null)) return null;
    return { 'contain-intrinsic-height': sizes[sizes.length - 1] as boolean };
  },
};

export type Parsed = Partial<Values>;

/**
 * Prefixed and logical names browsers treat as the same property, in the
 * horizontal, left-to-right writing mode this engine assumes.
 */
const ALIASES: Record<string, string> = {
  '-webkit-filter': 'filter',
  '-webkit-transform': 'transform',
  '-webkit-clip-path': 'clip-path',
  '-webkit-animation': 'animation',
  '-webkit-animation-name': 'animation-name',
  '-webkit-animation-fill-mode': 'animation-fill-mode',
  '-webkit-animation-iteration-count': 'animation-iteration-count',
  '-webkit-animation-direction': 'animation-direction',
  '-webkit-animation-play-state': 'animation-play-state',
  'inline-size': 'width',
  'block-size': 'height',
  'max-inline-size': 'max-width',
  'max-block-size': 'max-height',
  'contain-intrinsic-block-size': 'contain-intrinsic-height',
  'min-inline-size': 'min-width',
  'min-block-size': 'min-height',
  'padding-block-start': 'padding-top',
  'padding-block-end': 'padding-bottom',
  'padding-inline-start': 'padding-left',
  'padding-inline-end': 'padding-right',
};

/**
 * Parses a declaration of a modeled property into longhand values, or
 * `null` when a browser would reject it. A shorthand with an invalid modeled
 * part is rejected as a whole, as browsers do.
 */
export function parseProperty(
  name: string,
  value: ComponentValue[],
  quirks: boolean,
): Parsed | null {
  const property = own(ALIASES, name) ?? name;
  const nodes = significant(value);
  if (nodes.some((node) => isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenCurly))
    return null;
  const longhand = own(LONGHANDS as unknown as Record<string, Definition<Longhand>>, property);
  if (longhand !== undefined) {
    const parsed = longhand.parse(nodes, quirks && QUIRKY[property] === true);
    return parsed === null ? null : ({ [property]: parsed } as Parsed);
  }
  const shorthand = own(SHORTHANDS, property);
  if (shorthand === undefined) return null;
  const parsed = shorthand(nodes, quirks);
  if (parsed === null || Object.values(parsed).some((part) => part === null)) return null;
  return parsed;
}

/** Whether a property is one this engine models (as a longhand, a shorthand or an alias). */
export function isModeled(name: string): boolean {
  const property = own(ALIASES, name) ?? name;
  return Object.hasOwn(LONGHANDS, property) || Object.hasOwn(SHORTHANDS, property);
}

/** The longhands a modeled property sets. */
export function longhandsOf(alias: string): Longhand[] {
  const name = own(ALIASES, alias) ?? alias;
  if (Object.hasOwn(LONGHANDS, name)) return [name as Longhand];
  switch (name) {
    case 'font':
      return ['font-size'];
    case 'overflow':
      return ['overflow-x', 'overflow-y'];
    case 'inset':
      return ['top', 'right', 'bottom', 'left'];
    case 'inset-block':
      return ['top', 'bottom'];
    case 'inset-inline':
      return ['left', 'right'];
    case 'inset-block-start':
      return ['top'];
    case 'inset-block-end':
      return ['bottom'];
    case 'inset-inline-start':
      return ['left'];
    case 'inset-inline-end':
      return ['right'];
    case 'margin':
      return ['margin-top', 'margin-left'];
    case 'margin-block':
    case 'margin-block-start':
      return ['margin-top'];
    case 'margin-inline':
    case 'margin-inline-start':
      return ['margin-left'];
    case 'white-space':
      return ['white-space-collapse', 'text-wrap-mode'];
    case 'text-wrap':
      return ['text-wrap-mode'];
    case 'contain-intrinsic-size':
      return ['contain-intrinsic-height'];
    case 'padding':
      return ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
    case 'padding-block':
      return ['padding-top', 'padding-bottom'];
    case 'padding-inline':
      return ['padding-left', 'padding-right'];
    case 'animation':
      return [
        'animation-name',
        'animation-fill-mode',
        'animation-iteration-count',
        'animation-direction',
        'animation-play-state',
      ];
    default:
      return [];
  }
}
