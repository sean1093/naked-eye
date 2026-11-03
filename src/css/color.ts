/**
 * CSS Color Level 4 parsing into sRGB, and WCAG contrast. White text on a
 * white page can be written as `#fff`, `rgb(255 255 255)`, `hsl(0 0% 100%)`,
 * `oklch(1 0 0)` or `color(display-p3 1 1 1)`; every one has to come out as
 * white.
 */
import { type ComponentValue, isFunctionNode } from '@csstools/css-parser-algorithms';
import { TokenType } from '@csstools/css-tokenizer';
import { own } from '../util.js';
import { type Context, evaluate, parseNumeric } from './calc.js';
import { identOf, isToken, significant, splitCommas, stringOf, tokenOf } from './syntax.js';

/** Gamma-encoded sRGB channels in 0..1, and alpha in 0..1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Scheme = 'light' | 'dark';

/**
 * A parsed color: concrete, `currentcolor`, a system color or `light-dark()`
 * that depends on the element's color scheme, or a valid color this parser
 * cannot evaluate.
 */
export type Color =
  | { kind: 'rgba'; value: RGBA }
  | { kind: 'currentcolor' }
  | { kind: 'scheme'; light: Color; dark: Color }
  | { kind: 'unknown'; text: string };

const NAMED = Object.fromEntries(
  (
    'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,' +
    'black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,' +
    'chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,' +
    'darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
    'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
    'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
    'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,' +
    'dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
    'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,' +
    'honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
    'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,' +
    'lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
    'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
    'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,' +
    'mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,' +
    'midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,' +
    'oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
    'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,' +
    'pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,' +
    'sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
    'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,' +
    'violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'
  )
    .split(',')
    .map((entry) => entry.split(':') as [string, string]),
);

/** System colors as Chromium renders them, light then dark. */
const SYSTEM: Record<string, [string, string]> = {
  canvas: ['ffffff', '121212'],
  canvastext: ['000000', 'ffffff'],
  linktext: ['0000ee', '9e9eff'],
  visitedtext: ['551a8b', 'd0adf0'],
  activetext: ['ff0000', 'ff9e9e'],
  buttonface: ['efefef', '6b6b6b'],
  buttontext: ['000000', 'ffffff'],
  buttonborder: ['767676', '6b6b6b'],
  field: ['ffffff', '3b3b3b'],
  fieldtext: ['000000', 'ffffff'],
  highlight: ['b4d5fe', '99c8ff'],
  highlighttext: ['000000', '000000'],
  selecteditem: ['0075ff', '99c8ff'],
  selecteditemtext: ['ffffff', '3b3b3b'],
  mark: ['ffff00', 'ffff00'],
  marktext: ['000000', '000000'],
  graytext: ['6d6d6d', '848484'],
  accentcolor: ['0075ff', '99c8ff'],
  accentcolortext: ['ffffff', '000000'],
};

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function rgba(r: number, g: number, b: number, a = 1): Color {
  const clamp = (value: number): number =>
    Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value));
  return { kind: 'rgba', value: { r: clamp(r), g: clamp(g), b: clamp(b), a: clamp(a) } };
}

function hex(text: string): Color | null {
  if (!/^[0-9a-f]+$/i.test(text) || ![3, 4, 6, 8].includes(text.length)) return null;
  const full = text.length <= 4 ? [...text].map((digit) => digit + digit).join('') : text;
  const channel = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  return rgba(channel(0), channel(1), channel(2), full.length === 8 ? channel(3) : 1);
}

type Matrix = [[number, number, number], [number, number, number], [number, number, number]];

function apply(m: Matrix, [x, y, z]: [number, number, number]): [number, number, number] {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

// Matrices and transfer functions from the CSS Color 4 sample code.
const XYZ_TO_LINEAR_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65: Matrix = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const P3_TO_XYZ: Matrix = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const A98_TO_XYZ: Matrix = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.0752914584939978],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];
const PROPHOTO_TO_XYZ_D50: Matrix = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0, 0, 0.8251046025104601],
];
const REC2020_TO_XYZ: Matrix = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791],
];
const OKLAB_TO_LMS: Matrix = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_LINEAR_SRGB: Matrix = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

