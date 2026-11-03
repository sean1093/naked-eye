/**
 * Rule-level CSS parsing (CSS Syntax Level 3, including nesting) on top of the
 * spec-exact tokenizer and component-value parser from @csstools. The
 * attacker writes the CSS, so this follows the specification's algorithms
 * rather than a regular expression: whatever a browser treats as a rule or a
 * declaration, this does too.
 */
import {
  type ComponentValue,
  isCommentNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseListOfComponentValues,
  SimpleBlockNode,
  stringify,
} from '@csstools/css-parser-algorithms';
import { type CSSToken, TokenType, tokenize } from '@csstools/css-tokenizer';

export type { ComponentValue } from '@csstools/css-parser-algorithms';

export interface Declaration {
  /** Lowercased, except custom properties, which are case-sensitive. */
  name: string;
  value: ComponentValue[];
  important: boolean;
}

export interface StyleRule {
  kind: 'style';
  prelude: ComponentValue[];
  /** Declarations and nested rules in order of appearance. */
  items: BlockItem[];
}

export interface AtRule {
  kind: 'at';
  /** Lowercased, without the `@`. */
  name: string;
  prelude: ComponentValue[];
  /** The contents of the `{}` block, or `null` for a statement. */
  block: ComponentValue[] | null;
}

export type Rule = StyleRule | AtRule;

export type BlockItem =
  | { kind: 'declarations'; declarations: Declaration[] }
  | { kind: 'rule'; rule: Rule };

/**
 * Blocks nested deeper than this are cut short. The component-value parser
 * throws past 512 levels; cutting at the token level instead keeps the rest of
 * the style sheet, as a browser keeps the rest when it drops one declaration.
 */
const MAX_NESTING = 256;

const OPENERS: Partial<Record<TokenType, true>> = {
  [TokenType.OpenParen]: true,
  [TokenType.OpenSquare]: true,
  [TokenType.OpenCurly]: true,
  [TokenType.Function]: true,
};
const CLOSERS: Partial<Record<TokenType, true>> = {
  [TokenType.CloseParen]: true,
  [TokenType.CloseSquare]: true,
  [TokenType.CloseCurly]: true,
};

/** Tokenizes and parses into component values, dropping whatever nests deeper than MAX_NESTING. */
export function parseComponentValues(css: string): ComponentValue[] {
  const tokens: CSSToken[] = [];
  let depth = 0;
  for (const token of tokenize({ css })) {
    const type = token[0];
    if (OPENERS[type] === true) {
      depth += 1;
      if (depth > MAX_NESTING) continue;
    } else if (CLOSERS[type] === true) {
      depth = Math.max(0, depth - 1);
      if (depth >= MAX_NESTING) continue;
    } else if (depth > MAX_NESTING) {
      continue;
    }
    tokens.push(token);
  }
  return parseListOfComponentValues(tokens);
}

/** Parses a style sheet into its top-level rules. */
export function parseStylesheet(css: string): Rule[] {
  return parseRuleList(parseComponentValues(css), true);
}

/** Parses the contents of a `style` attribute: declarations only. */
export function parseStyleAttribute(css: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const item of parseBlockContents(parseComponentValues(css))) {
    if (item.kind === 'declarations') declarations.push(...item.declarations);
  }
  return declarations;
}

export function isToken(node: ComponentValue | undefined, type: TokenType): boolean {
  return node !== undefined && isTokenNode(node) && node.value[0] === type;
}

export function tokenOf(node: ComponentValue | undefined): CSSToken | undefined {
  return node !== undefined && isTokenNode(node) ? node.value : undefined;
}

/** The string value of an ident, string, URL, hash, at-keyword, function or delimiter token. */
export function stringOf(node: ComponentValue | undefined): string | undefined {
  const data = tokenOf(node)?.[4] as { value?: unknown } | undefined;
  return typeof data?.value === 'string' ? data.value : undefined;
}

/** The ident value of a token node, lowercased, or `undefined`. */
export function identOf(node: ComponentValue | undefined): string | undefined {
  const token = tokenOf(node);
  return token?.[0] === TokenType.Ident ? token[4].value.toLowerCase() : undefined;
}

export function isBlank(node: ComponentValue): boolean {
  return isWhitespaceNode(node) || isCommentNode(node);
}

/** The list without whitespace and comments. */
export function significant(values: readonly ComponentValue[]): ComponentValue[] {
  return values.filter((node) => !isBlank(node));
}

/** Trims whitespace and comments from both ends. */
export function trim(values: readonly ComponentValue[]): ComponentValue[] {
  let start = 0;
  let end = values.length;
  while (start < end && isBlank(values[start] as ComponentValue)) start += 1;
  while (end > start && isBlank(values[end - 1] as ComponentValue)) end -= 1;
  return values.slice(start, end);
}

/** Splits on top-level comma tokens. */
export function splitCommas(values: readonly ComponentValue[]): ComponentValue[][] {
  const parts: ComponentValue[][] = [[]];
  for (const node of values) {
    if (isToken(node, TokenType.Comma)) parts.push([]);
    else (parts[parts.length - 1] as ComponentValue[]).push(node);
  }
  return parts;
}

export function serialize(values: readonly ComponentValue[]): string {
  return stringify([values as ComponentValue[]]);
}

