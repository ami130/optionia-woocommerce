import type { PreviewTree } from './preview-tree';

/**
 * Which options' answers a rule target controls.
 *
 * `evaluateRules` takes this map and, for every hidden target, does
 * `delete answers[optionId]` for each id it lists. So the question it answers is
 * narrow and specific: **whose answer disappears when this target is hidden?**
 * It is *not* "what does this target contain".
 *
 * | Target | Controls |
 * | --- | --- |
 * | group | every option inside it |
 * | option | itself |
 * | **value** | **nothing** |
 *
 * 🔴 **A value maps to NO option, and this is the whole reason the file exists.**
 *
 * Hiding one colour of five removes a *choice*: the question stays on the page
 * and the customer's answer stays valid. The plugin mapped a value to its owning
 * option until M17.8's audit, and the measurement there is the argument —
 * hiding `val-extra` **deleted the answer of a customer who had chosen `plain`**,
 * and an unrelated rule reading *"opt-b is empty"* then fired, hiding a third
 * option nothing was meant to touch.
 *
 * ⚠️ **The backend has a DIFFERENT map, and is right to.**
 * `publish-check.ts`'s `idsIn` maps a value to its owning option, because its
 * cycle detector asks what a target can *reach* — `set_default` writes the
 * owning option's answer. Two questions, two maps; conflating them is what
 * produced the defect above, and `publish-check.ts` says so in as many words:
 * *"This is NOT the map the evaluator clears answers through."*
 *
 * 🔴 **So the copy to mirror is the PLUGIN's**, not the one in the same language
 * sitting in the sibling repository — `SelectionResolver::index_containment()`
 * and `frontend.js`'s `containmentIn()`, which agree with each other.
 *
 * ⚠️ **The evaluator's own docblock said the opposite until this milestone.** It
 * read *"a value controls the option that owns it"*, written before M17.8 and
 * never corrected, naming a parameter (`answersFor`) that no longer exists. The
 * shared fixture is the authority, and its case is named
 * *"a value target hides a choice, and clears NO answer — not even its own
 * option's"*.
 *
 * ## Why it is built from the preview tree
 *
 * The plugin builds this from the published document, where disabled nodes are
 * already gone. `previewTree()` applies exactly those filters, so building from
 * it gives the storefront's map rather than the editor's.
 *
 * @param tree The preview projection of an option set.
 * @returns Target id → the options whose answers it clears.
 */
export function optionsUnder(tree: PreviewTree): ReadonlyMap<string, readonly string[]> {
  const under = new Map<string, readonly string[]>();

  tree.groups.forEach((group) => {
    /*
     * Registered before its options, so a group that contains none is still a
     * target the evaluator knows — `frontend.js` does the same. A target absent
     * from the map falls back to `?? []` inside the evaluator, which is the same
     * behaviour by accident rather than by statement.
     */
    under.set(group.id, []);

    group.options.forEach((option) => {
      under.set(group.id, [...(under.get(group.id) ?? []), option.id]);

      /* An option controls its own answer, and only its own. */
      under.set(option.id, [option.id]);

      /*
       * Registered with an empty list rather than omitted, so a value id is
       * still a target the evaluator recognises — the distinction between
       * "known, clears nothing" and "never heard of it".
       */
      option.values.forEach((value) => {
        under.set(value.id, []);
      });
    });
  });

  return under;
}
