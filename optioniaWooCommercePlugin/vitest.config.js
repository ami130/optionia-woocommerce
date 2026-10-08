import { defineConfig } from 'vitest/config';

/**
 * Vitest for the storefront runtime.
 *
 * ## Why a PHP plugin has a package.json
 *
 * `assets/js/frontend.js` had **no tests at all**, and two real defects shipped
 * because of it: a dropdown's price estimate totalled £0 for an entire stage
 * (the selector matched `<select>`, which is never `:checked`, while the prices
 * sit on its `<option>` children), and the character counter's grapheme parity
 * with PHP was proven twice by throwaway harnesses that were then deleted.
 *
 * Hosting these in the dashboard repo was the alternative. It was rejected: a
 * repo that cannot run its own tests cannot gate on them, and `bin/check.sh` is
 * where this project decides whether the plugin is shippable.
 *
 * ⚠️ **`node_modules/` is dev-only and never ships.** The plugin is PHP; nothing
 * here is loaded by WordPress.
 *
 * ## Why `environment: 'jsdom'` rather than `happy-dom`
 *
 * These tests drive the **real file**, unmodified, through the DOM — no
 * exports, no string-slicing, no calling internals. That needs faithful
 * behaviour for `readyState`, `DOMContentLoaded`, `:checked` on a selected
 * `<option>`, and `Intl.Segmenter`. jsdom is the implementation the dashboard
 * repo already relies on, so the two suites agree about the DOM.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/js/**/*.test.js'],


    /*
     * ⚠️ **No coverage reporting, and the reason matters.**
     *
     * `@vitest/coverage-v8` was installed and configured, and reported **0% over
     * 62 passing tests**. Not a misconfiguration: these tests evaluate the real
     * `frontend.js` with `window.eval()` inside a jsdom realm, which V8's
     * instrumenter cannot see. The code runs; the reporter is blind to it.
     *
     * A permanently-zero number is worse than none — it reads as total failure,
     * and the habit it teaches is to ignore the coverage output entirely.
     *
     * ✏️ **Mutation testing is this suite's coverage measure instead**, and it
     * is the stronger one: it found seven untested paths behind a green 47-test
     * run, including a guard whose own dedicated test never exercised it.
     *
     * 🔴 **An invariant here went stale once, and that is the thing to avoid.**
     * This note used to read "every guard in `frontend.js` has been
     * mutation-probed". It was true when written and false three commits later:
     * M26e.2–M26e.4 added eleven guards and probed six, so five survived behind
     * a green 195-test run — including the positioned-ancestor promotion the
     * whole overlay depends on. A claim like that is worse than none, because
     * the next person trusts it instead of re-measuring.
     *
     * 📌 **So the claim is now about the practice, not a completed state.**
     * Every guard added to `frontend.js` is mutation-probed when it is added,
     * and a survivor is either given a test or documented in place with the
     * reason it cannot be killed — `✏️` marks each one. Whether that held for
     * the most recent change is answered by re-running the probe, not by
     * reading this comment.
     */
  },
});
