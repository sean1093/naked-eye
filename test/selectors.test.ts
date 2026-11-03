import { parse } from 'css-what';
import { describe, expect, it } from 'vitest';
import { specificityOf } from '../src/css/selectors.js';
import { styled } from './helpers.js';

const STANDARDS = '<!doctype html>';

/** Whether `selector` hides the element `#t` in `body`. */
function matches(selector: string, body: string): boolean {
  return (
    styled(`${STANDARDS}<style>${selector} { display: none }</style>${body}`).style('t').display
      .kind === 'none'
  );
}

describe('specificity', () => {
  it.each([
    ['#a', [1, 0, 0]],
    ['[id=a]', [0, 1, 0]],
    ['p.a:first-child', [0, 2, 1]],
    [':is(#a, p) .b', [1, 1, 0]],
    [':not(.a, #b)', [1, 0, 0]],
    [':has(> p, #x)', [1, 0, 0]],
    [':where(#a) p', [0, 0, 1]],
    [':nth-child(2 of #a, .b)', [1, 1, 0]],
    ['p::before', [0, 0, 2]],
    ['*', [0, 0, 0]],
  ])('%s has specificity %j', (selector, expected) => {
    expect(specificityOf((parse(selector) as never[][])[0] as never)).toEqual(expected);
  });
});

describe('pseudo-classes, judged before any interaction', () => {
  it.each([
    [':placeholder-shown', '<input id=t placeholder=p>', true],
    [':placeholder-shown', '<input id=t placeholder=p value=v>', false],
    [':placeholder-shown', '<textarea id=t placeholder=p></textarea>', true],
    [':invalid', '<select id=t required><option value="">pick</option></select>', true],
    [':invalid', '<input id=t type=checkbox required>', true],
    ['form:invalid', '<form id=t><textarea required></textarea></form>', true],
    [':valid', '<input id=t>', true],
    [':out-of-range', '<input id=t type=number min=1 max=5 value=9>', true],
    [':in-range', '<input id=t type=range min=1 max=5 value=3>', true],
    [':dir(rtl)', '<div dir=rtl><p id=t>x</div>', true],
    [':dir(ltr)', '<p id=t>x', true],
    [':defined', '<x-widget id=t>x</x-widget>', false],
    [':defined', '<p id=t>x', true],
    [':open', '<details id=t open>x</details>', true],
    [':default', '<input id=t type=radio checked>', true],
    [':indeterminate', '<progress id=t></progress>', true],
    [':paused', '<video id=t></video>', true],
    [':muted', '<audio id=t controls muted></audio>', true],
    [':modal, :popover-open, :fullscreen, :autofill', '<p id=t>x', false],
    [':state(open), :host, :host-context(p)', '<p id=t>x', false],
  ])('%s against %s is %s', (selector, body, expected) => {
    expect(matches(selector, body)).toBe(expected);
  });

  it('treats :scope in a document style sheet as the root', () => {
    expect(matches(':scope p', '<p id=t>x')).toBe(true);
    expect(matches('& p', '<p id=t>x')).toBe(true);
  });

  it('drops pseudo-element selectors from element matching', () => {
    expect(matches('p::before', '<p id=t>x')).toBe(false);
    expect(matches('p:after', '<p id=t>x')).toBe(false);
  });
});

describe('media queries', () => {
  const env = (width: number, height: number, colorScheme: 'light' | 'dark' = 'light') => ({
    environment: { width, height, colorScheme },
  });
  const hidden = (query: string, options = env(1280, 800)) =>
    styled(
      `${STANDARDS}<style>@media ${query} { p { display: none } }</style><p id=t>x`,
      options,
    ).style('t').display.kind === 'none';

  it.each([
    ['(orientation: landscape)', true],
    ['(min-aspect-ratio: 16/10)', true],
    ['(max-aspect-ratio: 1/1)', false],
    ['(min-resolution: 2dppx)', false],
    ['(-webkit-min-device-pixel-ratio: 1)', true],
    ['(hover) and (pointer: fine)', true],
    ['(prefers-reduced-motion)', false],
    ['(prefers-color-scheme: dark)', false],
    ['(color)', true],
    ['(monochrome)', false],
    ['not all and (color)', false],
    ['only screen', true],
    ['print, (min-width: 1px)', true],
    ['(min-width: 1px) or (max-width: 1px)', true],
    ['not ((min-width: 1px) and (max-width: 1px))', true],
    ['(1px < height < 900px)', true],
    ['(width >= 80em)', true],
    ['screen and (min-width: 1px) or (max-width: 1px)', false],
    ['tv', false],
    ['(min-width: 1px', false],
  ])('%s matches: %s', (query, expected) => {
    expect(hidden(query)).toBe(expected);
  });

  it('follows the configured environment', () => {
    expect(hidden('(prefers-color-scheme: dark)', env(1280, 800, 'dark'))).toBe(true);
    expect(hidden('(orientation: portrait)', env(400, 800))).toBe(true);
  });
});

describe('@supports', () => {
  const hidden = (condition: string) =>
    styled(
      `${STANDARDS}<style>@supports ${condition} { p { display: none } }</style><p id=t>x`,
    ).style('t');

  it('decides selector() and combinations of modeled declarations', () => {
    expect(hidden('selector(:has(p))').display.kind).toBe('none');
    expect(hidden('selector(:::bad)').display.kind).toBe('box');
    expect(hidden('(display: grid) and (not (opacity: banana))').display.kind).toBe('none');
    expect(hidden('(--anything: 1)').display.kind).toBe('none');
    expect(hidden('(opacity: banana) or (display: flex)').display.kind).toBe('none');
  });
});
