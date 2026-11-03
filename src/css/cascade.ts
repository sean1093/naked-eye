/**
 * The cascade: collects every style sheet a browser would apply to the
 * document, matches rules to elements, and computes, per element, the
 * values of the properties that decide visibility.
 *
 * Rules under a condition the engine cannot decide are kept apart, and
 * styles are computed in two worlds: one without those rules (world 0) and
 * one with them (world 1). The extractor keeps text only if it is visible in
 * both, so an attacker gains nothing by hiding text behind `@container`.
 */
import type { ComponentValue } from '@csstools/css-parser-algorithms';
import { isFunctionNode } from '@csstools/css-parser-algorithms';
import { TokenType } from '@csstools/css-tokenizer';
import type { AnyNode, Document, Element } from 'domhandler';
import type { Warning, WarningCode } from '../types.js';
import { own } from '../util.js';
import {
  type Context,
  type Expr,
  type Resolved,
  resolveAngle,
  resolveLength,
  resolveNumber,
} from './calc.js';
import {
  type Environment,
  evaluateMediaQueryList,
  evaluateSupports,
  supportsArgument,
  type Truth,
} from './conditions.js';
import {
  type ClipPath,
  type Display,
  isModeled,
  LONGHANDS,
  type Longhand,
  longhandsOf,
  type Offset,
  parseProperty,
  type Size,
  type Values,
} from './properties.js';
import {
  type CompiledSelector,
  compareSpecificity,
  compileSelectorList,
  type Nesting,
  type Specificity,
} from './selectors.js';
import { hasSubstitution, type SubstitutionContext, substitute } from './substitute.js';
import {
  type BlockItem,
  type Declaration,
  identOf,
  isToken,
  parseBlockContents,
  parseComponentValues,
  parseRuleList,
  parseStyleAttribute,
  parseStylesheet,
  type Rule,
  serialize,
  significant,
  splitCommas,
  stringOf,
  tokenOf,
  trim,
} from './syntax.js';
import { presentationalHints, UA_STYLESHEET } from './ua.js';

export interface StyleOptions {
  environment: Environment;
  /** CSS text for `<link rel="stylesheet">` and `@import`, keyed by the URL as written. */
  stylesheets: Readonly<Record<string, string>>;
}

export type World = 0 | 1;
export type Length = number | 'auto' | 'unknown';

/** A transform function with its arguments resolved: lengths in px, angles in degrees. */
export interface ResolvedTransform {
  name: string;
  args: (number | 'unknown')[];
}

/** Computed values of the properties that decide visibility. */
export interface Style {
  display: Display;
  visibility: Values['visibility'];
  contentVisibility: Values['content-visibility'];
  opacity: number;
  filterOpacity: number;
  /** Computed font size in px. */
  fontSize: number;
  zoom: number;
  transform: ResolvedTransform[];
  width: Length | 'none' | 'intrinsic';
  height: Length | 'none' | 'intrinsic';
  maxWidth: Length | 'none' | 'intrinsic';
  maxHeight: Length | 'none' | 'intrinsic';
  overflowX: Values['overflow-x'];
  overflowY: Values['overflow-y'];
  clip: 'auto' | Length[];
  clipPath: ClipPath;
  position: Values['position'];
  top: Length;
  right: Length;
  bottom: Length;
  left: Length;
  marginLeft: Length;
  marginTop: Length;
  textIndent: Length;
  whiteSpaceCollapse: Values['white-space-collapse'];
  textWrapMode: Values['text-wrap-mode'];
  contain: Values['contain'];
  /** A `contain-intrinsic-*` block size, which keeps a size-contained box from collapsing. */
  intrinsicHeight: boolean;
}

export interface StyleEngine {
  /** 2 when some rules sit under conditions the engine cannot decide. */
  readonly worlds: 1 | 2;
  readonly warnings: readonly Warning[];
  readonly quirks: boolean;
  style(element: Element, world: World): Style;
  /** A length context for resolving lengths against an element's styles. */
  context(element: Element, world: World): Context;
}

type CssWide = 'inherit' | 'initial' | 'unset' | 'revert' | 'revert-layer';
const CSS_WIDE: Record<string, true> = {
  inherit: true,
  initial: true,
  unset: true,
  revert: true,
  'revert-layer': true,
};

interface Decl {
  /** A longhand, or a custom property name. */
  property: string;
  value: unknown;
  wide: CssWide | null;
  /** Raw tokens awaiting substitution, and the property they were declared on. */
  pending: { raw: ComponentValue[]; source: string } | null;
  important: boolean;
}

class Layer {
  readonly children = new Map<string, Layer>();
  rank = 0;
  anonymous = 0;
  constructor(readonly parent: Layer | null) {}

  child(name: string): Layer {
    let layer = this.children.get(name);
    if (layer === undefined) {
      layer = new Layer(this);
      this.children.set(name, layer);
    }
    return layer;
  }
}

interface Block {
  declarations: Decl[];
  layer: Layer;
  conditional: boolean;
  order: number;
  origin: 'ua' | 'hint' | 'author' | 'inline' | 'animation';
}

interface Entry {
  block: Block;
  selector: CompiledSelector;
}

interface Keyframe {
  offsets: number[];
  declarations: Decl[];
}

interface Registration {
  inherits: boolean;
  initial: ComponentValue[] | null;
}

/**
 * The enclosing style rule, for nesting. Nested selectors refer to it through
 * a private pseudo-class instead of a copy of its text, so each level costs
 * the same however deep the nesting goes.
 */
interface ParentRef {
  name: string;
  selectors: CompiledSelector[];
  nesting: Nesting;
}

