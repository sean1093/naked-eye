/**
 * Arbitrary substitution functions: `var()`, `attr()`, `env()` and `if()`.
 * A value that contains one is only validated after substitution, at
 * computed-value time, and an invalid result behaves like `unset`.
 */
import {
  type ComponentValue,
  FunctionNode,
  isFunctionNode,
  isSimpleBlockNode,
  parseListOfComponentValues,
  SimpleBlockNode,
} from '@csstools/css-parser-algorithms';
import { TokenType, tokenize } from '@csstools/css-tokenizer';
import {
  type Environment,
  evaluateCondition,
  evaluateMediaCondition,
  type Truth,
} from './conditions.js';
import { identOf, isToken, paren, serialize, significant, tokenOf, trim } from './syntax.js';

const SUBSTITUTIONS: Record<string, true> = { var: true, attr: true, env: true, if: true };

export interface SubstitutionContext {
  /** A computed custom property, or `null` when it is the guaranteed-invalid value. */
  custom: (name: string) => ComponentValue[] | null;
  attribute: (name: string) => string | undefined;
  environment: Environment;
  /** Decides `supports(property: value)` inside `if()`. */
  supports: (nodes: ComponentValue[]) => Truth;
}

export function hasSubstitution(values: readonly ComponentValue[]): boolean {
  for (const node of values) {
    if (isFunctionNode(node)) {
      if (SUBSTITUTIONS[node.getName().toLowerCase()] === true || hasSubstitution(node.value))
        return true;
    } else if (isSimpleBlockNode(node) && hasSubstitution(node.value)) {
      return true;
    }
  }
  return false;
}

/** Splits at the first top-level comma: `[before, after | null]`. */
function firstComma(
  values: readonly ComponentValue[],
): [ComponentValue[], ComponentValue[] | null] {
  const index = values.findIndex((node) => isToken(node, TokenType.Comma));
  return index === -1 ? [[...values], null] : [values.slice(0, index), values.slice(index + 1)];
}

function fallback(
  rest: ComponentValue[] | null,
  ctx: SubstitutionContext,
  depth: number,
): ComponentValue[] | null {
  return rest === null ? null : substituteAll(trim(rest), ctx, depth);
}

const ENV_ZERO = /^(safe-area-(max-)?inset|keyboard-inset)-(top|right|bottom|left|width|height)$/;

function attrValue(
  args: ComponentValue[],
  ctx: SubstitutionContext,
  depth: number,
): ComponentValue[] | null {
  const [head, rest] = firstComma(args);
  const parts = significant(head);
  const nameToken = tokenOf(parts[0]);
  if (nameToken?.[0] !== TokenType.Ident) return null;
  const raw = ctx.attribute((nameToken[4].value as string).toLowerCase());
  const typeNode = parts[1];
  const untyped = typeNode === undefined || identOf(typeNode) === 'raw-string';
  // A missing attribute is the empty string for an untyped attr() with no fallback.
  if (raw === undefined)
    return untyped && rest === null
      ? parseListOfComponentValues(tokenize({ css: '""' }))
      : fallback(rest, ctx, depth);

  if (untyped) {
    const quoted = `"${raw.replace(/["\\\n]/g, (character) => `\\${character === '\n' ? 'a ' : character}`)}"`;
    return parseListOfComponentValues(tokenize({ css: quoted }));
  }
  const parsed = parseListOfComponentValues(tokenize({ css: raw.trim() }));
  if (isFunctionNode(typeNode) && typeNode.getName().toLowerCase() === 'type') {
    return parsed.length > 0 && !hasSubstitution(parsed) ? parsed : fallback(rest, ctx, depth);
  }
  const unit = identOf(typeNode) ?? (isToken(typeNode, TokenType.Delim) ? '%' : undefined);
  const number = significant(parsed);
  const token = tokenOf(number[0]);
  if (unit === undefined || number.length !== 1 || token?.[0] !== TokenType.Number)
    return fallback(rest, ctx, depth);
  if (unit === 'number') return number;
  const css = unit === '%' ? `${token[4].value}%` : `${token[4].value}${unit}`;
  return parseListOfComponentValues(tokenize({ css }));
}

