/**
 * The curated font families, mirrored for the BACKEND build.
 *
 * 🔴 **A mirror, and a gate keeps it honest.** `shared/design` is the source of
 * truth and the dashboard imports it directly — but a production backend file
 * that imports `@shared/*` moves the build's emit root, which
 * `tsconfig.build.json` records in detail: the artefact lands at
 * `dist/optioniaWooCommerceBackend/src/main.js` while `start:prod` runs
 * `node dist/main.js`, and the server cannot start.
 *
 * ⚠️ **That comment predicted this exact moment** — *"when a production file
 * imports `@shared/*`, this must change"* — and the first version of
 * `design-fonts.ts` did import it, breaking the build with every unit test
 * green. `check-build-output.sh` is what caught it, by building and looking.
 *
 * 📌 **Mirroring beats restructuring the build here.** This module needs eight
 * strings; moving the emit root to buy them would put the shared tree in the
 * production program for every future file, which is a larger change than the
 * problem deserves. `check-option-type-parity.sh` already proves cross-repo
 * lists agree by comparison rather than by import.
 */
export const TEXT_FONTS = [
  'Roboto',
  'Open Sans',
  'Montserrat',
  'Lato',
  'Oswald',
  'Playfair Display',
  'Dancing Script',
  'Pacifico',
] as const;

/** A font a design may name. Derived, so the list and the type cannot diverge. */
export type TextFont = (typeof TEXT_FONTS)[number];
