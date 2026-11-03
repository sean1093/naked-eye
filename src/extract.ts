/**
 * Static mode: walks the parsed document with the computed styles of every
 * element and builds the render tree, deciding for each text node whether a
 * human would see it.
 */
import type { AnyNode, Document, Element, ParentNode } from 'domhandler';
import { createStyleEngine, type Style, type StyleEngine, type World } from './css/cascade.js';
import { DepthExceededError, parseHtml } from './dom.js';
import { assemble, type Layout, type RenderNode, type Space, type Verdict } from './render.js';
import type { ExtractOptions, ExtractResult, HiddenReason } from './types.js';
import { own } from './util.js';
import {
  clipDetail,
  clipPathDetail,
  isSized,
  scaleOf,
  transformOf,
  zeroSizeDetail,
} from './visibility.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Hidden by the user-agent sheet: their text is reported as never rendered. */
const NEVER_RENDERED: Record<string, true> = {
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
const FALLBACK: Record<string, true> = {
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
const SVG_HIDDEN: Record<string, true> = {
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

/** SVG text content elements: text inside them is painted. */
const SVG_TEXT: Record<string, true> = { text: true, tspan: true, textPath: true };

/** Reasons after which the hidden elements generate no boxes, so they add no line structure. */
const BOXLESS: Partial<Record<HiddenReason, true>> = {
  'display-none': true,
  'not-rendered': true,
  collapsed: true,
};

interface Limits {
  minFontSize: number;
  minOpacity: number;
  offScreenDistance: number;
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
  opacity: 1,
  scale: 1,
  shiftX: 0,
  shiftY: 0,
};

const isElement = (node: AnyNode): node is Element =>
  node.type === 'tag' || node.type === 'script' || node.type === 'style';

const CSS_IDENT = /^-?[_a-zA-Z][\w-]*$/;

function createSelector(): (node: ParentNode | null) => string {
  const cache = new WeakMap<Element, string>();
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
      const siblings =
        parent === null
          ? []
          : parent.children.filter((child) => isElement(child) && child.name === node.name);
      const step =
        siblings.length > 1 ? `${node.name}:nth-of-type(${siblings.indexOf(node) + 1})` : node.name;
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
    else if (node.name === 'optgroup') stack.push(...[...node.children].reverse());
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
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0)
      throw new TypeError(`${name} must be a finite, non-negative number`);
  }
  return limits;
}

class Extractor {
  private readonly selectorOf = createSelector();
  private readonly worlds: World[];
  private readonly rootClipsX: boolean;
  private readonly rootClipsY: boolean;

  constructor(
    private readonly engine: StyleEngine,
    private readonly limits: Limits,
    root: Element | undefined,
  ) {
    this.worlds = engine.worlds === 2 ? [0, 1] : [0];
    // Content pushed beyond the right or bottom edge can be scrolled to, unless
    // the root clips that axis.
    const body = root?.children.find(
      (child): child is Element => isElement(child) && child.name === 'body',
    );
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

  /** The frame an element passes to its content, in one world. */
  private enter(element: Element, style: Style, parent: Frame, scope: Scope): Frame {
    if (parent.subtree !== null) return parent;
    const frame: Frame = { ...parent };
    const hide = (reason: HiddenReason, detail: string): Frame => ({
      ...frame,
      subtree: this.verdict(reason, element, detail),
    });
    const { name, namespace } = element;

    if (namespace === SVG_NAMESPACE && own(SVG_HIDDEN, name) === true)
      return hide('not-rendered', `SVG <${name}> content`);
    if (style.display.kind === 'none') {
      // Code and document metadata, not text: dropped without a finding.
      if (
        name === 'script' ||
        name === 'style' ||
        (namespace === HTML_NAMESPACE && (name === 'head' || name === 'title'))
      ) {
        return { ...hide('not-rendered', `<${name}>`), silent: true };
      }
      if (own(NEVER_RENDERED, name) === true) return hide('not-rendered', `<${name}> content`);
      if (element.attribs.hidden !== undefined) return hide('display-none', 'hidden attribute');
      if (element.name === 'dialog') return hide('display-none', 'closed <dialog>');
      if (element.attribs.popover !== undefined)
        return hide('display-none', 'popover that is not open');
      return hide('display-none', 'display: none');
    }

    if (style.visibility !== 'visible') {
      frame.visibility =
        parent.visibility ??
        this.verdict('visibility-hidden', element, `visibility: ${style.visibility}`);
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

    const matrix = sized ? transformOf(style) : null;
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
        return hide('off-screen', detail);
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
        ? (parent.font ?? this.verdict('font-size', element, `font-size: ${px(size)}`))
        : null;

    const blockContainer =
      boxed &&
      (blockified ||
        (style.display.kind === 'box' &&
          (style.display.outer !== 'inline' || style.display.inner === 'flow-root')) ||
        style.display.kind === 'internal');
    if (blockContainer) {
      const indent = numeric(style.textIndent);
      frame.indent =
        indent !== null && indent <= -this.limits.offScreenDistance
          ? this.verdict('off-screen', element, `text-indent: ${px(indent)}`)
          : null;
    }
    return frame;
  }

  private layoutOf(element: Element, style: Style, scope: Scope): Layout {
    if (element.name === 'p') return 'paragraph';
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
      frame.subtree ?? graphics ?? frame.visibility ?? frame.font ?? frame.indent;
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
        out.push({ kind: 'text', text: node.data, space, hidden: this.textVerdict(frames, scope) });
        continue;
      }
      if (node.type === 'root') {
        out.push(...this.build(node.children, frames, scope, parentStyle));
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
    const frames = this.worlds.map((world) =>
      this.enter(element, styles[world] as Style, parentFrames[world] as Frame, scope),
    );
    const first = frames[0] as Frame;
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

    const hideChildren = (reason: HiddenReason, detail: string): Frame[] => {
      const verdict = this.verdict(reason, element, detail);
      return frames.map((frame) =>
        frame.subtree === null ? { ...frame, subtree: verdict } : frame,
      );
    };

    let children: RenderNode[];
    if (element.name === 'template') {
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
    return { kind: 'box', layout, children };
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
      warnings: [{ code: 'document-too-deep', message: error.message }],
    };
  }

  const engine = createStyleEngine(document, {
    environment: {
      width: viewport.width,
      height: viewport.height,
      colorScheme: options.colorScheme ?? 'light',
    },
    stylesheets: options.stylesheets ?? {},
  });
  const root = document.children.find(
    (child): child is Element => isElement(child) && child.name === 'html',
  );
  const extractor = new Extractor(engine, limits, root);
  const frames = engine.worlds === 2 ? [ROOT_FRAME, ROOT_FRAME] : [ROOT_FRAME];
  const tree = extractor.build(
    document.children,
    frames,
    { svgGraphics: null, svgText: false, flexItem: false },
    null,
  );
  const { text, hidden } = assemble(tree);
  return { text, hidden, warnings: [...engine.warnings] };
}
