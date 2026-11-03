import { selectOne } from 'css-select';
import type { AnyNode, Element } from 'domhandler';
import {
  createStyleEngine,
  type Style,
  type StyleOptions,
  type World,
} from '../src/css/cascade.js';
import { parseHtml } from '../src/dom.js';

export const DEFAULT_STYLE_OPTIONS: StyleOptions = {
  environment: { width: 1280, height: 800, colorScheme: 'light' },
  stylesheets: {},
};

/** Parses a document and returns its style engine with an element-by-id lookup. */
export function styled(html: string, options: Partial<StyleOptions> = {}) {
  const document = parseHtml(html);
  const engine = createStyleEngine(document, { ...DEFAULT_STYLE_OPTIONS, ...options });
  const element = (id: string): Element => {
    const found = selectOne<AnyNode, Element>(`#${id}`, document);
    if (found === null) throw new Error(`no element #${id}`);
    return found;
  };
  return {
    engine,
    element,
    style: (id: string, world: World = 0): Style => engine.style(element(id), world),
  };
}
