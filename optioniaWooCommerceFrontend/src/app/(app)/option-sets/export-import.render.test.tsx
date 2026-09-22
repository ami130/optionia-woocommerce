import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PortablePanel } from '@/components/option-sets/option-set-display';

/**
 * Export and import, as a merchant meets them (M20.8).
 *
 * 🔴 **Export is read-only; import is a WRITE path.** The panel offers both and
 * says which is which — an import replaces nothing silently, it creates a new
 * set, because overwriting the one on screen would destroy work with no undo.
 */
describe('PortablePanel', () => {
  it('offers a download', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel canEdit filename="finish.json" href="data:," problems={[]} />,
    );

    expect(markup).toMatch(/Export/);
    expect(markup).toMatch(/finish\.json/);
  });

  /** ⚠️ A viewer may export; only an editor may import. */
  it('offers no import to a viewer', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel canEdit={false} filename="finish.json" href="data:," problems={[]} />,
    );

    expect(markup).toMatch(/Export/);
    expect(markup).not.toMatch(/Import/);
  });

  it('offers an import to an editor', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel canEdit filename="finish.json" href="data:," problems={[]} />,
    );

    expect(markup).toMatch(/Import/);
  });

  /** 🔴 Every problem at once — one file, one round of corrections. */
  it('lists every problem in a refused file', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel
        canEdit
        filename="finish.json"
        href="data:,"
        problems={['Group 1 has no label.', 'Group 1, option 1 has no key.']}
      />,
    );

    expect(markup).toMatch(/has no label/);
    expect(markup).toMatch(/has no key/);
  });

  /**
   * 🔴 **The panel must not promise behaviour that does not exist.**
   *
   * It read *"An import creates a new set — it never replaces this one."*
   * Measured: the import path makes **zero** calls to `createSet`,
   * `createGroup` or `createOption` — it validates and reports. A merchant read
   * that sentence, picked a file, and got a message instead of a set, having
   * been told what would happen.
   *
   * ⚠️ **Absent functionality is visible; a false promise is not.** The panel
   * now states what it does, and says the rebuild is not available — so the
   * limitation is read before the file is chosen rather than after.
   */
  /**
   * ✏️ **Superseded: the rebuild now exists.**
   *
   * This asserted the panel must NOT promise to create a set, because it could
   * not — `POST /v1/option-sets/import` builds the whole tree in one
   * transaction, so the promise is now true and the assertion becomes its
   * opposite. A claim is worth re-checking when it becomes keepable, not only
   * when it is broken.
   */
  it('says an import creates a new set', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel canEdit filename="finish.json" href="data:," problems={[]} />,
    );

    expect(markup).toMatch(/creates a new set/i);
  });

  /** ⚠️ And that it never replaces the one on screen — that has not changed. */
  it('says an import never replaces this set', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel canEdit filename="finish.json" href="data:," problems={[]} />,
    );

    expect(markup).toMatch(/never replaces/i);
    expect(markup).not.toMatch(/not available/i);
  });

  /**
   * 🔴 **A valid file must not read as an error.** The summary went through the
   * `problems` channel, styled `text-destructive` — so a merchant who picked a
   * **valid** file saw success reported in red. One prop carried two meanings,
   * and the component had no way to tell them apart.
   */
  it('shows a summary that is not styled as a problem', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel
        canEdit
        filename="finish.json"
        href="data:,"
        problems={[]}
        summary={'That file is a valid set: "Finish", 2 group(s).'}
      />,
    );

    expect(markup).toMatch(/valid set/);
    expect(markup).not.toMatch(/text-destructive[^"]*">[^<]*valid set/);
  });

  /** ⚠️ Problems stay red — that channel was never wrong, only overloaded. */
  it('still styles real problems as problems', () => {
    const markup = renderToStaticMarkup(
      <PortablePanel
        canEdit
        filename="finish.json"
        href="data:,"
        problems={['Group 1 has no label.']}
      />,
    );

    expect(markup).toMatch(/text-destructive/);
  });
});

/**
 * 🔴 **How the PAGE routes a result, not just how the panel renders one.**
 *
 * The component tests above pin the two channels; a mutant that sent a success
 * back through `problems` survived them all (M267), because nothing asserted
 * which channel the page chooses. The defect this fixed could return one layer
 * up, invisibly.
 */
describe('the editor routes results to the right channel', () => {
  const editor = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
    'utf8',
  );

  const block = editor.slice(editor.indexOf('const parsed = parsePortable'), editor.indexOf('}}\n      />'));

  it('sends problems only when the file is refused', () => {
    expect(block).toMatch(/setImportProblems\(parsed\.ok \? \[\] : parsed\.problems\)/);
  });

  /**
   * ⚠️ **Asserted on the summary call's OWN condition.** A first version matched
   * `parsed.ok ?` anywhere in the block and survived a mutant that changed the
   * summary's condition to `true ?` — the neighbouring `setImportProblems` line
   * satisfied the pattern.
   */
  it('sends the summary only when the file is accepted', () => {
    const call = block.slice(block.indexOf('setImportSummary('));

    expect(call).toMatch(/setImportSummary\(\s*\n?\s*parsed\.ok\s*\n?\s*\?/);
  });
});


/**
 * 🔴 **The editor must SEND the document, not just validate it.** The panel's
 * promise is only true if something calls the endpoint — and the last audit
 * found exactly that gap, a sentence describing a rebuild that did not exist.
 */
describe('the editor sends a valid document to the API', () => {
  const editor = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
    'utf8',
  );

  it('calls importSet when a file parses', () => {
    expect(editor).toMatch(/importSet\(/);
  });

  it('sends the set’s own store', () => {
    expect(editor).toMatch(/importSet\(\s*set\.storeId/);
  });
});
