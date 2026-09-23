'use client';

import { useMemo, useState } from 'react';

import { formatAmount } from '@/lib/money/money';
import type { Product } from '@/lib/products/api';
import { INPUT_TYPES, answerInput } from '@/lib/preview/answer-input';
import { fieldConstraints } from '@/lib/preview/field-constraints';
import { previewBase, rendersOptions } from '@/lib/preview/preview-base';
import { optionPricingDelta, priceConfigDelta } from '@/lib/money/price-config-delta';
import { mergedEntries } from '@/lib/option-sets/entries';
import type { AuthoringSet } from '@/lib/option-sets/api';
import {
  CHOICE_COLUMN_MIN,
  SWATCH_SIZES_EM,
  describedBy,
  displaySettings,
  dividerStyle,
  styleTokens,
  guidance,
  valuePrice,
} from '@/lib/preview/option-view';
import { optionsUnder } from '@/lib/preview/options-under';
import { evaluableAnswers, evaluableRules, type PreviewAnswers } from '@/lib/preview/preview-answers';
import { previewTree, type PreviewOption, type PreviewValue } from '@/lib/preview/preview-tree';
import { pricingState, ruleEffects } from '@/lib/preview/rule-effects';
import { evaluateRules, type TargetState } from '@/lib/rules/rule-evaluator';

import { OptionPreview } from './option-preview';

/**
 * The whole set, as a customer would receive it.
 *
 * 🔴 **This is the pane M20.1 was written with and shipped without.** That
 * milestone read *"structure · editor · live preview"*; the shell shipped with
 * two panes and recorded the third as Phase 21's subject.
 *
 * ⚠️ **Not a second `OptionPreview`** (ADR-104). That one lives inside the
 * option editor form and answers *"is this the control I meant?"* for the field
 * being typed into. This answers *"what does my customer get?"* for the whole
 * set: every enabled group in order, every enabled value, with real prices.
 *
 * ## What makes it a preview rather than a mock-up
 *
 * It renders `previewTree()` — the authoring tree reduced to exactly what the
 * publish serializer would emit, with disabled rows dropped and pricing
 * converted to the document's dialect (ADR-103). So a group the merchant
 * disabled is **absent** here, as it would be absent from the storefront, rather
 * than drawn greyed out.
 *
 * Prices come from `priceConfigDelta`, the evaluator the storefront and the
 * server both run, held byte-identical across repositories by
 * `bin/check-evaluator-parity.sh`.
 *
 * 📌 **Rules are not applied yet.** M21.3 wires `evaluateRules` and the answers
 * a customer would give; until then this shows the set with every rule dormant,
 * which is what a customer sees before touching anything.
 */
/**
 * ⚠️ **Products are passed in, not fetched here.**
 *
 * ✏️ **A first version called `useQuery` inside this component**, and every
 * render test broke with *"No QueryClient set"* — a design signal rather than a
 * test problem. A preview is a pure function of a set, a chosen product and a
 * width; fetching its own data would couple the one component whose whole job is
 * to be predictable to the network, and would make it untestable without a
 * provider it has no other need for.
 *
 * The page already supplies `set` the same way.
 */
