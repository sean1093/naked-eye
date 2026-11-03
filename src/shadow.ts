/**
 * Declarative shadow DOM. parse5 leaves `<template shadowrootmode>` as an
 * ordinary template; a browser instead attaches its content as the shadow
 * root of the parent and renders the flat tree: shadow content in place of the
 * host's children, with light children shown only where a `<slot>` accepts
 * them. Light children no slot accepts are not rendered at all.
 */
import type { AnyNode, Document, Element, ParentNode } from 'domhandler';

/** A shadow root: the template's content fragment, and the element hosting it. */
export interface ShadowRoot {
  fragment: ParentNode;
  host: Element;
}

/** A slot and the shadow root it belongs to. */
export interface Slotting {
  slot: Element;
  root: ShadowRoot;
}

export interface ShadowTrees {
  /** Shadow roots by host. */
  readonly roots: ReadonlyMap<Element, ShadowRoot>;
  /** The shadow root an element belongs to, or `null` for the document tree. */
  scopeOf(element: Element): ShadowRoot | null;
  /** The parent in the flat tree: a slotted element's slot, a shadow tree's top-level element's host. */
  flatParent(element: Element): Element | null;
  /** The nodes assigned to a slot. A slot with none renders its own children instead. */
  assignedNodes(slot: Element): AnyNode[];
  /** A host's light children that no slot accepts. */
  unslotted(host: Element): AnyNode[];
  /**
   * The slot a node is assigned to. A slot can itself be assigned to a slot
   * one shadow tree deeper, which then renders the node too.
   */
  assignedSlot(node: AnyNode): Slotting | undefined;
  /**
   * The hosts that expose an element as a part, innermost first, each with
   * the part names it carries there: its `part` attribute for the host of its
   * own tree, then the names each host's `exportparts` forwards one tree out.
   */
  partsOf(element: Element): { host: Element; names: ReadonlySet<string> }[];
}

const isElement = (node: AnyNode | null): node is Element =>
  node !== null && (node.type === 'tag' || node.type === 'script' || node.type === 'style');

/** Elements a shadow root can be attached to: autonomous custom elements and these. */
const HOSTS: Record<string, true> = {
  article: true,
  aside: true,
  blockquote: true,
  body: true,
  div: true,
  footer: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  header: true,
  main: true,
  nav: true,
  p: true,
  section: true,
  span: true,
};

/** Dashed names a custom element may not take, so they cannot host a shadow root either. */
const RESERVED: Record<string, true> = {
  'annotation-xml': true,
  'color-profile': true,
  'font-face': true,
  'font-face-src': true,
  'font-face-uri': true,
  'font-face-format': true,
  'font-face-name': true,
  'missing-glyph': true,
};

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function canHost(element: Element): boolean {
  if (element.namespace !== HTML_NAMESPACE || RESERVED[element.name] === true) return false;
  return HOSTS[element.name] === true || /^[a-z][^\sA-Z]*-[^\sA-Z]*$/.test(element.name);
}

const slotName = (node: AnyNode): string => (isElement(node) ? (node.attribs.slot ?? '') : '');

/** The names an `exportparts` attribute forwards: comma-separated `inner` or `inner: outer`. */
function exported(attribute: string | undefined, names: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const mapping of attribute?.split(',') ?? []) {
    const [inner = '', outer = inner, extra] = mapping.split(':').map((part) => part.trim());
    if (extra !== undefined || !/^[^\s:,]+$/.test(inner) || !/^[^\s:,]+$/.test(outer)) continue;
    if (names.has(inner)) out.add(outer);
  }
  return out;
}

/**
 * Attaches every declarative shadow root in the document, removing the
 * templates from the tree as the HTML parser does, and computes slotting.
 */
export function attachShadowRoots(document: Document): ShadowTrees {
  const roots = new Map<Element, ShadowRoot>();
  const scopes = new Map<Element, ShadowRoot>();
  const assignment = new Map<Element, AnyNode[]>();
  const slotOf = new Map<AnyNode, Slotting>();
  const unassigned = new Map<Element, AnyNode[]>();

  // Attach roots in tree order, including roots declared inside other shadow trees. The walk
  // keeps its own stack: nesting is attacker-controlled.
  const stack: { node: AnyNode; scope: ShadowRoot | null }[] = [];
  const pushChildren = (parent: ParentNode, scope: ShadowRoot | null): void => {
    for (let index = parent.children.length - 1; index >= 0; index -= 1)
      stack.push({ node: parent.children[index] as AnyNode, scope });
  };
  pushChildren(document, null);
  while (stack.length > 0) {
    const { node: child, scope } = stack.pop() as { node: AnyNode; scope: ShadowRoot | null };
    if (!isElement(child)) continue;
    if (scope !== null) scopes.set(child, scope);
    if (child.name !== 'template') {
      pushChildren(child, scope);
      continue;
    }
    const mode = child.attribs.shadowrootmode?.toLowerCase();
    const host = child.parent;
    const content = child.children[0];
    if (
      (mode === 'open' || mode === 'closed') &&
      isElement(host) &&
      canHost(host) &&
      !roots.has(host) &&
      content !== undefined &&
      'children' in content
    ) {
      // The parser drops the template and makes its content the host's shadow root.
      host.children.splice(host.children.indexOf(child), 1);
      content.parent = host;
      const root: ShadowRoot = { fragment: content, host };
      roots.set(host, root);
      pushChildren(content, root);
    }
  }

  // The first slot of each name in tree order takes the host's matching light children. Slots
  // among a nested host's light children belong to this tree too; its shadow tree does not.
  for (const root of roots.values()) {
    const slots = new Map<string, Element>();
    const stack: AnyNode[] = [...root.fragment.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop() as AnyNode;
      if (!isElement(node)) continue;
      if (node.name === 'slot') {
        const name = node.attribs.name ?? '';
        if (!slots.has(name)) slots.set(name, node);
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index] as AnyNode);
    }
    const leftovers: AnyNode[] = [];
    for (const child of root.host.children) {
      const slot =
        child.type === 'text' || isElement(child) ? slots.get(slotName(child)) : undefined;
      if (slot === undefined) {
        leftovers.push(child);
        continue;
      }
      const list = assignment.get(slot);
      if (list === undefined) assignment.set(slot, [child]);
      else list.push(child);
      slotOf.set(child, { slot, root });
    }
    unassigned.set(root.host, leftovers);
  }

  return {
    roots,
    scopeOf: (element) => scopes.get(element) ?? null,
    flatParent: (element) => {
      const slotted = slotOf.get(element);
      if (slotted !== undefined) return slotted.slot;
      const parent = element.parent;
      if (isElement(parent)) return parent;
      const scope = scopes.get(element);
      return scope !== undefined && parent === scope.fragment ? scope.host : null;
    },
    assignedNodes: (slot) => assignment.get(slot) ?? [],
    unslotted: (host) => unassigned.get(host) ?? [],
    assignedSlot: (node) => slotOf.get(node),
    partsOf: (element) => {
      const levels: { host: Element; names: ReadonlySet<string> }[] = [];
      let names = new Set(
        (element.attribs.part ?? '').split(/[\t\n\f\r ]+/).filter((name) => name !== ''),
      );
      for (let host = scopes.get(element)?.host; host !== undefined && names.size > 0; ) {
        levels.push({ host, names });
        names = exported(host.attribs.exportparts, names);
        host = scopes.get(host)?.host;
      }
      return levels;
    },
  };
}
