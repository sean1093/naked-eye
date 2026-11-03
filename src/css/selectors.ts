/**
 * Selector matching for the cascade: css-what parses, css-select matches,
 * and this module computes specificity, splits off pseudo-elements, and
 * decides how pseudo-classes behave for a page judged before any interaction.
 */
import { compile, type Options } from 'css-select';
import { type AttributeSelector, parse, type Selector, SelectorType } from 'css-what';
import type { AnyNode, Element } from 'domhandler';

export type Specificity = readonly [number, number, number];

export interface CompiledSelector {
  test: (element: Element) => boolean;
  specificity: Specificity;
  /** `before`, `after`, ... or `null` when the selector targets the element itself. */
  pseudoElement: string | null;
  /** Index key of the rightmost compound: `#id`, `.class`, a tag name, or `*`. */
  bucket: string;
}

/**
 * Pseudo-classes that cannot match a page that is judged as first rendered:
 * no pointer, focus, fragment, script, fullscreen, media playback or user
 * input. Shadow-tree selectors never match from a document style sheet.
 */
const NEVER: Record<string, true> = {
  'active-view-transition': true,
  'active-view-transition-type': true,
  autofill: true,
  '-webkit-autofill': true,
  blank: true,
  buffering: true,
  current: true,
  focus: true,
  'focus-visible': true,
  'focus-within': true,
  fullscreen: true,
  future: true,
  'has-slotted': true,
  host: true,
  'host-context': true,
  'interest-source': true,
  'interest-target': true,
  'local-link': true,
  modal: true,
  past: true,
  'picture-in-picture': true,
  playing: true,
  'popover-open': true,
  seeking: true,
  stalled: true,
  state: true,
  target: true,
  'target-within': true,
  'user-invalid': true,
  'user-valid': true,
  'volume-locked': true,
  'xr-overlay': true,
};

/** Pseudo-elements browsers accept; any other name makes the whole selector invalid. */
const PSEUDO_ELEMENTS: Record<string, true> = {
  after: true,
  backdrop: true,
  before: true,
  checkmark: true,
  column: true,
  cue: true,
  'details-content': true,
  'file-selector-button': true,
  'first-letter': true,
  'first-line': true,
  'grammar-error': true,
  highlight: true,
  marker: true,
  part: true,
  picker: true,
  'picker-icon': true,
  placeholder: true,
  'scroll-button': true,
  'scroll-marker': true,
  'scroll-marker-group': true,
  'search-text': true,
  selection: true,
  slotted: true,
  'spelling-error': true,
  'target-text': true,
  'view-transition': true,
  'view-transition-group': true,
  'view-transition-image-pair': true,
  'view-transition-new': true,
  'view-transition-old': true,
};

/** Pseudo-classes that take a selector list and count as its most specific member. */
const SELECTOR_ARGUMENT: Record<string, true> = {
  is: true,
  not: true,
  has: true,
  matches: true,
  '-webkit-any': true,
  '-moz-any': true,
};

const COMBINATORS: Record<string, true> = {
  child: true,
  parent: true,
  sibling: true,
  adjacent: true,
  descendant: true,
  'column-combinator': true,
};

function attribute(element: Element, name: string): string | undefined {
  return element.attribs[name];
}

function textContent(node: AnyNode): string {
  if (node.type === 'text') return node.data;
  if ('children' in node) return node.children.map(textContent).join('');
  return '';
}

function isRequiredEmpty(element: Element): boolean {
  if (attribute(element, 'required') === undefined) return false;
  if (element.name === 'textarea') return textContent(element) === '';
  if (element.name === 'select') {
    const options = element.children.filter(
      (child): child is Element => child.type === 'tag' && child.name === 'option',
    );
    const selected =
      options.find((option) => attribute(option, 'selected') !== undefined) ?? options[0];
    return selected === undefined || (attribute(selected, 'value') ?? textContent(selected)) === '';
  }
  if (element.name !== 'input') return false;
  const type = (attribute(element, 'type') ?? 'text').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return attribute(element, 'checked') === undefined;
  if (['hidden', 'button', 'submit', 'reset', 'image', 'range', 'color'].includes(type))
    return false;
  return (attribute(element, 'value') ?? '') === '';
}

