import { describe, expect, it } from 'vitest';

import { PORTABLE_VERSION } from './portable';
import { parsePortable } from './portable-import';

/**
 * Reading a set back from JSON (M20.8).
 *
 * 🔴 **A file is INPUT, never authority.** Export is read-only and cheap;
 * import is a write path, and the document arrives from a merchant's disk —
 * edited by hand, produced by an older release, or simply the wrong file. So
 * every field is re-validated here rather than trusted, and the API validates
 * again behind it.
 *
 * ⚠️ **Refused whole, never part-applied.** Creating groups and options is a
 * sequence of writes with no transaction across them, so a document that fails
 * halfway would leave a set nobody authored — and a create clears the undo log.
 * Validation happens before the first request.
 */
const doc = (over: Record<string, unknown> = {}) => ({
  version: PORTABLE_VERSION,
  name: 'Finish',
  groups: [
    {
      label: 'Finish',
      description: null,
      displayType: 'inline',
      isCollapsible: false,
      isEnabled: true,
      sortOrder: 0,
      options: [
        {
          key: 'colour',
          label: 'Colour',
          presentation: 'dropdown',
          isRequired: false,
          isEnabled: true,
          sortOrder: 0,
          values: [
            {
              valueKey: 'gold',
              label: 'Gold',
              sortOrder: 0,
              priceType: 'fixed',
              priceAmountMinor: 500,
            },
          ],
        },
      ],
      items: [],
    },
  ],
  rules: [],
  ...over,
});

describe('parsePortable', () => {
  it('accepts a document this release wrote', () => {
    expect(parsePortable(JSON.stringify(doc())).ok).toBe(true);
  });

  it('reads the set name', () => {
    const parsed = parsePortable(JSON.stringify(doc()));

    expect(parsed.ok && parsed.set.name).toBe('Finish');
  });

  /** 🔴 Not JSON at all is the commonest failure — a merchant picks a PDF. */
  it('refuses a file that is not JSON', () => {
    const parsed = parsePortable('not a document');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/not a valid/i);
  });

  /** 🔴 A version it cannot read is refused by NAME, not guessed at. */
  it('refuses a future format version', () => {
    const parsed = parsePortable(JSON.stringify(doc({ version: PORTABLE_VERSION + 1 })));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/version/i);
  });

  it('refuses a document with no version', () => {
    const noVersion: Record<string, unknown> = { ...doc() };

    delete noVersion.version;

    expect(parsePortable(JSON.stringify(noVersion)).ok).toBe(false);
  });

  it('refuses a document with no name', () => {
    expect(parsePortable(JSON.stringify(doc({ name: '' }))).ok).toBe(false);
  });

  it('refuses a document with no groups', () => {
    expect(parsePortable(JSON.stringify(doc({ groups: [] }))).ok).toBe(false);
  });

  /**
   * 🔴 **A presentation the dashboard cannot author is refused.** A document
   * from a future release may name one, and importing it would create an option
   * the editor cannot open — authored, published, and uneditable.
   */
  it('refuses an unknown presentation', () => {
    const bad = doc();

    (bad.groups[0]!.options[0] as { presentation: string }).presentation = 'hologram';

    expect(parsePortable(JSON.stringify(bad)).ok).toBe(false);
  });

  /** ⚠️ Every problem at once — one file, one round of corrections. */
  it('reports every problem, not only the first', () => {
    const bad = doc({ name: '' });

    (bad.groups[0]!.options[0] as { presentation: string }).presentation = 'hologram';

    const parsed = parsePortable(JSON.stringify(bad));

    expect(!parsed.ok && parsed.problems.length).toBeGreaterThan(1);
  });

  /** 🔴 A duplicate key within one option would be refused by the API. */
  it('refuses two values sharing a key', () => {
    const bad = doc();

    bad.groups[0]!.options[0]!.values.push({
      valueKey: 'gold',
      label: 'Gold again',
      sortOrder: 1,
      priceType: 'fixed',
      priceAmountMinor: 0,
    });

    expect(parsePortable(JSON.stringify(bad)).ok).toBe(false);
  });

  /**
   * 🔴 **A valueless type carrying values.** The API refuses it — its own
   * docblock calls the result *"rows that exist, validate, publish, and mean
   * nothing"* — and this check exists so a merchant reads which line is wrong
   * rather than a 400 about a document they cannot see.
   */
  it('refuses values on a type that takes none', () => {
    const bad = doc();
    const option = bad.groups[0]!.options[0] as Record<string, unknown>;

    option.presentation = 'text_field';

    expect(parsePortable(JSON.stringify(bad)).ok).toBe(false);
  });

  /** ⚠️ The same type with no values is fine — the rule is about the values. */
  it('accepts a valueless type that carries no values', () => {
    const fine = doc();
    const option = fine.groups[0]!.options[0] as Record<string, unknown>;

    option.presentation = 'text_field';
    option.values = [];

    expect(parsePortable(JSON.stringify(fine)).ok).toBe(true);
  });

  /** ⚠️ And two options sharing a key within one group. */
  it('refuses two options sharing a key', () => {
    const bad = doc();

    bad.groups[0]!.options.push({ ...bad.groups[0]!.options[0]!, label: 'Colour again' });

    expect(parsePortable(JSON.stringify(bad)).ok).toBe(false);
  });

  /**
   * 🔴 **The limits the API enforces per write, checked up front.** A document
   * exceeding them would fail partway through a sequence of creates, leaving a
   * half-built set with no undo.
   */
  it('refuses more values than the API accepts', () => {
    const bad = doc();

    bad.groups[0]!.options[0]!.values = Array.from({ length: 501 }, (_, i) => ({
      valueKey: `v${i}`,
      label: `V${i}`,
      sortOrder: i,
      priceType: 'fixed',
      priceAmountMinor: 0,
    }));

    expect(parsePortable(JSON.stringify(bad)).ok).toBe(false);
  });
});

/**
 * 🔴 **The round trip is the whole promise.** An export a merchant cannot
 * re-import is a file that looks like a backup and is not one — and neither
 * module's own tests would notice, because each is correct in isolation.
 */
describe('round trip', () => {
  it('re-imports what this dashboard exported', async () => {
    const { toPortable } = await import('./portable');
    const source = {
      id: 's1',
      storeId: 'store-1',
      name: 'Finish',
      status: 'draft',
      version: 0,
      rowVersion: 1,
      publishedAt: null,
      publishedConfigVersion: 0,
      groups: [
        {
          id: 'g1',
          label: 'Finish',
          description: null,
          sortOrder: 0,
          isEnabled: true,
          displayType: 'inline',
          isCollapsible: false,
          options: [
            {
              id: 'o1',
              key: 'colour',
              label: 'Colour',
              presentation: 'dropdown',
              isRequired: false,
              sortOrder: 0,
              isEnabled: true,
              values: [
                {
                  id: 'v1',
                  valueKey: 'gold',
                  label: 'Gold',
                  sortOrder: 0,
                  priceType: 'fixed',
                  priceAmountMinor: 500,
                  skuSuffix: '-GD',
                },
              ],
            },
          ],
          items: [],
        },
      ],
    };

    const exported = JSON.stringify(toPortable(source as never));
    const parsed = parsePortable(exported);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.set.groups[0]?.options[0]?.values[0]?.skuSuffix).toBe('-GD');
  });
});
