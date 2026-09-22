import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HELP, type HelpConcept } from '@/lib/help/concepts';
import { HelpNote } from './help-note';

/**
 * Contextual help a merchant can actually reach (M20b.7, ADR-098).
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('HelpNote', () => {
  const concept: HelpConcept = { question: 'What is a widget?', answer: 'A small thing.' };

  it('shows the question and the answer', () => {
    const output = html(<HelpNote concept={concept} />);

    expect(output).toContain('What is a widget?');
    expect(output).toContain('A small thing.');
  });

  /**
   * 🔴 **Native disclosure, not a tooltip.** A hover tooltip is unreachable on a
   * phone, and this repository already guards phone usability. `<details>` works
   * by tap and by keyboard with no library, no positioning and no focus trap.
   */
  it('uses a native disclosure so it works by tap and keyboard', () => {
    const output = html(<HelpNote concept={concept} />);

    expect(output).toContain('<details');
    expect(output).toContain('<summary');
  });

  /**
   * 📌 Collapsed by default: these answer a question a merchant has once or
   * twice, and open by default they are noise on every later visit.
   */
  it('starts collapsed', () => {
    const output = html(<HelpNote concept={concept} />);

    expect(output).not.toMatch(/<details[^>]*\sopen/);
  });

  /** ⚠️ The caret is decorative; the question is the accessible name. */
  it('hides the caret from assistive technology', () => {
    const output = html(<HelpNote concept={concept} />);

    expect(output).toMatch(/aria-hidden="true"/);
  });
});

/**
 * One source per concept (ADR-098).
 *
 * 🔴 **Both hierarchy explanations already existed, in two different empty
 * states.** Left as prose per screen, the list and the editor drift into
 * describing the product differently — so the text lives in `HELP` and every
 * placement reads it.
 */
describe('the help concepts', () => {
  it('covers each concept the milestone names', () => {
    expect(Object.keys(HELP).sort()).toEqual(['hierarchy', 'pricing', 'publishing']);
  });

  it.each(Object.entries(HELP))('%s asks a question and answers it', (_name, entry) => {
    expect(entry.question).toMatch(/\?$/);
    expect(entry.answer.length).toBeGreaterThan(40);
  });

  /** Help, not documentation: an answer nobody reads explains nothing. */
  it.each(Object.entries(HELP))('%s stays short enough to read', (_name, entry) => {
    expect(entry.answer.length).toBeLessThan(400);
  });

  /**
   * ⚠️ **No placement may write its own copy.** Asserted by walking the source:
   * a `HelpNote` whose `concept` is an inline object is a second definition of a
   * concept `HELP` already owns.
   */
  it('is never given an inline concept', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
          return files(path);
        }

        return entry.endsWith('.tsx') && !entry.includes('.test.') ? [path] : [];
      });

    const uses = files(join(process.cwd(), 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

      return [...source.matchAll(/<HelpNote\s+concept=\{([^}]*)\}/g)].map((m) => m[1].trim());
    });

    expect(uses.length).toBeGreaterThan(0);
    for (const used of uses) {
      expect(used).toMatch(/^HELP\./);
    }
  });
});

/**
 * Each concept reaches the screen where it is asked (M20b.7).
 *
 * 🔴 **The gap this milestone closed was placement, not prose.** Both hierarchy
 * explanations were already written, and only in empty states — which vanish the
 * moment a merchant has a set or a group, which is precisely when the difference
 * between a group and an option starts to matter.
 */