const CONTROLS: Record<string, true> = {
  input: true,
  select: true,
  textarea: true,
  button: true,
  output: true,
  object: true,
};

function isInvalid(element: Element): boolean {
  if (CONTROLS[element.name] === true) return isRequiredEmpty(element);
  if (element.name !== 'form' && element.name !== 'fieldset') return false;
  const stack: AnyNode[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    if (node.type !== 'tag') continue;
    if (CONTROLS[node.name] === true && isRequiredEmpty(node)) return true;
    stack.push(...node.children);
  }
  return false;
}

function inRange(element: Element): boolean | null {
  if (element.name !== 'input') return null;
  const type = (attribute(element, 'type') ?? '').toLowerCase();
  if (type !== 'number' && type !== 'range') return null;
  const min = attribute(element, 'min');
  const max = attribute(element, 'max');
  if (min === undefined && max === undefined) return null;
  const value = Number.parseFloat(attribute(element, 'value') ?? '');
  if (Number.isNaN(value)) return true;
  if (min !== undefined && value < Number.parseFloat(min)) return false;
  return !(max !== undefined && value > Number.parseFloat(max));
}

function direction(element: Element): 'ltr' | 'rtl' {
  for (let node: Element | null = element; node !== null; ) {
    const dir = attribute(node, 'dir')?.toLowerCase();
    if (dir === 'rtl') return 'rtl';
    if (dir === 'ltr' || dir === 'auto') return 'ltr';
    node = node.parent?.type === 'tag' ? node.parent : null;
  }
  return 'ltr';
}

/**
 * Pseudo-classes css-select does not know, decided for a page as it is first
 * rendered, with scripts not run and nothing interacted with. Form state is
 * read from the markup: an attacker can make `:invalid` match without any
 * interaction, so it has to be evaluated, not assumed.
 */
const PSEUDOS: Options<AnyNode, Element>['pseudos'] = {
  '-ne-never': () => false,
  defined: (element: Element) => !element.name.includes('-'),
  open: ':is(details, dialog)[open]',
  closed: ':is(details, dialog):not([open])',
  paused: ':is(audio, video)',
  muted: ':is(audio, video)[muted]',
  default: ':is(input:is([type=checkbox i], [type=radio i])[checked], option[selected])',
  indeterminate: 'progress:not([value])',
  'placeholder-shown': (element: Element) => {
    if (attribute(element, 'placeholder') === undefined) return false;
    if (element.name === 'textarea') return textContent(element) === '';
    return element.name === 'input' && (attribute(element, 'value') ?? '') === '';
  },
  invalid: (element: Element) => isInvalid(element),
  valid: (element: Element) =>
    (CONTROLS[element.name] === true || element.name === 'form' || element.name === 'fieldset') &&
    !isInvalid(element),
  'in-range': (element: Element) => inRange(element) === true,
  'out-of-range': (element: Element) => inRange(element) === false,
  dir: (element: Element, value?: string | null) =>
    direction(element) === value?.trim().toLowerCase(),
  heading: ':is(h1, h2, h3, h4, h5, h6)',
};

function isIdSelector(token: AttributeSelector): boolean {
  return token.name === 'id' && token.action === 'equals' && token.ignoreCase === 'quirks';
}

function add(into: [number, number, number], from: Specificity): void {
  into[0] += from[0];
  into[1] += from[1];
  into[2] += from[2];
}

function compare(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function maxOf(list: Selector[][]): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const complex of list) {
    const candidate = specificityOf(complex);
    if (compare(candidate, best) > 0) best = candidate;
  }
  return best;
}