function encodeSrgb(linear: number): number {
  const sign = Math.sign(linear);
  const magnitude = Math.abs(linear);
  return magnitude > 0.0031308 ? sign * (1.055 * magnitude ** (1 / 2.4) - 0.055) : 12.92 * linear;
}

function decodeSrgb(encoded: number): number {
  const sign = Math.sign(encoded);
  const magnitude = Math.abs(encoded);
  return magnitude <= 0.04045 ? encoded / 12.92 : sign * ((magnitude + 0.055) / 1.055) ** 2.4;
}

function fromLinear([r, g, b]: [number, number, number], alpha: number): Color {
  return rgba(encodeSrgb(r), encodeSrgb(g), encodeSrgb(b), alpha);
}

function fromXyzD65(xyz: [number, number, number], alpha: number): Color {
  return fromLinear(apply(XYZ_TO_LINEAR_SRGB, xyz), alpha);
}

function fromLab(l: number, a: number, b: number, alpha: number): Color {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const xyz: [number, number, number] = [
    (f0 ** 3 > epsilon ? f0 ** 3 : (116 * f0 - 16) / kappa) * (0.3457 / 0.3585),
    l > kappa * epsilon ? f1 ** 3 : l / kappa,
    (f2 ** 3 > epsilon ? f2 ** 3 : (116 * f2 - 16) / kappa) * ((1 - 0.3457 - 0.3585) / 0.3585),
  ];
  return fromXyzD65(apply(D50_TO_D65, xyz), alpha);
}

function fromOklab(l: number, a: number, b: number, alpha: number): Color {
  const lms = apply(OKLAB_TO_LMS, [l, a, b]).map((value) => value ** 3) as [number, number, number];
  return fromLinear(apply(LMS_TO_LINEAR_SRGB, lms), alpha);
}

function fromHsl(hue: number, saturation: number, lightness: number, alpha: number): Color {
  const h = (((hue % 360) + 360) % 360) / 30;
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): number => {
    const k = (n + h) % 12;
    return lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgba(channel(0), channel(8), channel(4), alpha);
}

function fromHwb(hue: number, white: number, black: number, alpha: number): Color {
  if (white + black >= 1) {
    const gray = white / (white + black);
    return rgba(gray, gray, gray, alpha);
  }
  const base = fromHsl(hue, 1, 0.5, 1);
  if (base.kind !== 'rgba') return base;
  const scale = (channel: number): number => channel * (1 - white - black) + white;
  return rgba(scale(base.value.r), scale(base.value.g), scale(base.value.b), alpha);
}

const CHECK: Context = {
  em: 16,
  rem: 16,
  viewportWidth: 1280,
  viewportHeight: 800,
  percent: 'number',
};

/** A channel as `[value, isPercentage]`; `none` is 0. */
function channel(node: ComponentValue | undefined): [number, boolean] | null {
  if (node === undefined) return null;
  if (identOf(node) === 'none') return [0, false];
  const token = tokenOf(node);
  if (token?.[0] === TokenType.Percentage) return [token[4].value / 100, true];
  const expr = parseNumeric(node);
  if (expr === null) return null;
  const value = evaluate(expr, CHECK);
  if (value === null || value.unknown) return null;
  if (value.kind === 'angle') return [value.value, false];
  return value.kind === 'number' ? [value.value, false] : null;
}