interface SheetContext {
  layer: Layer;
  conditional: boolean;
  parent: ParentRef | null;
  origin: 'ua' | 'author';
  /** `@namespace` prefixes declared by the style sheet. */
  namespaces: Record<string, string>;
}

/** A definition that only exists in the second world when declared under an undecidable condition. */
interface Defined<T> {
  value: T;
  conditional: boolean;
}

/** The last definition that exists in a world. */
function latest<T>(definitions: readonly Defined<T>[] | undefined, world: World): T | undefined {
  if (definitions === undefined) return undefined;
  for (let index = definitions.length - 1; index >= 0; index -= 1) {
    const definition = definitions[index] as Defined<T>;
    if (world === 1 || !definition.conditional) return definition.value;
  }
  return undefined;
}

function define<T>(
  map: Map<string, Defined<T>[]>,
  name: string,
  value: T,
  conditional: boolean,
): void {
  const list = map.get(name);
  if (list === undefined) map.set(name, [{ value, conditional }]);
  else list.push({ value, conditional });
}

const MAX_IMPORT_DEPTH = 8;
/** Style sheets applied through `@import` per document; each URL is parsed once. */
const MAX_IMPORTS = 128;

/** Serializes a selector, replacing each nesting selector `&` with `replacement`. */
function serializeNesting(
  values: readonly ComponentValue[],
  replacement: string,
): [string, boolean] {
  let found = false;
  const walk = (nodes: readonly ComponentValue[]): string =>
    nodes
      .map((node) => {
        if (isToken(node, TokenType.Delim) && stringOf(node) === '&') {
          found = true;
          return replacement;
        }
        if (isFunctionNode(node)) return `${node.name[1]}${walk(node.value)}${node.endToken[1]}`;
        if ('startToken' in node)
          return `${node.startToken[1]}${walk(node.value)}${node.endToken[1]}`;
        return node.toString();
      })
      .join('');
  return [walk(values), found];
}

