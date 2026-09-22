import { AUTHORABLE_TYPES, takesValues } from '@/lib/schemas/option-sets';

import { PORTABLE_VERSION, type PortableSet } from './portable';

/**
 * Reading a set back from a JSON file (M20.8).
 *
 * ## A file is input, never authority
 *
 * 🔴 **Export is read-only and cheap; import is a WRITE path.** The document
 * arrives from a merchant's disk — hand-edited, produced by a future release, or
 * simply the wrong file — so every field is re-validated here, and the API
 * validates again behind it. Trusting the file because this dashboard wrote one
 * like it is how a malformed document becomes a malformed set.
 *
 * ⚠️ **Refused whole, never part-applied.** Creating groups, options and values
 * is a sequence of writes with no transaction across them: a document failing
 * halfway leaves a set nobody authored, and a create is a shape change that
 * clears the undo log. Validation therefore happens before the first request —
 * the same discipline bulk paste follows, for the same reason.
 */

/** Mirrors `AUTHORING_LIMITS` in the API, so a paste-sized document is refused up front. */
const LIMITS = { groupsPerSet: 100, optionsPerGroup: 200, valuesPerOption: 500, itemsPerGroup: 50 };

export type PortableParse =
  | { ok: true; set: PortableSet }
  | { ok: false; problems: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Validate a document, or report every reason it cannot be used.
 *
 * 📌 **Every problem at once.** A merchant fixing a hundred-line file one error
 * at a time would import a hundred times.
 */
export function parsePortable(raw: string): PortableParse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['That file is not a valid JSON document.'] };
  }

  if (!isObject(parsed)) {
    return { ok: false, problems: ['That file is not a valid option set document.'] };
  }

  const problems: string[] = [];

  /*
   * 🔴 **The version is checked FIRST and refuses by name.** A document from a
   * later release may use fields this one would silently drop, and importing it
   * would produce a set quietly missing what the merchant exported.
   */
  if (parsed.version !== PORTABLE_VERSION) {
    return {
      ok: false,
      problems: [
        `This file is format version ${String(parsed.version ?? 'unknown')}; ` +
          `this dashboard reads version ${PORTABLE_VERSION}.`,
      ],
    };
  }

  if (text(parsed.name) === '') {
    problems.push('The document has no set name.');
  }

  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];

  if (groups.length === 0) {
    problems.push('The document has no groups.');
  }

  if (groups.length > LIMITS.groupsPerSet) {
    problems.push(`A set holds at most ${LIMITS.groupsPerSet} groups.`);
  }

  /* The presentations this dashboard can author — a superset would import an
   * option the editor cannot open: authored, published and uneditable. */
  const authorable = new Set<string>(AUTHORABLE_TYPES.map((type) => type.value));

  groups.forEach((rawGroup, g) => {
    if (!isObject(rawGroup)) {
      problems.push(`Group ${g + 1} is not a group.`);

      return;
    }

    if (text(rawGroup.label) === '') {
      problems.push(`Group ${g + 1} has no label.`);
    }

    const options = Array.isArray(rawGroup.options) ? rawGroup.options : [];

    if (options.length > LIMITS.optionsPerGroup) {
      problems.push(`Group ${g + 1} has more than ${LIMITS.optionsPerGroup} options.`);
    }

    const items = Array.isArray(rawGroup.items) ? rawGroup.items : [];

    if (items.length > LIMITS.itemsPerGroup) {
      problems.push(`Group ${g + 1} has more than ${LIMITS.itemsPerGroup} items.`);
    }

    /* 🔴 The API refuses a duplicate key; finding it here avoids a part-write. */
    const optionKeys = new Set<string>();

    options.forEach((rawOption, o) => {
      const where = `Group ${g + 1}, option ${o + 1}`;

      if (!isObject(rawOption)) {
        problems.push(`${where} is not an option.`);

        return;
      }

      const key = text(rawOption.key);

      if (key === '') {
        problems.push(`${where} has no key.`);
      } else if (optionKeys.has(key)) {
        problems.push(`${where} repeats the key "${key}".`);
      } else {
        optionKeys.add(key);
      }

      if (text(rawOption.label) === '') {
        problems.push(`${where} has no label.`);
      }

      const presentation = text(rawOption.presentation);

      if (!authorable.has(presentation)) {
        problems.push(`${where} is a "${presentation}", which this dashboard cannot author.`);
      }

      const values = Array.isArray(rawOption.values) ? rawOption.values : [];

      /*
       * 🔴 **A valueless type must refuse values.** The API says why: the
       * publish check deliberately looks past a valueless option's values, so
       * rows created from them *"exist, validate, publish, and mean nothing"*,
       * and the storefront renders an input that ignores them.
       *
       * ⚠️ **Checked here AND there.** The API is the boundary; this exists so
       * a merchant reads which line of their file is wrong rather than a 400
       * about a document they cannot see.
       */
      if (values.length > 0 && !takesValues(presentation)) {
        problems.push(`${where} is a "${presentation}", which the customer types — it takes no values.`);
      }

      if (values.length > LIMITS.valuesPerOption) {
        problems.push(`${where} has more than ${LIMITS.valuesPerOption} values.`);
      }

      const valueKeys = new Set<string>();

      values.forEach((rawValue, v) => {
        const at = `${where}, value ${v + 1}`;

        if (!isObject(rawValue)) {
          problems.push(`${at} is not a value.`);

          return;
        }

        const valueKey = text(rawValue.valueKey);

        if (valueKey === '') {
          problems.push(`${at} has no key.`);
        } else if (valueKeys.has(valueKey)) {
          problems.push(`${at} repeats the key "${valueKey}".`);
        } else {
          valueKeys.add(valueKey);
        }

        if (text(rawValue.label) === '') {
          problems.push(`${at} has no label.`);
        }
      });
    });
  });

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, set: parsed as unknown as PortableSet };
}
