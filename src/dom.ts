import type { Document } from 'domhandler';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

/**
 * Parses HTML with the WHATWG algorithm, as a browser with scripting enabled
 * does: `<noscript>` content becomes raw text, tables foster-parent stray
 * text, and a missing doctype puts the document in quirks mode.
 */
export function parseHtml(html: string): Document {
  return parse(html, { treeAdapter: adapter, scriptingEnabled: true });
}