/** A nested selector list made absolute: `&` and the implicit descendant refer to the parent. */
function resolveSelector(prelude: readonly ComponentValue[], parent: ParentRef | null): string {
  return splitCommas(prelude)
    .map((part) => {
      const [text, nested] = serializeNesting(
        trim(part),
        parent === null ? ':scope' : `:${parent.name}`,
      );
      return parent === null || nested ? text : `:${parent.name} ${text}`;
    })
    .join(', ');
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

const INITIAL_STYLE: Style = {
  display: { kind: 'box', outer: 'inline', inner: 'flow', listItem: false },
  visibility: 'visible',
  contentVisibility: 'visible',
  opacity: 1,
  filterOpacity: 1,
  fontSize: 16,
  zoom: 1,
  transform: [],
  width: 'auto',
  height: 'auto',
  maxWidth: 'none',
  maxHeight: 'none',
  overflowX: 'visible',
  overflowY: 'visible',
  clip: 'auto',
  clipPath: 'none',
  position: 'static',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  left: 'auto',
  marginLeft: 0,
  marginTop: 0,
  textIndent: 0,
  whiteSpaceCollapse: 'collapse',
  textWrapMode: 'wrap',
  contain: { size: false, paint: false },
  intrinsicHeight: false,
};

function elementChildren(node: { children: AnyNode[] }): Element[] {
  return node.children.filter(
    (child): child is Element =>
      child.type === 'tag' || child.type === 'script' || child.type === 'style',
  );
}

/** Builds the style engine for a parsed document. */
export function createStyleEngine(document: Document, options: StyleOptions): StyleEngine {
  const quirks = (document as unknown as { 'x-mode'?: string })['x-mode'] === 'quirks';
  const { environment } = options;
  const warnings: Warning[] = [];
  const warned = new Set<string>();
  const warn = (code: WarningCode, message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    warnings.push({ code, message });
  };

  const root = new Layer(null);
  const index = new Map<string, Entry[]>();
  const keyframes = new Map<string, Defined<Keyframe[]>[]>();
  const registered = new Map<string, Defined<Registration>[]>();
  const parsedSheets = new Map<string, Rule[]>();
  let imports = 0;
  let order = 0;
  let conditionalRules = false;

  const toDeclarations = (list: readonly Declaration[], inKeyframe = false): Decl[] => {
    const out: Decl[] = [];
    for (const { name, value, important } of list) {
      if (inKeyframe && important) continue;
      const nodes = significant(value);
      const word = nodes.length === 1 ? identOf(nodes[0]) : undefined;
      const wide = word !== undefined && CSS_WIDE[word] === true ? (word as CssWide) : null;
      if (name.startsWith('--')) {
        out.push({ property: name, value: trim(value), wide, pending: null, important });
        continue;
      }
      if (!isModeled(name)) continue;
      if (wide !== null || hasSubstitution(value)) {
        for (const longhand of longhandsOf(name)) {
          out.push({
            property: longhand,
            value: null,
            wide,
            pending: wide === null ? { raw: value, source: name } : null,
            important,
          });
        }
        continue;
      }
      const parsed = parseProperty(name, value, quirks);
      if (parsed === null) continue;
      for (const [property, typed] of Object.entries(parsed)) {
        out.push({ property, value: typed, wide: null, pending: null, important });
      }
    }
    return out;
  };

  const addBlock = (
    selectors: CompiledSelector[],
    declarations: Decl[],
    ctx: SheetContext,
  ): void => {
    if (declarations.length === 0) return;
    const block: Block = {
      declarations,
      layer: ctx.layer,
      conditional: ctx.conditional,
      order: order++,
      origin: ctx.origin,
    };
    for (const selector of selectors) {
      if (selector.pseudoElement !== null) continue;
      const list = index.get(selector.bucket);
      if (list === undefined) index.set(selector.bucket, [{ block, selector }]);
      else list.push({ block, selector });
    }
  };

  const supportsDeclaration = (name: string, value: ComponentValue[]): Truth => {
    if (name.startsWith('--')) return true;
    if (!isModeled(name)) return 'unknown';
    if (hasSubstitution(value)) return true;
    return parseProperty(name, value, false) !== null;
  };

  const supportsSelector = (nodes: ComponentValue[]): Truth => {
    const result = compileSelectorList(serialize(nodes), quirks);
    if ('selectors' in result) return true;
    return result.syntax ? false : 'unknown';
  };

  const evaluateSupportsPrelude = (prelude: ComponentValue[]): Truth =>
    evaluateSupports(prelude, supportsDeclaration, supportsSelector);

  const layerFor = (prelude: ComponentValue[], ctx: SheetContext): Layer[] | null => {
    const names = splitCommas(prelude).map((part) => serialize(trim(part)).trim());
    if (names.length === 1 && names[0] === '') {
      ctx.layer.anonymous += 1;
      return [ctx.layer.child(`\u0000${ctx.layer.anonymous}`)];
    }
    const layers: Layer[] = [];
    for (const name of names) {
      if (
        !/^-?[_a-zA-Z\u0080-\uffff][\w\u0080-\uffff-]*(\.-?[_a-zA-Z\u0080-\uffff][\w\u0080-\uffff-]*)*$/.test(
          name,
        )
      )
        return null;
      layers.push(
        name.split('.').reduce<Layer>((layer, segment) => layer.child(segment), ctx.layer),
      );
    }
    return layers;
  };

  const condition = (truth: Truth, ctx: SheetContext, what: string): SheetContext | null => {
    if (truth === false) return null;
    if (truth === 'unknown') {
      conditionalRules = true;
      warn(
        'unknown-condition',
        `${what} cannot be decided without a browser; its rules were evaluated both ways`,
      );
      return { ...ctx, conditional: true };
    }
    return ctx;
  };

  let parents = 0;
  const parentRef = (selectors: CompiledSelector[], outer: ParentRef | null): ParentRef => {
    const own = selectors.filter((selector) => selector.pseudoElement === null);
    const name = `-ne-parent-${parents++}`;
    const specificity = own.reduce<Specificity>(
      (best, selector) =>
        compareSpecificity(selector.specificity, best) > 0 ? selector.specificity : best,
      [0, 0, 0],
    );
    const test = (element: Element): boolean => own.some((selector) => selector.test(element));
    return { name, selectors, nesting: { ...outer?.nesting, [name]: { test, specificity } } };
  };

  const compileRule = (
    prelude: readonly ComponentValue[],
    ctx: SheetContext,
  ): CompiledSelector[] | null => {
    const compiled = compileSelectorList(
      resolveSelector(prelude, ctx.parent),
      quirks,
      ctx.parent?.nesting ?? {},
      ctx.namespaces,
    );
    if ('selectors' in compiled) return compiled.selectors;
    if (!compiled.syntax)
      warn('unsupported-selector', `Unsupported selector skipped: ${serialize(prelude).trim()}`);
    return null;
  };

  const groupContents = (block: ComponentValue[], ctx: SheetContext): void => {
    if (ctx.parent === null) {
      for (const rule of parseRuleList(block, false)) processRule(rule, ctx);
      return;
    }
    processItems(parseBlockContents(block), ctx.parent.selectors, ctx);
  };

  /** Declarations apply to `selectors`; nested rules resolve against them. */
  const processItems = (
    items: BlockItem[],
    selectors: CompiledSelector[],
    ctx: SheetContext,
  ): void => {
    let parent: ParentRef | null = null;
    for (const item of items) {
      if (item.kind === 'declarations') {
        addBlock(selectors, toDeclarations(item.declarations), ctx);
        continue;
      }
      parent ??= parentRef(selectors, ctx.parent);
      processRule(item.rule, { ...ctx, parent });
    }
  };

  const processRule = (rule: Rule, ctx: SheetContext): void => {
    if (rule.kind === 'style') {
      const selectors = compileRule(rule.prelude, ctx);
      if (selectors !== null) processItems(rule.items, selectors, ctx);
      return;
    }
    const { name, prelude, block } = rule;
    switch (name) {
      case 'media': {
        if (block === null) return;
        const next = condition(evaluateMediaQueryList(prelude, environment), ctx, '@media');
        if (next !== null) groupContents(block, next);
        return;
      }
      case 'supports': {
        if (block === null) return;
        const next = condition(evaluateSupportsPrelude(prelude), ctx, '@supports');
        if (next !== null) groupContents(block, next);
        return;
      }
      case 'container': {
        if (block === null) return;
        const next = condition('unknown', ctx, '@container');
        if (next !== null) groupContents(block, next);
        return;
      }
      case 'scope': {
        // Approximated as nesting under the scope root, ignoring the lower
        // bound; the rules only apply in the second world.
        if (block === null) return;
        const next = condition('unknown', ctx, '@scope') as SheetContext;
        const start = significant(prelude)[0];
        const roots =
          start !== undefined && 'startToken' in start ? compileRule(start.value, next) : null;
        if (roots !== null) processItems(parseBlockContents(block), roots, next);
        else if (next.parent !== null)
          processItems(parseBlockContents(block), next.parent.selectors, next);
        else for (const inner of parseRuleList(block, false)) processRule(inner, next);
        return;
      }
      case 'layer': {
        const layers = layerFor(prelude, ctx);
        if (layers === null || block === null || layers.length !== 1) return;
        groupContents(block, { ...ctx, layer: layers[0] as Layer });
        return;
      }
      case 'keyframes':
      case '-webkit-keyframes': {
        const keyframeName = stringOf(significant(prelude)[0]);
        if (block === null || typeof keyframeName !== 'string' || ctx.parent !== null) return;
        const frames: Keyframe[] = [];
        for (const frame of parseRuleList(block, false)) {
          if (frame.kind !== 'style') continue;
          const offsets = splitCommas(frame.prelude).map((part) => {
            const nodes = significant(part);
            const word = identOf(nodes[0]);
            if (word === 'from') return 0;
            if (word === 'to') return 1;
            const token = tokenOf(nodes[0]);
            return token?.[0] === TokenType.Percentage && nodes.length === 1
              ? (token[4].value as number) / 100
              : Number.NaN;
          });
          if (offsets.some(Number.isNaN)) continue;
          const declarations = frame.items.flatMap((item) =>
            item.kind === 'declarations' ? toDeclarations(item.declarations, true) : [],
          );
          frames.push({ offsets, declarations });
        }
        define(keyframes, keyframeName, frames, ctx.conditional);
        return;
      }
      case 'property': {
        const property = stringOf(significant(prelude)[0]);
        if (block === null || typeof property !== 'string' || !property.startsWith('--')) return;
        const descriptors = new Map<string, ComponentValue[]>();
        for (const item of parseBlockContents(block)) {
          if (item.kind === 'declarations')
            for (const d of item.declarations) descriptors.set(d.name, d.value);
        }
        const inherits = identOf(significant(descriptors.get('inherits') ?? [])[0]);
        const syntax = tokenOf(significant(descriptors.get('syntax') ?? [])[0]);
        if ((inherits !== 'true' && inherits !== 'false') || syntax?.[0] !== TokenType.String)
          return;
        const initial = descriptors.get('initial-value');
        if (initial === undefined && syntax[4].value.trim() !== '*') return;
        define(
          registered,
          property,
          { inherits: inherits === 'true', initial: initial === undefined ? null : trim(initial) },
          ctx.conditional,
        );
        return;
      }
      default:
        return;
    }
  };

  const sheetRules = (url: string, css: string): Rule[] => {
    let rules = parsedSheets.get(url);
    if (rules === undefined) {
      rules = parseStylesheet(css);
      parsedSheets.set(url, rules);
    }
    return rules;
  };

  const addSheet = (
    rules: Rule[],
    parent: SheetContext,
    depth: number,
    seen: Set<string>,
  ): void => {
    const ctx: SheetContext = { ...parent, namespaces: {} };
    let importsAllowed = true;
    for (const rule of rules) {
      if (rule.kind === 'at' && rule.name === 'import') {
        if (importsAllowed) addImport(rule.prelude, ctx, depth, seen);
        continue;
      }
      if (rule.kind === 'at' && rule.name === 'namespace') {
        const nodes = significant(rule.prelude);
        const prefix = nodes.length === 2 ? identOf(nodes[0]) : undefined;
        const target = nodes[nodes.length - 1];
        const url =
          stringOf(target) ??
          (target !== undefined && isFunctionNode(target)
            ? stringOf(significant(target.value)[0])
            : undefined);
        if (prefix !== undefined && url !== undefined) ctx.namespaces[prefix] = url;
        importsAllowed = false;
        continue;
      }
      if (
        rule.kind === 'at' &&
        (rule.name === 'charset' || (rule.name === 'layer' && rule.block === null))
      ) {
        if (rule.name === 'layer') layerFor(rule.prelude, ctx);
        continue;
      }
      importsAllowed = false;
      processRule(rule, ctx);
    }
  };

  const addImport = (
    prelude: ComponentValue[],
    ctx: SheetContext,
    depth: number,
    seen: Set<string>,
  ): void => {
    const nodes = significant(prelude);
    const first = nodes[0];
    const head = tokenOf(first);
    let url: string | undefined;
    if (head?.[0] === TokenType.URL || head?.[0] === TokenType.String)
      url = head[4].value as string;
    else if (
      first !== undefined &&
      isFunctionNode(first) &&
      first.getName().toLowerCase() === 'url'
    ) {
      url = stringOf(significant(first.value)[0]) as string | undefined;
    }
    if (url === undefined) return;
    let rest = nodes.slice(1);
    let layer = ctx.layer;
    const layerNode = rest[0];
    if (identOf(layerNode) === 'layer') {
      ctx.layer.anonymous += 1;
      layer = ctx.layer.child(`\u0000${ctx.layer.anonymous}`);
      rest = rest.slice(1);
    } else if (
      layerNode !== undefined &&
      isFunctionNode(layerNode) &&
      layerNode.getName().toLowerCase() === 'layer'
    ) {
      const layers = layerFor(layerNode.value, ctx);
      if (layers === null || layers.length !== 1) return;
      layer = layers[0] as Layer;
      rest = rest.slice(1);
    }
    let next: SheetContext | null = { ...ctx, layer };
    const supportsNode = rest[0];
    if (
      supportsNode !== undefined &&
      isFunctionNode(supportsNode) &&
      supportsNode.getName().toLowerCase() === 'supports'
    ) {
      next = condition(
        evaluateSupportsPrelude(supportsArgument(supportsNode.value)),
        next,
        '@import supports()',
      );
      rest = rest.slice(1);
    }
    if (next !== null)
      next = condition(evaluateMediaQueryList(rest, environment), next, '@import media');
    if (next === null) return;
    const css = own(options.stylesheets, url);
    if (css === undefined) {
      warn('unresolved-stylesheet', `@import of ${url} was not applied: its CSS was not supplied`);
      return;
    }
    if (depth >= MAX_IMPORT_DEPTH || seen.has(url)) return;
    imports += 1;
    if (imports > MAX_IMPORTS) {
      warn(
        'unresolved-stylesheet',
        `@import of ${url} was not applied: the document imports more than ${MAX_IMPORTS} style sheets`,
      );
      return;
    }
    addSheet(sheetRules(url, css), next, depth + 1, new Set([...seen, url]));
  };

  // User-agent sheet, then every author sheet in tree order.
  addSheet(
    parseStylesheet(UA_STYLESHEET),
    { layer: root, conditional: false, parent: null, origin: 'ua', namespaces: {} },
    0,
    new Set(),
  );
  const authorContext: SheetContext = {
    layer: root,
    conditional: false,
    parent: null,
    origin: 'author',
    namespaces: {},
  };
  const stack: AnyNode[] = [...document.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    if (node.type !== 'tag' && node.type !== 'style' && node.type !== 'script') continue;
    if (node.name === 'template') continue;
    const attributes = node.attribs;
    if (node.name === 'style') {
      const type = attributes.type?.trim().toLowerCase();
      if (type === undefined || type === '' || type === 'text/css') {
        const media = condition(
          evaluateMediaQueryList(parseMedia(attributes.media), environment),
          authorContext,
          'A media attribute',
        );
        const css = node.children
          .map((child) => (child.type === 'text' ? child.data : ''))
          .join('');
        if (media !== null) addSheet(parseStylesheet(css), media, 0, new Set());
      }
    } else if (node.name === 'link') {
      const rel = (attributes.rel ?? '').toLowerCase().split(/[\t\n\f\r ]+/);
      const href = attributes.href;
      if (
        rel.includes('stylesheet') &&
        !rel.includes('alternate') &&
        attributes.disabled === undefined &&
        href !== undefined
      ) {
        const media = condition(
          evaluateMediaQueryList(parseMedia(attributes.media), environment),
          authorContext,
          'A media attribute',
        );
        const css = own(options.stylesheets, href);
        if (css === undefined)
          warn(
            'unresolved-stylesheet',
            `<link rel="stylesheet" href="${href}"> was not applied: its CSS was not supplied`,
          );
        else if (media !== null) addSheet(sheetRules(href, css), media, 1, new Set([href]));
      }
    }
    stack.push(...[...node.children].reverse());
  }
  const ranks = { next: 0 };
  const assignRanks = (layer: Layer): void => {
    for (const child of layer.children.values()) assignRanks(child);
    layer.rank = ranks.next++;
  };
  assignRanks(root);

  const hintLayer = new Layer(null);
  hintLayer.rank = -1;

  // Per-element matching is shared by both worlds.
  const matchCache = new Map<Element, { block: Block; specificity: Specificity }[]>();
  const matches = (element: Element): { block: Block; specificity: Specificity }[] => {
    const cached = matchCache.get(element);
    if (cached !== undefined) return cached;
    const found = new Map<Block, Specificity>();
    const keys = [element.name.toLowerCase(), '*'];
    const id = element.attribs.id;
    if (id !== undefined && id !== '') keys.push(`#${id}`);
    for (const name of (element.attribs.class ?? '').split(/[\t\n\f\r ]+/))
      if (name !== '') keys.push(`.${name}`);
    for (const key of new Set(keys)) {
      for (const { block, selector } of index.get(key) ?? []) {
        const previous = found.get(block);
        if (previous !== undefined && compareSpecificity(previous, selector.specificity) >= 0)
          continue;
        if (selector.test(element)) found.set(block, selector.specificity);
      }
    }
    const list = [...found].map(([block, specificity]) => ({ block, specificity }));
    const hints = presentationalHints(element.name, element.attribs);
    if (hints !== '') {
      list.push({
        block: {
          declarations: toDeclarations(parseStyleAttribute(hints)),
          layer: hintLayer,
          conditional: false,
          order: -1,
          origin: 'hint',
        },
        specificity: [0, 0, 0],
      });
    }
    const inline = element.attribs.style;
    if (inline !== undefined) {
      list.push({
        block: {
          declarations: toDeclarations(parseStyleAttribute(inline)),
          layer: root,
          conditional: false,
          order: order + 1,
          origin: 'inline',
        },
        specificity: [0, 0, 0],
      });
    }
    matchCache.set(element, list);
    return list;
  };

  /** Precedence, highest wins: origin and importance, style attribute, layer, specificity, order. */
  const keyOf = (
    block: Block,
    decl: Decl,
    specificity: Specificity,
    position: number,
  ): number[] => {
    let tier: number;
    if (block.origin === 'ua') tier = decl.important ? 4 : 0;
    else if (block.origin === 'animation') tier = 2;
    else tier = decl.important ? 3 : 1;
    const layer = block.origin === 'ua' ? 0 : decl.important ? -block.layer.rank : block.layer.rank;
    return [tier, block.origin === 'inline' ? 1 : 0, layer, ...specificity, block.order, position];
  };

  interface Candidate {
    decl: Decl;
    key: number[];
    layer: Layer;
    origin: Block['origin'];
  }

  const candidatesFor = (
    list: { block: Block; specificity: Specificity }[],
    world: World,
  ): Map<string, Candidate[]> => {
    const byProperty = new Map<string, Candidate[]>();
    for (const { block, specificity } of list) {
      if (block.conditional && world === 0) continue;
      for (const [position, decl] of block.declarations.entries()) {
        const candidate = {
          decl,
          key: keyOf(block, decl, specificity, position),
          layer: block.layer,
          origin: block.origin,
        };
        const existing = byProperty.get(decl.property);
        if (existing === undefined) byProperty.set(decl.property, [candidate]);
        else existing.push(candidate);
      }
    }
    for (const candidates of byProperty.values())
      candidates.sort((a, b) => compareKeys(b.key, a.key));
    return byProperty;
  };

  /** The winning declaration after `revert` and `revert-layer` roll back. */
  const winner = (candidates: Candidate[] | undefined): Decl | null => {
    if (candidates === undefined) return null;
    let skipOrigin: 'author' | null = null;
    let skipLayer: { layer: Layer; tier: number } | null = null;
    for (const candidate of candidates) {
      const author = candidate.origin !== 'ua';
      if (skipOrigin !== null && author) continue;
      if (
        skipLayer !== null &&
        candidate.layer === skipLayer.layer &&
        candidate.key[0] === skipLayer.tier
      )
        continue;
      if (candidate.decl.wide === 'revert') {
        skipOrigin = 'author';
        if (!author) return null;
        continue;
      }
      if (candidate.decl.wide === 'revert-layer') {
        skipLayer = { layer: candidate.layer, tier: candidate.key[0] as number };
        continue;
      }
      return candidate.decl;
    }
    return null;
  };

  interface Computed {
    style: Style;
    custom: Map<string, ComponentValue[] | null>;
  }

  const worlds: Map<Element, Computed>[] = [new Map(), new Map()];
  const parentOf = (element: Element): Element | null =>
    element.parent?.type === 'tag' ||
    element.parent?.type === 'script' ||
    element.parent?.type === 'style'
      ? (element.parent as Element)
      : null;

  const rootFontSize: [number, number] = [16, 16];
  const lengthContext = (element: Element, style: Style, world: World): Context => ({
    em: style.fontSize,
    rem: rootFontSize[world],
    viewportWidth: environment.width,
    viewportHeight: environment.height,
    percent: 'length',
    element,
  });

  const registrationCache: (Map<string, Registration> | undefined)[] = [];
  const registrations = (world: World): Map<string, Registration> => {
    let found = registrationCache[world];
    if (found === undefined) {
      found = new Map();
      for (const name of registered.keys()) {
        const registration = latest(registered.get(name), world);
        if (registration !== undefined) found.set(name, registration);
      }
      registrationCache[world] = found;
    }
    return found;
  };

  const computeCustom = (
    element: Element,
    byProperty: Map<string, Candidate[]>,
    parent: Map<string, ComponentValue[] | null> | null,
    world: World,
  ): Map<string, ComponentValue[] | null> => {
    const declared = [...byProperty.keys()].filter((name) => name.startsWith('--'));
    const active = registrations(world);
    const nonInherited = [...active].filter(([, registration]) => !registration.inherits);
    if (declared.length === 0 && nonInherited.length === 0 && parent !== null) return parent;
    const result = new Map(parent ?? []);
    for (const [name, registration] of nonInherited) result.set(name, registration.initial);
    for (const [name, registration] of active) {
      if (!result.has(name)) result.set(name, registration.initial);
    }
    const resolving = new Set<string>();
    const resolved = new Map<string, ComponentValue[] | null>();
    const get = (name: string): ComponentValue[] | null => {
      if (resolved.has(name)) return resolved.get(name) ?? null;
      const decl = winner(byProperty.get(name));
      if (decl === null) return result.get(name) ?? null;
      if (resolving.has(name)) return null;
      resolving.add(name);
      let value: ComponentValue[] | null;
      const registration = active.get(name);
      const inherited = parent?.get(name) ?? registration?.initial ?? null;
      if (decl.wide === 'initial') value = registration?.initial ?? null;
      else if (decl.wide === 'inherit') value = inherited;
      else if (decl.wide !== null)
        value = registration?.inherits === false ? (registration.initial ?? null) : inherited;
      else value = substitute(decl.value as ComponentValue[], substitutionContext(element, get));
      resolving.delete(name);
      resolved.set(name, value);
      return value;
    };
    for (const name of declared) result.set(name, get(name));
    return result;
  };

  const substitutionContext = (
    element: Element,
    custom: (name: string) => ComponentValue[] | null,
  ): SubstitutionContext => ({
    custom,
    attribute: (name) => element.attribs[name],
    environment,
    supports: (nodes) => evaluateSupportsPrelude(supportsArgument(nodes)),
  });

  const resolveDecl = (
    decl: Decl,
    element: Element,
    custom: Map<string, ComponentValue[] | null>,
  ): unknown => {
    if (decl.pending === null) return decl.value;
    const substituted = substitute(
      decl.pending.raw,
      substitutionContext(element, (name) => custom.get(name) ?? null),
    );
    if (substituted === null) return undefined;
    const parsed = parseProperty(decl.pending.source, substituted, quirks);
    return parsed === null ? undefined : (parsed as Record<string, unknown>)[decl.property];
  };

  const animationBlocks = (
    element: Element,
    byProperty: Map<string, Candidate[]>,
    custom: Map<string, ComponentValue[] | null>,
    world: World,
  ): Candidate[][] => {
    const read = <K extends Longhand>(property: K): Values[K] => {
      const decl = winner(byProperty.get(property));
      const value =
        decl === null || decl.wide !== null ? undefined : resolveDecl(decl, element, custom);
      return (value ?? LONGHANDS[property].initial) as Values[K];
    };
    const names = read('animation-name');
    if (names.every((name) => name === null || name === '')) return [];
    const fills = read('animation-fill-mode');
    const counts = read('animation-iteration-count');
    const directions = read('animation-direction');
    const states = read('animation-play-state');
    const out: Candidate[][] = [];
    names.forEach((name, position) => {
      if (name === null || name === '') return;
      const frames = latest(keyframes.get(name), world);
      if (frames === undefined) return;
      const pick = <T>(list: T[]): T => list[position % list.length] as T;
      const fill = pick(fills);
      const count = pick(counts);
      const direction = pick(directions);
      const reversed = direction === 'reverse' || direction === 'alternate-reverse';
      let offset: number | null = null;
      if (pick(states) === 'paused') offset = reversed ? 1 : 0;
      else if (
        (fill === 'forwards' || fill === 'both') &&
        count !== 'infinite' &&
        Number.isInteger(count)
      ) {
        if (count === 0) offset = reversed ? 1 : 0;
        else if (direction === 'normal') offset = 1;
        else if (direction === 'reverse') offset = 0;
        else {
          const endsForward = count % 2 === 1;
          offset = direction === 'alternate' ? (endsForward ? 1 : 0) : endsForward ? 0 : 1;
        }
      }
      if (offset === null) return;
      const block: Block = {
        declarations: [],
        layer: root,
        conditional: false,
        order: position,
        origin: 'animation',
      };
      for (const frame of frames) {
        if (frame.offsets.includes(offset)) block.declarations.push(...frame.declarations);
      }
      out.push(
        block.declarations.map((decl, at) => ({
          decl,
          key: [2, 0, 0, 0, 0, 0, position, at],
          layer: root,
          origin: 'animation',
        })),
      );
    });
    return out;
  };

  const compute = (element: Element, world: World): Computed => {
    const cache = worlds[world] as Map<Element, Computed>;
    const known = cache.get(element);
    if (known !== undefined) return known;
    const parentElement = parentOf(element);
    const parent = parentElement === null ? null : compute(parentElement, world);
    const parentStyle = parent?.style ?? INITIAL_STYLE;
    const byProperty = candidatesFor(matches(element), world);
    const custom = computeCustom(element, byProperty, parent?.custom ?? null, world);

    for (const animation of animationBlocks(element, byProperty, custom, world)) {
      for (const candidate of animation) {
        const list = byProperty.get(candidate.decl.property);
        if (list === undefined) byProperty.set(candidate.decl.property, [candidate]);
        else {
          list.push(candidate);
          list.sort((a, b) => compareKeys(b.key, a.key));
        }
      }
    }

    const specified = <K extends Longhand>(property: K): Values[K] | 'inherit' | 'initial' => {
      const decl = winner(byProperty.get(property));
      const definition = LONGHANDS[property];
      if (decl === null) return definition.inherited ? 'inherit' : 'initial';
      if (decl.wide === 'inherit') return 'inherit';
      if (decl.wide === 'initial') return 'initial';
      if (decl.wide !== null) return definition.inherited ? 'inherit' : 'initial';
      const value = resolveDecl(decl, element, custom);
      if (value === undefined) return definition.inherited ? 'inherit' : 'initial';
      return value as Values[K];
    };

    const style: Style = { ...INITIAL_STYLE };
    const font = specified('font-size');
    if (font === 'inherit') style.fontSize = parentStyle.fontSize;
    else if (font === 'initial') style.fontSize = 16;
    else if (font.kind === 'px') style.fontSize = font.px;
    else if (font.kind === 'scale') style.fontSize = parentStyle.fontSize * font.factor;
    else {
      const px = resolveLength(font.expr, {
        em: parentStyle.fontSize,
        rem: parentElement === null ? 16 : rootFontSize[world],
        viewportWidth: environment.width,
        viewportHeight: environment.height,
        percent: 'length',
        basis: parentStyle.fontSize,
        element,
      });
      style.fontSize = typeof px === 'number' ? Math.max(0, px) : parentStyle.fontSize;
    }
    if (parentElement === null) rootFontSize[world] = style.fontSize;
    const ctx = lengthContext(element, style, world);

    const length = (value: Offset | Size | Expr, inherited: Length): Length => {
      if (value === 'auto') return 'auto';
      if (typeof value === 'string') return inherited;
      const px: Resolved | null = resolveLength(value, ctx);
      return px === null ? inherited : px;
    };
    const plain = <K extends Longhand>(
      property: K,
      inheritedValue: Values[K],
      initialValue: Values[K],
    ): Values[K] => {
      const value = specified(property);
      if (value === 'inherit') return inheritedValue;
      if (value === 'initial') return initialValue;
      return value;
    };

    style.display = plain('display', parentStyle.display, INITIAL_STYLE.display);
    style.visibility = plain('visibility', parentStyle.visibility, 'visible');
    style.contentVisibility = plain('content-visibility', parentStyle.contentVisibility, 'visible');
    style.position = plain('position', parentStyle.position, 'static');
    style.whiteSpaceCollapse = plain(
      'white-space-collapse',
      parentStyle.whiteSpaceCollapse,
      'collapse',
    );
    style.textWrapMode = plain('text-wrap-mode', parentStyle.textWrapMode, 'wrap');

    const opacity = specified('opacity');
    if (opacity === 'inherit') style.opacity = parentStyle.opacity;
    else if (opacity !== 'initial') {
      const value = resolveNumber(opacity, ctx);
      style.opacity = typeof value === 'number' ? Math.min(1, Math.max(0, value)) : 1;
    }
    const filter = specified('filter');
    if (filter === 'inherit') style.filterOpacity = parentStyle.filterOpacity;
    else if (filter !== 'initial') {
      style.filterOpacity = filter.reduce((product, amount) => {
        const value = resolveNumber(amount, ctx);
        return product * (typeof value === 'number' ? Math.min(1, Math.max(0, value)) : 1);
      }, 1);
    }
    const zoom = specified('zoom');
    if (zoom === 'inherit') style.zoom = parentStyle.zoom;
    else if (zoom !== 'initial' && zoom !== 'normal') {
      const value = resolveNumber(zoom, ctx);
      style.zoom = typeof value === 'number' && value > 0 ? value : 1;
    }

    const resolveArg = (expr: Expr): number | 'unknown' => {
      if (expr.op === 'value' && expr.unit === '') return expr.value;
      const asLength = resolveLength(expr, ctx);
      if (asLength !== null) return asLength;
      const asAngle = resolveAngle(expr, ctx);
      if (asAngle !== null) return asAngle;
      const asNumber = resolveNumber(expr, ctx);
      return asNumber ?? 'unknown';
    };
    const transforms: ResolvedTransform[] = [];
    const translate = specified('translate');
    if (translate !== 'inherit' && translate !== 'initial' && translate !== 'none') {
      transforms.push({
        name: 'translate3d',
        args: [0, 1, 2].map((at) =>
          translate[at] === undefined ? 0 : resolveArg(translate[at] as Expr),
        ),
      });
    }
    const rotate = specified('rotate');
    if (rotate !== 'inherit' && rotate !== 'initial' && rotate !== 'none') {
      if (rotate.axis !== 'other') {
        transforms.push({
          name: rotate.axis === 'z' ? 'rotate' : `rotate${rotate.axis}`,
          args: [resolveArg(rotate.angle)],
        });
      }
    }
    const scale = specified('scale');
    if (scale !== 'inherit' && scale !== 'initial' && scale !== 'none') {
      const x = resolveNumber(scale[0] as Expr, ctx) ?? 'unknown';
      const y = scale[1] === undefined ? x : (resolveNumber(scale[1], ctx) ?? 'unknown');
      transforms.push({ name: 'scale', args: [x, y] });
    }
    const transform = specified('transform');
    if (transform !== 'inherit' && transform !== 'initial') {
      for (const fn of transform) transforms.push({ name: fn.name, args: fn.args.map(resolveArg) });
    }
    style.transform = transforms;

    const size = (
      property: 'width' | 'height' | 'max-width' | 'max-height',
      initial: 'auto' | 'none',
    ): Style['width'] => {
      const value = specified(property);
      if (value === 'inherit') {
        const key = (
          {
            width: 'width',
            height: 'height',
            'max-width': 'maxWidth',
            'max-height': 'maxHeight',
          } as const
        )[property];
        return parentStyle[key];
      }
      if (value === 'initial') return initial;
      if (value === 'auto' || value === 'none' || value === 'intrinsic') return value;
      const px = resolveLength(value, ctx);
      return px === null ? initial : px;
    };
    style.width = size('width', 'auto');
    style.height = size('height', 'auto');
    style.maxWidth = size('max-width', 'none');
    style.maxHeight = size('max-height', 'none');

    let overflowX = plain('overflow-x', parentStyle.overflowX, 'visible');
    let overflowY = plain('overflow-y', parentStyle.overflowY, 'visible');
    const scrolls = (value: Values['overflow-x']): boolean =>
      value === 'hidden' || value === 'scroll' || value === 'auto';
    if (scrolls(overflowX) || scrolls(overflowY)) {
      if (overflowX === 'visible') overflowX = 'auto';
      else if (overflowX === 'clip') overflowX = 'hidden';
      if (overflowY === 'visible') overflowY = 'auto';
      else if (overflowY === 'clip') overflowY = 'hidden';
    }
    style.overflowX = overflowX;
    style.overflowY = overflowY;

    const clip = specified('clip');
    if (clip === 'inherit') style.clip = parentStyle.clip;
    else if (clip !== 'initial' && clip !== 'auto')
      style.clip = clip.map((edge) => length(edge, 'unknown'));
    style.clipPath = plain('clip-path', parentStyle.clipPath, 'none');

    const offset = (
      property: 'top' | 'right' | 'bottom' | 'left' | 'margin-left' | 'margin-top' | 'text-indent',
      fallback: Length,
      inheritedValue: Length,
    ): Length => {
      const value = specified(property);
      if (value === 'inherit') return inheritedValue;
      if (value === 'initial') return fallback;
      return length(value, 'unknown');
    };
    style.top = offset('top', 'auto', parentStyle.top);
    style.right = offset('right', 'auto', parentStyle.right);
    style.bottom = offset('bottom', 'auto', parentStyle.bottom);
    style.left = offset('left', 'auto', parentStyle.left);
    style.marginLeft = offset('margin-left', 0, parentStyle.marginLeft);
    style.marginTop = offset('margin-top', 0, parentStyle.marginTop);
    style.textIndent = offset('text-indent', 0, parentStyle.textIndent);
    style.contain = plain('contain', parentStyle.contain, INITIAL_STYLE.contain);
    style.intrinsicHeight = plain('contain-intrinsic-height', parentStyle.intrinsicHeight, false);

    const computed: Computed = { style, custom };
    cache.set(element, computed);
    return computed;
  };

  // Compute in tree order, iteratively, so that deep documents cannot overflow the stack.
  const queue: Element[] = elementChildren(document);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const element = queue[cursor] as Element;
    compute(element, 0);
    if (conditionalRules) compute(element, 1);
    if (element.name !== 'template') queue.push(...elementChildren(element));
  }

  return {
    worlds: conditionalRules ? 2 : 1,
    warnings,
    quirks,
    style: (element, world) => compute(element, conditionalRules ? world : 0).style,
    context: (element, world) =>
      lengthContext(element, compute(element, conditionalRules ? world : 0).style, world),
  };
}

function parseMedia(media: string | undefined): ComponentValue[] {
  return media === undefined ? [] : parseComponentValues(media);
}
