import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * 🔴 **A THIRD resolver had to be told about `@shared/*`.**
 *
 * The shared geometry lives in a sibling directory, outside this Next.js
 * project, and three tools must each be told so independently:
 *
 *   - `tsconfig.json` — satisfies `tsc`, and nothing else reads it
 *   - `vitest.config.ts` — Vite does not read tsconfig paths (gate 31 records
 *     this: "the first test importing the shared geometry failed with 'Failed
 *     to resolve import' while `tsc` was perfectly happy")
 *   - this file — Turbopack reads neither of the above
 *
 * ⚠️ **The failure was LATENT until the Design Lab was wired into a page.**
 * Typecheck, lint and 2161 tests all passed while `next build` could not resolve
 * the import, because nothing in the page tree had imported a design-lab module
 * yet. A build is the only check that sees a bundler's resolver, which is why
 * gate 32 now builds the dashboard too.
 *
 * 📌 **`root`, not `resolveAlias`.** The problem is not the mapping —
 * Turbopack reports the alias resolving to `../shared/...` — but that the
 * target lies above the inferred project root, which no alias can fix; only
 * naming a root containing both can. `resolveAlias` was tried first in three
 * forms (`'@shared/*'` with a wildcard, an absolute value, and the bare prefix
 * `vitest.config.ts` uses) and none resolved.
 *
 * ⚠️ **`distDir` was tried beside it and made things worse**, so it is
 * deliberately absent: an absolute value is interpreted relative to the project
 * and created a literal `Users/` directory, and Next rewrote `tsconfig.json` to
 * match. The build output lands in `.next/` here without it.
 */
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, '..'),
  },
};

export default nextConfig;