/** Channels of a color function: three components and an optional alpha. */
function components(
  args: ComponentValue[],
  legacyCommas: boolean,
): { values: [number, boolean][]; alpha: number } | null {
  const commas = splitCommas(args).map(significant);
  let nodes: ComponentValue[];
  let alphaNode: ComponentValue | undefined;
  if (legacyCommas && commas.length >= 3) {
    if (commas.length > 4 || commas.some((part) => part.length !== 1)) return null;
    nodes = commas.slice(0, 3).map((part) => part[0] as ComponentValue);
    alphaNode = commas[3]?.[0];
  } else {
    if (commas.length !== 1) return null;
    const all = commas[0] as ComponentValue[];
    const slash = all.findIndex((node) => isToken(node, TokenType.Delim) && stringOf(node) === '/');
    nodes = slash === -1 ? all : all.slice(0, slash);
    if (slash !== -1) {
      if (all.length !== slash + 2) return null;
      alphaNode = all[slash + 1];
    }
  }
  if (nodes.length !== 3) return null;
  const values = nodes.map(channel);
  if (values.includes(null)) return null;
  let alpha = 1;
  if (alphaNode !== undefined) {
    const parsed = channel(alphaNode);
    if (parsed === null) return null;
    alpha = parsed[0];
  }
  return { values: values as [number, boolean][], alpha };
}

const FUNCTIONS: Record<string, true> = {
  rgb: true,
  rgba: true,
  hsl: true,
  hsla: true,
  hwb: true,
  lab: true,
  lch: true,
  oklab: true,
  oklch: true,
  color: true,
  'color-mix': true,
  'light-dark': true,
  'contrast-color': true,
  'device-cmyk': true,
};

function parseFunction(name: string, args: ComponentValue[]): Color | null {
  if (name === 'light-dark') {
    const parts = splitCommas(args).map(significant);
    if (parts.length !== 2) return null;
    const light = parseColor(parts[0] as ComponentValue[]);
    const dark = parseColor(parts[1] as ComponentValue[]);
    return light === null || dark === null ? null : { kind: 'scheme', light, dark };
  }
  if (name === 'color-mix') return parseMix(args);
  if (significant(args).some((node) => identOf(node) === 'from'))
    return { kind: 'unknown', text: `${name}(from …)` };
  if (name === 'color') return parseColorFunction(args);
  if (name === 'contrast-color' || name === 'device-cmyk')
    return { kind: 'unknown', text: `${name}()` };

  const parsed = components(
    args,
    name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla',
  );
  if (parsed === null) return null;
  const [[x, xPct], [y, yPct], [z, zPct]] = parsed.values as [
    [number, boolean],
    [number, boolean],
    [number, boolean],
  ];
  const { alpha } = parsed;
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const scale = (value: number, percent: boolean): number => (percent ? value : value / 255);
      return rgba(scale(x, xPct), scale(y, yPct), scale(z, zPct), alpha);
    }
    case 'hsl':
    case 'hsla':
      return fromHsl(x, yPct ? y : y / 100, zPct ? z : z / 100, alpha);
    case 'hwb':
      return fromHwb(x, yPct ? y : y / 100, zPct ? z : z / 100, alpha);
    case 'lab':
      return fromLab(xPct ? x * 100 : x, yPct ? y * 125 : y, zPct ? z * 125 : z, alpha);
    case 'lch': {
      const chroma = yPct ? y * 150 : y;
      const hue = (z * Math.PI) / 180;
      return fromLab(xPct ? x * 100 : x, chroma * Math.cos(hue), chroma * Math.sin(hue), alpha);
    }
    case 'oklab':
      return fromOklab(x, yPct ? y * 0.4 : y, zPct ? z * 0.4 : z, alpha);
    default: {
      const chroma = yPct ? y * 0.4 : y;
      const hue = (z * Math.PI) / 180;
      return fromOklab(x, chroma * Math.cos(hue), chroma * Math.sin(hue), alpha);
    }
  }
}

