/**
 * Characters that render as nothing but that models read: Unicode tag
 * characters, variation-selector runs, zero-width and bidirectional controls.
 * They are removed from visible text, and what they encoded is decoded for the
 * report wherever an encoding is known.
 */

export type InvisibleKind = 'tag' | 'variation-selector' | 'zero-width' | 'bidi';

export interface Removal {
  kind: InvisibleKind;
  /** The decoded payload, or the removed code points in `U+XXXX` form. */
  text: string;
  count: number;
}

/** Cheap pre-check: whether a string may contain anything this module removes. */
export const MAY_CONTAIN_INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: every member is an escaped code point, matched alone under the u flag.
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E01EF}\u{1D173}-\u{1D17A}\u{1BCA0}-\u{1BCA3}]/u;

const BIDI = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

function isZeroWidth(code: number): boolean {
  return (
    code === 0x034f ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x17b4 ||
    code === 0x17b5 ||
    code === 0x180e ||
    code === 0x200b ||
    (code >= 0x2060 && code <= 0x2065) ||
    (code >= 0x206a && code <= 0x206f) ||
    code === 0x3164 ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0x1bca0 && code <= 0x1bca3)
  );
}

const isTag = (code: number): boolean => code >= 0xe0000 && code <= 0xe007f;

/** Variation selectors: VS1–VS16, the Mongolian free variation selectors, and VS17–VS256. */
const isVariationSelector = (code: number): boolean =>
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0x180b && code <= 0x180d) ||
  code === 0x180f ||
  (code >= 0xe0100 && code <= 0xe01ef);

const isJoiner = (code: number): boolean => code === 0x200c || code === 0x200d;

/** A neighbour that a joiner can act on: anything outside ASCII that is not itself invisible. */
function joinable(code: number | undefined): boolean {
  if (code === undefined || code < 0x80) return false;
  return (
    !isTag(code) &&
    !isZeroWidth(code) &&
    !BIDI.has(code) &&
    !isJoiner(code) &&
    !/\s/u.test(String.fromCodePoint(code))
  );
}

/** The tag sequences of the three emoji flags Unicode recommends: England, Scotland, Wales. */
const FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'];

const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

function codePoints(codes: number[]): string {
  const shown = codes.slice(0, 64).map(hex).join(' ');
  return codes.length > 64 ? `${shown} …` : shown;
}

/** Bytes encoded one per variation selector: VS1–VS16 are 0–15, VS17–VS256 are 16–255. */
function decodeSelectors(codes: number[]): string {
  const bytes = codes
    .map((code) => (code >= 0xe0100 ? code - 0xe0100 + 16 : code - 0xfe00))
    .filter((byte) => byte >= 0 && byte <= 255);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Removes invisible characters, returning the cleaned text and one removal per kind. */
export function stripInvisible(input: string): { text: string; removals: Removal[] } {
  const codes = Array.from(input, (character) => character.codePointAt(0) as number);
  const kept: number[] = [];
  const output: string[] = [];
  const tags: number[] = [];
  const selectors: number[][] = [];
  const zeroWidth: number[] = [];
  const bidi: number[] = [];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] as number;

    if (isTag(code)) {
      let end = index;
      while (end < codes.length && isTag(codes[end] as number)) end += 1;
      const run = codes.slice(index, end);
      const spelled = run
        .slice(0, -1)
        .map((tag) => String.fromCodePoint(tag - 0xe0000))
        .join('');
      const flag =
        kept[kept.length - 1] === 0x1f3f4 &&
        run[run.length - 1] === 0xe007f &&
        FLAG_TAGS.includes(spelled);
      if (flag) kept.push(...run);
      else tags.push(...run);
      index = end - 1;
      continue;
    }

    if (isVariationSelector(code)) {
      let end = index;
      while (end < codes.length && isVariationSelector(codes[end] as number)) end += 1;
      const run = codes.slice(index, end);
      const previous = kept[kept.length - 1];
      // One presentation selector right after a base character is ordinary emoji or text style.
      const presentation =
        run.length === 1 &&
        (code === 0xfe0e || code === 0xfe0f) &&
        previous !== undefined &&
        !/\s/u.test(String.fromCodePoint(previous));
      if (presentation) kept.push(code);
      else selectors.push(run);
      index = end - 1;
      continue;
    }

    if (isJoiner(code)) {
      const single = !isJoiner(codes[index + 1] ?? 0) && !isJoiner(kept[kept.length - 1] ?? 0);
      if (single && joinable(kept[kept.length - 1]) && joinable(codes[index + 1])) kept.push(code);
      else zeroWidth.push(code);
      continue;
    }

    if (code === 0x00ad) continue; // A soft hyphen is typography, not a payload: removed silently.
    if (BIDI.has(code)) bidi.push(code);
    else if (isZeroWidth(code)) zeroWidth.push(code);
    else kept.push(code);
  }

  const removals: Removal[] = [];
  if (tags.length > 0) {
    const decoded = tags
      .map((tag) => tag - 0xe0000)
      .filter((ascii) => ascii >= 0x20 && ascii < 0x7f)
      .map((ascii) => String.fromCharCode(ascii))
      .join('');
    removals.push({
      kind: 'tag',
      text: decoded === '' ? codePoints(tags) : decoded,
      count: tags.length,
    });
  }
  if (selectors.length > 0) {
    const all = selectors.flat();
    const decoded = selectors
      .filter((run) => run.length > 1)
      .map(decodeSelectors)
      .join(' ');
    const printable = Array.from(decoded)
      .filter((character) => {
        const code = character.codePointAt(0) as number;
        return code >= 0x20 && code !== 0x7f && code !== 0xfffd;
      })
      .join('')
      .trim();
    removals.push({
      kind: 'variation-selector',
      text: printable === '' ? codePoints(all) : printable,
      count: all.length,
    });
  }
  if (zeroWidth.length > 0)
    removals.push({ kind: 'zero-width', text: codePoints(zeroWidth), count: zeroWidth.length });
  if (bidi.length > 0) removals.push({ kind: 'bidi', text: codePoints(bidi), count: bidi.length });

  for (const code of kept) output.push(String.fromCodePoint(code));
  return { text: output.join(''), removals };
}
