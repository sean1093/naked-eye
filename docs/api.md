# API reference

`naked-eye` has two entry points, and both return the same
[`ExtractResult`](#extractresult).

| Import | Function | Where it runs |
|---|---|---|
| `naked-eye` | [`extractVisible(html, options?)`](#extractvisiblehtml-options) | Any JavaScript runtime: no browser, no network, no Node.js built-ins. |
| `naked-eye/browser` | [`extractVisibleFromPage(page, options?)`](#extractvisiblefrompagepage-options) | Node.js, against a page open in Playwright or Puppeteer. |

Both entry points ship as ESM and CommonJS with type declarations, and export
the result types listed below.

## Contents

- [extractVisible(html, options?)](#extractvisiblehtml-options)
- [ExtractOptions](#extractoptions)
- [extractVisibleFromPage(page, options?)](#extractvisiblefrompagepage-options)
- [BrowserOptions](#browseroptions)
- [PageLike](#pagelike)
- [ExtractResult](#extractresult)
- [HiddenText](#hiddentext)
- [HiddenReason](#hiddenreason)
- [GeneratedText](#generatedtext)
- [Warning and WarningCode](#warning-and-warningcode)

## extractVisible(html, options?)

```ts
import { extractVisible } from 'naked-eye';

function extractVisible(html: string, options?: ExtractOptions): ExtractResult;
```

Parses `html` with a spec-compliant HTML parser, computes the CSS cascade of
its `<style>` elements, `style` attributes and any style sheets you supply,
and returns the text a sighted human would see at the configured viewport.
Scripts never run and nothing is fetched.

`html` may be a whole document or a fragment; a fragment is parsed as the body
of an otherwise empty document.

Throws a `TypeError` when an option is invalid: a threshold that is negative or
not finite, or a viewport dimension that is not positive. It does not throw on
hostile input: a document nested deeper than any real page returns empty text
with a `document-too-deep` warning.

## ExtractOptions

| Option | Type | Default | Meaning |
|---|---|---|---|
| `viewport` | `{ width: number; height: number }` | `{ width: 1280, height: 800 }` | The viewport media queries and viewport units are evaluated against. |
| `colorScheme` | `'light' \| 'dark'` | `'light'` | The `prefers-color-scheme` media feature, and the canvas color for pages that opt into dark mode. |
| `stylesheets` | `Record<string, string>` | `{}` | CSS text for `<link rel="stylesheet">` and `@import`, keyed by the URL exactly as written in the document. Sheets you do not supply are listed in `warnings`. |
| `minFontSize` | `number` | `4` | Text smaller than this many CSS pixels, after zoom and scaling, is hidden. |
| `minOpacity` | `number` | `0.1` | Text whose effective opacity is below this is hidden. |
| `offScreenDistance` | `number` | `1000` | Text moved this many CSS pixels or more out of the page is hidden. |
| `minContrast` | `number` | `1.5` | Text whose WCAG contrast ratio against its background is below this is hidden. White on white is 1. |

## extractVisibleFromPage(page, options?)

```ts
import { extractVisibleFromPage } from 'naked-eye/browser';

function extractVisibleFromPage(page: PageLike, options?: BrowserOptions): Promise<ExtractResult>;
```

Runs the extraction inside a page that Playwright or Puppeteer already has
open, as one script evaluated in the page. Verdicts come from the browser's own
computed styles and layout: the client rectangles of each text node, clipping
by ancestors, the document's scrollable area, and what is painted behind the
text. It walks open shadow roots and same-origin frames; cross-origin frames are
listed in `warnings`.

The page is read, never changed. The script runs in the page's main world, where
the page's own scripts can interfere with it; the
[threat model](threat-model.md#browser-mode) explains what that means.

Rejects with a `TypeError` when an option is invalid, and with whatever error
the page handle raises when the page cannot be evaluated (for example, a
closed page).

## BrowserOptions

| Option | Type | Default | Meaning |
|---|---|---|---|
| `minFontSize` | `number` | `4` | Text smaller than this many CSS pixels, after zoom and scaling, is hidden. |
| `minOpacity` | `number` | `0.1` | Text whose effective opacity is below this is hidden. |
| `minContrast` | `number` | `1.5` | Text whose WCAG contrast ratio against its background is below this is hidden. |

The viewport, color scheme and style sheets are the page's own, and off-screen
text is decided by the document's real scrollable area, so there is nothing to
configure for them.

## PageLike

```ts
interface PageLike {
  evaluate(pageFunction: string): Promise<unknown>;
}
```

What browser mode needs from a page handle. Playwright's `Page` and `Frame` and
Puppeteer's `Page` satisfy it, so neither library is a dependency of
`naked-eye`.

## ExtractResult

```ts
interface ExtractResult {
  text: string;
  hidden: HiddenText[];
  generated: GeneratedText[];
  warnings: Warning[];
}
```

| Field | Contents |
|---|---|
| `text` | The text a human would see. Block boundaries are line breaks, paragraphs are separated by a blank line, table cells by tabs, as `innerText` lays them out. |
| `hidden` | Every piece of text that was removed, in document order. |
| `generated` | Text in `text` that CSS `::before` and `::after` put on screen rather than the DOM holds, in document order. |
| `warnings` | What the extractor could not evaluate or chose not to render. |

## HiddenText

```ts
interface HiddenText {
  text: string;
  reason: HiddenReason;
  selector: string;
  detail: string;
}
```

| Field | Contents |
|---|---|
| `text` | The removed text, with white space collapsed. For invisible Unicode, the decoded payload or the removed code points as `U+XXXX`. |
| `reason` | Why it was removed: a [`HiddenReason`](#hiddenreason). |
| `selector` | A CSS selector for the element responsible, or for the pseudo-element, such as `#price::before`. Elements in a shadow tree are named through their host, as in `#card > p`. |
| `detail` | What exactly hid it, such as `font-size: 0px` or `#ffffff on #ffffff, contrast 1.00:1`. A verdict that only rules under an undecidable condition produced says so. |

Text removed for the same reason by the same element is merged into one
finding.

## HiddenReason

| Reason | Removed because |
|---|---|
| `comment` | It is an HTML comment. |
| `not-rendered` | It sits in an element that never renders: `<template>`, `<noscript>`, `<head>` content, fallback content of embedded elements and filled slots, SVG text outside a text element. |
| `display-none` | `display: none`, including the `hidden` attribute, closed dialogs and popovers that are not open. |
| `visibility-hidden` | `visibility: hidden` or `collapse`. |
| `content-visibility` | `content-visibility: hidden`, including `hidden="until-found"`. |
| `collapsed` | It is in the body of a closed `<details>`, or an unselected option of a drop-down `<select>`. |
| `opacity` | Its effective opacity is below `minOpacity`, including `filter: opacity()`. |
| `font-size` | Its effective font size is below `minFontSize`, including `zoom` and scale transforms. |
| `zero-size` | Its box is zero or one pixel wide or tall and clips its overflow. |
| `clipped` | `clip` or `clip-path` removes the whole box, or, in browser mode, an ancestor that clips its overflow cuts it off. |
| `off-screen` | Offsets, margins, `text-indent` or translation move it out of the page. |
| `transparent-text` | It is drawn in a fully transparent color with no visible stroke or shadow. |
| `low-contrast` | Its WCAG contrast against what lies behind it is below `minContrast`. |
| `invisible-unicode` | Its characters render as nothing: tag characters, variation-selector runs, zero-width and bidirectional controls. |
| `unslotted` | It is a shadow host's light content that no `<slot>` accepts. |

## GeneratedText

```ts
interface GeneratedText {
  text: string;
  selector: string;
}
```

`selector` names the pseudo-element, for example `#price::before`.

## Warning and WarningCode

```ts
interface Warning {
  code: WarningCode;
  message: string;
}
```

`message` is meant for people and may change between versions; match on
`code`.

| Code | Mode | Meaning |
|---|---|---|
| `unresolved-stylesheet` | static | A `<link rel="stylesheet">` or `@import` whose CSS was not supplied, so its rules were not applied. |
| `unsupported-selector` | static | A selector the engine cannot evaluate; its rule was skipped. |
| `unknown-condition` | static | Rules under a condition static mode cannot decide, such as `@container` or `:host-context()`, were evaluated both ways. |
| `unsupported-color` | static | A color the engine cannot evaluate; text drawn with it was kept. |
| `unsupported-content` | static | Generated content not rendered as text: counters, images, and text beyond 1,000,000 characters per document. |
| `document-too-deep` | static | The document nests deeper than any real page; nothing was extracted. |
| `cross-origin-frame` | browser | A frame on another origin, whose document the page cannot read; its text is missing from `text` and `hidden`. |