function parseColorFunction(args: ComponentValue[]): Color | null {
  const nodes = significant(args);
  const space = identOf(nodes[0]);
  if (space === undefined) return null;
  const parsed = components(nodes.slice(1), false);
  if (parsed === null) return null;
  const [r, g, b] = parsed.values.map(([value]) => value) as [number, number, number];
  const { alpha } = parsed;
  const linearize = (transfer: (value: number) => number): [number, number, number] => [
    transfer(r),
    transfer(g),
    transfer(b),
  ];
  switch (space) {
    case 'srgb':
      return rgba(r, g, b, alpha);
    case 'srgb-linear':
      return fromLinear([r, g, b], alpha);
    case 'display-p3':
      return fromXyzD65(apply(P3_TO_XYZ, linearize(decodeSrgb)), alpha);
    case 'a98-rgb':
      return fromXyzD65(
        apply(
          A98_TO_XYZ,
          linearize((v) => Math.sign(v) * Math.abs(v) ** (563 / 256)),
        ),
        alpha,
      );
    case 'prophoto-rgb': {
      const linear = linearize((v) =>
        Math.abs(v) <= 16 / 512 ? v / 16 : Math.sign(v) * Math.abs(v) ** 1.8,
      );
      return fromXyzD65(apply(D50_TO_D65, apply(PROPHOTO_TO_XYZ_D50, linear)), alpha);
    }
    case 'rec2020': {
      const alphaConstant = 1.09929682680944;
      const beta = 0.018053968510807;
      const linear = linearize((v) =>
        Math.abs(v) < beta * 4.5
          ? v / 4.5
          : Math.sign(v) * ((Math.abs(v) + alphaConstant - 1) / alphaConstant) ** (1 / 0.45),
      );
      return fromXyzD65(apply(REC2020_TO_XYZ, linear), alpha);
    }
    case 'xyz':
    case 'xyz-d65':
      return fromXyzD65([r, g, b], alpha);
    case 'xyz-d50':
      return fromXyzD65(apply(D50_TO_D65, [r, g, b]), alpha);
    default:
      return null;
  }
}

const LINEAR_SRGB_TO_LMS: Matrix = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB: Matrix = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

/** Coordinates to interpolate in: gamma-encoded sRGB, OKLab, or linear sRGB for every other space. */
function mixSpace(space: string): {
  to: (color: RGBA) => [number, number, number];
  from: (xyz: [number, number, number], alpha: number) => Color;
} {
  if (space === 'srgb' || space === 'hsl' || space === 'hwb') {
    return { to: ({ r, g, b }) => [r, g, b], from: ([r, g, b], alpha) => rgba(r, g, b, alpha) };
  }
  if (space === 'oklab' || space === 'oklch') {
    return {
      to: ({ r, g, b }) => {
        const lms = apply(LINEAR_SRGB_TO_LMS, [decodeSrgb(r), decodeSrgb(g), decodeSrgb(b)]).map(
          Math.cbrt,
        ) as [number, number, number];
        return apply(LMS_TO_OKLAB, lms);
      },
      from: ([l, a, b], alpha) => fromOklab(l, a, b, alpha),
    };
  }
  return {
    to: ({ r, g, b }) => [decodeSrgb(r), decodeSrgb(g), decodeSrgb(b)],
    from: (linear, alpha) => fromLinear(linear, alpha),
  };
}

/**
 * `color-mix()` with premultiplied alpha. Polar spaces are mixed in their
 * rectangular counterpart, which differs only for chromatic hue mixes.
 */
function parseMix(args: ComponentValue[]): Color | null {
  const parts = splitCommas(args).map(significant);
  const header = parts[0] ?? [];
  const space = identOf(header[1]);
  if (parts.length !== 3 || identOf(header[0]) !== 'in' || space === undefined) return null;
  const entries = parts.slice(1).map((part) => {
    const percent = part.find((node) => tokenOf(node)?.[0] === TokenType.Percentage);
    const amount = tokenOf(percent)?.[4] as { value?: unknown } | undefined;
    const weight = typeof amount?.value === 'number' ? amount.value / 100 : null;
    return { color: parseColor(part.filter((node) => node !== percent)), weight };
  });
  const [first, second] = entries as [(typeof entries)[0], (typeof entries)[0]];
  if (first.color === null || second.color === null) return null;
  if (first.color.kind !== 'rgba' || second.color.kind !== 'rgba')
    return { kind: 'unknown', text: 'color-mix()' };
  const p1 = first.weight ?? (second.weight === null ? 0.5 : 1 - second.weight);
  const p2 = second.weight ?? 1 - p1;
  const total = p1 + p2;
  if (total <= 0) return null;
  const [w1, w2] = [p1 / total, p2 / total];
  const a = first.color.value;
  const b = second.color.value;
  const alpha = a.a * w1 + b.a * w2;
  if (alpha === 0) return rgba(0, 0, 0, 0);
  const { to, from } = mixSpace(space);
  const x = to(a);
  const y = to(b);
  const mixed = x.map(
    (value, index) => (value * a.a * w1 + (y[index] as number) * b.a * w2) / alpha,
  ) as [number, number, number];
  return from(mixed, alpha * Math.min(1, total));
}

