/**
 * Browser mode: runs the extraction inside a page that Playwright or Puppeteer
 * already has open, so the verdicts come from the browser's own computed
 * styles and layout.
 */
import type { PageLimits } from './browser/page.js';
import { PAGE_SCRIPT } from './browser/page-script.js';
import type { ExtractResult } from './types.js';

/**
 * What browser mode needs from a page handle: the ability to evaluate a script
 * in the page and get its result back. Playwright's `Page` and `Frame` and
 * Puppeteer's `Page` all satisfy it, so neither library is a dependency here.
 */
export interface PageLike {
  evaluate(pageFunction: string): Promise<unknown>;
}

/**
 * The thresholds browser mode takes. The viewport, the color scheme and the
 * style sheets are the page's own, so unlike `ExtractOptions` there is nothing
 * to configure for them; off-screen text is decided by the document's real
 * scrollable area rather than by a distance.
 */
export interface BrowserOptions {
  /** Text smaller than this many CSS pixels, after zoom and scaling, is hidden. Default `4`. */
  minFontSize?: number;
  /** Text whose effective opacity is below this is hidden. Default `0.1`. */
  minOpacity?: number;
  /** Text whose WCAG contrast ratio against its background is below this is hidden. Default `1.5`. */
  minContrast?: number;
}

/**
 * Returns the text of the open page that a sighted human would see, and a
 * report of everything removed, in the same shape static mode returns.
 *
 * The page is only read, never changed. The script runs in the page's main
 * world, so a hostile page can interfere with it: see the threat model.
 */
export async function extractVisibleFromPage(
  page: PageLike,
  options: BrowserOptions = {},
): Promise<ExtractResult> {
  const limits: PageLimits = {
    minFontSize: options.minFontSize ?? 4,
    minOpacity: options.minOpacity ?? 0.1,
    minContrast: options.minContrast ?? 1.5,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0)
      throw new TypeError(`${name} must be a finite, non-negative number`);
  }
  // The page script is an IIFE that assigns one object; calling it here keeps
  // the whole thing a single expression, which is what `evaluate` takes.
  const result = await page.evaluate(
    `(() => { ${PAGE_SCRIPT}; return __nakedEye.run(${JSON.stringify(limits)}); })()`,
  );
  return result as ExtractResult;
}

export type {
  ExtractResult,
  GeneratedText,
  HiddenReason,
  HiddenText,
  Warning,
  WarningCode,
} from './types.js';
