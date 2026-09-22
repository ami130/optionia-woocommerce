import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PluginRelease } from '@/lib/activation/api';
import { ConnectionCheck, Download } from './install-display';

/**
 * What a merchant sees on the install screen (M20b.3).
 *
 * 🔴 **`ConnectionCheck` carries ADR-094**, the decision this milestone turned
 * on: the button checks the **connection**, because nothing can check the
 * install. Heartbeat is store realm and its credential is issued *by* the
 * handshake, so before connecting, the cloud holds no attributable record that a
 * merchant's plugin exists.
 *
 * A relabel to "Check my install" would pass every other gate and quietly promise
 * a verification the system cannot perform, so the wording is asserted here.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const RELEASE: PluginRelease = {
  version: '0.2.0',
  filename: 'optionia-0.2.0.zip',
  sizeBytes: 440657,
  downloadUrl: '/v1/plugin/download/0.2.0',
};

describe('Download', () => {
  it('names the file it will save, not just "download"', () => {
    const output = html(<Download release={RELEASE} />);

    expect(output).toContain('optionia-0.2.0.zip');
  });

  /** A merchant comparing against what they already installed needs the version. */
  it('states the version and a readable size', () => {
    const output = html(<Download release={RELEASE} />);

    expect(output).toContain('0.2.0');
    expect(output).toMatch(/\d+ KB/);
  });

  /**
   * ⚠️ **Absolute, pointing at the API.** A relative href resolves against the
   * dashboard's origin, where nothing serves the plugin.
   */
  it('links at the API host with a download attribute', () => {
    const output = html(<Download release={RELEASE} />);

    expect(output).toMatch(/href="https?:\/\/[^"]*\/plugin\/download\/0\.2\.0"/);
    expect(output).toContain('download="optionia-0.2.0.zip"');
  });

  /** A tab would flash empty: the response is an attachment, not a page. */
  it('does not open a new tab', () => {
    const output = html(<Download release={RELEASE} />);

    expect(output).not.toContain('target="_blank"');
  });
});

describe('ConnectionCheck', () => {
  const render = (props: Partial<Parameters<typeof ConnectionCheck>[0]> = {}) =>
    html(
      <ConnectionCheck
        checking={false}
        failed={false}
        connected={false}
        onRecheck={() => {}}
        {...props}
      />,
    );

  /**
   * 🔴 **ADR-094 in one assertion.** The control says what it checks. "Check my
   * install" would be a promise the system cannot keep — there is nothing to
   * check until the store connects.
   */
  it('offers to check the connection, never the installation', () => {
    const output = render();

    expect(output).toMatch(/Check connection/i);
    expect(output).not.toMatch(/check.{0,12}install/i);
  });

  it('says plainly that nothing is connected yet', () => {
    const output = render();

    expect(output).toMatch(/No store is connected yet/i);
  });

  it('confirms a connected store and points at the next step', () => {
    const output = render({ connected: true });

    expect(output).toMatch(/Your store is connected/i);
    expect(output).toContain('href="/option-sets"');
    // Nothing left to check.
    expect(output).not.toMatch(/Check connection/i);
  });

  /**
   * ⚠️ **A failed check must not read as "not connected".** They are different
   * facts, and telling a merchant with a working store that they have none sends
   * them to re-do work that is already done.
   */
  it('reports a failed check rather than claiming nothing is connected', () => {
    const output = render({ failed: true });

    expect(output).toMatch(/That did not work/i);
    expect(output).not.toMatch(/No store is connected yet/i);
  });

  it('shows progress while checking, and claims nothing', () => {
    const output = render({ checking: true });

    expect(output).not.toMatch(/No store is connected yet/i);
    expect(output).not.toMatch(/Your store is connected/i);
  });
});