export function SetPreview({
  set,
  products = [],
  docked = false,
}: {
  set: AuthoringSet;
  products?: readonly Product[];
  /**
   * 🔴 **The frame is only a frame if it can be resized** (ADR-108).
   *
   * Phone is 23.4rem, tablet 46rem and desktop 100%. Beside the editor there
   * is room for the first and not the others — tablet overflows by 22rem, and
   * desktop clamps to the column while its button still says Desktop, which
   * is a control lying about what it did.
   *
   * ⚠️ **So a docked preview offers phone alone, and says why.** The merchant
   * keeps the wider widths by opening the preview full-width, where they mean
   * something. Hiding the buttons without explanation would read as a missing
   * feature rather than a deliberate constraint.
   */
  docked?: boolean;
}) {
  const tree = useMemo(() => previewTree(set), [set]);

  /*
   * What a customer has chosen so far. Rules read these, and a rule that hides
   * an option **clears its answer** inside the evaluator — which is why the
   * answers are held here and re-evaluated from scratch rather than patched.
   */
  const [answers, setAnswers] = useState<PreviewAnswers>({});

  /*
   * 🔴 **The frame resizes; the markup inside is intrinsically responsive**
   * (ADR-108). The storefront ships **no** `@media` queries — a column *"needs a
   * width this stylesheet cannot know without owning the theme's layout"* — so
   * three preset widths change the *container* and the choice grid reacts the
   * way it reacts in a real theme, because it is built the same way.
   */
  const [width, setWidth] = useState<PreviewWidth>(docked ? 'phone' : 'desktop');

  /*
   * The product a merchant is pricing against. `null` until they choose — which
   * is every set while it is being written, and why the stated sample stays.
   */
  const [productId, setProductId] = useState<string | null>(null);

  const chosen = products.find((item) => item.id === productId) ?? null;
  const base = previewBase(chosen);

  /*
   * 🔴 **The evaluator reports states for three target types, and all three
   * matter.** A rule may target a group, an option or a value; `ruleEffects`
   * expands them the way the storefront does — a hidden group hides every option
   * inside it, a hidden value hides that value alone.
   */
  const { outcome, effects } = useMemo(() => {
    const under = optionsUnder(tree);
    const valueIds = new Set(
      tree.groups.flatMap((group) => group.options.flatMap((option) => option.values.map((value) => value.id))),
    );

    const evaluated = evaluateRules(
      evaluableRules(tree),
      evaluableAnswers(tree, answers),
      under,
    );

    return { outcome: evaluated, effects: ruleEffects(evaluated, under, valueIds) };
  }, [tree, answers]);

  if (tree.groups.length === 0) {
    return (
      <section className="space-y-2" aria-labelledby="set-preview-heading">
        <PreviewHeading />
        <p className="text-muted-foreground text-sm">
          {/*
            * An empty preview is a real answer, not a missing one: a set whose
            * groups are all disabled publishes nothing, and a merchant should
            * see that here rather than on a storefront.
            */}
          Nothing would be shown to a customer yet. Add a group, or enable one.
        </p>
      </section>
    );
  }

  /*
   * 🔴 **`refused` is "this cannot be priced", never "no rules applied"**
   * (ADR-050). Rules that never settle mean the storefront refuses the line, so
   * a preview that quietly drew the unevaluated set would show a merchant a
   * product a customer cannot buy.
   */
  if (outcome.refused !== null) {
    return (
      <section className="space-y-2" aria-labelledby="set-preview-heading">
        <PreviewHeading />
        <p className="text-destructive text-sm">
          These rules could not be resolved ({outcome.refused}), so a customer would not be
          able to buy this product. Check for rules that undo each other.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="set-preview-heading">
      <PreviewHeading />

      <div className="flex flex-wrap items-center gap-3">
        <WidthPicker value={width} onChange={setWidth} docked={docked} />

        {/*
          * Choosing a product is optional, and the stated sample is the default
          * — a set being written has no assignment yet, and refusing to preview
          * until one exists would withhold the answer at the moment it is most
          * useful.
          */}
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          Price against
          <select
            /*
             * Named, because the preview also draws a customer's own dropdown —
             * two unnamed comboboxes on one page is ambiguous for a screen
             * reader before it is ambiguous for a test.
             */
            aria-label="Price against"
            className="bg-background rounded border px-2 py-1 text-xs"
            value={productId ?? ''}
            onChange={(event) => setProductId(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">a sample price</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="space-y-6 rounded-lg border border-dashed p-4"
        style={{ maxWidth: PREVIEW_WIDTHS[width] }}
      >
        {tree.groups.map((group) => (
          <div key={group.id} className="space-y-3">
            <div className="space-y-1">
              {/*
                * 🔴 **A `div`, not a heading, and that is the accessibility
                * choice as well as the practical one.**
                *
                * The labels in here are a merchant's sample content, not this
                * page's structure: a screen-reader user navigating by heading
                * wants the editor's own sections, not a second copy of every
                * group name inside a preview. The section's own `h2` says where
                * they are; what is inside it is an illustration.
                *
                * ⚠️ **And it collided.** `canonical.spec.ts` clicks
                * `getByRole('heading', { name: 'Finish' })` to move focus and
                * trigger autosave — a step that once proved a real lost-edit
                * bug. Rendering group labels as headings made that locator
                * match two elements and fail on strict mode. The preview must
                * not compete with the editor for the page's landmarks.
                */}
              <div className="text-sm font-medium">{group.label}</div>
              {group.description === null ? null : (
                <p className="text-muted-foreground text-xs">{group.description}</p>
              )}
            </div>

            {/*
              * Options and presentational items interleave on **one** sortOrder
              * scale, which is what the storefront's renderer does — a heading's
              * only job is to sit above the right control (ADR-106). Reusing
              * `mergedEntries` rather than re-sorting here is deliberate: it is
              * the ordering the editor itself shows.
              */}
            {mergedEntries(group).map((entry) =>
              entry.kind === 'item' ? (
                <ItemLikeness key={entry.id} item={entry.item} />
              ) : (
                <OptionLikeness
                  key={entry.id}
                  option={entry.option}
                  state={outcome.states.get(entry.option.id)}
                  states={outcome.states}
                  hidden={effects.hiddenOptions.has(entry.option.id)}
                  hiddenValues={effects.hiddenValues}
                  baseMinor={base.baseMinor}
                  answer={answers[entry.option.id]}
                  onAnswer={(value) =>
                    setAnswers((current) => ({ ...current, [entry.option.id]: value }))
                  }
                />
              ),
            )}
          </div>
        ))}
      </div>

      {/*
        * 🔴 **The base is stated, never implied** (ADR-107, following M20.6).
        * A percentage is meaningless without saying what it is a percentage of,
        * and *"a number a merchant mistakes for 'what my customer pays' is worse
        * than no number."*
        */}
      {/*
        * 🔴 **The base is stated, never implied** (ADR-107, ADR-101). A
        * percentage is meaningless without saying what it is a percentage of,
        * and *"a number a merchant mistakes for 'what my customer pays' is worse
        * than no number."*
        *
        * ⚠️ **"as last synced" is load-bearing.** `StoreProduct` is display-only
        * — *"a cached price shown at checkout would be a customer charged the
        * wrong amount"* — and the catalogue is push-driven (ADR-067), so this
        * number is as fresh as the store's last push and no fresher.
        *
        * 📌 **"This set's options"**, because a product may carry several option
        * sets and the storefront sums every one of them into a single line total
        * (ADR-101, G3). The editor is showing one set, so it says so.
        */}
      <p className="text-muted-foreground text-xs">
        This set&rsquo;s options, priced against {base.description} of{' '}
        {formatAmount(base.baseMinor)}.
      </p>

      {rendersOptions(chosen) ? null : (
        /*
         * 🔴 **The catalogue pushes every product type; the storefront renders
         * two.** `Renderer::SUPPORTED_TYPES` is `['simple', 'variable']`, so a
         * merchant can price an option set against an `external` or `grouped`
         * product and their customer would see nothing at all.
         */
        <p className="text-destructive text-xs">
          {chosen?.name} is a {chosen?.type} product, and options are only shown on simple and
          variable products. A customer would see none of this.
        </p>
      )}
    </section>
  );
}

/**
 * The three widths a merchant can check.
 *
 * ⚠️ **Container widths, not breakpoints.** They are the widths a theme's
 * product column tends to have on each device, and the option markup responds to
 * the space it is given — which is exactly what it does on a storefront.
 */
export const PREVIEW_WIDTHS = {
  phone: '23.4rem',
  tablet: '46rem',
  desktop: '100%',
} as const;

export type PreviewWidth = keyof typeof PREVIEW_WIDTHS;

const WIDTH_LABELS: Readonly<Record<PreviewWidth, string>> = {
  phone: 'Phone',
  tablet: 'Tablet',
  desktop: 'Desktop',
};

function WidthPicker({
  value,
  onChange,
  docked = false,
}: {
  value: PreviewWidth;
  onChange: (next: PreviewWidth) => void;
  docked?: boolean;
}) {
  /*
   * ⚠️ **Docked shows the one width that fits, not all three greyed out.**
   * A disabled control invites the question "why?"; a single control with a
   * sentence beside it answers it before it is asked. The sentence matters
   * more than the buttons — without it this reads as a feature that went
   * missing rather than one that moved.
   */
  const available = docked
    ? (['phone'] as PreviewWidth[])
    : (Object.keys(PREVIEW_WIDTHS) as PreviewWidth[]);

  return (
    <div role="group" aria-label="Preview width" className="flex items-center gap-1">
      {available.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          aria-pressed={candidate === value}
          className={`rounded border px-2 py-1 text-xs ${
            candidate === value ? 'bg-accent font-medium' : 'text-muted-foreground'
          }`}
        >
          {WIDTH_LABELS[candidate]}
        </button>
      ))}
      {docked ? (
        <span className="text-muted-foreground ml-1 text-xs">
          Open full width for tablet and desktop
        </span>
      ) : null}
    </div>
  );
}

function PreviewHeading() {
  return (
    <div className="space-y-1">
      <h2 id="set-preview-heading" className="text-sm font-medium">
        What your customer sees
      </h2>
      <p className="text-muted-foreground text-xs">
        Disabled groups, options and values are left out, exactly as publishing leaves them out.
      </p>
    </div>
  );
}

const DIVIDER_BORDER: Record<string, string> = {
  solid: 'border-solid',
  dashed: 'border-dashed',
  dotted: 'border-dotted border-t-2',
};

function ItemLikeness({
  item,
}: {
  item: { kind: string; content: string; display?: Record<string, unknown> | null };
}) {
  if (item.kind === 'divider') {
    /*
     * 🔴 **The merchant's divider style** (M21c.5, F35). This drew `border-t`
     * and nothing else until 2026-09-22, so a `dashed` divider previewed solid
     * and shipped dashed — the parity Phase 21c's exit criterion names.
     *
     * ⚠️ **`dotted` is 2px here as it is on the storefront**, because at 1px
     * the dots are nearly invisible against the 0.18 opacity a divider uses.
     * Copying the number rather than inventing one is the point.
     */
    return <hr className={`border-t ${DIVIDER_BORDER[dividerStyle(item)]}`} />;
  }

  return item.kind === 'heading' ? (
    <p className="text-sm font-semibold">{item.content}</p>
  ) : (
    <p className="text-muted-foreground text-sm">{item.content}</p>
  );
}

function OptionLikeness({
  option,
  state,
  states,
  hidden,
  hiddenValues,
  baseMinor,
  answer,
  onAnswer,
}: {
  option: PreviewOption;
  state: TargetState | undefined;
  states: ReadonlyMap<string, TargetState>;
  hidden: boolean;
  hiddenValues: ReadonlySet<string>;
  baseMinor: number;
  answer: unknown;
  onAnswer: (value: string) => void;
}) {
  const display = displaySettings(option);
  const blocks = guidance(option);

  /*
   * 🔴 **The merchant's style tokens, on the option's own wrapper** (M21c.2,
   * F34). Phase 21c's exit requires *"configured styles render identically in
   * preview and storefront"* — and the preview knew nothing about these four
   * until 2026-09-22, so that criterion was **false** while the phase read as
   * nearly closed.
   *
   * The storefront sets them on `.optionia-option`; this is that element here.
   */
  const style = styleTokens(option);

  /*
   * 🔴 **Hidden means ABSENT, exactly as a disabled option is.** A rule that
   * hides an option removes it from the page on the storefront; drawing it
   * greyed out here would show a merchant something no customer sees.
   */
  if (hidden) {
    return null;
  }

  /*
   * A rule may make an option required, or stop requiring it. `null` means no
   * rule spoke, so the authored value stands.
   */
  const isRequired = state?.required ?? option.isRequired;

  const input = answerInput(option.presentation);

  return (
    <div className="space-y-1.5" style={style as React.CSSProperties | undefined}>
      {input === 'choice' || input === 'none' ? (
        /*
         * A likeness is enough where the customer answers by choosing a value
         * below, or where there is nothing to answer at all (`hidden` answers
         * itself; a file cannot be invented).
         */
        <OptionPreview
          label={option.label}
          presentation={option.presentation}
          isRequired={isRequired}
          maxLength={readMaxLength(option)}
        />
      ) : (
        /*
         * 🔴 **A real control, because nine of fifteen types could not be
         * answered at all.** `OptionPreview` is deliberately inert — *"a
         * likeness, not the storefront"* (ADR-104) — and the only way to answer
         * an option here was to choose a **value**. So a rule reading
         * *"engraving text is not empty"*, the commonest conditional pattern
         * there is, could never fire: nothing to type into, condition always
         * false, and a correct rule looking broken.
         *
         * ⚠️ **And `per_char` prices what a customer types**, so option-level
         * pricing had nothing to price.
         */
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            {option.label}
            {isRequired ? <span aria-hidden="true"> *</span> : null}
          </span>
          {/*
            * 🔴 **The constraints a browser actually enforces.** The preview read
            * `max_length` and discarded the other sixteen validation rules, so a
            * merchant setting min 1 / max 100 on a quantity saw no limit at all
            * while the storefront emits real attributes.
            *
            * ⚠️ **Only what reaches a browser.** Selection and date bounds are
            * server-enforced — no template emits them — and inventing them here
            * would show a customer a limit their browser will not apply.
            */}
          <span className={input === 'range' ? 'flex items-center gap-3' : undefined}>
            <input
              type={INPUT_TYPES[input]}
              aria-label={option.label}
              aria-describedby={describedBy(option)}
              required={isRequired}
              value={typeof answer === 'string' ? answer : ''}
              onChange={(event) => onAnswer(event.target.value)}
              className={
                input === 'range'
                  ? 'w-full'
                  : 'bg-background h-9 w-full rounded-md border px-3 text-sm'
              }
              {...fieldConstraints(option.validation, option.presentation)}
            />

            {/*
              * 🔴 **A slider needs its value read out**, because the handle's
              * position is not a number a customer can read. The storefront
              * pairs every `type="range"` with an `<output>` for exactly this,
              * and drawing the slider without it would show a control whose
              * value is invisible.
              */}
            {input === 'range' ? (
              <output className="text-muted-foreground w-10 text-right text-sm tabular-nums">
                {typeof answer === 'string' && answer !== '' ? answer : '—'}
              </output>
            ) : null}
          </span>
        </label>
      )}

      {blocks.map((block) => (
        <p key={block.id} id={block.id} className="text-muted-foreground text-xs">
          {block.text}
        </p>
      ))}

      {/*
        * 🔴 **Option-level pricing, which nothing showed anywhere.**
        * `per_char`, `per_unit` and `tiered` are authorable, the **server
        * charges them**, and nine shared fixture cases pin the `per_char`
        * arithmetic across three repositories — and neither this preview nor
        * M20.6's worked example rendered a penny of it. A merchant setting
        * *"£0.25 per character"* saw no indication of cost at all.
        *
        * ⚠️ **The storefront shows no label for these either**, because
        * `OptionView::value_price` prices only value-level `fixed`. ADR-107
        * decided the preview shows the **server's** arithmetic rather than the
        * storefront's silence — and this is that decision applied to the half it
        * had not reached.
        *
        * 📌 **Charged against what the customer typed**, so it appears only once
        * they have: `per_char` of an empty field is nothing, which is also what
        * the server charges.
        */}
      <OptionPrice pricing={option.pricing} answer={answer} />

      {/*
        * 🔴 **Two rules setting different prices is a refusal, not a winner.**
        * There is no principled choice between 5.00 and 7.00, and picking one
        * would make the amount depend on rule order. ADR-052 refuses the pair at
        * publish; this is what a merchant sees if one reaches here anyway.
        */}
      {(() => {
        /*
         * A value's rule-set price **overrides** its option's, and a conflict on
         * either refuses — `SelectionResolver::set_price_for()` checks both.
         * Taken across the option's values, because whichever the customer
         * chooses is the one that prices the line.
         */
        const priced = option.values.reduce(
          (carried, value) => {
            const fromValue = pricingState(state, states.get(value.id));

            return fromValue.priceConflict || fromValue.priceMinor !== null ? fromValue : carried;
          },
          pricingState(state, undefined),
        );

        if (priced.priceConflict) {
          return (
            <p className="text-destructive text-xs">
              Two rules set different prices on this option, so it cannot be priced.
            </p>
          );
        }

        return priced.priceMinor === null ? null : (
          <p className="text-muted-foreground text-xs">
            A rule sets this to {formatAmount(priced.priceMinor)}.
          </p>
        );
      })()}

      {option.values.length === 0 ? null : (
        <ul
          aria-describedby={describedBy(option)}
          /*
           * 🔴 **`columns` is a MAXIMUM, not a count** (ADR-108). The storefront
           * gives `--cols-2` through `--cols-6` one identical rule —
           * `repeat(auto-fit, minmax(7em, 1fr))` — so the number only decides
           * *whether* a grid applies. Drawing exactly four columns would promise
           * a layout the shop gives only when the container is wide enough.
           *
           * `columns: 1` stays a plain list, because one column is the default
           * flow and `--cols-1` deliberately matches nothing.
           */
          className={display.columns > 1 ? 'grid gap-x-4 gap-y-1' : 'space-y-1'}
          style={
            display.columns > 1
              ? { gridTemplateColumns: `repeat(auto-fit, minmax(${CHOICE_COLUMN_MIN}, 1fr))` }
              : undefined
          }
        >
          {option.values
            .filter((value) => !hiddenValues.has(value.id))
            .map((value) => (
              <ValueLine
                key={value.id}
                value={value}
                priceDisplay={display.priceDisplay}
                swatchSize={display.swatchSize}
                baseMinor={baseMinor}
                chosen={answer === value.valueKey}
                onChoose={() => onAnswer(value.valueKey)}
              />
            ))}
        </ul>
      )}
    </div>
  );
}

/** What an option-level price charges for the answer given so far. */
function OptionPrice({
  pricing,
  answer,
}: {
  pricing: Record<string, unknown> | null | undefined;
  answer: unknown;
}) {
  const typed = typeof answer === 'string' ? answer : '';
  const priced = optionPricingDelta(pricing, typed);

  if (priced.unpriced !== null) {
    /* Named rather than silent: a blank reads as "free" (ADR-050). */
    return (
      <p className="text-destructive text-xs">could not be priced ({priced.unpriced})</p>
    );
  }

  if (priced.deltaMinor === 0) {
    /* `+0.00` beside an unanswered field reads as a mistake, not as nothing. */
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {priced.deltaMinor > 0 ? '+' : '-'}
      {formatAmount(Math.abs(priced.deltaMinor))} for what you have entered.
    </p>
  );
}

function ValueLine({
  value,
  priceDisplay,
  swatchSize,
  baseMinor,
  chosen,
  onChoose,
}: {
  value: PreviewValue;
  priceDisplay: ReturnType<typeof displaySettings>['priceDisplay'];
  swatchSize: ReturnType<typeof displaySettings>['swatchSize'];
  baseMinor: number;
  chosen: boolean;
  onChoose: () => void;
}) {
  const priced = valuePrice(
    value.priceConfig,
    priceDisplay,
    baseMinor,
    formatAmount,
    priceConfigDelta,
  );

  return (
    <li>
      {/*
        * A real control, because M21.3 is about what a customer's choices *do*.
        * Choosing a value answers its option, which is what rules read — so a
        * merchant can watch a rule fire rather than reason about whether it
        * would.
        */}
      <button
        type="button"
        onClick={onChoose}
        aria-pressed={chosen}
        /*
         * 🔴 **The price sits BESIDE the label, not aligned in a column**
         * (ADR-065). The storefront states the rule and its reason: *"the label
         * and the price are one sentence a customer reads together, and a column
         * needs a width this stylesheet cannot know without owning the theme's
         * layout."* Its markup is two adjacent spans in a flex row, and its CSS
         * spaces them with `margin-left: 0.35em`.
         *
         * ✏️ **This used `justify-between` until an audit caught it** — the
         * column layout ADR-065 explicitly rejects. The shape was copied from
         * `PricingExample`, which is right for a **merchant-facing worked
         * example** and wrong for a customer-facing control. The narrow frame
         * M21.2 added is exactly where the two diverge.
         */
        className={`flex w-full items-center rounded px-1 text-left text-sm ${
          chosen ? 'bg-accent font-medium' : ''
        }`}
        /*
         * 🔴 **`--optionia-gap` with Tailwind's own `gap-2` as the fallback**
         * (M21c.2). The storefront spaces a `.optionia-value` the same way: one
         * token, falling back to what the row always used.
         *
         * ⚠️ **`gap-2` left the class list**, because a utility class and an
         * inline `gap` would both apply and the inline one would win silently —
         * leaving a class that reads as the source of a value it no longer sets.
         */
        style={{
          gap: 'var(--optionia-gap, 0.5rem)',
          /*
           * 🔴 **The merchant's accent on the chosen row.** The storefront drives
           * the native `accent-color` of a radio or checkbox; the preview shows
           * selection as a highlighted row instead (ADR-104: *"a likeness, not
           * the storefront"*), so the accent lands on the thing that carries the
           * same meaning here.
           *
           * ⚠️ **Falls back to the dashboard's own `bg-accent`**, which the class
           * list still sets — an option configuring no accent keeps the preview's
           * native look rather than gaining a colour of ours.
           */
          ...(chosen ? { backgroundColor: 'var(--optionia-accent, var(--accent))' } : {}),
        }}
      >
        {/*
          * A swatch when the value carries one, at the size the merchant chose.
          * The storefront sizes these in `em` so they scale with the theme's
          * type; the preview uses the same three values.
          */}
        {value.colorHex || value.imageUrl ? (
            <span
              aria-hidden="true"
              className="inline-block shrink-0 border"
              style={{
                /*
                 * 🔴 **`var()` with the enum as fallback, exactly as the
                 * storefront writes it** (M21c.2). `--optionia-swatch` is the
                 * merchant's pixel override and `SWATCH_SIZES_EM` the three-word
                 * default — an option setting neither renders as it always did.
                 *
                 * ⚠️ **`rounded-sm` was dropped from the class list**, because a
                 * Tailwind radius and `--optionia-radius` would both apply and
                 * the class would win. The storefront's own `3px` is the
                 * fallback here, so the two surfaces agree.
                 */
                width: `var(--optionia-swatch, ${SWATCH_SIZES_EM[swatchSize]})`,
                height: `var(--optionia-swatch, ${SWATCH_SIZES_EM[swatchSize]})`,
                borderRadius: 'var(--optionia-radius, 3px)',
                background: value.imageUrl
                  ? `center / cover url(${value.imageUrl})`
                  : (value.colorHex ?? undefined),
              }}
            />
        ) : null}

        <span>{value.label}</span>

        {priced.unpriced === null ? (
          <span className="text-muted-foreground tabular-nums text-xs">{priced.label}</span>
        ) : (
        /*
         * Named rather than silent. A type this build cannot price is a gap the
         * merchant can act on; a blank looks like "free" (ADR-050).
         */
          <span className="text-destructive text-xs">could not be priced ({priced.unpriced})</span>
        )}
      </button>
    </li>
  );
}

/** The option's `max_length`, in the published dialect `previewTree()` emits. */
function readMaxLength(option: PreviewOption): number | null {
  const value = option.validation?.max_length;

  return typeof value === 'number' ? value : null;
}
