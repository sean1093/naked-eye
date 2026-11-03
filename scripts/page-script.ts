/**
 * Embeds browser mode's in-page script in the build.
 *
 * `src/browser.ts` imports `PAGE_SCRIPT` from `./browser/page-script.js`, a
 * module that has no source file: only the declaration in
 * `src/browser/page-script.d.ts`, which is what `tsc` reads. Both bundlers
 * generate the module instead of resolving it, from `src/browser/page.ts`
 * bundled by esbuild into one self-contained IIFE string.
 *
 * Doing it in the bundler rather than in a code-generation step means the page
 * script is embedded in `dist/browser.js` and `dist/browser.cjs` (no file is
 * read at run time), that Vitest gets the same string without a prior build,
 * and that no generated source is committed. tsup and Vitest take different
 * plugin shapes, so each gets its own four-line adapter over `bundlePageScript`.
 */
import { fileURLToPath } from 'node:url';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin as VitePlugin } from 'vite';

const ENTRY = fileURLToPath(new URL('../src/browser/page.ts', import.meta.url));

/** The id both bundlers resolve `./browser/page-script.js` to. */
const VIRTUAL = '\0naked-eye:page-script';

const MATCHES = /(^|[\\/])browser[\\/]page-script\.js$/;

/** `src/browser/page.ts` as one IIFE that assigns `globalThis.__nakedEye`. */
export async function bundlePageScript(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__nakedEye',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
  });
  const [output] = result.outputFiles ?? [];
  if (output === undefined) throw new Error('the page script produced no output');
  return output.text.trim().replace(/;$/, '');
}

async function generate(): Promise<string> {
  return `export const PAGE_SCRIPT = ${JSON.stringify(await bundlePageScript())};\n`;
}

export function pageScriptEsbuildPlugin(): EsbuildPlugin {
  return {
    name: 'naked-eye-page-script',
    setup(builder) {
      builder.onResolve({ filter: MATCHES }, () => ({ path: VIRTUAL, namespace: 'naked-eye' }));
      builder.onLoad({ filter: /.*/, namespace: 'naked-eye' }, async () => ({
        contents: await generate(),
        loader: 'js',
      }));
    },
  };
}

export function pageScriptVitePlugin(): VitePlugin {
  return {
    name: 'naked-eye-page-script',
    enforce: 'pre',
    resolveId: (source) => (MATCHES.test(source) ? VIRTUAL : null),
    load: async (id) => (id === VIRTUAL ? await generate() : null),
  };
}
