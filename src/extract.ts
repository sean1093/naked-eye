/**
 * Static mode: walks the parsed document with the computed styles of every
 * element and builds the render tree, deciding for each text node whether a
 * human would see it.
 */
import type { AnyNode, Document, Element, ParentNode } from 'domhandler';
import { createStyleEngine, type Style, type StyleEngine, type World } from './css/cascade.js';
import {
  contrast,
  DARK_CANVAS,
  LIGHT_CANVAS,
  MAX_SHADOW_BLUR,
  MIN_STROKE,
  over,
  type RGBA,
  toHex,
} from './css/color.js';
import { DepthExceededError, parseHtml } from './dom.js';
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
} from './elements.js';
import {
  assemble,
  hideFirstLetter,
  type Layout,
  type RenderNode,
  type Space,
  type Verdict,
} from './render.js';
import { attachShadowRoots, type ShadowTrees } from './shadow.js';
import type { ExtractOptions, ExtractResult, HiddenReason, Warning } from './types.js';
import { MAY_CONTAIN_INVISIBLE } from './unicode.js';
import { own } from './util.js';
import {
  clipDetail,
  clipPathDetail,
  isSized,
  scaleOf,
  transformOf,
  zeroSizeDetail,
} from './visibility.js';

interface Limits {
  minFontSize: number;
  minOpacity: number;
  offScreenDistance: number;
  minContrast: number;
}

/** What an element passes down to its content, in one world. */
interface Frame {
  /** Everything inside is hidden. */
  subtree: Verdict | null;
  /** Hidden code or metadata: text is dropped without a finding. */
  silent: boolean;
  visibility: Verdict | null;
  font: Verdict | null;
  /** A negative `text-indent` on the nearest block container. */
  indent: Verdict | null;
  /** Moved outside the page with its ancestors; a descendant that moves back is visible again. */
  offscreen: Verdict | null;
  /** The parent's `perspective` distance, for 3D transforms of its children. */
  perspective: number | null;
  /** Text color invisible against the background. */
  color: Verdict | null;
  opacity: number;
  scale: number;
  shiftX: number;
  shiftY: number;
}

/** World-independent context. */
interface Scope {
  /** Inside `<svg>` but outside any text element, text is not painted: the verdict for it. */
  svgGraphics: Verdict | null;
  /** Inside an SVG text content element, where text is painted. */
  svgText: boolean;
  /** The parent is a flex or grid container, so this box is blockified. */
  flexItem: boolean;
}

const ROOT_FRAME: Frame = {
  subtree: null,
  silent: false,
  visibility: null,
  font: null,
  indent: null,
  offscreen: null,
  perspective: null,
  color: null,
  opacity: 1,
  scale: 1,
  shiftX: 0,
  shiftY: 0,
};

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** Boxes `::first-line` and `::first-letter` apply to: block containers. */
function isBlockContainer(style: Style, blockified: boolean): boolean {
  const { display } = style;
  if (display.kind === 'internal')
    return display.role === 'table-cell' || display.role === 'table-caption';
  if (display.kind !== 'box') return false;
  if (display.inner === 'flow-root') return true;
  return display.inner === 'flow' && (blockified || display.outer !== 'inline');
}

const isElement = (node: AnyNode): node is Element =>
  node.type === 'tag' || node.type === 'script' || node.type === 'style';

const CSS_IDENT = /^-?[_a-zA-Z][\w-]*$/;

function createSelector(): (node: ParentNode | null) => string {
  const cache = new WeakMap<Element, string>();
  // nth-of-type positions, computed once per parent so that many siblings stay linear.
  const positions = new WeakMap<ParentNode, Map<Element, [number, number]>>();
  const positionOf = (node: Element, parent: ParentNode): [number, number] => {
    let known = positions.get(parent);
    if (known === undefined) {
      known = new Map();
      const byName = new Map<string, Element[]>();
      for (const child of parent.children) {
        if (!isElement(child)) continue;
        const list = byName.get(child.name);
        if (list === undefined) byName.set(child.name, [child]);
        else list.push(child);
      }
      for (const list of byName.values()) {
        for (const [index, child] of list.entries()) known.set(child, [index + 1, list.length]);
      }
      positions.set(parent, known);
    }
    return known.get(node) ?? [1, 1];
  };
  const selectorOf = (start: ParentNode | null): string => {
    let node: ParentNode | null = start;
    // Content of a <template> belongs to the template.
    while (node !== null && !isElement(node))
      node = node.type === 'root' ? (node.parent as ParentNode | null) : null;
    if (node === null) return ':root';
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    let selector: string;
    const id = node.attribs.id;
    if (id !== undefined && CSS_IDENT.test(id)) {
      selector = `#${id}`;
    } else {
      const parent = node.parent;
      const [index, total] = parent === null ? [1, 1] : positionOf(node, parent);
      const step = total > 1 ? `${node.name}:nth-of-type(${index})` : node.name;
      // The document node ends the path; a template's content fragment continues it.
      const nested =
        parent !== null &&
        (isElement(parent) || (parent.type === 'root' && parent.parent !== null));
      selector = nested ? `${selectorOf(parent)} > ${step}` : step;
    }
    cache.set(node, selector);
    return selector;
  };
  return selectorOf;
}

