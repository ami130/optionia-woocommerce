import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AnalyticsSummary } from '@/lib/analytics/api';
import { Summary } from './page';

/**
 * M25.3's numbers, on a screen a merchant can open.
 *
 * 🔴 **The backend shipped complete and unreachable — the tenth instance.**
 * `GET /analytics` had twenty e2e tests and no page, and Phase 25's exit
 * criterion reads *"a **merchant** can identify their highest-revenue options
 * and their dead ones"*. The subject is the merchant, not the API.
 *
 * ⚠️ **Rendered rather than asserted on props**, for the reason F132's tests
 * record: the defect was that nothing reached the screen, and a test reading the
 * same object the component reads would have passed the whole time.
 */
describe('Analytics summary', () => {
  function summary(over: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
    return {
      attach: {
        orders: 10,
        ordersWithOptions: 8,
        rate: 0.8,
        optionRevenueMinor: 12_000,
        totalRevenueMinor: 90_000,
        averageOrderValueWithOptionsMinor: 9_000,
        averageOrderValueWithoutOptionsMinor: 4_000,
      },
      topOptions: {
        rows: [{ optionKey: 'engraving', label: 'Engraving', revenueMinor: 9_900, orders: 4 }],
        total: 1,
        truncated: false,
      },
      topValues: { rows: [], total: 0, truncated: false },
      leastValues: {
        rows: [
          { optionKey: 'finish', valueKey: 'matte', label: 'Finish', revenueMinor: 100, orders: 1 },
        ],
        total: 1,
        truncated: false,
      },
      deadOptions: { rows: [], total: 0, truncated: false },
      trend: {
        windowDays: 30,
        currentMinor: 9_900,
        previousMinor: 6_600,
        currentOrders: 4,
        previousOrders: 3,
        changeFraction: 0.5,
      },
      products: {
        rows: [{ productRef: '42', name: 'Engraved Mug', revenueMinor: 9_900, orders: 4 }],
        total: 1,
        truncated: false,
      },
      unattributedProductSelections: 0,
      conversion: {
        rows: [{ optionKey: 'engraving', label: 'Engraving', views: 40, orders: 4, rate: 0.1 }],
        total: 1,
        truncated: false,
      },
      optionSets: {
        rows: [{ optionSetId: 'set-1', name: 'Mug options', revenueMinor: 9_900, orders: 4 }],
        total: 1,
        truncated: false,
      },
      unattributedSelections: 0,
      currency: 'GBP',
      ...over,
    };
  }

  /** 🔴 The sentence Phase 25 exists for: which option earns most. */
  it('names the highest-earning option and what it made', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('Engraving');
    expect(container.textContent).toContain('£99.00');
  });

  /**
   * 🔴 **The other half of the exit criterion.** A merchant acts on dead
   * options; listing only winners answers half the question.
   */
  it('lists an option nobody has chosen', () => {
    const { container } = render(
      <Summary
        data={summary({
          deadOptions: {
            rows: [
              {
                optionSetId: 'set-1',
                optionSetName: 'Mug options',
                optionKey: 'gold_rim',
                label: 'Gold rim',
              },
            ],
            total: 1,
            truncated: false,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('Gold rim');
    expect(container.textContent).toContain('Mug options');
  });

  /**
   * 📌 **No dead options is stated, not left blank.** An empty box reads as a
   * failure to load; "every option has been chosen" is the good news it is.
   */
  it('says so plainly when every option has been chosen', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('has been chosen at least once');
  });

  /**
   * ⚠️ **Not labelled conversion.** M25.3 names "conversion with vs. without
   * options", which needs a denominator of visits that nothing records. Calling
   * an order-value comparison conversion would claim a measurement nobody took.
   */
  it('compares average order value without calling it conversion', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('£90.00');
    expect(container.textContent).toContain('£40.00');

    /*
     * ✏️ **This asserted the word "conversion" was ABSENT, and that was right
     * until M25.1.** Nothing recorded a view, so no conversion rate existed and
     * using the word anywhere would have claimed a measurement nobody took.
     *
     * 🔴 **Views exist now, and the real figure has its own section** — so the
     * assertion changes from "the word never appears" to "these two are not the
     * same thing". The order-value comparison must still not be labelled
     * conversion; what it must not do is pretend the real one is absent.
     */
    const averageOrderHeading = container.textContent ?? '';

    expect(averageOrderHeading).toContain('Average order, with options');
    expect(averageOrderHeading).toContain('Conversion by option');

    /* The order-value figures are not inside the conversion section. */
    const conversionAt = averageOrderHeading.indexOf('Conversion by option');
    const averageAt = averageOrderHeading.indexOf('Average order, with options');

    expect(conversionAt).toBeGreaterThanOrEqual(0);
    expect(averageAt).toBeGreaterThanOrEqual(0);
    expect(conversionAt).not.toBe(averageAt);
  });

  /**
   * 🔴 **A capped list says how much it left out.** Fifty rows and "that is
   * everything" are otherwise indistinguishable, and the merchant reads a
   * partial list as their whole catalogue.
   */
  it('says when a list is showing only part of the total', () => {
    const { container } = render(
      <Summary
        data={summary({
          topOptions: {
            rows: [{ optionKey: 'a', label: 'A', revenueMinor: 100, orders: 1 }],
            total: 90,
            truncated: true,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('Showing 1 of 90');
  });

  /**
   * 🔴 **Unattributable selections are surfaced.** Orders placed before the
   * plugin recorded which set a choice came from can never be attributed, so a
   * per-set total shown without that count reads as complete when it is not.
   */
  it('discloses selections that predate set attribution', () => {
    const { container } = render(<Summary data={summary({ unattributedSelections: 42 })} />);

    expect(container.textContent).toContain('42 earlier selections');
  });

  /**
   * 🔴 **Money is withheld across several currencies, not guessed.** Every
   * figure is a sum of minor units; across two currencies that sum is not an
   * amount in either, and labelling it with one makes a meaningless number look
   * meaningful.
   */
  it('withholds totals when the orders span more than one currency', () => {
    const { container } = render(<Summary data={summary({ currency: null })} />);

    expect(container.textContent).toContain('more than one currency');
    expect(container.textContent).not.toContain('£99.00');

    /* Counts survive: an option chosen four times was, whatever its price. */
    expect(container.textContent).toContain('4 orders');
  });

  /**
   * 🔴 **And the AVERAGES withhold too — this is F161, shipped and live.**
   *
   * ✏️ **The test above looked only at a list row.** The average-order figures
   * fell through to `${minor}` when the currency was null, printing a bare
   * `9000` where the value is £90.00 — the exact mislabelling the currency field
   * exists to prevent, written one function below the guard that forbids it.
   *
   * ⚠️ **Asserting the raw numbers are absent, not that a dash is present.** A
   * dash could appear for the unrelated reason that there are no such orders;
   * what must never happen is a minor-unit integer reaching the screen.
   */
  it('never prints a raw minor-unit amount when the currency is unknown', () => {
    const { container } = render(<Summary data={summary({ currency: null })} />);

    /* 9000 and 4000 are the two averages in the fixture, in minor units. */
    expect(container.textContent).not.toContain('9000');
    expect(container.textContent).not.toContain('4000');

    /* And the merchant is told WHY the figure is missing. */
    expect(container.textContent).toContain('single currency');
  });

  /**
   * ⚠️ **"No such orders" and "no single currency" are different absences.**
   * Collapsing them would tell a merchant with plenty of option orders that they
   * have none — a fact about the shop stated where a fact about display belongs.
   */
  it('distinguishes having no such orders from having no single currency', () => {
    const { container } = render(
      <Summary
        data={summary({
          attach: {
            orders: 10,
            ordersWithOptions: 10,
            rate: 1,
            optionRevenueMinor: 12_000,
            totalRevenueMinor: 90_000,
            averageOrderValueWithOptionsMinor: 9_000,
            /* Every order used options, so there is no "without" average. */
            averageOrderValueWithoutOptionsMinor: null,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('Every order used options');
    /* The currency is known here, so the other figure still shows money. */
    expect(container.textContent).toContain('£90.00');
    expect(container.textContent).not.toContain('single currency');
  });

  /**
   * 🔴 **M25.4 — the only figure here about change.** Everything else on this
   * page is all-time, so a merchant who raised a price last month cannot see
   * the effect of it anywhere but here.
   */
  it('shows whether option revenue is rising', () => {
    const { container } = render(<Summary data={summary()} />);

    /* £99.00 this window, £66.00 before it: +50%. */
    expect(container.textContent).toContain('+50%');
    expect(container.textContent).toContain('last 30 days');
  });

  /** 📌 A fall carries a real minus sign, not a hyphen. */
  it('shows a fall with an explicit sign', () => {
    const { container } = render(
      <Summary
        data={summary({
          trend: {
            windowDays: 30,
            currentMinor: 3_300,
            previousMinor: 6_600,
            currentOrders: 2,
            previousOrders: 4,
            changeFraction: -0.5,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('−50%');
  });

  /**
   * 🔴 **No history is not a 100% fall.** A merchant whose first order was last
   * week has nothing to compare against, and a percentage here would describe
   * how long they have been trading rather than how their options perform.
   */
  it('says there is nothing to compare against when the shop is new', () => {
    const { container } = render(
      <Summary
        data={summary({
          trend: {
            windowDays: 30,
            currentMinor: 9_900,
            previousMinor: null,
            currentOrders: 4,
            previousOrders: null,
            changeFraction: null,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('nothing to compare against');
    expect(container.textContent).not.toContain('−100%');
    expect(container.textContent).not.toContain('+100%');
  });

  /**
   * 🔴 **And a previous window that earned ZERO is a different sentence.**
   * That merchant has real history and a real zero — telling them there is
   * nothing to compare against would be false.
   */
  it('distinguishes a previous window that earned nothing from one that is absent', () => {
    const { container } = render(
      <Summary
        data={summary({
          trend: {
            windowDays: 30,
            currentMinor: 9_900,
            previousMinor: 0,
            currentOrders: 4,
            previousOrders: 2,
            changeFraction: null,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('earned nothing in the previous');
    expect(container.textContent).not.toContain('nothing to compare against');
  });

  /**
   * ⚠️ **Across several currencies the amounts are withheld and the COUNTS
   * survive** — the same rule the rest of this page follows. An option chosen
   * four times was chosen four times whatever it was priced in.
   */
  it('withholds trend amounts but keeps the counts across currencies', () => {
    const { container } = render(<Summary data={summary({ currency: null })} />);

    expect(container.textContent).toContain('4 orders with options');
    expect(container.textContent).not.toContain('£66.00');
  });

  /**
   * 🔴 **M25.3 asks for most AND least selected values.** `topValues` was
   * computed by the backend, carried in the type, present in every fixture —
   * and rendered by nothing. The fourth instance of this project's
   * mechanism-with-no-caller defect, found auditing the commit that fixed the
   * third.
   */
  it('lists the highest-earning values, not only the least-chosen', () => {
    const { container } = render(
      <Summary
        data={summary({
          topValues: {
            rows: [
              {
                optionKey: 'finish',
                valueKey: 'gloss',
                label: 'Finish',
                revenueMinor: 7_700,
                orders: 3,
              },
            ],
            total: 1,
            truncated: false,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('Highest-earning values');
    expect(container.textContent).toContain('Finish — gloss');
    expect(container.textContent).toContain('£77.00');
  });

  /**
   * ⚠️ **The two value lists are different questions and must stay
   * distinguishable.** `topValues` orders by revenue and `leastValues` by
   * order count — a value bought twice at a high price outranks one bought
   * fifty times. Rendering both through one component makes it easy to
   * collapse them by accident.
   */
  it('keeps the earning and the selection views separate', () => {
    const { container } = render(<Summary data={summary()} />);
    const text = container.textContent ?? '';

    expect(text).toContain('Highest-earning values');
    expect(text).toContain('Least-chosen values');
    expect(text.indexOf('Highest-earning values')).not.toBe(
      text.indexOf('Least-chosen values'),
    );
  });

  /**
   * 🔴 **M25.1 + M25.3 — the conversion figure, on the screen at last.**
   *
   * ✏️ **The backend shipped this and nothing rendered it.** An audit found the
   * only three mentions of "conversion" in this file were inside a comment
   * explaining why it could not be shown — stale the moment views existed. The
   * defect this project has met eleven times, committed in the feature built to
   * close it.
   */
  it('shows what fraction of viewers bought each option', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('Conversion by option');
    /* 4 of 40 is 10%. */
    expect(container.textContent).toContain('10%');
    expect(container.textContent).toContain('4 of 40');
  });

  /**
   * 🔴 **No views is NOT zero percent.** An option with orders and no recorded
   * views has a measurement gap — a store whose plugin predates M25.1 — and
   * printing 0% would tell a merchant their best-selling option never sells.
   */
  it('distinguishes an unmeasured option from one nobody buys', () => {
    const { container } = render(
      <Summary
        data={summary({
          conversion: {
            rows: [
              { optionKey: 'unseen', label: 'Unseen', views: 0, orders: 7, rate: null },
              { optionKey: 'ignored', label: 'Ignored', views: 500, orders: 0, rate: 0 },
            ],
            total: 2,
            truncated: false,
          },
        })}
      />,
    );

    /* The unmeasured one says so; it must not read as 0%. */
    expect(container.textContent).toContain('views not recorded');
    /* And the genuinely-unwanted one does show zero — that is a finding. */
    expect(container.textContent).toContain('0% — 0 of 500');
  });

  /**
   * 📌 **Empty says why, and what closes it.** Before the plugin release that
   * sends views, an empty box would read as a broken feature rather than as an
   * upgrade a merchant has not installed.
   */
  it('explains an empty conversion table rather than leaving it blank', () => {
    const { container } = render(
      <Summary data={summary({ conversion: { rows: [], total: 0, truncated: false } })} />,
    );

    expect(container.textContent).toContain('No views recorded yet');
    expect(container.textContent).toContain('plugin version');
  });

  /**
   * 🔴 **M25.4's per-product half, on the screen.** A merchant asks "which of my
   * products sell better with options?" before almost anything else, and until
   * this existed the data could not answer it at all.
   */
  it('names the product its options earned on', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('Engraved Mug');
    expect(container.textContent).toContain('Revenue by product');
  });

  /**
   * ⚠️ **An unsynced or deleted product shows its id, not "Unknown".** The
   * merchant still earned that money, and an id they can search for in
   * WooCommerce is actionable where a placeholder is not.
   */
  it('falls back to the product id when the catalogue has no name', () => {
    const { container } = render(
      <Summary
        data={summary({
          products: {
            rows: [{ productRef: '999', name: null, revenueMinor: 400, orders: 2 }],
            total: 1,
            truncated: false,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('Product 999');
    expect(container.textContent).not.toContain('Unknown');
  });

  /**
   * 🔴 **Selections predating product attribution are disclosed.** Without the
   * count the table reads as the merchant's whole catalogue when it is only the
   * part placed after the plugin update.
   */
  it('discloses selections that predate product attribution', () => {
    const { container } = render(
      <Summary data={summary({ unattributedProductSelections: 17 })} />,
    );

    expect(container.textContent).toContain('17 earlier selections');
    expect(container.textContent).toContain('which product they were for');
  });

  /**
   * 📌 **Before the plugin release this table is empty, and says why.** An empty
   * box would read as a broken feature rather than as a boundary date.
   */
  it('explains an empty product table rather than leaving it blank', () => {
    const { container } = render(
      <Summary data={summary({ products: { rows: [], total: 0, truncated: false } })} />,
    );

    expect(container.textContent).toContain('attribute revenue to a product');
  });

  /**
   * 🔴 **The export is reachable from the screen** (M25.5).
   *
   * The route, the CSV escaping and the plan gate are all proven server-side —
   * and none of that matters if a merchant has no way to ask for the file. This
   * is the F132 lesson applied before it becomes a finding.
   */
  it('offers the export on a populated screen', () => {
    const { container } = render(<Summary data={summary()} />);

    expect(container.textContent).toContain('Export CSV');
  });

  /**
   * 📌 **And withholds it before the first order.** A merchant with nothing sold
   * would download a file containing a header row, which reads as a broken
   * feature rather than as an empty shop.
   */
  it('does not offer the export before there are any orders', () => {
    const { container } = render(
      <Summary
        data={summary({
          attach: {
            orders: 0,
            ordersWithOptions: 0,
            rate: null,
            optionRevenueMinor: 0,
            totalRevenueMinor: 0,
            averageOrderValueWithOptionsMinor: null,
            averageOrderValueWithoutOptionsMinor: null,
          },
        })}
      />,
    );

    expect(container.textContent).not.toContain('Export CSV');
  });

  /**
   * 📌 **No orders is an empty state, not zero.** A shop that has sold nothing
   * has no analytics, and "£0.00 earned" invites the conclusion that the
   * options do not work.
   */
  it('shows an empty state rather than zeroes before the first order', () => {
    const { container } = render(
      <Summary
        data={summary({
          attach: {
            orders: 0,
            ordersWithOptions: 0,
            rate: null,
            optionRevenueMinor: 0,
            totalRevenueMinor: 0,
            averageOrderValueWithOptionsMinor: null,
            averageOrderValueWithoutOptionsMinor: null,
          },
        })}
      />,
    );

    expect(container.textContent).toContain('No orders yet');
    expect(container.textContent).not.toContain('£0.00');
  });
});
