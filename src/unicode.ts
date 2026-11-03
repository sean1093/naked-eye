/**
 * Characters that render as nothing but that models read: Unicode tag
 * characters, variation-selector runs, zero-width and bidirectional controls,
 * and the rest of Unicode's default-ignorable code points. They are removed
 * from visible text, and what they encoded is decoded for the report wherever
 * an encoding is known.
 */

type InvisibleKind = 'tag' | 'variation-selector' | 'zero-width' | 'bidi';

export interface Removal {
  kind: InvisibleKind;
  /** The decoded payload, or the removed code points in `U+XXXX` form. */
  text: string;
  count: number;
}

/** Cheap pre-check: whether a string may contain anything this module removes. */
export const MAY_CONTAIN_INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: every member is an escaped code point, matched alone under the u flag.
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\u{E0000}-\u{E0FFF}\u{1D173}-\u{1D17A}\u{1BCA0}-\u{1BCA3}]/u;

const isBidi = (code: number): boolean =>
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** Default-ignorable code points that are neither tags, selectors, joiners nor bidi controls. */
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
    (code >= 0xfff0 && code <= 0xfffb) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0xe0080 && code <= 0xe00ff) ||
    (code >= 0xe01f0 && code <= 0xe0fff)
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

/** Characters with an emoji presentation, which U+FE0E and U+FE0F choose between. */
const EMOJI = /\p{Emoji}/u;
/** What a ZWJ joins in an emoji sequence: a pictograph, modifier or presentation selector, then a pictograph. */
const EMOJI_BEFORE_JOINER = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]|\uFE0F/u;
const EMOJI_AFTER_JOINER = /\p{Extended_Pictographic}/u;
/** Scripts whose shaping ZWJ and ZWNJ control: Arabic-script joining, Indic conjuncts and half forms. */
const JOINING_SCRIPT =
  /[\p{sc=Arab}\p{sc=Syrc}\p{sc=Nkoo}\p{sc=Mong}\p{sc=Deva}\p{sc=Beng}\p{sc=Guru}\p{sc=Gujr}\p{sc=Orya}\p{sc=Taml}\p{sc=Telu}\p{sc=Knda}\p{sc=Mlym}\p{sc=Sinh}\p{sc=Mymr}\p{sc=Khmr}]/u;
/** Bases of standardized variation sequences: mathematical symbols and the scripts that have them. */
const STANDARDIZED_BASE = /[\p{Sm}\p{sc=Han}\p{sc=Mymr}\p{sc=Phag}\p{sc=Mani}\p{sc=Egyp}]/u;

/** A joiner between these two characters changes how they render. */
function joins(before: number | undefined, after: number | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  const left = String.fromCodePoint(before);
  const right = String.fromCodePoint(after);
  return (
    (EMOJI_BEFORE_JOINER.test(left) && EMOJI_AFTER_JOINER.test(right)) ||
    (JOINING_SCRIPT.test(left) && JOINING_SCRIPT.test(right))
  );
}

/**
 * A single selector that picks a glyph variant of its base: an ideographic
 * variation sequence, a standardized variant, or a Mongolian free variation
 * selector. It is typography, not a payload.
 */
function picksGlyph(code: number, before: number | undefined): boolean {
  if (before === undefined) return false;
  const base = String.fromCodePoint(before);
  if (code >= 0xe0100) return /\p{sc=Han}/u.test(base);
  if (code >= 0x180b && code <= 0x180f) return /\p{sc=Mong}/u.test(base);
  return code <= 0xfe0d && STANDARDIZED_BASE.test(base);
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

/**
 * Removes invisible characters, returning the cleaned text and one removal
 * per kind, in the order each kind first occurs. `before` and `after` are the
 * visible characters around the text, which decide whether a joiner or a
 * selector at its edge is kept. Untouched spans are copied, not expanded.
 */
export function stripInvisible(
  input: string,
  before?: number,
  after?: number,
): { text: string; removals: Removal[] } {
  const parts: string[] = [];
  let from = 0;
  let previous = before;
  const tags: number[] = [];
  const selectors: number[][] = [];
  const zeroWidth: number[] = [];
  const bidi: number[] = [];
  const firstAt: Partial<Record<InvisibleKind, number>> = {};
  const remove = (start: number, end: number, kind: InvisibleKind | null): void => {
    if (start > from) parts.push(input.slice(from, start));
    from = end;
    if (kind !== null) firstAt[kind] ??= start;
  };
  /** The code points from `start` while `test` holds, and the index after them. */
  const run = (start: number, test: (code: number) => boolean): [number[], number] => {
    const codes: number[] = [];
    let end = start;
    for (
      let code = input.codePointAt(end);
      code !== undefined && test(code);
      code = input.codePointAt(end)
    ) {
      codes.push(code);
      end += code > 0xffff ? 2 : 1;
    }
    return [codes, end];
  };

  let index = 0;
  while (index < input.length) {
    const code = input.codePointAt(index) as number;
    const size = code > 0xffff ? 2 : 1;

    if (isTag(code)) {
      const [codes, end] = run(index, isTag);
      const spelled = codes
        .slice(0, -1)
        .map((tag) => String.fromCodePoint(tag - 0xe0000))
        .join('');
      const flag =
        previous === 0x1f3f4 && codes[codes.length - 1] === 0xe007f && FLAG_TAGS.includes(spelled);
      if (flag) previous = 0xe007f;
      else {
        remove(index, end, 'tag');
        for (const tag of codes) tags.push(tag);
      }
      index = end;
      continue;
    }

    if (isVariationSelector(code)) {
      const [codes, end] = run(index, isVariationSelector);
      const single = codes.length === 1;
      // One presentation selector after an emoji is ordinary emoji or text style.
      const presentation =
        single &&
        (code === 0xfe0e || code === 0xfe0f) &&
        previous !== undefined &&
        EMOJI.test(String.fromCodePoint(previous));
      if (presentation) previous = code;
      else if (single && picksGlyph(code, previous)) remove(index, end, null);
      else {
        remove(index, end, 'variation-selector');
        selectors.push(codes);
      }
      index = end;
      continue;
    }

    if (isJoiner(code)) {
      const next = index + size < input.length ? input.codePointAt(index + size) : after;
      const lone =
        (next === undefined || isJoiner(next) === false) &&
        (previous === undefined || isJoiner(previous) === false);
      if (lone && joins(previous, next)) previous = code;
      else {
        remove(index, index + size, 'zero-width');
        zeroWidth.push(code);
      }
      index += size;
      continue;
    }

    // A soft hyphen is typography, not a payload: removed silently.
    if (code === 0x00ad) remove(index, index + size, null);
    else if (isBidi(code)) {
      remove(index, index + size, 'bidi');
      bidi.push(code);
    } else if (isZeroWidth(code)) {
      remove(index, index + size, 'zero-width');
      zeroWidth.push(code);
    } else previous = code;
    index += size;
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
      .filter((codes) => codes.length > 1)
      .map(decodeSelectors)
      .join(' ');
    const printable = Array.from(decoded)
      .filter((character) => {
        const value = character.codePointAt(0) as number;
        return value >= 0x20 && value !== 0x7f && value !== 0xfffd;
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
  removals.sort((a, b) => (firstAt[a.kind] ?? 0) - (firstAt[b.kind] ?? 0));

  if (from === 0) return { text: input, removals };
  if (from < input.length) parts.push(input.slice(from));
  return { text: parts.join(''), removals };
}
