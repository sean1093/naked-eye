import type { Document, ParentNode } from 'domhandler';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

/**
 * Deeper than any real page by an order of magnitude. Tree construction
 * scans the stack of open elements for most start tags, so its cost grows
 * with depth times size; browsers cap depth for the same reason (Blink at
 * 512).
 */
export const MAX_DEPTH = 1024;

export class DepthExceededError extends Error {
  constructor() {
    super(`The document nests elements more than ${MAX_DEPTH} deep.`);
    this.name = 'DepthExceededError';
  }
}

/**
 * Parses HTML with the WHATWG algorithm, as a browser with scripting enabled
 * does: `<noscript>` content becomes raw text, tables foster-parent stray
 * text, and a missing doctype puts the document in quirks mode.
 *
 * Throws `DepthExceededError` as soon as the tree grows deeper than
 * `MAX_DEPTH`, which bounds the parser's running time on hostile input.
 */
export function parseHtml(html: string): Document {
  const depths = new WeakMap<object, number>();
  const place = (parent: ParentNode, node: object): void => {
    const depth = (depths.get(parent) ?? 0) + 1;
    if (depth > MAX_DEPTH) throw new DepthExceededError();
    depths.set(node, depth);
  };
  const treeAdapter: typeof adapter = {
    ...adapter,
    appendChild(parent, node) {
      place(parent, node);
      adapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      place(parent, node);
      adapter.insertBefore(parent, node, reference);
    },
  };
  return parse(html, { treeAdapter, scriptingEnabled: true });
}
