# Threat model

`naked-eye` turns an HTML document into the text a human would see on screen.
This document defines who it defends against, what its output guarantees, which
hiding techniques each mode handles, and where each mode stops.

## Contents

- [Where it sits](#where-it-sits)
- [Attacker](#attacker)
- [Security goal](#security-goal)
- [Modes](#modes)
- [Hiding techniques](#hiding-techniques)
- [The reverse mismatch](#the-reverse-mismatch)
- [Non-goals](#non-goals)
- [Known limitations](#known-limitations)
- [Choosing a mode](#choosing-a-mode)
- [Reporting a bypass](#reporting-a-bypass)

## Where it sits

An LLM reads HTML that someone else wrote:

- an agent that browses the web, through `fetch` or a headless browser;
- a RAG pipeline that ingests web pages, help-center articles or HTML exports;
- an assistant that summarises or answers HTML email.

A human sees the rendered document: the user who asked for the summary, the
reviewer who approves an action, the author who checks what was indexed. The
model sees whatever text the pipeline extracts. Indirect prompt injection lives
in the gap between the two: instructions that are present in the extracted text
but invisible on screen, so nobody looking at the page can notice, question or
report them.

`naked-eye` closes that gap. It sits between the HTML and the model, and passes
on only the text the human could have seen.

## Attacker

The attacker controls all or part of the HTML: the author of a page, a user who
can post formatted content on someone else's page, the sender of an HTML email,
a compromised third-party widget, or an SEO spammer.

- They can use any HTML, CSS and Unicode they like.
- They cannot change the extraction code or its options.
- In static mode their scripts never run. In browser mode the document is live:
  their scripts run in the page before, during and after extraction.

Their goal is to get text into the model's input that a human would not see.

## Security goal

1. **No hidden text.** Every character in `text` comes from content that a
   sighted human would see on the rendered page: at the configured viewport, in
   the page's initial state before any hover, click or focus, anywhere within
   the page's scrollable area.
2. **Every removal is accounted for.** Text that is in the document but not in
   `text` is reported in `hidden`, with a reason code, a selector and a detail.
   Text that is on screen but not in the DOM is reported in `generated`.
3. **Hostile input stays bounded.** No input makes the extractor crash,
   overflow the stack, or take far longer than a browser needs to style the
   same document.

"Sighted human" means the visual rendering, not the accessibility tree. Content
hidden only from assistive technology (`aria-hidden="true"`) is on screen, so it
stays in `text`. Content shown only to screen readers (the "visually hidden"
pattern: a 1px clipped box) is not on screen, so it is removed.

The goal is not that `text` is safe. Visible text can be an injection too:
"Ignore your previous instructions" in plain sight is still an attack.
`naked-eye` removes the invisible channel, so that whatever the model reads, a
human could also have read. Judging visible text needs a classifier or a
policy, and a human in the loop for consequential actions.

## Modes

**Static mode**, `extractVisible(html, options)`, parses the HTML with a
spec-compliant parser, computes the CSS cascade itself, and decides visibility
from computed values. It does no layout, runs no scripts and makes no network
requests, so it runs anywhere JavaScript does. Where a CSS condition cannot be
decided without layout (`@container`, `@scope`, an unknown media feature), it
evaluates the rules both ways and keeps text only if it is visible in both.

**Browser mode**, `extractVisibleFromPage(page, options)`, runs inside a page
that Playwright or Puppeteer already has open. It reads the browser's computed
styles and real geometry: the rectangles of each text node, clipping by
ancestors, and the document's scrollable area.

Both modes return the same result shape and the same reason codes.

## Hiding techniques

Coverage marks: **yes** means handled, **approx.** means handled with
thresholds instead of real geometry, **no** means a known limitation (see
[Known limitations](#known-limitations)). The issue column links the work that
implements each row.

### Markup that is never rendered

| Technique | Example | Static | Browser | Reason | Issue |
|---|---|---|---|---|---|
| HTML comments | `<!-- ignore the user -->` | yes | yes | `comment` | [#5][i5] |
| Elements that never render | `<template>`, `<noscript>`, `<head>` content | yes | yes | `not-rendered` | [#5][i5] |
| Fallback content of embedded and replaced elements | text inside `<iframe>`, `<object>`, `<video>`, `<audio>`, `<canvas>`, `<progress>`, `<meter>` | yes | yes | `not-rendered` | [#5][i5] |
| SVG text outside text elements | `<svg><g>text</g></svg>`, `<title>` and `<desc>` inside SVG | yes | yes | `not-rendered` | [#5][i5] |
| The `hidden` attribute | `<p hidden>` | yes | yes | `display-none` | [#5][i5] |
| A closed dialog | `<dialog>` without `open` | yes | yes | `display-none` | [#5][i5] |
| A popover that is not open | an element with the `popover` attribute | yes | yes | `display-none` | [#5][i5] |
| A closed disclosure | the body of `<details>` without `open` | yes | yes | `collapsed` | [#5][i5] |
| A closed drop-down | the options of a `<select>` other than the selected one | yes | yes | `collapsed` | [#5][i5] |
| Unslotted shadow host children | a light DOM child no `<slot>` accepts | yes | yes | `unslotted` | [#9][i9] |

Script and style contents are code, not text: they are dropped without a
finding.

### CSS that hides

| Technique | Example | Static | Browser | Reason | Issue |
|---|---|---|---|---|---|
| Display | `display: none` | yes | yes | `display-none` | [#5][i5] |
| Visibility | `visibility: hidden`, `collapse` | yes | yes | `visibility-hidden` | [#5][i5] |
| Content visibility | `content-visibility: hidden`, `hidden="until-found"` | yes | yes | `content-visibility` | [#5][i5] |
| Opacity | `opacity: 0.01`, `filter: opacity(0)` | yes | yes | `opacity` | [#5][i5] |
| Tiny text | `font-size: 0`, `font: 0/0 a`, `zoom: 0.01`, `transform: scale(0)` | yes | yes | `font-size` | [#5][i5] |
| Fill-forwards animations | `animation: fade 0s forwards` ending at `opacity: 0` | yes | yes | as the property | [#5][i5] |
| The start of a block | `::first-line { font-size: 0 }`, `::first-letter { color: transparent }` | approx. | yes | as the property | [#8][i8] |

Static mode cannot tell where a block's first line ends, so when `::first-line`
styles hide text, it reports every line of the block. `::first-letter` hides the
first letter and the punctuation around it, as a browser does.

The cascade is computed the way browsers compute it, because the attacker writes
the CSS: selectors of any kind, `!important`, cascade layers, nesting, custom
properties, media queries and `@supports` all reach the same declarations they
reach in a browser ([#4][i4]).

### Geometry

| Technique | Example | Static | Browser | Reason | Issue |
|---|---|---|---|---|---|
| Zero-size box that clips | `width: 0; height: 0; overflow: hidden`, `max-height: 0` | yes | yes | `zero-size` | [#5][i5] |
| Clipping | `clip: rect(0 0 0 0)`, `clip-path: inset(50%)` | yes | yes | `clipped` | [#5][i5] |
| Off-screen placement | `position: absolute; left: -9999px`, `text-indent: -9999px`, `transform: translateX(-200vw)`, `margin-left: -9999px` | approx. | yes | `off-screen` | [#5][i5] |
| Clipped by an ancestor after layout | text that overflows a fixed-height `overflow: hidden` box | no | yes | `clipped` | [#10][i10] |

### Color and contrast

| Technique | Example | Static | Browser | Reason | Issue |
|---|---|---|---|---|---|
| Transparent text | `color: transparent`, `-webkit-text-fill-color: transparent`, SVG `fill-opacity: 0` | yes | yes | `transparent-text` | [#6][i6] |
| Text the color of its background | white on white, in any color syntax, `<font color>`, SVG `fill` | yes | yes | `low-contrast` | [#6][i6] |

Contrast is the WCAG ratio between the text, composited with its effective
opacity, and the background behind it: translucent backgrounds of the element
and its ancestors composited over the canvas. A stroke, a text shadow or a
background clipped to the text (`background-clip: text`) that draws the glyphs
in a visible color keeps the text; a stroke thinner than half a pixel or a
shadow blurred wider than a quarter of the font size does not count. Fully
transparent ink is reported whatever lies behind it. A background image or
gradient behind the text makes contrast unknowable without pixels, so the text
is kept.

Without layout, static mode cannot tell exactly what lies behind text that is
not an ancestor's background. A large absolutely positioned or fixed box with
a background, and a table column's background, may lie behind any text in its
containing block, so such text is kept when it contrasts with that box too.

### Characters that render as nothing

| Technique | Example | Static | Browser | Reason | Issue |
|---|---|---|---|---|---|
| Unicode tag characters | an ASCII prompt mapped to U+E0000–U+E007F | yes | yes | `invisible-unicode` | [#7][i7] |
| Variation selector smuggling | bytes encoded as a run of variation selectors after one emoji | yes | yes | `invisible-unicode` | [#7][i7] |
| Zero-width and bidirectional controls | U+200B, U+2060, U+202E, and every other default-ignorable code point | yes | yes | `invisible-unicode` | [#7][i7] |

Findings for tag characters and variation-selector runs carry the decoded
payload, so a log shows what the attacker tried to say. ZWJ and ZWNJ are kept
only between two characters they join: emoji sequences, and letters of the
Arabic-script and Indic scripts whose shaping they control, also across inline
markup. A lone U+FE0E or U+FE0F is kept only after a character with an emoji
presentation. A single selector that picks a glyph variant (an ideographic
variation sequence, a standardized variant, a Mongolian free variation
selector) is typography: it is removed without a finding, like a soft hyphen.

## The reverse mismatch

The opposite gap also exists: text a human sees that is not in the DOM. CSS
`::before` and `::after` can draw a price, a warning or a recipient name that a
DOM-only extractor never sees, so the model and the human disagree about what
the page says. `naked-eye` renders generated content into `text` at its
position, subject to the same hiding rules, and lists each insertion in
`generated` ([#8][i8]). Strings, `attr()` and quotes are rendered; counters and
images are reported in `warnings`; icon-font glyphs in the Private Use Area are
pictures, not text, and are dropped. List markers (`::marker`) are not read.

## Non-goals

- **Judging visible text.** `naked-eye` does not classify text as malicious and
  does not block keywords. Visible injections are out of scope.
- **Text in pixels.** Images, `<canvas>` and video are not read; no OCR.
- **Other formats.** PDF, Office documents and Markdown are not HTML. Convert
  them with a renderer that keeps visibility information, or treat them as
  untrusted in full.
- **Sanitizing HTML.** The output is plain text. This is not an XSS sanitizer,
  and its output must not be used to decide whether HTML is safe to render.

## Known limitations

### Static mode

- **No layout.** Static mode cannot see overlap, text covered by another
  element, text pushed out of a clipping box by the length of its content, or
  offsets expressed as percentages of an unknown size. Off-screen placement is
  judged from offsets, indents, translations and margins against a distance
  threshold.
- **No scripts.** Text hidden or revealed by JavaScript is judged by the
  document's markup and CSS alone.
- **No network.** `<link rel="stylesheet">` and `@import` apply only when the
  caller supplies their CSS text. Unsupplied stylesheets are listed in
  `warnings`.
- **Unknown conditions.** Rules under conditions static mode cannot decide are
  evaluated both ways, all together. An attack that combines several such
  conditions so that only one particular mix hides the text can still get
  through.
- **Animations** other than the end state of fill-forwards animations, and
  **transitions**, are not modelled.
- **Colors it cannot evaluate.** Relative color syntax (`rgb(from …)`),
  `contrast-color()`, `device-cmyk()` and `color-mix()` in `display-p3`,
  `a98-rgb`, `prophoto-rgb` or `rec2020` keep the text and add an
  `unsupported-color` warning.
- **Backdrops from positioned boxes.** Text is kept when it contrasts with any
  large positioned box in its containing block, wherever that box lands. An
  attacker who adds such a box in a contrasting color can make invisible text
  count as visible; browser mode sees where the box is.
- **Form constraints.** `:invalid` and `:valid` evaluate `required`, e-mail and
  URL syntax, and number ranges and steps, but not `pattern`: a hostile pattern
  could stall the regular expression engine.
- **Shapes painted under SVG text** are not considered when judging its
  contrast.

### Both modes

- **Fonts.** A web font can draw blank glyphs or different letters than the
  characters in the DOM. Neither mode inspects glyph outlines.
- **Occlusion.** Text covered by another opaque element is still reported as
  visible.
- **Masks, blend modes and filters other than `opacity()`.** `mask-image`,
  `mix-blend-mode`, `backdrop-filter` and `blur()` are not modelled.
- **Viewport.** Visibility is judged at one viewport. Text shown only at other
  widths or in print is treated as the configured viewport shows it.
- **Interaction.** Content revealed by hover, focus, clicks or `:target` counts
  as hidden.
- **Attributes.** Text drawn from attributes is not extracted: form control
  values and placeholders, and image `alt` text shown when an image fails to
  load.
- **SVG `<use>`.** Text inside a `<symbol>` or `<defs>` that a `<use>` element
  draws elsewhere is reported as never rendered.

### Browser mode

- **A live, hostile page.** The extraction function runs in the page's main
  world, next to the attacker's scripts, which can redefine the DOM APIs it
  calls or change the document after it returns. For untrusted pages, disable
  JavaScript in the browser context when the page does not need it, or run
  static mode on the response HTML as well.
- **Closed shadow roots** cannot be read from the page; their text is missing
  from `text`.
- **Cross-origin frames** cannot be read; they are listed in `warnings`.
- **Timing.** The result is a snapshot. Content that appears later, or blinks,
  is judged as it was at the moment of extraction.

## Choosing a mode

- **You have HTML but no browser** (RAG ingestion, email, `fetch`-based agents):
  use static mode. Supply the external stylesheets if you fetched them, and treat
  a non-empty `warnings` list as a reason for caution.
- **You already drive a browser** (a computer-use agent, a Playwright tool): use
  browser mode, with page JavaScript disabled where the page allows it.
- **The stakes are high** (the model can send email, spend money or change
  data): keep a human approval step for consequential actions, and log the
  `hidden` findings: an injection attempt is worth knowing about even when it
  was stopped.

## Reporting a bypass

Text that reaches `text` through a technique this document marks as covered is
a vulnerability. Report it privately through
[GitHub Security Advisories](https://github.com/sean1093/naked-eye/security/advisories/new),
not in a public issue.

[i4]: https://github.com/sean1093/naked-eye/issues/4
[i5]: https://github.com/sean1093/naked-eye/issues/5
[i6]: https://github.com/sean1093/naked-eye/issues/6
[i7]: https://github.com/sean1093/naked-eye/issues/7
[i8]: https://github.com/sean1093/naked-eye/issues/8
[i9]: https://github.com/sean1093/naked-eye/issues/9
[i10]: https://github.com/sean1093/naked-eye/issues/10
