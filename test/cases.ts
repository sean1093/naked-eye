import type { HiddenReason } from '../src/types.js';

/**
 * The shared corpus: each case is a document, the text a human sees in it,
 * and the findings the removed text must produce. Static mode runs every case;
 * browser mode (#10) runs the same corpus in real engines.
 *
 * Hiding cases come in pairs where it matters: the same markup without the
 * hiding declaration must keep its text, so a rule cannot quietly remove
 * visible content.
 */
export interface Case {
  name: string;
  /** Body content, or a whole document when it starts with `<!doctype`. */
  html: string;
  /** The exact expected `text`. */
  visible: string;
  /** Findings that must be present: `[reason, text]`. */
  hidden?: [HiddenReason, string][];
}

export const cases: Case[] = [
  // Structure: nothing visible is dropped, and line structure follows the boxes.
  {
    name: 'headings, paragraphs and inline markup',
    html: '<h1>Title</h1><p>Hello <b>bold</b> and <i>italic</i>.</p><p>Second</p>',
    visible: 'Title\n\nHello bold and italic.\n\nSecond',
  },
  {
    name: 'lists and line breaks',
    html: '<ul><li>one</li><li>two</li></ul><div>a<br>b</div>',
    visible: 'one\ntwo\na\nb',
  },
  {
    name: 'tables',
    html: '<table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>',
    visible: 'h1\th2\nc1\tc2',
  },
  {
    name: 'preformatted text',
    html: '<pre>  a\n    b</pre><p style="white-space: pre-line">x   y\nz</p>',
    visible: '  a\n    b\n\nx y\nz',
  },
  {
    name: 'text misplaced in a table is moved before it',
    html: '<table>stray <b>bold</b><tr><td>cell</td></tr></table>',
    visible: 'stray bold\ncell',
  },
  {
    name: 'collapsible white space',
    html: '<p>  lots   of\n\n space  </p>',
    visible: 'lots of space',
  },
  {
    name: 'inline-level boxes stay on one line, flex items do not',
    html: '<span style="display: inline-block">a</span><span style="display: inline-block">b</span><div style="display: flex"><span>c</span><span>d</span></div>',
    visible: 'ab\nc\nd',
  },
  {
    name: 'display: contents',
    html: '<div style="display: contents">a</div><div style="display: contents">b</div>',
    visible: 'ab',
  },
  {
    name: 'aria-hidden content is on screen',
    html: '<p aria-hidden="true">decorative</p>',
    visible: 'decorative',
  },
  {
    name: 'form controls with text content',
    html: '<textarea>typed</textarea> <button>Send</button>',
    visible: 'typed Send',
  },
  { name: 'an open dialog', html: '<dialog open>hi</dialog>', visible: 'hi' },
  {
    name: 'an open details',
    html: '<details open><summary>S</summary>body</details>',
    visible: 'S\nbody',
  },
  {
    name: 'a list box shows every option',
    html: '<select multiple><option>a</option><option>b</option></select>',
    visible: 'a\nb',
  },
  {
    name: 'a removed box adds no line break',
    html: 'a<div style="display: none">x</div>b',
    visible: 'ab',
    hidden: [['display-none', 'x']],
  },
  {
    name: 'an invisible box keeps its line breaks',
    html: 'a<div style="visibility: hidden">x</div>b',
    visible: 'a\nb',
    hidden: [['visibility-hidden', 'x']],
  },

  // Markup that never renders.
  { name: 'comments', html: 'a<!-- secret -->b', visible: 'ab', hidden: [['comment', 'secret']] },
  {
    name: 'scripts and styles are code, not findings',
    html: '<script>var secret</script><style>p {}</style>keep',
    visible: 'keep',
  },
  {
    name: 'template content',
    html: '<template><p>secret</p></template>keep',
    visible: 'keep',
    hidden: [['not-rendered', 'secret']],
  },
  {
    name: 'noscript content',
    html: '<noscript>secret</noscript>keep',
    visible: 'keep',
    hidden: [['not-rendered', 'secret']],
  },
  {
    name: 'fallback content of embedded elements',
    html: '<iframe>a</iframe><video>b</video><audio controls>c</audio><canvas>d</canvas><object data="x.svg">e</object><progress>f</progress>keep',
    visible: 'keep',
    hidden: [
      ['not-rendered', 'a'],
      ['not-rendered', 'b'],
      ['not-rendered', 'c'],
      ['not-rendered', 'd'],
      ['not-rendered', 'e'],
      ['not-rendered', 'f'],
    ],
  },
  {
    name: 'SVG text outside text elements',
    html: '<svg><title>tip</title><g>loose</g><text>painted</text><foreignObject><p>html</p></foreignObject></svg>',
    visible: 'painted\n\nhtml',
    hidden: [
      ['not-rendered', 'tip'],
      ['not-rendered', 'loose'],
    ],
  },
  {
    name: 'the hidden attribute',
    html: '<p hidden>secret</p><p>keep</p>',
    visible: 'keep',
    hidden: [['display-none', 'secret']],
  },
  {
    name: 'the hidden attribute overridden by author CSS',
    html: '<style>[hidden] { display: block }</style><p hidden>shown</p>',
    visible: 'shown',
  },
  {
    name: 'a closed dialog',
    html: '<dialog>secret</dialog>keep',
    visible: 'keep',
    hidden: [['display-none', 'secret']],
  },
  {
    name: 'a popover that is not open',
    html: '<div popover>secret</div>keep',
    visible: 'keep',
    hidden: [['display-none', 'secret']],
  },
  {
    name: 'a closed details',
    html: '<details><summary>Question</summary>secret answer</details>',
    visible: 'Question',
    hidden: [['collapsed', 'secret answer']],
  },
  {
    name: 'a drop-down shows only its selected option',
    html: '<select><option>first</option><optgroup label="g"><option selected>chosen</option><option>other</option></optgroup></select>',
    visible: 'chosen',
    hidden: [['collapsed', 'first other']],
  },

  // CSS that hides.
  {
    name: 'display: none from a class rule',
    html: '<style>.x { display: none }</style><p class="x">secret</p><p>keep</p>',
    visible: 'keep',
    hidden: [['display-none', 'secret']],
  },
  {
    name: 'visibility: hidden with a visible descendant',
    html: '<div style="visibility: hidden">secret <span style="visibility: visible">shown</span></div>',
    visible: 'shown',
    hidden: [['visibility-hidden', 'secret']],
  },
  {
    name: 'visibility: collapse on a table row',
    html: '<table><tr style="visibility: collapse"><td>secret</td></tr><tr><td>keep</td></tr></table>',
    visible: 'keep',
    hidden: [['visibility-hidden', 'secret']],
  },
  {
    name: 'content-visibility: hidden and hidden=until-found',
    html: '<div style="content-visibility: hidden">secret</div><div hidden="until-found">found later</div>keep',
    visible: 'keep',
    hidden: [
      ['content-visibility', 'secret'],
      ['content-visibility', 'found later'],
    ],
  },
  {
    name: 'opacity below the threshold',
    html: '<p style="opacity: 0">a</p><p style="opacity: 0.09">b</p><div style="opacity: 0.3"><p style="opacity: 0.3">c</p></div><p style="filter: opacity(0)">d</p>',
    visible: '',
    hidden: [
      ['opacity', 'a'],
      ['opacity', 'b'],
      ['opacity', 'c'],
      ['opacity', 'd'],
    ],
  },
  {
    name: 'opacity at the threshold is visible',
    html: '<p style="opacity: 0.1">faint but there</p>',
    visible: 'faint but there',
  },
  {
    name: 'font size below the threshold',
    html: '<p style="font-size: 0">a</p><p style="font-size: 3.9px">b</p><p style="font: 0/0 a">c</p><p style="zoom: 0.2">d</p><p style="transform: scale(0.2)">e</p>',
    visible: '',
    hidden: [
      ['font-size', 'a'],
      ['font-size', 'b'],
      ['font-size', 'c'],
      ['font-size', 'd'],
      ['font-size', 'e'],
    ],
  },
  {
    name: 'font size at the threshold, and a child that restores it',
    html: '<p style="font-size: 4px">small</p><div style="font-size: 0"><span style="font-size: 16px">restored</span></div>',
    visible: 'small\n\nrestored',
  },
  {
    name: 'transforms that collapse or squash text',
    html: '<p style="transform: matrix(0, 0, 0, 0, 0, 0)">a</p><p style="transform: rotateX(90deg)">b</p><p style="transform: scaleY(0.1)">c</p><p style="transform: matrix3d(0.1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)">d</p><p style="scale: 0.2">e</p><p style="transform: translateY(-5000px)">f</p>',
    visible: '',
    hidden: [
      ['font-size', 'a'],
      ['font-size', 'b'],
      ['font-size', 'c'],
      ['font-size', 'd'],
      ['font-size', 'e'],
      ['off-screen', 'f'],
    ],
  },
  {
    name: 'transforms that keep text readable',
    html: '<p style="transform: rotate(180deg) skewX(10deg)">turned</p><p style="transform: scale(-1)">mirrored</p><p style="transform: translate(10px, 10px) scaleX(1.5)">moved</p>',
    visible: 'turned\n\nmirrored\n\nmoved',
  },
  {
    name: 'transforms do not apply to inline boxes',
    html: '<span style="transform: scale(0)">still here</span>',
    visible: 'still here',
  },
  {
    name: 'zero-size boxes that clip',
    html: '<div style="height: 0; overflow: hidden">a</div><div style="max-height: 0; overflow: hidden">b</div><div style="width: 1px; overflow: clip">c</div>',
    visible: '',
    hidden: [
      ['zero-size', 'a'],
      ['zero-size', 'b'],
      ['zero-size', 'c'],
    ],
  },
  {
    name: 'size and paint containment',
    html: '<div style="contain: strict">secret</div><div style="contain: size; overflow: hidden">also secret</div><div style="contain: strict; contain-intrinsic-size: auto 40px">sized</div><div style="contain: content">kept</div>',
    visible: 'sized\nkept',
    hidden: [
      ['zero-size', 'secret'],
      ['zero-size', 'also secret'],
    ],
  },
  {
    name: 'zero-size boxes that let content overflow, and inline boxes',
    html: '<div style="height: 0">overflowing</div><span style="width: 0; height: 0; overflow: hidden">inline</span>',
    visible: 'overflowing\ninline',
  },
  {
    name: 'the visually-hidden pattern',
    html: '<style>.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0 }</style><span class="sr">screen readers only</span>keep',
    visible: 'keep',
    hidden: [['zero-size', 'screen readers only']],
  },
  {
    name: 'clip on an absolutely positioned box',
    html: '<p style="position: absolute; clip: rect(0 0 0 0)">secret</p><p style="clip: rect(0 0 0 0)">not positioned</p>',
    visible: 'not positioned',
    hidden: [['clipped', 'secret']],
  },
  {
    name: 'clip rectangles with auto edges',
    html: '<p style="position: absolute; clip: rect(auto, auto, 0, auto)">secret</p><p style="position: absolute; clip: rect(auto auto auto auto)">kept</p>',
    visible: 'kept',
    hidden: [['clipped', 'secret']],
  },
  {
    name: 'more clip-path shapes',
    html: '<p style="clip-path: rect(0 0 0 0)">a</p><p style="clip-path: xywh(0 0 0 0)">b</p><p style="clip-path: ellipse(10px 0)">c</p><p style="clip-path: polygon(0% 0%, 50% 50%, 100% 100%)">d</p><p style="clip-path: inset(0 0 100% 0 round 5px)">e</p><p style="clip-path: polygon(0 0, 100% 0, 100% 100%)">kept</p><p style="clip-path: circle(closest-side)">round</p><p style="clip-path: inset(10px)">inset</p>',
    visible: 'kept\n\nround\n\ninset',
    hidden: [
      ['clipped', 'a'],
      ['clipped', 'b'],
      ['clipped', 'c'],
      ['clipped', 'd'],
      ['clipped', 'e'],
    ],
  },
  {
    name: 'clip paths that remove the box',
    html: '<p style="clip-path: inset(50%)">a</p><p style="clip-path: circle(0)">b</p><p style="clip-path: polygon(0 0, 0 0, 0 0)">c</p><p style="clip-path: inset(10%)">kept</p>',
    visible: 'kept',
    hidden: [
      ['clipped', 'a'],
      ['clipped', 'b'],
      ['clipped', 'c'],
    ],
  },
  {
    name: 'off-screen placement',
    html: '<p style="position: absolute; left: -9999px">a</p><p style="position: relative; top: -2000px">b</p><p style="position: absolute; right: 9999px">c</p><p style="margin-left: -9999px">d</p><p style="transform: translateX(-9999px)">e</p><p style="text-indent: -9999px">f</p><p style="position: relative; left: -10px">kept</p>',
    visible: 'kept',
    hidden: [
      ['off-screen', 'a'],
      ['off-screen', 'b'],
      ['off-screen', 'c'],
      ['off-screen', 'd'],
      ['off-screen', 'e'],
      ['off-screen', 'f'],
    ],
  },
  {
    name: 'pushed past the right edge of a page that clips it',
    html: '<style>html { overflow-x: hidden }</style><p style="position: relative; left: 99999px">secret</p>keep',
    visible: 'keep',
    hidden: [['off-screen', 'secret']],
  },
  {
    name: 'pushed past the right edge of a page that scrolls',
    html: '<p style="position: relative; left: 99999px">reachable</p>',
    visible: 'reachable',
  },

  {
    name: 'SVG presentation attributes',
    html: '<svg><text display="none">a</text><text visibility="hidden">b</text><text opacity="0">c</text><text font-size="0">d</text><g transform="translate(-9999,0)"><text>e</text></g><text font-size="20">kept</text></svg>',
    visible: 'kept',
    hidden: [
      ['display-none', 'a'],
      ['visibility-hidden', 'b'],
      ['opacity', 'c'],
      ['font-size', 'd'],
      ['off-screen', 'e'],
    ],
  },
  {
    name: 'rotations and perspective in three dimensions',
    html: '<p style="transform: rotate3d(1, 0, 0, 90deg)">a</p><p style="transform: perspective(1px) translateZ(-10000px)">b</p><div style="perspective: 10px"><p style="transform: translateZ(-100000px)">c</p></div><p style="transform: rotate3d(0, 0, 1, 45deg)">kept</p>',
    visible: 'kept',
    hidden: [
      ['font-size', 'a'],
      ['font-size', 'b'],
      ['font-size', 'c'],
    ],
  },
  {
    name: 'a large positive indent on a page that clips horizontally',
    html: '<style>html { overflow-x: hidden }</style><p style="text-indent: 9999px">secret</p>keep',
    visible: 'keep',
    hidden: [['off-screen', 'secret']],
  },
  {
    name: 'padding and minimum sizes keep a zero-height box open',
    html: '<div style="height: 0; padding: 40px 0; overflow: hidden">padded</div><div style="height: 0; padding-bottom: 56.25%; overflow: hidden">ratio</div><div style="height: 0; min-height: 60px; overflow: hidden">minimum</div><div style="min-width: 300px; max-width: 0; overflow: hidden">wide</div>',
    visible: 'padded\nratio\nminimum\nwide',
  },
  {
    name: 'paragraph breaks follow display, not the tag',
    html: '<p style="display: inline">a</p><p style="display: inline">b</p>',
    visible: 'ab',
  },
  {
    name: 'a descendant moved back on screen',
    html: '<div style="margin-left: -9999px"><div style="margin-left: 9999px">back on screen</div></div>',
    visible: 'back on screen',
  },
  {
    name: 'preserve-spaces collapses line breaks into spaces',
    html: '<div style="white-space-collapse: preserve-spaces">a  b\nc</div>',
    visible: 'a  b c',
  },

  // The cascade is followed wherever it leads.
  {
    name: 'hiding reached through a layer, nesting and a custom property',
    html: '<style>@layer base { .card { --h: none; .x { display: var(--h) } } } p.x { color: red }</style><div class="card"><p class="x">secret</p></div>keep',
    visible: 'keep',
    hidden: [['display-none', 'secret']],
  },
  {
    name: 'the end state of a fill-forwards animation',
    html: '<style>@keyframes vanish { to { opacity: 0 } } .x { animation: vanish 0s forwards }</style><p class="x">secret</p>keep',
    visible: 'keep',
    hidden: [['opacity', 'secret']],
  },
];