/** Wraps component values in a parenthesized block. */
export function paren(inner: ComponentValue[]): SimpleBlockNode {
  const open: CSSToken = [TokenType.OpenParen, '(', -1, -1, undefined];
  const close: CSSToken = [TokenType.CloseParen, ')', -1, -1, undefined];
  return new SimpleBlockNode(open, close, inner);
}

function isCurlyBlock(node: ComponentValue | undefined): node is SimpleBlockNode {
  return (
    node !== undefined && isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenCurly
  );
}

/** Consumes an at-rule starting at `values[start]`; returns it and the next index. */
function consumeAtRule(values: readonly ComponentValue[], start: number): [AtRule, number] {
  const head = tokenOf(values[start]) as CSSToken;
  const name = (head[4] as { value: string }).value.toLowerCase();
  const prelude: ComponentValue[] = [];
  let index = start + 1;
  for (; index < values.length; index += 1) {
    const node = values[index] as ComponentValue;
    if (isToken(node, TokenType.Semicolon)) {
      return [{ kind: 'at', name, prelude: trim(prelude), block: null }, index + 1];
    }
    if (isCurlyBlock(node)) {
      return [{ kind: 'at', name, prelude: trim(prelude), block: node.value }, index + 1];
    }
    prelude.push(node);
  }
  return [{ kind: 'at', name, prelude: trim(prelude), block: null }, index];
}

/**
 * Consumes a qualified rule. Returns `null` for the rule when the input ends,
 * or (when nested) a semicolon arrives, before its block: both are parse
 * errors that drop the rule.
 */
function consumeQualifiedRule(
  values: readonly ComponentValue[],
  start: number,
  nested: boolean,
): [StyleRule | null, number] {
  const prelude: ComponentValue[] = [];
  for (let index = start; index < values.length; index += 1) {
    const node = values[index] as ComponentValue;
    if (nested && isToken(node, TokenType.Semicolon)) return [null, index + 1];
    if (isCurlyBlock(node)) {
      return [
        { kind: 'style', prelude: trim(prelude), items: parseBlockContents(node.value) },
        index + 1,
      ];
    }
    prelude.push(node);
  }
  return [null, values.length];
}

export function parseRuleList(values: readonly ComponentValue[], topLevel: boolean): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  while (index < values.length) {
    const node = values[index] as ComponentValue;
    if (isBlank(node)) {
      index += 1;
      continue;
    }
    if (topLevel && (isToken(node, TokenType.CDO) || isToken(node, TokenType.CDC))) {
      index += 1;
      continue;
    }
    if (isToken(node, TokenType.AtKeyword)) {
      const [rule, next] = consumeAtRule(values, index);
      rules.push(rule);
      index = next;
      continue;
    }
    const [rule, next] = consumeQualifiedRule(values, index, false);
    if (rule !== null) rules.push(rule);
    index = next;
  }
  return rules;
}

/** CSS Syntax "consume a declaration" over the tokens before a top-level `;`. */
function parseDeclaration(values: readonly ComponentValue[]): Declaration | null {
  const list = trim(values);
  const head = tokenOf(list[0]);
  if (head?.[0] !== TokenType.Ident) return null;
  let index = 1;
  while (index < list.length && isBlank(list[index] as ComponentValue)) index += 1;
  if (!isToken(list[index], TokenType.Colon)) return null;

  const rawName = (head[4] as { value: string }).value;
  const custom = rawName.startsWith('--');
  let value = trim(list.slice(index + 1));
  let important = false;

  const tail = significant(value);
  const bang = tail[tail.length - 2];
  const last = tail[tail.length - 1];
  if (isToken(bang, TokenType.Delim) && stringOf(bang) === '!' && identOf(last) === 'important') {
    important = true;
    value = trim(value.slice(0, value.lastIndexOf(bang as ComponentValue)));
  }

  if (!custom) {
    const meaningful = significant(value);
    if (meaningful.some(isCurlyBlock) && meaningful.length > 1) return null;
  }
  return { name: custom ? rawName : rawName.toLowerCase(), value, important };
}

/** CSS Syntax "consume a block's contents": declarations interleaved with nested rules. */
export function parseBlockContents(values: readonly ComponentValue[]): BlockItem[] {
  const items: BlockItem[] = [];
  const pushDeclaration = (declaration: Declaration): void => {
    const last = items[items.length - 1];
    if (last?.kind === 'declarations') last.declarations.push(declaration);
    else items.push({ kind: 'declarations', declarations: [declaration] });
  };

  let index = 0;
  while (index < values.length) {
    const node = values[index] as ComponentValue;
    if (isBlank(node) || isToken(node, TokenType.Semicolon)) {
      index += 1;
      continue;
    }
    if (isToken(node, TokenType.AtKeyword)) {
      const [rule, next] = consumeAtRule(values, index);
      items.push({ kind: 'rule', rule });
      index = next;
      continue;
    }
    let end = index;
    while (end < values.length && !isToken(values[end], TokenType.Semicolon)) end += 1;
    const declaration = parseDeclaration(values.slice(index, end));
    if (declaration !== null) {
      pushDeclaration(declaration);
      index = end + 1;
      continue;
    }
    const [rule, next] = consumeQualifiedRule(values, index, true);
    if (rule !== null) items.push({ kind: 'rule', rule });
    index = next;
  }
  return items;
}
