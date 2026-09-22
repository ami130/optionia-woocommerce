import type { HelpConcept } from '@/lib/help/concepts';
import { cn } from '@/lib/utils';

/**
 * A short explanation a merchant can open where they are (M20b.7, ADR-098).
 *
 * ## Why native `<details>`
 *
 * ⚠️ **A hover tooltip is unreachable on a phone**, and this repository already
 * guards phone usability — the builder's panes have a whole test block about
 * collapsing at 375px. A merchant on a tablet in a workshop is a real user, and
 * hover is not an interaction they have.
 *
 * `<details>` works by tap and by keyboard with no library: no positioning, no
 * dismissal handling, no focus trap, and it degrades to visible text if CSS
 * fails. A popover needs all four managed by hand for the same outcome, and each
 * is a way to make help *less* reachable than no help at all.
 *
 * 📌 **Collapsed by default.** These answer a question a merchant has once or
 * twice; open by default they are noise on every later visit, which is how
 * in-product help comes to be ignored.
 *
 * 📌 **The text comes from `HELP`, never from the call site.** Two screens
 * explaining the same concept in their own words is how a product comes to
 * describe itself differently in two places.
 */
export function HelpNote({
  concept,
  className,
}: {
  concept: HelpConcept;
  className?: string;
}) {
  return (
    <details className={cn('group text-muted-foreground text-xs', className)}>
      <summary
        /*
         * `cursor-pointer` and `marker:hidden` only; the triangle is replaced by
         * the caret below so it can sit after the text rather than before it.
         *
         * ⚠️ No `list-none` on its own — Safari needs the `::-webkit-details-marker`
         * rule that `marker:hidden` compiles to, and without it the native
         * triangle shows alongside ours.
         */
        className="marker:hidden inline-flex cursor-pointer items-center gap-1 underline decoration-dotted underline-offset-2"
      >
        {concept.question}
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>

      <p className="mt-2 max-w-prose leading-relaxed">{concept.answer}</p>
    </details>
  );
}
