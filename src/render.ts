/**
 * The render tree both extraction modes produce, and the one place that turns
 * it into text and findings. Static mode builds the tree from the cascade;
 * browser mode builds it inside the page. Sharing the assembly is what makes
 * the two modes return the same text for the same rendering.
 */
import type { HiddenReason, HiddenText } from './types.js';
import { MAY_CONTAIN_INVISIBLE, type Removal, stripInvisible } from './unicode.js';

/** How white space in a text run is processed (CSS `white-space-collapse`). */
export type Space =
  | 'collapse'
  | 'preserve'
  | 'preserve-breaks'
  | 'preserve-spaces'
  | 'break-spaces';

/**
 * How a box contributes line structure: `paragraph` is a `<p>`, which
 * innerText separates by a blank line; `row` and `cell` are table parts.
 */
export type Layout = 'inline' | 'block' | 'paragraph' | 'row' | 'cell';

export interface Verdict {
  reason: HiddenReason;
  selector: string;
  detail: string;
}

export type RenderNode =
  /** `origin` names the element a visible text belongs to, for findings about invisible characters in it. */
  | { kind: 'text'; text: string; space: Space; hidden: Verdict | null; origin?: string }
  | { kind: 'break' }
  | { kind: 'box'; layout: Layout; children: RenderNode[] };

const COLLAPSIBLE = /[\t\n\f\r ]+/g;

/** Accumulates text with innerText-style line structure. */
class Builder {
  private out = '';
  /** Line breaks required before the next content, merged by maximum. */
  private breaks = 0;
  private space = false;

  private atLineStart(): boolean {
    return this.out === '' || this.out.endsWith('\n');
  }

  private flush(): void {
    if (this.breaks > 0 && this.out !== '') this.out += '\n'.repeat(this.breaks);
    else if (this.space && !this.atLineStart() && !this.out.endsWith('\t')) this.out += ' ';
    this.breaks = 0;
    this.space = false;
  }

  require(count: number): void {
    this.breaks = Math.max(this.breaks, count);
    this.space = false;
  }

  lineBreak(): void {
    this.flush();
    this.out += '\n';
  }

  tab(): void {
    this.flush();
    this.out += '\t';
  }

  text(value: string, space: Space): void {
    if (space === 'collapse' || space === 'preserve-breaks') {
      const lines = space === 'collapse' ? [value] : value.split('\n');
      lines.forEach((line, index) => {
        if (index > 0) this.lineBreak();
        const collapsed = line.replace(COLLAPSIBLE, ' ');
        const content = collapsed.trim();
        if (content === '') {
          if (collapsed !== '') this.space = true;
          return;
        }
        if (collapsed.startsWith(' ')) this.space = true;
        this.flush();
        this.out += content;
        this.space = collapsed.endsWith(' ');
      });
      return;
    }
    if (value === '') return;
    this.flush();
    // preserve-spaces keeps spaces and tabs but turns segment breaks into spaces.
    this.out += space === 'preserve-spaces' ? value.replace(/\r\n|[\n\r\f]/g, ' ') : value;
  }

  result(): string {
    return this.out.replace(/[\t\n ]+$/, '');
  }
}

/** Collapses white space for a finding's text. */
export function squash(text: string): string {
  return text.replace(COLLAPSIBLE, ' ').trim();
}

/** What each kind of removal is called, for one and for several. */
const INVISIBLE_DETAIL: Record<Removal['kind'], [string, string]> = {
  tag: ['Unicode tag character', 'Unicode tag characters'],
  'variation-selector': ['variation selector', 'variation selectors'],
  'zero-width': ['zero-width character', 'zero-width characters'],
  bidi: ['bidirectional control', 'bidirectional controls'],
};

/** Turns render trees into the visible text and the hidden findings, in document order. */
export function assemble(roots: readonly RenderNode[]): { text: string; hidden: HiddenText[] } {
  const builder = new Builder();
  const findings = new Map<string, HiddenText>();
  const report = (text: string, { reason, selector, detail }: Verdict): void => {
    if (text === '') return;
    const key = `${selector}\u0000${reason}\u0000${detail}`;
    const existing = findings.get(key);
    if (existing === undefined) findings.set(key, { text, reason, selector, detail });
    else existing.text += ` ${text}`;
  };

  // A joiner or selector at the edge of a text node is judged by the visible text around it.
  const visible: Extract<RenderNode, { kind: 'text' }>[] = [];
  const collect = (node: RenderNode): void => {
    if (node.kind === 'text') {
      if (node.hidden === null) visible.push(node);
    } else if (node.kind === 'box') {
      for (const child of node.children) collect(child);
    }
  };
  for (const root of roots) collect(root);
  let cursor = 0;
  let last: number | undefined;

  const visit = (node: RenderNode, cellIndex: number): void => {
    if (node.kind === 'break') {
      builder.lineBreak();
      return;
    }
    if (node.kind === 'text') {
      if (node.hidden === null) {
        cursor += 1;
        let { text } = node;
        if (MAY_CONTAIN_INVISIBLE.test(text)) {
          const stripped = stripInvisible(text, last, visible[cursor]?.text.codePointAt(0));
          text = stripped.text;
          for (const removal of stripped.removals) {
            const [one, many] = INVISIBLE_DETAIL[removal.kind];
            report(squash(removal.text), {
              reason: 'invisible-unicode',
              selector: node.origin ?? ':root',
              detail: `${removal.count} ${removal.count === 1 ? one : many}`,
            });
          }
        }
        if (text !== '') {
          const end = text.length - 1;
          const unit = text.charCodeAt(end);
          last = unit >= 0xdc00 && unit <= 0xdfff && end > 0 ? text.codePointAt(end - 1) : unit;
        }
        builder.text(text, node.space);
        return;
      }
      report(squash(node.text), node.hidden);
      return;
    }
    const { layout, children } = node;
    if (layout === 'cell' && cellIndex > 0) builder.tab();
    const breaks = layout === 'paragraph' ? 2 : layout === 'block' || layout === 'row' ? 1 : 0;
    if (breaks > 0) builder.require(breaks);
    let cells = 0;
    for (const child of children) {
      visit(child, cells);
      if (child.kind === 'box' && child.layout === 'cell') cells += 1;
    }
    if (breaks > 0) builder.require(breaks);
  };

  for (const root of roots) visit(root, 0);
  return { text: builder.result(), hidden: [...findings.values()] };
}