/**
 * Parses a `<color>`. `null` means a browser rejects it; `unknown` means a
 * valid color this parser cannot evaluate.
 */
export function parseColor(values: readonly ComponentValue[]): Color | null {
  const nodes = significant(values);
  if (nodes.length !== 1) return null;
  const node = nodes[0] as ComponentValue;
  const token = tokenOf(node);
  if (token?.[0] === TokenType.Hash) return hex(token[4].value);
  const word = identOf(node);
  if (word !== undefined) {
    if (word === 'transparent') return { kind: 'rgba', value: TRANSPARENT };
    if (word === 'currentcolor') return { kind: 'currentcolor' };
    const named = own(NAMED, word);
    if (named !== undefined) return hex(named);
    const system = own(SYSTEM, word);
    if (system !== undefined)
      return { kind: 'scheme', light: hex(system[0]) as Color, dark: hex(system[1]) as Color };
    return null;
  }
  if (isFunctionNode(node)) {
    const name = node.getName().toLowerCase();
    if (FUNCTIONS[name] !== true) return null;
    return parseFunction(name, node.value);
  }
  return null;
}

/**
 * The HTML "rules for parsing a legacy colour value", used by `<font color>`
 * and `bgcolor`: lenient enough that `chucknorris` is a color.
 */
export function parseLegacyColor(input: string): RGBA | null {
  let value = input.trim();
  if (value === '' || value.toLowerCase() === 'transparent') return null;
  const named = own(NAMED, value.toLowerCase());
  if (named !== undefined) return (hex(named) as { value: RGBA }).value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return (hex(value.slice(1)) as { value: RGBA }).value;
  value = [...value]
    .map((character) => ((character.codePointAt(0) as number) > 0xffff ? '00' : character))
    .join('');
  value = value
    .slice(0, 128)
    .replace(/^#/, '')
    .replace(/[^0-9a-f]/gi, '0');
  while (value.length === 0 || value.length % 3 !== 0) value += '0';
  let length = value.length / 3;
  let parts = [value.slice(0, length), value.slice(length, 2 * length), value.slice(2 * length)];
  if (length > 8) {
    parts = parts.map((part) => part.slice(length - 8));
    length = 8;
  }
  while (length > 2 && parts.every((part) => part.startsWith('0'))) {
    parts = parts.map((part) => part.slice(1));
    length -= 1;
  }
  if (length > 2) parts = parts.map((part) => part.slice(0, 2));
  const [r, g, b] = parts.map((part) => Number.parseInt(part.padStart(2, '0'), 16) / 255) as [
    number,
    number,
    number,
  ];
  return { r, g, b, a: 1 };
}

/** Composites `top` over an opaque `bottom`. */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const blend = (a: number, b: number): number => a * top.a + b * (1 - top.a);
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: RGBA): number {
  return 0.2126 * decodeSrgb(r) + 0.7152 * decodeSrgb(g) + 0.0722 * decodeSrgb(b);
}

/** WCAG 2 contrast ratio between two opaque colors, 1 to 21. */
export function contrast(a: RGBA, b: RGBA): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export function toHex({ r, g, b, a }: RGBA): string {
  const byte = (value: number): string =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ''}`;
}

/** Resolves scheme-dependent colors and `currentcolor`. */
export function resolveColor(color: Color, current: RGBA | null, scheme: Scheme): RGBA | null {
  switch (color.kind) {
    case 'rgba':
      return color.value;
    case 'currentcolor':
      return current;
    case 'scheme':
      return resolveColor(scheme === 'dark' ? color.dark : color.light, current, scheme);
    default:
      return null;
  }
}
