/**
 * What a render is allowed to cost, before one is attempted (F1).
 *
 * ## The failure this exists to prevent
 *
 * 🔴 **An oversized canvas SUCCEEDS, and that is worse than failing.** Measured
 * against `@resvg/resvg-js` during M26's Stage 0 spike: a 50000×50000 SVG
 * rendered — 46 seconds, a 9.8 MB PNG, roughly **10 GB of RGBA**. The batch that
 * ran it was killed by the OS at exit 137.
 *
 * ⚠️ **A kernel kill leaves nothing to report.** It is not an exception, so
 * nothing catches it; the process is gone, so nothing logs it; and the merchant
 * waiting on a print file learns only that it never arrived. Every other failure
 * in this pipeline can be explained to somebody. This one cannot, which is why
 * it is refused **before** the render rather than survived after it.
 *
 * 📌 **`optionia-app` has no such bound**, which is worth recording: the
 * reference implementation is not a source of this guard, and porting its render
 * path faithfully would port the hole with it.
 *
 * ## Where the numbers come from
 *
 * Measured, not chosen. Resident memory against canvas size, rendering a shape
 * over a filled background:
 *
 * | Canvas | Megapixels | RSS delta | Time |
 * |---|---|---|---|
 * | 3000×3000 | 9 | 76 MB | 94 ms |
 * | 5000×5000 | 25 | 194 MB | 261 ms |
 * | 6000×6000 | 36 | 229 MB | 394 ms |
 * | 8000×8000 | 64 | 237 MB | 651 ms |
 *
 * Cost tracks **pixel count**, not edge length, at roughly twice the theoretical
 * RGBA size — so a ceiling has to be expressed in megapixels. An edge-length
 * limit would permit 60000×10 and refuse 7000×7000, which is backwards.
 */

/**
 * The most a single render may cover, in megapixels.
 *
 * 🔴 **36 MP is 6000×6000, and the ceiling is the INSTANCE, not the format.**
 * At that size a render costs ~229 MB resident on a 1 GB App Platform instance,
 * which leaves room for the process itself and for a second render alongside it.
 * 64 MP measured only marginally worse in isolation and would leave no such
 * room — a ceiling that is safe only when nothing else is happening is not a
 * ceiling.
 *
 * ⚠️ **It is generous for the purpose.** 6000×6000 is 20×20 inches at 300 dpi,
 * beyond any product photograph a merchant will composite onto.
 */
export const MAX_RENDER_MEGAPIXELS = 36;

/**
 * The longest a single render may take, in milliseconds.
 *
 * 📌 **Far above the measured worst case, and deliberately so.** 8000×8000 took
 * 651 ms; this is a **runaway** guard, not a performance budget. A render that
 * has taken thirty seconds is not slow, it is wrong — and the job holding a
 * worker for ten minutes is the failure this prevents.
 */
export const MAX_RENDER_MS = 30_000;

/** Why a render was refused, in terms a caller can act on. */
export interface RenderBoundsFailure {
  readonly reason: 'not-finite' | 'not-positive' | 'too-large';
  readonly message: string;
}

/**
 * Whether a canvas may be rendered at all.
 *
 * 🔴 **Checked in pixel COUNT, because that is what memory follows.** Bounding
 * width and height separately would admit 60000×10 — sixty times the edge limit
 * of a square that is refused — while refusing 7000×7000, which costs less.
 *
 * ⚠️ **`NaN` and `Infinity` are refused explicitly.** `NaN * NaN` is `NaN`, and
 * `NaN > 36` is **false** — so a naive comparison passes a canvas whose
 * dimensions are not numbers, and the renderer receives it. That is the exact
 * shape of the bug this module exists to stop.
 *
 * @returns `null` when the canvas is acceptable, otherwise why it is not.
 */
export function checkRenderBounds(width: number, height: number): RenderBoundsFailure | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return {
      reason: 'not-finite',
      message: 'Canvas dimensions must be finite numbers.',
    };
  }

  if (width <= 0 || height <= 0) {
    return {
      reason: 'not-positive',
      message: 'Canvas dimensions must be greater than zero.',
    };
  }

  const megapixels = (width * height) / 1_000_000;

  if (megapixels > MAX_RENDER_MEGAPIXELS) {
    return {
      reason: 'too-large',
      message:
        `A ${Math.round(width)}×${Math.round(height)} canvas is ` +
        `${megapixels.toFixed(1)} megapixels; the limit is ${MAX_RENDER_MEGAPIXELS} ` +
        `(about 6000×6000).`,
    };
  }

  return null;
}
