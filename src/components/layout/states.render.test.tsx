import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AsyncState,
  EmptyState,
  ErrorState,
  FullPageLoading,
  LoadingRows,
} from './states';

/**
 * What these components **do**, not what their signatures say.
 *
 * ## Why this exists, and why it did not until now
 *
 * Three rounds of this phase asserted the state components by reading their
 * source: that a prop was required, that a class name was present, that an
 * identifier appeared. Every one of those guards passed while `AsyncState` was
 * mutated to stop rendering the skeleton, to return `null` instead of the empty
 * state, and to swallow errors entirely — **278 tests green each time**, on the
 * one component behind loading, empty and error for every list in the product.
 *
 * The premise behind that choice was *"nothing in this repo can mount a
 * component"*, repeated three times and **false**: `react-dom/server` ships with
 * Next and renders any component that is a pure function of its props to an HTML
 * string. That is exactly what these are. `@testing-library/react` buys hooks,
 * events and user interaction — none of which is needed here — so the premise
 * confused "cannot test interaction" with "cannot render", and never checked.
 *
 * ⚠️ These are **static** renders. Anything driven by an effect or an event
 * belongs in a test that can drive one; a component whose behaviour is a
 * function of its props belongs here.
 */

/** Rendered markup, so an assertion is about output rather than source. */
const html = (element: React.ReactElement): string => renderToStaticMarkup(element);

const ROWS = ['a', 'b'];
const rowsOf = (rows: string[]) => <p>{`rows:${rows.join(',')}`}</p>;
const EMPTY = <p>EMPTY-STATE</p>;

describe('LoadingRows', () => {
  it('announces itself to a screen reader', () => {
    const output = html(<LoadingRows />);

    expect(output).toContain('role="status"');
    expect(output).toContain('aria-label="Loading"');
  });

  /** A skeleton in the shape of the content, never a spinner (M13.1). */
  it('renders one placeholder per row', () => {
    expect(html(<LoadingRows rows={5} />).match(/animate-pulse/g)).toHaveLength(5);
  });
});

describe('FullPageLoading', () => {
  it('announces itself', () => {
    expect(html(<FullPageLoading />)).toContain('role="status"');
  });
});

describe('EmptyState', () => {
  /**
   * 🔴 *"An empty state that says 'No data' is a defect"* — M13.1. The action is
   * the whole point: a merchant's first visit to every screen is the empty
   * state. A mutation that dropped it from the output passed every source guard.
   */
  it('renders the action that fills it', () => {
    const output = html(
      <EmptyState title="Nothing yet" description="Add one." action={<button>ADD-ONE</button>} />,
    );

    expect(output).toContain('Nothing yet');
    expect(output).toContain('Add one.');
    expect(output).toContain('ADD-ONE');
  });
});

describe('ErrorState', () => {
  it('states what went wrong and offers a retry', () => {
    const output = html(<ErrorState error={new Error('boom')} onRetry={() => {}} />);

    expect(output).toContain('role="alert"');
    expect(output).toContain('Try again');
  });

  /** No retry offered when there is nothing to retry — the button would lie. */
  it('omits the retry when none is given', () => {
    expect(html(<ErrorState error={new Error('boom')} />)).not.toContain('Try again');
  });
});

describe('AsyncState', () => {
  /*
   * The four branches, each asserted by what reaches the DOM. These are the
   * mutants that survived every source-reading guard.
   */

  it('shows the skeleton while loading, and nothing else', () => {
    const output = html(
      <AsyncState isLoading error={null} data={undefined} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('role="status"');
    expect(output).not.toContain('EMPTY-STATE');
    expect(output).not.toContain('rows:');
  });

  it('shows the error, not the rows, when the fetch failed', () => {
    const output = html(
      <AsyncState isLoading={false} error={new Error('boom')} data={ROWS} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('role="alert"');
    expect(output).not.toContain('rows:');
  });

  /** Loading wins: a first fetch has no data to have failed with. */
  it('prefers loading over error', () => {
    const output = html(
      <AsyncState isLoading error={new Error('boom')} data={undefined} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('role="status"');
    expect(output).not.toContain('role="alert"');
  });

  it.each([
    ['an empty array', [] as string[]],
    ['undefined', undefined],
  ])('shows the empty state for %s', (_name, data) => {
    const output = html(
      <AsyncState isLoading={false} error={null} data={data} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('EMPTY-STATE');
  });

  it('renders the rows once there are some', () => {
    const output = html(
      <AsyncState isLoading={false} error={null} data={ROWS} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('rows:a,b');
    expect(output).not.toContain('EMPTY-STATE');
  });

  /**
   * 🔴 L1: a settled list with a new fetch in flight is **stale**, and saying so
   * is the difference between a slow search and one that ignores input.
   */
  it('marks stale rows busy rather than replacing them', () => {
    const output = html(
      <AsyncState isLoading={false} isRefreshing error={null} data={ROWS} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).toContain('aria-busy="true"');
    expect(output).toContain('rows:a,b');
  });

  /**
   * An empty *stale* result is still stale: showing "nothing has been imported
   * yet" mid-search answers a question the merchant did not ask.
   */
  it('withholds the empty state while refreshing', () => {
    const output = html(
      <AsyncState isLoading={false} isRefreshing error={null} data={[]} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).not.toContain('EMPTY-STATE');
    expect(output).toContain('role="status"');
  });

  it('leaves settled rows unmarked', () => {
    const output = html(
      <AsyncState isLoading={false} error={null} data={ROWS} empty={EMPTY}>
        {rowsOf}
      </AsyncState>,
    );

    expect(output).not.toContain('aria-busy="true"');
  });
});
