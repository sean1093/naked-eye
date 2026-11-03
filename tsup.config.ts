import { defineConfig } from 'tsup';

export default defineConfig({
  // ESM (.js, because package.json is type: module) + CJS (.cjs) + types.
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  clean: true,
});