function branchCondition(nodes: ComponentValue[], ctx: SubstitutionContext): Truth {
  if (significant(nodes).length === 1 && identOf(significant(nodes)[0]) === 'else') return true;
  return (
    evaluateCondition(nodes, (node) => {
      if (!isFunctionNode(node)) return 'unknown';
      const inner = trim(node.value);
      switch (node.getName().toLowerCase()) {
        case 'media': {
          const head = significant(inner)[0];
          const bare = head !== undefined && !isSimpleBlockNode(head) && identOf(head) !== 'not';
          return evaluateMediaCondition(bare ? [paren(inner)] : inner, ctx.environment);
        }
        case 'supports':
          return ctx.supports(inner);
        case 'style': {
          const [name, value] = splitColon(inner);
          const property = tokenOf(significant(name)[0]);
          if (property?.[0] !== TokenType.Ident || !(property[4].value as string).startsWith('--'))
            return 'unknown';
          const current = ctx.custom(property[4].value as string);
          if (value === null) return current !== null;
          return current !== null && serialize(trim(current)) === serialize(trim(value));
        }
        default:
          return 'unknown';
      }
    }) ?? false
  );
}

function splitColon(values: ComponentValue[]): [ComponentValue[], ComponentValue[] | null] {
  const index = values.findIndex((node) => isToken(node, TokenType.Colon));
  return index === -1 ? [values, null] : [values.slice(0, index), values.slice(index + 1)];
}

function ifValue(
  args: ComponentValue[],
  ctx: SubstitutionContext,
  depth: number,
): ComponentValue[] | null {
  const branches: ComponentValue[][] = [[]];
  for (const node of args) {
    if (isToken(node, TokenType.Semicolon)) branches.push([]);
    else (branches[branches.length - 1] as ComponentValue[]).push(node);
  }
  for (const branch of branches) {
    if (significant(branch).length === 0) continue;
    const [condition, value] = splitColon(branch);
    if (value === null) return null;
    if (branchCondition(condition, ctx) === true) return substituteAll(trim(value), ctx, depth);
  }
  return null;
}

/** Deeply nested substitutions are a denial-of-service vector; browsers cap them too. */
const MAX_DEPTH = 32;

/**
 * The most component values one substitution may produce. A custom property
 * that references another twice doubles per level; Blink stops at 65,536
 * tokens and treats the declaration as invalid at computed-value time.
 */
const MAX_VALUES = 65_536;

function substituteAll(
  values: readonly ComponentValue[],
  ctx: SubstitutionContext,
  depth: number,
): ComponentValue[] | null {
  if (depth > MAX_DEPTH) return null;
  const out: ComponentValue[] = [];
  for (const node of values) {
    if (isFunctionNode(node)) {
      const name = node.getName().toLowerCase();
      let replacement: ComponentValue[] | null;
      if (name === 'var') {
        const [head, rest] = firstComma(node.value);
        const property = tokenOf(significant(head)[0]);
        if (property?.[0] !== TokenType.Ident || !(property[4].value as string).startsWith('--'))
          return null;
        const value = ctx.custom(property[4].value as string);
        replacement = value === null ? fallback(rest, ctx, depth + 1) : value;
      } else if (name === 'env') {
        const [head, rest] = firstComma(node.value);
        const variable = identOf(significant(head)[0]) ?? '';
        if (ENV_ZERO.test(variable))
          replacement = parseListOfComponentValues(tokenize({ css: '0px' }));
        else if (variable === 'preferred-text-scale')
          replacement = parseListOfComponentValues(tokenize({ css: '1' }));
        else replacement = fallback(rest, ctx, depth + 1);
      } else if (name === 'attr') {
        replacement = attrValue(node.value, ctx, depth + 1);
      } else if (name === 'if') {
        replacement = ifValue(node.value, ctx, depth + 1);
      } else {
        const inner = substituteAll(node.value, ctx, depth + 1);
        if (inner === null) return null;
        out.push(new FunctionNode(node.name, node.endToken, inner));
        continue;
      }
      if (replacement === null || out.length + replacement.length > MAX_VALUES) return null;
      for (const value of replacement) out.push(value);
      continue;
    }
    if (isSimpleBlockNode(node)) {
      const inner = substituteAll(node.value, ctx, depth + 1);
      if (inner === null) return null;
      out.push(new SimpleBlockNode(node.startToken, node.endToken, inner));
      continue;
    }
    out.push(node);
  }
  return out;
}

/** Substitutes every substitution function; `null` is invalid at computed-value time. */
export function substitute(
  values: readonly ComponentValue[],
  ctx: SubstitutionContext,
): ComponentValue[] | null {
  return substituteAll(values, ctx, 0);
}
