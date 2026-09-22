'use client';

import { useEffect, useState } from 'react';

/**
 * The default pause before a search reaches the API.
 *
 * 300ms is below the ~400ms a reader notices as lag, and long enough that
 * ordinary typing collapses to one request rather than one per keystroke.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * A value that settles before anything acts on it.
 *
 * ## 🔴 Why this exists: a merchant can rate-limit their own search box
 *
 * A search term put straight into a TanStack `queryKey` fires a request per
 * keystroke. The API's short throttle is **20 requests per second**
 * (`THROTTLE_SHORT_LIMIT`), and typing a product name like "Oak Serving Board"
 * is seventeen keystrokes in about two seconds. The API answers `429`, the
 * client renders *"Too many attempts. Wait a moment and try again."*, and the
 * merchant has replaced their own results with an error by typing normally.
 *
 * The requests are also **wasted** rather than merely early: every prefix of a
 * word is a different `queryKey`, so each one is a real query whose result is
 * cached and never looked at again.
 *
 * ## Why a hook rather than a debounced callback
 *
 * The input stays controlled and responsive — the character appears instantly —
 * while only the *derived* value used for fetching lags. Debouncing the
 * `onChange` instead would make the field itself feel broken.
 *
 * @param value The value that changes on every keystroke.
 * @param delayMs How long it must hold still. Defaults to {@link SEARCH_DEBOUNCE_MS}.
 */
export function useDebounced<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);

    /*
     * Clearing on every change is what makes this a debounce rather than a
     * throttle: a keystroke inside the window replaces the pending update
     * instead of queueing a second one.
     */
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
