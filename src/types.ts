/** Why a piece of text was removed. */
export type HiddenReason =
  /** An HTML comment. */
  | 'comment'
  /** Inside an element that never renders: `<template>`, `<noscript>`, fallback content, SVG text outside a text element. */
  | 'not-rendered'
  /** `display: none`, including the `hidden` attribute, closed dialogs and unopened popovers. */
  | 'display-none'
  /** `visibility: hidden` or `collapse`. */
  | 'visibility-hidden'
  /** `content-visibility: hidden`, including `hidden="until-found"`. */
  | 'content-visibility'
  /** The body of a closed `<details>`, or an unselected option of a drop-down `<select>`. */
  | 'collapsed'
  /** Effective opacity below `minOpacity`, including `filter: opacity()`. */
  | 'opacity'
  /** Effective font size below `minFontSize`, including `zoom` and scale transforms. */
  | 'font-size'
  /** A box of zero (or one pixel) width or height that clips its overflow. */
  | 'zero-size'
  /** `clip` or `clip-path` that removes the whole box. */
  | 'clipped'
  /** Moved outside the page by offsets, margins, `text-indent` or translation. */
  | 'off-screen'
  /** Drawn in a fully transparent color, with no visible stroke or shadow. */
  | 'transparent-text'
  /** Contrast against the background below `minContrast`, such as white on white. */
  | 'low-contrast';

export interface HiddenText {
  /** The removed text, with whitespace collapsed. */
  text: string;
  reason: HiddenReason;
  /** A CSS selector for the element responsible. */
  selector: string;
  /** What exactly hid it, for example `font-size: 0px`. */
  detail: string;
}

export type WarningCode =
  /** A `<link rel="stylesheet">` or `@import` whose CSS was not supplied, so its rules were not applied. */
  | 'unresolved-stylesheet'
  /** A selector the engine cannot evaluate; its rule was skipped. */
  | 'unsupported-selector'
  /** Rules under a condition that cannot be decided statically were evaluated both ways. */
  | 'unknown-condition'
  /** A color the engine cannot evaluate; text drawn with it was kept. */
  | 'unsupported-color'
  /** The document nests deeper than any real page; nothing was extracted. */
  | 'document-too-deep';

export interface Warning {
  code: WarningCode;
  message: string;
}

export interface ExtractResult {
  /** The text a human would see, with block boundaries as line breaks. */
  text: string;
  /** Everything that was removed, in document order. */
  hidden: HiddenText[];
  warnings: Warning[];
}

export interface ExtractOptions {
  /** The viewport media queries and viewport units are evaluated against. Default `{ width: 1280, height: 800 }`. */
  viewport?: { width: number; height: number };
  /** The `prefers-color-scheme` media feature. Default `'light'`. */
  colorScheme?: 'light' | 'dark';
  /** CSS text for `<link rel="stylesheet">` and `@import`, keyed by the URL exactly as written in the document. */
  stylesheets?: Record<string, string>;
  /** Text smaller than this many CSS pixels, after zoom and scaling, is hidden. Default `4`. */
  minFontSize?: number;
  /** Text whose effective opacity is below this is hidden. Default `0.1`. */
  minOpacity?: number;
  /** Text moved this many CSS pixels or more out of the page is hidden. Default `1000`. */
  offScreenDistance?: number;
  /** Text whose WCAG contrast ratio against its background is below this is hidden. Default `1.5`. */
  minContrast?: number;
}
