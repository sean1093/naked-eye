import { defineConfig } from 'tsup';
import { pageScriptEsbuildPlugin } from './scripts/page-script.js';

export default defineConfig({
  // ESM (.js, because package.json is type: module) + CJS (.cjs) + types.
  entry: { index: 'src/index.ts', browser: 'src/browser.ts' },
  format: ['esm', 'cjs'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  clean: true,
  // Embeds browser mode's in-page script; see scripts/page-script.ts.
  esbuildPlugins: [pageScriptEsbuildPlugin()],
});