function px(value: number): string {
  return `${Number.parseFloat(value.toFixed(2))}px`;
}

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The option of a drop-down `<select>` that shows when it is closed. */
function shownOption(select: Element): Element | undefined {
  const options: Element[] = [];
  const stack = [...select.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    if (!isElement(node)) continue;
    if (node.name === 'option') options.push(node);
    else if (node.name === 'optgroup') {
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index] as AnyNode);
    }
  }
  const selected = options.filter((option) => option.attribs.selected !== undefined);
  return (
    selected[selected.length - 1] ??
    options.find((option) => option.attribs.disabled === undefined) ??
    options[0]
  );
}

function isDropDown(select: Element): boolean {
  const size = Number.parseInt(select.attribs.size ?? '', 10);
  return select.attribs.multiple === undefined && !(size > 1);
}

function resolveLimits(options: ExtractOptions): Limits {
  const limits = {
    minFontSize: options.minFontSize ?? 4,
    minOpacity: options.minOpacity ?? 0.1,
    offScreenDistance: options.offScreenDistance ?? 1000,
    minContrast: options.minContrast ?? 1.5,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0)
      throw new TypeError(`${name} must be a finite, non-negative number`);
  }
  return limits;
}

/** Characters `::before` and `::after` may add to a document: one rule matching every element must not multiply into gigabytes. */
const GENERATED_LIMIT = 1_000_000;

class Extractor {
  /** Problems found while rendering, reported with the engine's warnings. */
  readonly warnings: Warning[] = [];
  private generatedBudget = GENERATED_LIMIT;
  private readonly selectorOf = createSelector();
  private readonly worlds: World[];
  private readonly rootClipsX: boolean;
  private readonly rootClipsY: boolean;
  private readonly body: Element | undefined;

  constructor(
    private readonly engine: StyleEngine,
    private readonly limits: Limits,
    private readonly root: Element | undefined,
    private readonly viewport: { width: number; height: number },
    private readonly shadow: ShadowTrees,
  ) {
    this.worlds = engine.worlds === 2 ? [0, 1] : [0];
    // Content pushed beyond the right or bottom edge can be scrolled to, unless
    // the root clips that axis.
    const body = root?.children.find(
      (child): child is Element => isElement(child) && child.name === 'body',
    );
    this.body = body;
    const clipsAxis = (axis: 'overflowX' | 'overflowY'): boolean =>
      [root, body].some(
        (element) =>
          element !== undefined && ['hidden', 'clip'].includes(engine.style(element, 0)[axis]),
      );
    this.rootClipsX = clipsAxis('overflowX');
    this.rootClipsY = clipsAxis('overflowY');
  }

  private verdict(reason: HiddenReason, element: ParentNode | null, detail: string): Verdict {
    return { reason, selector: this.selectorOf(element), detail };
  }

  private readonly backdrops: Map<Element, RGBA[] | null>[] = [new Map(), new Map()];
  private readonly textClips: Map<Element, RGBA | null | undefined>[] = [new Map(), new Map()];
  private readonly painters: (Map<Element, (RGBA | null)[]> | undefined)[] = [undefined, undefined];

  /**
   * Boxes that can paint behind text they are not an ancestor of, by the
   * element under whose content they may lie: large absolutely positioned
   * and fixed boxes with a background, under their containing block, and
   * table columns, under their table. `null` is an image or an unknown color.
   */
  private paintersIn(world: World): Map<Element, (RGBA | null)[]> {
    const known = this.painters[world];
    if (known !== undefined) return known;
    const painters = new Map<Element, (RGBA | null)[]>();
    this.painters[world] = painters;
    // `fade` is the opacity the ancestors apply: a box inside a faded subtree paints faded too.
    const visit = (nodes: AnyNode[], fade: number): void => {
      for (const node of nodes) {
        if (isElement(node) === false) continue;
        const style = this.engine.style(node, world);
        if (style.display.kind === 'none') continue;
        const faded = fade * style.opacity * style.filterOpacity;
        const register = (container: Element | null, painter: Style, alpha: number): void => {
          if (container === null || alpha <= 0) return;
          const { backgroundColor: color } = painter;
          const paint =
            painter.backgroundImage || color === null ? null : { ...color, a: color.a * alpha };
          const list = painters.get(container);
          if (list === undefined) painters.set(container, [paint]);
          else list.push(paint);
        };
        register(this.paintsUnder(node, style, world, false), style, faded);
        // A positioned ::before or ::after is the usual overlay behind a hero's text.
        if (node.namespace === HTML_NAMESPACE && own(NO_PSEUDO, node.name) !== true) {
          for (const which of ['before', 'after'] as const) {
            const generated = this.engine.pseudoStyle(node, which, world);
            if (
              generated !== null &&
              generated.content !== null &&
              generated.display.kind !== 'none'
            ) {
              const alpha = faded * generated.opacity * generated.filterOpacity;
              register(this.paintsUnder(node, generated, world, true), generated, alpha);
            }
          }
        }
        visit(this.flatChildren(node), faded);
      }
    };
    if (this.root !== undefined) visit([this.root], 1);
    return painters;
  }

