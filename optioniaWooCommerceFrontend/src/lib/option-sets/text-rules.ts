/**
 * The three rules a merchant writes for a text answer.
 *
 * ## Why `pattern` is treated differently from every other field
 *
 * 🔴 **It is the one rule written as CODE.** M14.4 calls merchant-authored
 * regex a security boundary: it runs on every add-to-cart, and a
 * catastrophically backtracking expression — `(a+)+` and its relatives — is a
 * denial-of-service vector aimed at the merchant's own customers.
 *
 * ⚠️ **So the complexity judgement is NOT made here.** `type-registry.ts` is
 * explicit that authoring accepts an unsafe pattern and `patternsAreSafe`
 * refuses it at **publish**, *"because refusing it at authoring would stop a
 * merchant saving a draft they are still writing"*. A half-typed pattern is the
 * ordinary state of the field.
 *
 * This parser therefore checks what stops a merchant saving **nonsense** — a
 * pattern that cannot compile, or one longer than the API accepts — and leaves
 * the shape check to the gate that owns it. A form refusing early would diverge
 * from the API and block legitimate work in progress.
 *
 * 📌 **The field is `forbiddenWords`.** An audit of mine called it `blocklist`
 * from memory; the schema is the authority and the name was wrong.
 */

/** The fields the form holds, all strings that may be half-typed. */
export interface TextRuleFields {
  pattern: string;
  charset: string;
  words: string;
}

export type TextRuleParse =
  | { ok: true; validation: Record<string, unknown> | null }
  | { ok: false; message: string };

/** Mirrors `MAX_PATTERN_LENGTH` in the publish check and the plugin's own cap. */
const MAX_PATTERN = 200;
const MAX_WORDS = 200;
const MAX_WORD = 100;

/**
 * Build the stored validation, keeping the bounds this form does not edit.
 *
 * 🔴 **`stored` is merged, not replaced.** `textValidationSchema` is
 * `.strict()`, so a merchant setting a pattern would otherwise delete the
 * length limit they set in the wording panel — a rule they never opened.
 */
export function parseTextRules(
  fields: TextRuleFields,
  stored: Record<string, unknown> | null | undefined,
): TextRuleParse {
  const next: Record<string, unknown> = { ...(stored ?? {}) };
  const pattern = fields.pattern.trim();

  delete next.pattern;
  delete next.allowedCharset;
  delete next.forbiddenWords;

  if (pattern !== '') {
    if (pattern.length > MAX_PATTERN) {
      return { ok: false, message: `A pattern longer than ${MAX_PATTERN} characters is refused.` };
    }

    /*
     * 🔴 **Compiled, not shape-checked.** A pattern that cannot compile matches
     * nothing, so every answer would be refused — and that is a merchant typo,
     * not a security question. The *complexity* check belongs to
     * `patternsAreSafe` at publish, which is where the registry puts it.
     */
    try {
      new RegExp(pattern);
    } catch {
      return { ok: false, message: 'That is not a valid pattern.' };
    }

    next.pattern = pattern;
  }

  if (fields.charset.trim() !== '') {
    next.allowedCharset = fields.charset.trim();
  }

  /* One word per line — what a merchant pastes from a list they already keep. */
  const words = fields.words
    .split('\n')
    .map((word) => word.trim())
    .filter((word) => word !== '');

  if (words.length > MAX_WORDS) {
    return {
      ok: false,
      message: `At most ${MAX_WORDS} words; a longer list is a content-moderation product.`,
    };
  }

  const overlong = words.find((word) => word.length > MAX_WORD);

  if (overlong !== undefined) {
    return { ok: false, message: `"${overlong.slice(0, 20)}…" is longer than ${MAX_WORD} characters.` };
  }

  if (words.length > 0) {
    next.forbiddenWords = words;
  }

  return { ok: true, validation: Object.keys(next).length === 0 ? null : next };
}

/** Read stored rules back into form fields. */
export function readTextRules(
  validation: Record<string, unknown> | null | undefined,
): TextRuleFields {
  return {
    pattern: typeof validation?.pattern === 'string' ? validation.pattern : '',
    charset: typeof validation?.allowedCharset === 'string' ? validation.allowedCharset : '',
    words: Array.isArray(validation?.forbiddenWords)
      ? (validation.forbiddenWords as string[]).join('\n')
      : '',
  };
}