describe('help reaches the screens where the questions are asked', () => {
  const code = (path: string): string =>
    readFileSync(join(process.cwd(), path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  /**
   * ⚠️ Asserted **outside** the empty branch on each screen. A note that only
   * rendered when the merchant had nothing would be the defect this fixed.
   */
  it('explains the hierarchy on the list screen, not only when it is empty', () => {
    const source = code('src/app/(app)/option-sets/page.tsx');
    const note = source.indexOf('HELP.hierarchy');
    const emptyProp = source.indexOf('empty={');

    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(emptyProp);
  });

  /**
   * ✏️ **The editor's two notes are asserted by rendering**, in
   * `editor-help.render.test.tsx`, not here.
   *
   * A source check placed here first — "`HELP.hierarchy` appears before the
   * no-groups notice" — and it measured the wrong thing: it proves the note is
   * not *nested inside* that notice and says nothing about whether it renders.
   * Mutation showed it: gating the note on an unrelated condition, so a merchant
   * almost never sees it, left every test green.
   *
   * `EditorHeader` is exported for that reason, and the render test mounts it
   * with groups present — the state the milestone is actually about.
   */
  it('keeps the editor’s help in a component a renderer can mount', () => {
    expect(code('src/app/(app)/option-sets/[id]/page.tsx')).toMatch(
      /export function EditorHeader/,
    );
  });

  /**
   * 🔴 The one concept nothing explained at all — answered where the question is
   * asked, beside the worked total a merchant reads and doubts.
   */
  it('explains server pricing beside the worked example', () => {
    const source = code('src/components/option-sets/option-set-display.tsx');
    const example = source.indexOf('export function PricingExample');
    const note = source.indexOf('HELP.pricing');

    expect(note).toBeGreaterThan(example);
  });
});

/**
 * Help copy shares a page with content it cannot predict.
 *
 * 🔴 **This broke the canonical flow.** The pricing answer said "a £200
 * **engraving** for £2", and `Engraving` is an option name in that flow's own
 * fixture — so `getByText('Engraving')` matched the **collapsed** help paragraph
 * before the merchant's option, and the assertion failed on a hidden element.
 *
 * ⚠️ **The rule is narrower than "avoid merchant words".** `Finish` and `Size`
 * appear in the hierarchy copy *and* in that flow, harmlessly: those are
 * `fill()` calls and a `getByRole('button')`, which cannot match a paragraph.
 * Only a bare `getByText` collides — so that is what this checks, rather than
 * banning vocabulary the copy is better for having.
 */
describe('help copy does not collide with what the canonical flow reads', () => {
  const copy = Object.values(HELP)
    .map((entry) => `${entry.question} ${entry.answer}`)
    .join(' ')
    .toLowerCase();

  const flow = readFileSync(join(process.cwd(), 'e2e/canonical.spec.ts'), 'utf8');

  /**
   * Every literal the canonical flow searches page text for.
   *
   * ✏️ **The first version matched bare `getByText('…')` only — 10 of 36 calls.**
   * The 26 it missed included the **regex** matchers, which are the ones most
   * likely to collide with prose: `/connected/i` and `/connect a store first/i`
   * are case-insensitive substrings, where a quoted string is exact.
   *
   * 📌 The remainder are **variables** — `SET_NAME`, `merchant.email` — whose
   * values a static guard cannot resolve, and which are fixture data rather than
   * prose. 23 literal matchers is the complete static set.
   */
  const searched = [
    ...[...flow.matchAll(/getByText\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]),
    ...[...flow.matchAll(/getByText\(\s*\/((?:[^/\\]|\\.)+)\/[a-z]*/g)].map((m) => m[1]),
  ];

  /**
   * ⚠️ A floor, because a regex that stopped matching would make every case
   * below vacuous — which is exactly how the first version passed while covering
   * 28% of the assertions.
   */
  it('finds the terms that flow searches for', () => {
    expect(searched.length).toBeGreaterThanOrEqual(20);
  });

  it.each(searched)('does not contain %p', (term) => {
    /*
     * Regex sources carry escapes and anchors that are not literal text; the
     * comparison is on the plain words, which is what could actually collide.
     */
    const plain = term.replace(/\\([.*+?^${}()|[\]\\])/g, '$1').toLowerCase();

    expect(copy).not.toContain(plain);
  });
});

