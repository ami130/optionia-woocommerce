import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  /**
   * `import X = require('…')` is required here, not a style choice.
   *
   * 🔴 **`tsconfig.json` sets `allowSyntheticDefaultImports` WITHOUT
   * `esModuleInterop`.** That combination lets `import Stripe from 'stripe'`
   * typecheck and then resolve to `undefined` at runtime — the compiler is told
   * to pretend a default export exists and the emitted CommonJS never creates
   * one. F93 hit it through `Stripe.errors`, where it broke a `catch`; in
   * `billing.module.ts` it breaks construction outright.
   *
   * ⚠️ **So the rule is off for the files that must use the form**, rather than
   * seven inline disables that each invite deletion by someone tidying up. The
   * narrow path list is what keeps it from becoming a licence to write
   * `require()` anywhere.
   *
   * ✏️ **Found by CI on the first push in 57 commits.** `npm run lint` runs in
   * the Backend workflow and is **not** part of `bin/check.sh`, so seven errors
   * sat unseen for four days — the gates were green the whole time.
   */
  {
    files: [
      'src/billing/billing.module.ts',
      'src/billing/billing.module.spec.ts',
      'src/billing/provider-prices.ts',
      'src/billing/provider-prices.spec.ts',
      'src/billing/invoice.mapper.contract.spec.ts',
      'src/billing/subscription-lifecycle.contract.spec.ts',
      'test/billing-webhook.e2e-spec.ts',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