  /** An element's children in the flat tree: a host's shadow content, a slot's assigned nodes. */
  private flatChildren(element: Element): AnyNode[] {
    const shadowRoot = this.shadow.roots.get(element);
    if (shadowRoot !== undefined) return shadowRoot.fragment.children;
    if (element.name !== 'slot' || this.shadow.scopeOf(element) === null) return element.children;
    const assigned = this.shadow.assignedNodes(element);
    return assigned.length === 0 ? element.children : assigned;
  }

  /**
   * The element whose content a box may paint a background under, or `null`.
   * For a `::before` or `::after` box, `element` is its originating element.
   */
  private paintsUnder(
    element: Element,
    style: Style,
    world: World,
    pseudo: boolean,
  ): Element | null {
    const color = style.backgroundColor;
    if (style.backgroundClipText || style.visibility !== 'visible') return null;
    if (style.backgroundImage === false && color !== null && color.a === 0) return null;
    if (
      pseudo === false &&
      element.namespace === HTML_NAMESPACE &&
      (element.name === 'col' || element.name === 'colgroup')
    ) {
      for (
        let node = this.shadow.flatParent(element);
        node !== null;
        node = this.shadow.flatParent(node)
      )
        if (node.name === 'table') return node;
      return null;
    }
    if (style.position !== 'absolute' && style.position !== 'fixed') return null;
    // A small box, one sized by its content, or one pinned to a corner covers too little to be a page's backdrop.
    const large = (
      size: Style['width'],
      start: Style['left'],
      end: Style['left'],
      viewport: number,
    ) =>
      (start !== 'auto' && end !== 'auto') ||
      size === 'unknown' ||
      (typeof size === 'number' && size >= viewport / 4);
    if (
      large(style.width, style.left, style.right, this.viewport.width) === false ||
      large(style.height, style.top, style.bottom, this.viewport.height) === false
    )
      return null;
    const start = pseudo ? element : this.shadow.flatParent(element);
    for (let node = start; node !== null; node = this.shadow.flatParent(node)) {
      const ancestor = this.engine.style(node, world);
      const containsFixed =
        ancestor.transform.length > 0 || ancestor.perspective !== null || ancestor.contain.paint;
      if (containsFixed || (style.position === 'absolute' && ancestor.position !== 'static'))
        return node;
    }
    return this.root ?? null;
  }

  /**
   * The colors that may lie behind an element's content, at most 16: its
   * background and its ancestors' composited over the canvas, and that stack
   * under each box that may paint beneath an ancestor's content. `null` when
   * an image or an unknown color is in the way: contrast is then unknown.
   */
  private backdropsOf(element: Element, world: World): RGBA[] | null {
    const cache = this.backdrops[world] as Map<Element, RGBA[] | null>;
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    const style = this.engine.style(element, world);
    const parent = this.shadow.flatParent(element);
    const layerOf = (of: Style): { color: RGBA | null; image: boolean } =>
      of.backgroundClipText
        ? { color: TRANSPARENT, image: false }
        : { color: of.backgroundColor, image: of.backgroundImage };
    let layer = layerOf(style);
    if (
      this.body !== undefined &&
      this.root !== undefined &&
      (element === this.root || element === this.body)
    ) {
      const root = layerOf(this.engine.style(this.root, world));
      if (root.image === false && root.color !== null && root.color.a === 0) {
        // A transparent root paints the body's background on the canvas, and the body paints none.
        layer =
          element === this.body
            ? { color: TRANSPARENT, image: false }
            : layerOf(this.engine.style(this.body, world));
      }
    }
    const { color, image } = layer;
    let result: RGBA[] | null = null;
    const below =
      color === null || color.a >= 1
        ? []
        : parent === null
          ? [style.colorScheme === 'dark' ? DARK_CANVAS : LIGHT_CANVAS]
          : this.backdropsOf(parent, world);
    if (image === false && color !== null && below !== null) {
      const stack =
        color.a >= 1
          ? [color]
          : color.a === 0
            ? below
            : below.map((backdrop) => over(color, backdrop));
      const painters = this.paintersIn(world).get(element);
      if (painters === undefined) result = stack;
      else if (painters.includes(null) === false) {
        result = [...stack];
        const seen = new Set(result.map(toHex));
        for (const painter of painters as RGBA[]) {
          for (const backdrop of stack) {
            const composite = over(painter, backdrop);
            const key = toHex(composite);
            if (result.length < 16 && seen.has(key) === false) {
              seen.add(key);
              result.push(composite);
            }
          }
        }
      }
    }
    cache.set(element, result);
    return result;
  }

