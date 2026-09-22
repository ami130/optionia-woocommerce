import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, setSession } from '@/lib/auth/token-store';
import {
  ACTIVATION_STEP,
  ACTIVATION_STEPS,
  STEP_ACTIONS,
  STEP_LABELS,
  getActivation,
  getPluginRelease,
  getPreferences,
  isSetupStep,
  pluginDownloadUrl,
  setChecklistDismissed,
  type ActivationStep,
} from './api';

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ data, meta: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('activation api', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the funnel from the documented path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({ tenantId: 't-1', steps: [], activated: false, nextStep: 'verified' }),
    );

    const activation = await getActivation();

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/activation/me');
    expect(activation.tenantId).toBe('t-1');
  });

  /**
   * The route takes no tenant id, and must never gain one: the tenant comes from
   * the caller's token, which is what makes a cross-tenant read unrepresentable.
   */
  it('sends no tenant identifier of its own', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ tenantId: 't-1', steps: [], activated: false, nextStep: null }));

    await getActivation();

    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/\/activation\/me$/);
  });

  describe('the step table', () => {
    it('labels every step', () => {
      for (const step of ACTIVATION_STEPS) {
        expect(STEP_LABELS[step]).toBeTruthy();
      }
    });

    it('holds no label for a step that does not exist', () => {
      const labelled = Object.keys(STEP_LABELS).sort();

      expect(labelled).toEqual([...ACTIVATION_STEPS].sort());
    });

    it('activates at published', () => {
      expect(ACTIVATION_STEP).toBe('published');
    });

    /**
     * The two steps after activation are things a **customer** does. A checklist
     * that asks the merchant to complete them is asking for something outside
     * their control.
     */
    it('treats only the steps up to publish as merchant setup', () => {
      const setup = ACTIVATION_STEPS.filter(isSetupStep);

      expect(setup).toEqual([
        'signed_up',
        'verified',
        'installed',
        'connected',
        'synced',
        'created',
        'assigned',
        'published',
      ]);
      expect(ACTIVATION_STEPS.filter((s) => !isSetupStep(s))).toEqual(['selected', 'ordered']);
    });

    it('orders the steps as the funnel runs', () => {
      const order = (step: ActivationStep) => ACTIVATION_STEPS.indexOf(step);

      expect(order('verified')).toBeLessThan(order('connected'));
      expect(order('connected')).toBeLessThan(order('published'));
      expect(order('published')).toBeLessThan(order('ordered'));
    });
  });

  /**
   * Where each step sends the merchant (M20b.2).
   *
   * 📌 A table in `lib` rather than markup, so it is testable without a renderer
   * and a route rename fails here rather than in a browser.
   */
  describe('the action table', () => {
    it('names an action or an explicit null for every step', () => {
      expect(Object.keys(STEP_ACTIONS).sort()).toEqual([...ACTIVATION_STEPS].sort());
    });

    /**
     * ⚠️ ADR-090 — the dashboard cannot start a handshake. `/connect` is the
     * *approval* screen and needs `?request=&state=` that only WordPress can
     * produce, so a step that linked there would be a broken promise.
     */
    it('never links a step at the approval screen', () => {
      for (const action of Object.values(STEP_ACTIONS)) {
        expect(action?.href).not.toBe('/connect');
      }
    });

    it('sends the connect step to the stores screen', () => {
      expect(STEP_ACTIONS.connected?.href).toBe('/stores');
    });

    /** ⚠️ ADR-091 — a sync cannot be triggered from the browser at all. */
    it('offers no action for a step the merchant cannot perform', () => {
      expect(STEP_ACTIONS.synced).toBeNull();
      expect(STEP_ACTIONS.selected).toBeNull();
      expect(STEP_ACTIONS.ordered).toBeNull();
      expect(STEP_ACTIONS.signed_up).toBeNull();
    });

    /**
     * 🔴 The capability is what stops a `viewer` or a `billing` member being sent
     * to a screen that refuses them. A step that writes must declare one.
     */
    it.each(['connected', 'created', 'assigned', 'published'] as const)(
      '%s requires a capability before it is offered',
      (step) => {
        expect(STEP_ACTIONS[step]?.capability).toBeTruthy();
      },
    );

    /** Reading a page a merchant may always see needs no capability. */
    it.each(['verified', 'installed'] as const)('%s needs no capability', (step) => {
      expect(STEP_ACTIONS[step]?.capability).toBeNull();
    });

    it('publishes behind the publish capability, not the edit one', () => {
      expect(STEP_ACTIONS.published?.capability).toBe('option_sets:publish');
    });

    it('labels every action it offers', () => {
      for (const action of Object.values(STEP_ACTIONS)) {
        if (action !== null) {
          expect(action.label.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('preferences', () => {
    it('reads them from the documented path', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(ok({ checklistDismissedAt: null }));

      const result = await getPreferences();

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(
        '/activation/preferences',
      );
      expect(result.checklistDismissedAt).toBeNull();
    });

    it('dismisses by sending an explicit boolean', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(ok({ checklistDismissedAt: '2026-09-16T10:00:00.000Z' }));

      await setChecklistDismissed(true);

      const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ dismissed: true });
      expect(init.method).toBe('PATCH');
    });

    /** 📌 The same route restores — `false`, not a second endpoint. */
    it('restores through the same route', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(ok({ checklistDismissedAt: null }));

      await setChecklistDismissed(false);

      const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ dismissed: false });
    });
  });

  describe('the plugin release', () => {
    it('reads the newest build from the documented path', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        ok({
          version: '0.2.0',
          filename: 'optionia-0.2.0.zip',
          sizeBytes: 440657,
          downloadUrl: '/v1/plugin/download/0.2.0',
        }),
      );

      const release = await getPluginRelease();

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/plugin/latest');
      expect(release.version).toBe('0.2.0');
    });

    /**
     * 🔴 **The `/v1` must not be doubled.** `API_BASE_URL` already ends in `/v1`
     * and the API returns a `/v1`-prefixed path, so a naive concatenation gives
     * `/v1/v1/plugin/...` — a 404 on the one link the install screen exists for.
     */
    it('builds an absolute download URL without doubling the prefix', () => {
      const url = pluginDownloadUrl({
        version: '0.2.0',
        filename: 'optionia-0.2.0.zip',
        sizeBytes: 1,
        downloadUrl: '/v1/plugin/download/0.2.0',
      });

      expect(url).not.toContain('/v1/v1/');
      expect(url).toMatch(/\/v1\/plugin\/download\/0\.2\.0$/);
    });

    /**
     * ⚠️ **Absolute, not relative.** A relative href would resolve against the
     * dashboard's own origin, where nothing serves the plugin.
     */
    it('points at the API host rather than the dashboard', () => {
      const url = pluginDownloadUrl({
        version: '1.0.0',
        filename: 'optionia-1.0.0.zip',
        sizeBytes: 1,
        downloadUrl: '/v1/plugin/download/1.0.0',
      });

      expect(url).toMatch(/^https?:\/\//);
    });
  });
});