/** Selectors Level 4 specificity of one complex selector. */
export function specificityOf(complex: Selector[]): Specificity {
  const total: [number, number, number] = [0, 0, 0];
  for (const token of complex) {
    if (token.type === 'attribute') {
      total[isIdSelector(token) ? 0 : 1] += 1;
    } else if (token.type === 'tag' || token.type === 'pseudo-element') {
      total[2] += 1;
    } else if (token.type === 'pseudo') {
      if (token.name === 'where') continue;
      if (Array.isArray(token.data) && SELECTOR_ARGUMENT[token.name] === true) {
        add(total, maxOf(token.data));
        continue;
      }
      total[1] += 1;
      if (typeof token.data === 'string' && /^nth-(last-)?child$/.test(token.name)) {
        const of = /\sof\s+(.+)$/is.exec(token.data);
        if (of?.[1] !== undefined) add(total, maxOf(parse(of[1])));
      }
    }
  }
  return total;
}

/** Rewrites pseudo-classes for matching: never-matching states, and `:scope` at the root. */
function rewrite(complex: Selector[]): Selector[] {
  return complex.map((token): Selector => {
    if (token.type !== 'pseudo') return token;
    if (NEVER[token.name] === true)
      return { type: SelectorType.Pseudo, name: '-ne-never', data: null };
    if (token.name === 'scope') return { type: SelectorType.Pseudo, name: 'root', data: null };
    if (Array.isArray(token.data)) return { ...token, data: token.data.map(rewrite) };
    return token;
  });
}

function bucketOf(complex: Selector[], quirks: boolean): string {
  let start = complex.length;
  while (start > 0 && !COMBINATORS[(complex[start - 1] as Selector).type] === true) start -= 1;
  const compound = complex.slice(start);
  if (!quirks) {
    for (const token of compound) {
      if (token.type === 'attribute' && isIdSelector(token)) return `#${token.value}`;
    }
    for (const token of compound) {
      if (
        token.type === 'attribute' &&
        token.name === 'class' &&
        token.action === 'element' &&
        token.ignoreCase === 'quirks'
      ) {
        return `.${token.value}`;
      }
    }
  }
  for (const token of compound) {
    if (token.type === 'tag') return token.name;
  }
  return '*';
}

/** `syntax` is true for a selector no browser accepts, false for one css-select cannot evaluate. */
export type SelectorListResult =
  | { selectors: CompiledSelector[] }
  | { error: string; syntax: boolean };

/**
 * Compiles a selector list. A list a browser would reject as a whole (a
 * syntax error, or a selector css-select cannot evaluate) comes back as an
 * error, so the caller can drop the rule and warn.
 */
export function compileSelectorList(text: string, quirks: boolean): SelectorListResult {
  let list: Selector[][];
  try {
    list = parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), syntax: true };
  }
  const options: Options<AnyNode, Element> = { quirksMode: quirks, pseudos: PSEUDOS };
  const selectors: CompiledSelector[] = [];
  for (const complex of list) {
    for (const token of complex) {
      const known =
        PSEUDO_ELEMENTS[token.type === SelectorType.PseudoElement ? token.name : 'before'] === true;
      if (!known && !/^-(webkit|moz)-/.test((token as { name?: string }).name ?? '')) {
        return {
          error: `Unknown pseudo-element ::${(token as { name: string }).name}`,
          syntax: true,
        };
      }
    }
  }
  try {
    for (const complex of list) {
      const specificity = specificityOf(complex);
      const index = complex.findIndex((token) => token.type === 'pseudo-element');
      let target = complex;
      let pseudoElement: string | null = null;
      if (index !== -1) {
        // Anything after a pseudo-element is a user-action state (`::before:hover`)
        // or another pseudo-element: neither matches before interaction.
        if (index !== complex.length - 1) continue;
        pseudoElement = (complex[index] as { name: string }).name;
        target = complex.slice(0, index);
        const last = target[target.length - 1];
        if (last === undefined || COMBINATORS[last.type] === true)
          target = [...target, { type: SelectorType.Universal, namespace: null }];
      }
      const rewritten = rewrite(target);
      selectors.push({
        test: compile<AnyNode, Element>([rewritten], options),
        specificity,
        pseudoElement,
        bucket: bucketOf(rewritten, quirks),
      });
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), syntax: false };
  }
  return { selectors };
}

export { compare as compareSpecificity };
