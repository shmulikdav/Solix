import { defineConfig } from 'vitest/config';

/**
 * Minimal root config — deliberately does NOT override include/environment, so
 * the node tests keep running exactly as before and web tests opt into jsdom
 * per-file via `// @vitest-environment jsdom`.
 */
export default defineConfig({
  test: {
    // The Claude Code plugin under plugin/ has tests of its own, written
    // against `claude-code/testing` and run by `claude plugin test`. They
    // import a module that only exists inside the engine's host, so vitest
    // can only fail them. `pnpm test:plugin` runs those.
    exclude: ['**/node_modules/**', '**/dist/**', 'plugin/**'],
  },
  define: {
    // Vite injects this when building the web UI; component tests render the
    // same components outside that build, so it must be defined here too.
    __SOLIX_VERSION__: JSON.stringify('0.0.0-test'),
  },
});
