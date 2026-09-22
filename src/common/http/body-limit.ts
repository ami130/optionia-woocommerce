/**
 * The maximum request body the API accepts (ADR-072).
 *
 * 🔴 **Its own module, because both bootstraps need it and neither may import
 * the other.** `main.ts` calls `void bootstrap()` at module scope, so importing
 * the constant from there would start a real server inside every e2e run.
 * `test/harness.ts` builds its own application by hand, and a limit written out
 * in two files is a limit that drifts — measured: the harness ran on Express's
 * 100 kb default while production ran on 1 MB, so a legal 529 kB body answered
 * `413` in tests and `200` in production.
 *
 * **1 MB**, chosen against the two things that bound a catalogue push: a
 * product serialises to ~2 kB realistically and ~22 kB at this API's declared
 * maxima, and `Client::TIMEOUT` gives the plugin 8 seconds to build and send a
 * batch. Larger buys nothing the timeout does not already forbid.
 */
export const BODY_LIMIT = '1mb';