  /**
   * The ink a background clipped to the text paints the glyphs with, from the
   * element or an ancestor: `null` for an image or an unknown color,
   * `undefined` when there is none.
   */
  private textClipOf(element: Element, world: World): RGBA | null | undefined {
    const cache = this.textClips[world] as Map<Element, RGBA | null | undefined>;
    if (cache.has(element)) return cache.get(element);
    const style = this.engine.style(element, world);
    const parent = this.shadow.flatParent(element);
    let ink: RGBA | null | undefined;
    if (style.backgroundClipText && (style.backgroundImage || style.backgroundColor?.a !== 0))
      ink = style.backgroundImage ? null : style.backgroundColor;
    else ink = parent === null ? undefined : this.textClipOf(parent, world);
    cache.set(element, ink);
    return ink;
  }

  /** Transparent or low-contrast text: every ink that draws the glyphs is invisible. */
  private colorVerdict(
    element: Element,
    style: Style,
    frame: Frame,
    parent: Frame,
    world: World,
    selector: string | undefined,
  ): Verdict | null {
    const inks: (RGBA | null)[] = [];
    const withAlpha = (ink: RGBA | null, alpha: number): RGBA | null =>
      ink === null ? null : { ...ink, a: ink.a * alpha };
    if (element.namespace === SVG_NAMESPACE) {
      if (style.svgFill !== 'none') inks.push(withAlpha(style.svgFill, style.fillOpacity));
      if (style.svgStroke !== 'none' && style.svgStrokeWidth * frame.scale >= MIN_STROKE)
        inks.push(withAlpha(style.svgStroke, style.strokeOpacity));
    } else {
      inks.push(style.textFill);
      // A hairline stroke, or a shadow blurred far wider than the glyphs, draws nothing legible.
      if (style.strokeWidth * frame.scale >= MIN_STROKE) inks.push(style.strokeColor);
      for (const shadow of style.shadows)
        if (shadow.blur <= style.fontSize * MAX_SHADOW_BLUR) inks.push(shadow.color);
      // A pseudo-element's own background clipped to its text paints its glyphs.
      const clip =
        selector !== undefined && style.backgroundClipText
          ? style.backgroundImage
            ? null
            : style.backgroundColor
          : this.textClipOf(element, world);
      if (clip !== undefined) inks.push(clip);
    }
    if (inks.includes(null)) return null;
    const fill = inks[0] ?? TRANSPARENT;
    const painted = (inks as RGBA[])
      .map((ink) => ({ ...ink, a: ink.a * frame.opacity }))
      .filter((ink) => ink.a > 0);
    let verdict: [HiddenReason, string];
    if (painted.length === 0) {
      // Fully transparent ink is invisible over any backdrop, known or not.
      verdict = ['transparent-text', `text color ${toHex(fill)} is fully transparent`];
    } else {
      let backdrops = this.backdropsOf(element, world);
      // A pseudo-element paints its own background behind its glyphs.
      if (selector !== undefined && backdrops !== null && style.backgroundClipText === false) {
        const own = style.backgroundColor;
        if (style.backgroundImage || own === null) return null;
        if (own.a >= 1) backdrops = [own];
        else if (own.a > 0) backdrops = backdrops.map((backdrop) => over(own, backdrop));
      }
      if (backdrops === null) return null;
      let best = 0;
      for (const backdrop of backdrops) {
        for (const ink of painted) best = Math.max(best, contrast(over(ink, backdrop), backdrop));
        if (best >= this.limits.minContrast) return null;
      }
      const behind = backdrops[0] as RGBA;
      verdict = [
        'low-contrast',
        `${toHex(fill)} on ${toHex(behind)}, contrast ${best.toFixed(2)}:1`,
      ];
    }
    const [reason, detail] = verdict;
    if (parent.color?.reason === reason && parent.color.detail === detail) return parent.color;
    return selector === undefined
      ? this.verdict(reason, element, detail)
      : { reason, selector, detail };
  }

