import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Where `RulesPanel` gets its rules (M20.8 audit F3).
 *
 * 🔴 **The tree already carries them.** `GET /:id/detail` returns the set's
 * rules — the backend projection's own docblock records the mirror-image
 * mistake being fixed once before: *"a fifth query on every dashboard render
 * whose result was thrown away"*. The dashboard then declared the field in
 * M20.6 step 0 and still fetched a second copy.
 *
 * ⚠️ **`initialData`, not a replacement for the query.** The panel's mutations
 * invalidate `['option-set', id, 'rules']`, and repointing them at the tree
 * would change that refresh contract for no gain. Seeding the query removes the
 * request on first render and leaves every later refresh exactly as it was.
 */
const panel = readFileSync(
  join(process.cwd(), 'src/components/option-sets/rules-panel.tsx'),
  'utf8',
);

describe('the rules query is seeded from the tree', () => {
  it('uses the set’s own rules as initial data', () => {
    const query = panel.slice(panel.indexOf('const rules = useQuery'), panel.indexOf('const findings'));

    expect(query).toMatch(/initialData:\s*set\.rules/);
  });

  /** ⚠️ The query stays, so the existing invalidation still refreshes it. */
  it('keeps the query and its key', () => {
    expect(panel).toMatch(/queryKey: \['option-set', set\.id, 'rules'\]/);
    expect(panel).toMatch(/queryFn: \(\) => listRules\(set\.id\)/);
  });
});
