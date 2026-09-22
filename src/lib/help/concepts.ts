/**
 * The concepts M20b.7 names, explained once (ADR-098).
 *
 * 🔴 **Both hierarchy explanations already existed, and only in empty states** —
 * which vanish the moment a merchant has a set or a group. A merchant meets them
 * once, before they have any content, and never again; but "what is the
 * difference between a group and an option?" is asked while building the
 * *second* one, by which time the explanation has been replaced by the thing it
 * explained.
 *
 * 📌 **One source, so two screens cannot disagree.** The list screen and the
 * editor both explain the hierarchy, and a copy on each is how they drift into
 * describing the product differently.
 */
export interface HelpConcept {
  /** What the merchant clicks to open it. A question, in their words. */
  readonly question: string;
  /** The answer. Short — this is help, not documentation. */
  readonly answer: string;
}

export const HELP: Readonly<Record<'hierarchy' | 'publishing' | 'pricing', HelpConcept>> = {
  /**
   * Set vs. group vs. option — the first thing a builder's vocabulary asks of
   * someone who has never seen one.
   */
  hierarchy: {
    question: 'What is a set, a group and an option?',
    answer:
      'An option set is everything you offer on a product. Inside it, a group holds ' +
      'related choices — “Size”, “Finish” — and an option is one choice in that group, ' +
      'with the values a customer picks from. A product gets a set; the set carries the ' +
      'rest.',
  },

  /**
   * What publish does.
   *
   * ⚠️ Already explained at the two moments it matters — the unpublished notice
   * and the empty version history — so this is the *durable* version, for a
   * merchant who is not currently looking at either.
   */
  publishing: {
    question: 'What does publishing do?',
    answer:
      'Publishing sends a snapshot of this set to your store. Until you publish, your ' +
      'changes are saved here and your storefront keeps serving the last version you ' +
      'published — so you can edit safely and release when you are ready.',
  },

  /**
   * Why a price is server-calculated.
   *
   * 🔴 **The one concept the milestone names that nothing explained at all.** The
   * merchant sees a worked example and reasonably asks whether it is what their
   * customer pays — and the honest answer is the reason the architecture exists.
   */
  pricing: {
    /*
     * ⚠️ **The example avoids words a merchant is likely to have used.** This
     * said "a £200 engraving for £2", and "Engraving" is an option name in the
     * canonical flow's own fixture — so `getByText('Engraving')` matched this
     * collapsed paragraph before the merchant's option and the E2E failed on a
     * hidden element. Help copy shares a page with content it cannot predict;
     * borrowing that vocabulary makes the page ambiguous to anyone searching it,
     * a screen reader included.
     */
    question: 'Why is the price worked out on the server?',
    answer:
      'Your storefront shows this total, but it never decides it. When a customer adds ' +
      'to cart, the price is recalculated here from the configuration you published — ' +
      'so a changed page, an old cached script or a crafted request cannot buy a £200 ' +
      'upgrade for £2.',
  },
} as const;