  /**
   * The frame an element passes to its content, in one world. For a
   * pseudo-element, `element` is its originating element and `selector` names
   * the pseudo-element in findings.
   */
  private enter(
    element: Element,
    style: Style,
    parent: Frame,
    scope: Scope,
    world: World,
    selector?: string,
  ): Frame {
    const { name, namespace } = element;
    // Code and document metadata, not text: dropped without a finding, hidden or not.
    const code =
      name === 'script' ||
      name === 'style' ||
      (namespace === HTML_NAMESPACE && (name === 'head' || name === 'title'));
    if (parent.subtree !== null)
      return code && !parent.silent ? { ...parent, silent: true } : parent;
    const frame: Frame = { ...parent };
    const at = (reason: HiddenReason, detail: string): Verdict =>
      selector === undefined ? this.verdict(reason, element, detail) : { reason, selector, detail };
    const hide = (reason: HiddenReason, detail: string): Frame => ({
      ...frame,
      subtree: at(reason, detail),
    });

    if (namespace === SVG_NAMESPACE && own(SVG_HIDDEN, name) === true)
      return hide('not-rendered', `SVG <${name}> content`);
    if (style.display.kind === 'none') {
      if (code) return { ...hide('not-rendered', `<${name}>`), silent: true };
      if (own(NEVER_RENDERED, name) === true) return hide('not-rendered', `<${name}> content`);
      if (element.attribs.hidden !== undefined) return hide('display-none', 'hidden attribute');
      if (element.name === 'dialog') return hide('display-none', 'closed <dialog>');
      if (element.attribs.popover !== undefined)
        return hide('display-none', 'popover that is not open');
      return hide('display-none', 'display: none');
    }

    if (style.visibility !== 'visible') {
      frame.visibility =
        parent.visibility ?? at('visibility-hidden', `visibility: ${style.visibility}`);
    } else {
      frame.visibility = null;
    }

    const boxed = style.display.kind !== 'contents';
    const blockified =
      scope.flexItem || style.position === 'absolute' || style.position === 'fixed';
    const sized = boxed && isSized(style, blockified);

    if (boxed) {
      frame.opacity = parent.opacity * style.opacity * style.filterOpacity;
      if (frame.opacity < this.limits.minOpacity) {
        const detail =
          style.filterOpacity < 1 && style.opacity === 1
            ? `filter: opacity(${style.filterOpacity})`
            : `opacity: ${Number.parseFloat(frame.opacity.toFixed(3))}`;
        return hide('opacity', detail);
      }
    }

    if (sized) {
      const zero = zeroSizeDetail(style, blockified);
      if (zero !== null) return hide('zero-size', zero);
      const clip = clipDetail(style);
      if (clip !== null) return hide('clipped', clip);
    }
    if (boxed) {
      const clipPath = clipPathDetail(style, this.engine.context(element, 0));
      if (clipPath !== null) return hide('clipped', clipPath);
    }

    // SVG elements are transformable whatever their display; inline HTML boxes are not.
    const matrix =
      sized || element.namespace === SVG_NAMESPACE ? transformOf(style, parent.perspective) : null;
    frame.perspective = style.perspective;
    frame.scale = parent.scale * style.zoom * (matrix === null ? 1 : scaleOf(matrix));

    if (boxed) {
      const positioned =
        style.position === 'relative' ||
        style.position === 'absolute' ||
        style.position === 'fixed';
      const left = positioned ? numeric(style.left) : null;
      const right = positioned ? numeric(style.right) : null;
      const top = positioned ? numeric(style.top) : null;
      const bottom = positioned ? numeric(style.bottom) : null;
      const offsetX = left ?? (right === null ? 0 : -right);
      const offsetY = top ?? (bottom === null ? 0 : -bottom);
      const marginX = numeric(style.marginLeft) ?? 0;
      const marginY = sized ? (numeric(style.marginTop) ?? 0) : 0;
      const ownX = offsetX + marginX + (matrix?.e ?? 0);
      const ownY = offsetY + marginY + (matrix?.f ?? 0);
      // Accumulated without regard to containing blocks: a fixed box inside an
      // off-screen ancestor also counts as off-screen. Over-hiding is the safe
      // direction; an ancestor transform would make it off-screen anyway.
      frame.shiftX = parent.shiftX + ownX;
      frame.shiftY = parent.shiftY + ownY;
      const limit = this.limits.offScreenDistance;
      const out =
        frame.shiftX <= -limit ||
        frame.shiftY <= -limit ||
        (this.rootClipsX && frame.shiftX >= limit) ||
        (this.rootClipsY && frame.shiftY >= limit);
      if (out) {
        const contributions: [string, number][] = [
          [left === null ? 'right' : 'left', left ?? -(right ?? 0)],
          [top === null ? 'bottom' : 'top', top ?? -(bottom ?? 0)],
          ['margin-left', marginX],
          ['margin-top', marginY],
          ['transform: translateX', matrix?.e ?? 0],
          ['transform: translateY', matrix?.f ?? 0],
        ];
        const [name, value] = contributions.reduce((best, entry) =>
          Math.abs(entry[1]) > Math.abs(best[1]) ? entry : best,
        );
        const detail =
          Math.abs(value) >= limit
            ? `${name}${name.includes(':') ? '' : ':'} ${px(name === 'right' || name === 'bottom' ? -value : value)}`
            : `moved ${px(frame.shiftX)}, ${px(frame.shiftY)} with its ancestors`;
        frame.offscreen = parent.offscreen ?? at('off-screen', detail);
      } else {
        frame.offscreen = null;
      }
    }

    if (boxed && style.contentVisibility === 'hidden') {
      const detail =
        element.attribs.hidden?.toLowerCase() === 'until-found'
          ? 'hidden="until-found"'
          : 'content-visibility: hidden';
      return hide('content-visibility', detail);
    }

    const size = style.fontSize * frame.scale;
    frame.font =
      size < this.limits.minFontSize
        ? (parent.font ?? at('font-size', `font-size: ${px(size)}`))
        : null;

    const blockContainer =
      boxed &&
      (blockified ||
        (style.display.kind === 'box' &&
          (style.display.outer !== 'inline' || style.display.inner === 'flow-root')) ||
        style.display.kind === 'internal');
    if (blockContainer) {
      const indent = numeric(style.textIndent);
      const limit = this.limits.offScreenDistance;
      // A large positive indent is out of reach only when the root clips horizontally.
      frame.indent =
        indent !== null && (indent <= -limit || (this.rootClipsX && indent >= limit))
          ? at('off-screen', `text-indent: ${px(indent)}`)
          : null;
    }
    frame.color = this.colorVerdict(element, style, frame, parent, world, selector);
    return frame;
  }

