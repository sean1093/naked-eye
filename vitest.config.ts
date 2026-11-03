import { defineConfig } from 'vitest/config';
import { pageScriptVitePlugin } from './scripts/page-script.js';

export default defineConfig({
  // The same in-page script the build embeds, so the tests need no build first.
  plugins: [pageScriptVitePlugin()],
  test: {
    include: ['test/**/*.test.ts'],
    // The browser corpus drives three engines, which is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The in-page script runs in the browser, where the Node coverage
      // provider cannot see it; the browser corpus exercises it instead.
      exclude: ['src/browser/**'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
