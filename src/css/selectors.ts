/**
 * Selector matching for the cascade: css-what parses, css-select matches,
 * and this module computes specificity, splits off pseudo-elements, and
 * decides how pseudo-classes behave for a page judged before any interaction.
 */
import { compile, type Options } from 'css-select';
import { type AttributeSelector, parse, type Selector, SelectorType } from 'css-what';
import type { AnyNode, Element } from 'domhandler';
import { own } from '../util.js';

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

/** The HTML specification's valid e-mail address. */
const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Constraints a control fails as soon as it is parsed, with no interaction:
 * required and empty, an e-mail or URL that does not parse, a number out of
 * range or off its step. `pattern` is not evaluated: a hostile pattern could
 * stall the regular expression engine.
 */
function failsConstraints(element: Element): boolean {
  if (isRequiredEmpty(element)) return true;
  if (element.name !== 'input') return false;
  const type = (attribute(element, 'type') ?? 'text').toLowerCase();
  const value = (attribute(element, 'value') ?? '').trim();
  if (value === '') return false;
  if (type === 'email') {
    const addresses =
      attribute(element, 'multiple') === undefined
        ? [value]
        : value.split(',').map((part) => part.trim());
    return addresses.some((address) => !EMAIL.test(address));
  }
  if (type === 'url') {
    try {
      new URL(value);
      return false;
    } catch {
      return true;
    }
  }
  if (type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    const min = Number.parseFloat(attribute(element, 'min') ?? '');
    const max = Number.parseFloat(attribute(element, 'max') ?? '');
    if (number < min || number > max) return true;
    const stepAttribute = attribute(element, 'step')?.trim().toLowerCase();
    if (stepAttribute === 'any') return false;
    const step = Number.parseFloat(stepAttribute ?? '');
    const size = Number.isFinite(step) && step > 0 ? step : 1;
    const base = Number.isFinite(min) ? min : 0;
    const steps = (number - base) / size;
    return Math.abs(steps - Math.round(steps)) > 1e-9;
  }
  return false;
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
  if (CONTROLS[element.name] === true) return failsConstraints(element);
  if (element.name !== 'form' && element.name !== 'fieldset') return false;
  const stack: AnyNode[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    if (node.type !== 'tag') continue;
    if (CONTROLS[node.name] === true && failsConstraints(node)) return true;
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

/** Strong right-to-left letters: Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms. */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const STRONG = /[\p{L}]/u;

/** `dir=auto` resolves from the first strong character of the text. */
function autoDirection(element: Element): 'ltr' | 'rtl' {
  const match = STRONG.exec(textContent(element));
  return match !== null && RTL.test(match[0]) ? 'rtl' : 'ltr';
}

function direction(element: Element): 'ltr' | 'rtl' {
  for (let node: Element | null = element; node !== null; ) {
    const dir = attribute(node, 'dir')?.toLowerCase();
    if (dir === 'rtl' || dir === 'ltr') return dir;
    if (dir === 'auto') return autoDirection(node);
    node = node.parent?.type === 'tag' ? node.parent : null;
  }
  return 'ltr';
}

/** Input types whose value the user can edit as text. */
const TEXT_INPUTS: Record<string, true> = {
  text: true,
  search: true,
  url: true,
  tel: true,
  email: true,
  password: true,
  date: true,
  month: true,
  week: true,
  time: true,
  'datetime-local': true,
  number: true,
};

function isDisabled(element: Element): boolean {
  if (attribute(element, 'disabled') !== undefined) return true;
  for (let node = element.parent; node !== null && node.type === 'tag'; node = node.parent) {
    if (node.name !== 'fieldset' || attribute(node, 'disabled') === undefined) continue;
    const legend = node.children.find(
      (child): child is Element => child.type === 'tag' && child.name === 'legend',
    );
    let inLegend = false;
    for (
      let up: Element | null = element;
      up !== null && up !== node;
      up = up.parent?.type === 'tag' ? up.parent : null
    ) {
      if (up === legend) inLegend = true;
    }
    if (!inLegend) return true;
  }
  return false;
}

/** `contenteditable` makes an editing host; `false` ends one. */
function isEditable(element: Element): boolean {
  for (
    let node: Element | null = element;
    node !== null;
    node = node.parent?.type === 'tag' ? node.parent : null
  ) {
    const value = attribute(node, 'contenteditable')?.trim().toLowerCase();
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    if (value === 'false') return false;
  }
  return false;
}

/** `:read-write`: a mutable text control, or editable content. `:read-only` is everything else. */
function isReadWrite(element: Element): boolean {
  if (element.name === 'input') {
    const type = (attribute(element, 'type') ?? 'text').trim().toLowerCase();
    const editable = TEXT_INPUTS[type] === true || !Object.hasOwn(INPUT_TYPES, type);
    return editable && attribute(element, 'readonly') === undefined && !isDisabled(element);
  }
  if (element.name === 'textarea')
    return attribute(element, 'readonly') === undefined && !isDisabled(element);
  return isEditable(element);
}

/** Every valid input type; an unknown one falls back to `text`. */
const INPUT_TYPES: Record<string, true> = {
  ...TEXT_INPUTS,
  hidden: true,
  checkbox: true,
  radio: true,
  file: true,
  submit: true,
  image: true,
  reset: true,
  button: true,
  range: true,
  color: true,
};

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
  '-ne-read-write': (element: Element) => isReadWrite(element),
  '-ne-read-only': (element: Element) => !isReadWrite(element),
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

function maxOf(list: Selector[][], nesting: Nesting): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const complex of list) {
    const candidate = specificityOf(complex, nesting);
    if (compare(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * Private pseudo-classes that stand for the enclosing style rule of a nested
 * one, with that rule's specificity (the specificity of `:is(parent)`).
 */
export type Nesting = Record<
  string,
  { test: (element: Element) => boolean; specificity: Specificity }
>;

/** Selectors Level 4 specificity of one complex selector. */
export function specificityOf(complex: Selector[], nesting: Nesting = {}): Specificity {
  const total: [number, number, number] = [0, 0, 0];
  for (const token of complex) {
    if (token.type === 'attribute') {
      total[isIdSelector(token) ? 0 : 1] += 1;
    } else if (token.type === 'tag' || token.type === 'pseudo-element') {
      total[2] += 1;
    } else if (token.type === 'pseudo') {
      if (token.name === 'where') continue;
      const parent = own(nesting, token.name);
      if (parent !== undefined) {
        add(total, parent.specificity);
        continue;
      }
      if (Array.isArray(token.data) && SELECTOR_ARGUMENT[token.name] === true) {
        add(total, maxOf(token.data, nesting));
        continue;
      }
      total[1] += 1;
      if (typeof token.data === 'string' && /^nth-(last-)?child$/.test(token.name)) {
        const of = /\sof\s+(.+)$/is.exec(token.data);
        if (of?.[1] !== undefined) add(total, maxOf(parse(of[1]), nesting));
      }
    }
  }
  return total;
}

const NEVER_TOKEN: Selector = { type: SelectorType.Pseudo, name: '-ne-never', data: null };

/** css-select aliases that do not follow the HTML specification, evaluated by our own pseudo-classes instead. */
const OVERRIDDEN: Record<string, string> = {
  'read-only': '-ne-read-only',
  'read-write': '-ne-read-write',
};

/**
 * css-select's jQuery extensions. Browsers reject them, which drops the whole
 * rule: accepting `.x:parent { display: block }` would reveal what a browser
 * keeps hidden.
 */
const NONSTANDARD: Record<string, true> = {
  contains: true,
  icontains: true,
  parent: true,
  header: true,
  button: true,
  input: true,
  text: true,
  checkbox: true,
  file: true,
  password: true,
  radio: true,
  reset: true,
  image: true,
  submit: true,
  selected: true,
};

/**
 * Rewrites a selector for css-select: states that cannot match become a
 * never-matching pseudo-class, `:scope` is the root, and namespace prefixes
 * become a namespace test (`*|p` matches any `p`; an undeclared prefix is a
 * syntax error).
 */
function rewrite(complex: Selector[], namespaces: Readonly<Record<string, string>>): Selector[] {
  return complex.flatMap((token): Selector[] => {
    if ((token.type === 'tag' || token.type === 'universal') && token.namespace !== null) {
      const { namespace } = token;
      if (namespace === '*') return [{ ...token, namespace: null }];
      const url = namespace === '' ? null : own(namespaces, namespace);
      if (url === undefined) throw new SyntaxError(`Undeclared namespace prefix ${namespace}`);
      return [
        { ...token, namespace: null },
        url === null
          ? NEVER_TOKEN
          : { type: SelectorType.Pseudo, name: '-ne-namespace', data: url },
      ];
    }
    if (token.type !== 'pseudo') return [token];
    if (NONSTANDARD[token.name] === true)
      throw new SyntaxError(`Unknown pseudo-class :${token.name}`);
    if (NEVER[token.name] === true) return [NEVER_TOKEN];
    const replacement = own(OVERRIDDEN, token.name);
    if (replacement !== undefined) return [{ ...token, name: replacement }];
    if (token.name === 'scope') return [{ type: SelectorType.Pseudo, name: 'root', data: null }];
    if (Array.isArray(token.data))
      return [{ ...token, data: token.data.map((inner) => rewrite(inner, namespaces)) }];
    return [token];
  });
}

/**
 * `:is()` and `:where()` take forgiving selector lists: browsers drop the
 * arguments they cannot use and keep the rest, so one junk argument must not
 * invalidate the whole rule.
 */
function forgive(complex: Selector[], check: (selector: Selector[]) => boolean): Selector[] {
  return complex.map((token): Selector => {
    if (token.type !== 'pseudo' || !Array.isArray(token.data)) return token;
    const inner = token.data.map((selector) => forgive(selector, check));
    if (token.name !== 'is' && token.name !== 'where') return { ...token, data: inner };
    const usable = inner.filter(
      (selector) => !selector.some((part) => part.type === 'pseudo-element') && check(selector),
    );
    return usable.length === 0 ? NEVER_TOKEN : { ...token, data: usable };
  });
}

function bucketOf(complex: Selector[], quirks: boolean): string {
  let start = complex.length;
  while (start > 0 && COMBINATORS[(complex[start - 1] as Selector).type] !== true) start -= 1;
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
    // Type selectors are case-insensitive, and elements are indexed by lowercase name.
    if (token.type === 'tag') return token.name.toLowerCase();
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
export function compileSelectorList(
  text: string,
  quirks: boolean,
  nesting: Nesting = {},
  namespaces: Readonly<Record<string, string>> = {},
): SelectorListResult {
  let list: Selector[][];
  try {
    list = parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), syntax: true };
  }
  for (const complex of list) {
    for (const token of complex) {
      if (token.type !== 'pseudo-element') continue;
      if (PSEUDO_ELEMENTS[token.name] !== true && !/^-(webkit|moz)-/.test(token.name)) {
        return { error: `Unknown pseudo-element ::${token.name}`, syntax: true };
      }
    }
  }
  const pseudos: Options<AnyNode, Element>['pseudos'] = {
    ...PSEUDOS,
    '-ne-namespace': (element: Element, url?: string | null) => element.namespace === url,
  };
  for (const [name, parent] of Object.entries(nesting))
    pseudos[name] = (element: Element) => parent.test(element);
  const options: Options<AnyNode, Element> = { quirksMode: quirks, pseudos };
  const compiles = (selector: Selector[]): boolean => {
    try {
      compile<AnyNode, Element>([rewrite(selector, namespaces)], options);
      return true;
    } catch {
      return false;
    }
  };
  const selectors: CompiledSelector[] = [];
  try {
    for (const original of list) {
      const complex = forgive(original, compiles);
      const specificity = specificityOf(complex, nesting);
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
        if (last === undefined || COMBINATORS[last.type] === true) {
          target = [...target, { type: SelectorType.Universal, namespace: null }];
        }
      }
      const rewritten = rewrite(target, namespaces);
      selectors.push({
        test: compile<AnyNode, Element>([rewritten], options),
        specificity,
        pseudoElement,
        bucket: bucketOf(rewritten, quirks),
      });
    }
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    return { error: error instanceof Error ? error.message : String(error), syntax };
  }
  return { selectors };
}

export { compare as compareSpecificity };