  private layoutOf(element: Element, style: Style, scope: Scope): Layout {
    const layout = this.layoutOfStyle(style, scope);
    // innerText separates a <p> by a blank line, but only when it is block-level.
    return element.name === 'p' && layout === 'block' ? 'paragraph' : layout;
  }

  private layoutOfStyle(style: Style, scope: Scope): Layout {
    const { display } = style;
    if (display.kind === 'internal') {
      if (display.role === 'table-row') return 'row';
      if (display.role === 'table-cell') return 'cell';
      return display.role.startsWith('ruby') ? 'inline' : 'block';
    }
    if (display.kind !== 'box') return 'inline';
    const blockified =
      scope.flexItem || style.position === 'absolute' || style.position === 'fixed';
    return blockified || display.outer === 'block' ? 'block' : 'inline';
  }

  /** The verdict for text directly inside an element with these frames, combining both worlds. */
  private textVerdict(frames: Frame[], scope: Scope): Verdict | null {
    const graphics = scope.svgText ? null : scope.svgGraphics;
    const decide = (frame: Frame): Verdict | null =>
      frame.subtree ??
      graphics ??
      frame.offscreen ??
      frame.visibility ??
      frame.font ??
      frame.indent ??
      frame.color;
    const first = decide(frames[0] as Frame);
    if (first !== null || frames.length === 1) return first;
    const second = decide(frames[1] as Frame);
    return second === null
      ? null
      : { ...second, detail: `${second.detail} (under a condition static mode cannot decide)` };
  }

  build(
    nodes: readonly AnyNode[],
    frames: Frame[],
    scope: Scope,
    parentStyle: Style | null,
  ): RenderNode[] {
    const out: RenderNode[] = [];
    const space: Space = parentStyle?.whiteSpaceCollapse ?? 'collapse';
    for (const node of nodes) {
      if (node.type === 'comment') {
        out.push({
          kind: 'text',
          text: node.data,
          space: 'collapse',
          hidden: this.verdict('comment', node.parent, 'HTML comment'),
        });
        continue;
      }
      if (node.type === 'text') {
        if ((frames[0] as Frame).silent) continue;
        const hidden = this.textVerdict(frames, scope);
        const origin =
          hidden === null && MAY_CONTAIN_INVISIBLE.test(node.data)
            ? this.selectorOf(node.parent)
            : undefined;
        out.push(
          origin === undefined
            ? { kind: 'text', text: node.data, space, hidden }
            : { kind: 'text', text: node.data, space, hidden, origin },
        );
        continue;
      }
      if (node.type === 'root') {
        for (const child of this.build(node.children, frames, scope, parentStyle)) out.push(child);
        continue;
      }
      if (!isElement(node)) continue;
      out.push(this.element(node, frames, scope));
    }
    return out;
  }

