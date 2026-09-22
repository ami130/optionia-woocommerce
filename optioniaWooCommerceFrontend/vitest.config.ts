import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest, deliberately without `@vitejs/plugin-react`.
 *
 * That plugin pulls `@rolldown/plugin-babel`, which demands Babel 8 while the
 * Next.js toolchain here is on Babel 7 — an unresolvable peer conflict, not a
 * flag away. It exists to transform JSX, and nothing under test is a component:
 * the API client, the token store and the error mapping are plain modules.
 *
 * ✏️ **Component tests arrived without it.** `react-dom/server` ships with Next
 * and renders a component that is a pure function of its props to an HTML
 * string, which is what `states.render.test.tsx` and
 * `product-display.render.test.tsx` do. Vitest's own esbuild transform handles
 * their JSX. The plugin would still be needed for anything driving hooks or
 * events; nothing here does.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,

    /*
     * `e2e/` belongs to Playwright, which brings its own `test` and `expect`.
     * Without this exclusion Vitest collects those specs, fails to resolve
     * `@playwright/test`'s runner, and reports a failure that is about the
     * harness rather than the product.
     */
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
