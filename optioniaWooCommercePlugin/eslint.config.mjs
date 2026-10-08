import js from '@eslint/js';

/**
 * Linting the storefront runtime.
 *
 * ## Why this exists
 *
 * 🔴 **A duplicate function reached `main` and nothing noticed.** M26e.4 added
 * a second `cssEscape` to `frontend.js` — same name, same scope, 1,200 lines
 * apart — which silently overrode the one the rules engine had used since M17.
 * Both happened to agree on every input tried, so nothing broke; the next edit
 * to either would have changed rule matching with no test, no gate and no lint
 * to catch it. `no-redeclare` is an ESLint default and would have refused it
 * instantly.
 *
 * 📌 **Deliberately narrow.** This is ES5-era browser code with its own house
 * style — tabs, `var`, Yoda conditions, jQuery-free DOM work — and a
 * styleguide-grade config would bury a real finding under hundreds of
 * preferences. `js.configs.recommended` is the set that catches *mistakes*:
 * redeclarations, unreachable code, unused variables, `==` against `null` on
 * the wrong side, duplicate object keys.
 *
 * ⚠️ **`var` and function hoisting are NOT flagged**, because this file ships
 * to whatever browser a merchant's customer arrives with and has no build step.
 * Rules that would push it toward `let`/`const` are off by omission, not by
 * oversight.
 */
export default [
  {
    ignores: [ 'node_modules/**', 'vendor/**', 'tests/js/rendered-fixtures.json' ],
  },

  {
    files: [ 'assets/js/**/*.js' ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        /* The browser surface this runtime actually touches. */
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        XMLHttpRequest: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        WeakMap: 'readonly',
        CSS: 'readonly',
        Intl: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        Image: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        Symbol: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      /*
       * 📌 **An empty `catch` is a decision here, not an oversight.** The
       * runtime parses a response body, reads `localStorage` and measures text
       * in places where the only sane answer to a failure is "carry on without
       * it" — M26e.6's rule that a sale is never blocked by an extra. The
       * binding is still required by ES5 syntax (optional catch binding is
       * ES2019 and this ships unbuilt), so the name is allowed to go unused
       * where it is literally called `error`.
       */
      'no-unused-vars': [ 'error', { caughtErrors: 'none' } ],
    },
  },

  {
    /*
     * 📌 **The build files lint too.** `vitest.config.js` was the one JavaScript
     * file in this plugin ESLint could not see — and it is the file that decides
     * what the test suite runs, so a mistake there silently shrinks the suite.
     */
    files: [ '*.config.js', '*.config.mjs' ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },

  {
    /* The test suite is modern JavaScript run by vitest, not shipped code. */
    files: [ 'tests/js/**/*.js' ],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      /*
       * 📌 **On, so the one deliberate use has to say so.** `rule-fixtures`
       * evaluates `rules.js` through `new Function` because the engine ships as
       * a classic script and importing it would test a shape the storefront
       * never loads. That file already carried an `eslint-disable` for it; the
       * rule is enabled here so the directive means something rather than
       * sitting stale.
       */
      'no-new-func': 'error',
    },
  },
];