  private element(element: Element, parentFrames: Frame[], scope: Scope): RenderNode {
    const styles = this.worlds.map((world) => this.engine.style(element, world));
    const style = styles[0] as Style;
    const ownFrames = this.worlds.map((world) =>
      this.enter(element, styles[world] as Style, parentFrames[world] as Frame, scope, world),
    );
    const first = ownFrames[0] as Frame;
    const boxless = first.subtree !== null && BOXLESS[first.subtree.reason] === true;
    const layout: Layout = boxless ? 'inline' : this.layoutOf(element, style, scope);

    if (element.name === 'br' && element.namespace !== SVG_NAMESPACE) {
      return first.subtree === null
        ? { kind: 'break' }
        : { kind: 'box', layout: 'inline', children: [] };
    }

    const inner: Scope = {
      svgGraphics: scope.svgGraphics,
      svgText: scope.svgText,
      flexItem:
        style.display.kind === 'box' &&
        (style.display.inner === 'flex' || style.display.inner === 'grid'),
    };
    if (element.namespace === SVG_NAMESPACE) {
      if (own(SVG_TEXT, element.name) === true) {
        inner.svgText = true;
      } else if (element.name === 'foreignObject') {
        inner.svgGraphics = null;
        inner.svgText = false;
      } else if (element.name === 'svg' && !scope.svgText) {
        inner.svgGraphics = this.verdict(
          'not-rendered',
          element,
          'SVG text outside a text element',
        );
      }
    }

    // Without layout, a block's first formatted line may hold all of its text.
    const container =
      first.subtree === null &&
      isBlockContainer(
        style,
        scope.flexItem || style.position === 'absolute' || style.position === 'fixed',
      );
    const line = container ? this.startVerdict(element, ownFrames, scope, 'first-line') : null;
    const frames =
      line === null
        ? ownFrames
        : ownFrames.map((frame) => (frame.subtree === null ? { ...frame, subtree: line } : frame));

    const hideChildren = (reason: HiddenReason, detail: string): Frame[] => {
      const verdict = this.verdict(reason, element, detail);
      return frames.map((frame) =>
        frame.subtree === null ? { ...frame, subtree: verdict } : frame,
      );
    };

    let children: RenderNode[];
    const shadowRoot = this.shadow.roots.get(element);
    if (shadowRoot !== undefined) {
      // A shadow host renders its shadow tree; light children appear only through slots.
      children = this.build(shadowRoot.fragment.children, frames, inner, style);
      const unslotted = this.shadow.unslotted(element);
      if (unslotted.length > 0) {
        const hidden = hideChildren('unslotted', 'light content no <slot> accepts');
        for (const child of this.build(unslotted, hidden, inner, style)) children.push(child);
      }
    } else if (element.name === 'slot' && this.shadow.scopeOf(element) !== null) {
      const assigned = this.shadow.assignedNodes(element);
      children = this.build(
        assigned.length === 0 ? element.children : assigned,
        frames,
        inner,
        style,
      );
      if (assigned.length > 0) {
        // A slot that renders assigned nodes does not render its own children.
        const fallback = hideChildren('not-rendered', 'fallback content of a filled <slot>');
        for (const child of this.build(element.children, fallback, inner, style))
          children.push(child);
      }
    } else if (element.name === 'template') {
      const content = element.children[0];
      children =
        content === undefined
          ? []
          : this.build([content], hideChildren('not-rendered', '<template> content'), inner, style);
    } else if (own(FALLBACK, element.name) === true && element.namespace !== SVG_NAMESPACE) {
      children = this.build(
        element.children,
        hideChildren('not-rendered', `fallback content of <${element.name}>`),
        inner,
        style,
      );
    } else if (element.name === 'details' && element.attribs.open === undefined) {
      const summary = element.children.find(
        (child): child is Element => isElement(child) && child.name === 'summary',
      );
      const collapsed = hideChildren('collapsed', 'closed <details>');
      children = element.children.flatMap((child) =>
        this.build([child], child === summary ? frames : collapsed, inner, style),
      );
    } else if (element.name === 'select' && isDropDown(element)) {
      const shown = shownOption(element);
      const collapsed = hideChildren('collapsed', 'unselected option of a drop-down <select>');
      children = this.buildSelect(element.children, shown, frames, collapsed, inner, style);
    } else {
      children = this.build(element.children, frames, inner, style);
    }
    if (!boxless && element.namespace === HTML_NAMESPACE && own(NO_PSEUDO, element.name) !== true) {
      const before = this.pseudo(element, 'before', frames, inner);
      const after = this.pseudo(element, 'after', frames, inner);
      if (before !== null) children.unshift(before);
      if (after !== null) children.push(after);
    }
    const letter = container ? this.startVerdict(element, frames, scope, 'first-letter') : null;
    if (letter !== null) hideFirstLetter(children, letter);
    return { kind: 'box', layout, children };
  }

  /**
   * The verdict `::first-line` or `::first-letter` styles give a block's text,
   * when they hide text the block's own styles show.
   */
  private startVerdict(
    element: Element,
    frames: Frame[],
    scope: Scope,
    which: 'first-line' | 'first-letter',
  ): Verdict | null {
    if (element.namespace !== HTML_NAMESPACE || this.textVerdict(frames, scope) !== null)
      return null;
    const styles = this.worlds.map((world) => this.engine.pseudoStyle(element, which, world));
    if (styles.every((pseudoStyle) => pseudoStyle === null)) return null;
    const selector = `${this.selectorOf(element)}::${which}`;
    // Only fonts, colors and visibility apply to these boxes, and opacity to ::first-letter:
    // a browser ignores display, position, margins, transforms and clipping on them.
    const verdicts = this.worlds.map((world): Verdict | null => {
      const pseudoStyle = styles[world];
      const frame = frames[world] as Frame;
      if (pseudoStyle === null || pseudoStyle === undefined) return null;
      if (pseudoStyle.visibility !== 'visible') {
        return {
          reason: 'visibility-hidden',
          selector,
          detail: `visibility: ${pseudoStyle.visibility}`,
        };
      }
      const size = pseudoStyle.fontSize * frame.scale;
      if (size < this.limits.minFontSize)
        return { reason: 'font-size', selector, detail: `font-size: ${px(size)}` };
      const opacity = which === 'first-letter' ? pseudoStyle.opacity : 1;
      if (frame.opacity * opacity < this.limits.minOpacity)
        return { reason: 'opacity', selector, detail: `opacity: ${pseudoStyle.opacity}` };
      const inked = { ...frame, opacity: frame.opacity * opacity };
      return this.colorVerdict(element, pseudoStyle, inked, frame, world, selector);
    });
    const [first, second] = verdicts;
    if (first !== null && first !== undefined) return first;
    return second === null || second === undefined
      ? null
      : { ...second, detail: `${second.detail} (under a condition static mode cannot decide)` };
  }

