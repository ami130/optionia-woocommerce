import {
  MAX_RENDER_MEGAPIXELS,
  MAX_RENDER_MS,
  checkRenderBounds,
} from './render-bounds';

/**
 * The guard that stops a render killing its own container (F1).
 *
 * 🔴 **Measured, not imagined.** A 50000×50000 SVG handed to `@resvg/resvg-js`
 * rendered successfully in 46 seconds at roughly 10 GB of RGBA, and the process
 * running it was killed by the OS at exit 137 — no exception, no log, nothing to
 * tell a merchant why their print file never arrived.
 */
describe('checkRenderBounds', () => {
  /** 📌 The ordinary case: a product photograph, comfortably inside the limit. */
  it('permits a canvas a merchant would actually use', () => {
    expect(checkRenderBounds(3000, 3000)).toBeNull();
    expect(checkRenderBounds(2000, 4000)).toBeNull();
  });

  /** 📌 And exactly at the ceiling, which must be allowed rather than refused. */
  it('permits a canvas exactly at the limit', () => {
    expect(checkRenderBounds(6000, 6000)).toBeNull();
  });

  /**
   * 🔴 **The case that OOM-killed a real process.** It must be refused before a
   * renderer sees it, because afterwards there is nothing left to refuse with.
   */
  it('refuses the canvas that killed the spike', () => {
    const failure = checkRenderBounds(50_000, 50_000);

    expect(failure?.reason).toBe('too-large');
    expect(failure?.message).toContain('50000×50000');
  });

  /** ⚠️ One pixel over is over — a ceiling with slack is a different ceiling. */
  it('refuses a canvas just past the limit', () => {
    expect(checkRenderBounds(6001, 6000)?.reason).toBe('too-large');
  });

  /**
   * 🔴 **Bounded on pixel COUNT, not edge length**, because memory follows area.
   * A width-and-height check would admit this — sixty thousand pixels wide — and
   * refuse a 7000×7000 square that costs less.
   */
  it('refuses a wide, short canvas that a per-edge check would admit', () => {
    expect(checkRenderBounds(60_000, 1_000)?.reason).toBe('too-large');
  });

  /** 📌 And permits a long thin one that is genuinely cheap. */
  it('permits a long canvas that is small in area', () => {
    expect(checkRenderBounds(30_000, 1_000)).toBeNull();
  });

  /**
   * 🔴 **`NaN` must be refused EXPLICITLY, and this is the subtle one.**
   * `NaN * NaN` is `NaN`, and `NaN > 36` is **false** — so a comparison alone
   * treats a canvas whose dimensions are not numbers as acceptable and hands it
   * to the renderer. That is the exact shape of the defect this module exists to
   * prevent, arriving through the check meant to stop it.
   */
  it('refuses dimensions that are not numbers', () => {
    expect(checkRenderBounds(Number.NaN, 100)?.reason).toBe('not-finite');
    expect(checkRenderBounds(100, Number.NaN)?.reason).toBe('not-finite');
    expect(checkRenderBounds(Number.POSITIVE_INFINITY, 100)?.reason).toBe('not-finite');
  });

  /** ⚠️ Zero and negative are refused separately, so the message can say why. */
  it('refuses a canvas with no area', () => {
    expect(checkRenderBounds(0, 1000)?.reason).toBe('not-positive');
    expect(checkRenderBounds(1000, 0)?.reason).toBe('not-positive');
    expect(checkRenderBounds(-100, 100)?.reason).toBe('not-positive');
  });

  /**
   * ⚠️ **The message names the actual size**, because a refusal a merchant
   * cannot act on is an error report rather than an explanation.
   */
  it('says what was asked for and what the limit is', () => {
    const message = checkRenderBounds(10_000, 10_000)?.message ?? '';

    expect(message).toContain('10000×10000');
    expect(message).toContain('100.0 megapixels');
    expect(message).toContain('6000×6000');
  });

  /**
   * 🔴 **The constants are pinned, because they are measurements.** 36 MP is
   * ~229 MB resident on a 1 GB instance, leaving room for a concurrent render;
   * quietly raising it would remove that room without anything failing until
   * production does.
   */
  it('keeps the measured limits', () => {
    expect(MAX_RENDER_MEGAPIXELS).toBe(36);
    expect(MAX_RENDER_MS).toBe(30_000);
  });
});
