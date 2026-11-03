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
  // A template's content fragment is created before the template is attached, so
  // its depth is looked up through the template once its children arrive.
  const owners = new WeakMap<object, object>();
  const depthOf = (node: object): number => {
    const known = depths.get(node);
    if (known !== undefined) return known;
    const owner = owners.get(node);
    return owner === undefined ? 0 : (depths.get(owner) ?? 0) + 1;
  };
  const place = (parent: ParentNode, node: object): void => {
    const depth = depthOf(parent) + 1;
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
    // Template content hangs below its template, so nested templates count as nesting.
    setTemplateContent(template, content) {
      owners.set(content, template);
      adapter.setTemplateContent(template, content);
    },
  };
  return parse(html, { treeAdapter, scriptingEnabled: true });
}