  /**
   * `::before` or `::after`, as a box holding its generated text. Icon-font
   * glyphs in the Private Use Area are pictures, not text, and are dropped. A
   * world in which the box does not exist hides the text, as `display: none`
   * in one world does.
   */
  private pseudo(
    element: Element,
    which: 'before' | 'after',
    frames: Frame[],
    scope: Scope,
  ): RenderNode | null {
    const styles = this.worlds.map((world) => this.engine.pseudoStyle(element, which, world));
    const generates = (style: Style | null | undefined): style is Style =>
      style !== null &&
      style !== undefined &&
      (style.content?.replace(PRIVATE_USE, '') ?? '') !== '';
    const first = styles.find(generates);
    if (first === undefined) return null;
    const text = (first.content as string).replace(PRIVATE_USE, '');
    if (text.length > this.generatedBudget) {
      this.warnings.push({
        code: 'unsupported-content',
        message: `Generated content beyond ${GENERATED_LIMIT} characters was not rendered`,
      });
      this.generatedBudget = 0;
      return null;
    }
    this.generatedBudget -= text.length;
    const selector = `${this.selectorOf(element)}::${which}`;
    const pseudoFrames = this.worlds.map((world) => {
      const style = styles[world];
      const frame = frames[world] as Frame;
      if (generates(style)) return this.enter(element, style, frame, scope, world, selector);
      const missing: Verdict = { reason: 'not-rendered', selector, detail: 'content: none' };
      return frame.subtree === null ? { ...frame, subtree: missing } : frame;
    });
    const subtree = (pseudoFrames[0] as Frame).subtree;
    const layout =
      subtree !== null && BOXLESS[subtree.reason] === true
        ? 'inline'
        : this.layoutOfStyle(first, scope);
    const hidden = this.textVerdict(pseudoFrames, scope);
    return {
      kind: 'box',
      layout,
      children: [
        {
          kind: 'text',
          text,
          space: first.whiteSpaceCollapse,
          hidden,
          origin: selector,
          generated: selector,
        },
      ],
    };
  }

  private buildSelect(
    nodes: readonly AnyNode[],
    shown: Element | undefined,
    frames: Frame[],
    collapsed: Frame[],
    scope: Scope,
    style: Style,
  ): RenderNode[] {
    return nodes.flatMap((node): RenderNode[] => {
      if (isElement(node) && node.name === 'optgroup') {
        return [
          {
            kind: 'box',
            layout: 'inline',
            children: this.buildSelect(node.children, shown, frames, collapsed, scope, style),
          },
        ];
      }
      return this.build([node], node === shown ? frames : collapsed, scope, style);
    });
  }
}

/**
 * Returns the text of an HTML document that a sighted human would see when
 * it is rendered, and a report of everything removed. Static: no layout, no
 * scripts, no network.
 */
export function extractVisible(html: string, options: ExtractOptions = {}): ExtractResult {
  const limits = resolveLimits(options);
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  if (!(viewport.width > 0 && viewport.height > 0))
    throw new TypeError('viewport width and height must be positive');

  let document: Document;
  try {
    document = parseHtml(html);
  } catch (error) {
    if (!(error instanceof DepthExceededError)) throw error;
    return {
      text: '',
      hidden: [],
      generated: [],
      warnings: [{ code: 'document-too-deep', message: error.message }],
    };
  }

  const shadow = attachShadowRoots(document);
  const engine = createStyleEngine(
    document,
    {
      environment: {
        width: viewport.width,
        height: viewport.height,
        colorScheme: options.colorScheme ?? 'light',
      },
      stylesheets: options.stylesheets ?? {},
    },
    shadow,
  );
  const root = document.children.find(
    (child): child is Element => isElement(child) && child.name === 'html',
  );
  const extractor = new Extractor(engine, limits, root, viewport, shadow);
  const frames = engine.worlds === 2 ? [ROOT_FRAME, ROOT_FRAME] : [ROOT_FRAME];
  const tree = extractor.build(
    document.children,
    frames,
    { svgGraphics: null, svgText: false, flexItem: false },
    null,
  );
  const { text, hidden, generated } = assemble(tree);
  return { text, hidden, generated, warnings: [...engine.warnings, ...extractor.warnings] };
}
