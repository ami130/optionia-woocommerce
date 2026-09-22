import { API_BASE_URL, api } from '@/lib/api/client';
import type { UiCapability } from '@/lib/auth/capabilities';

/**
 * The activation funnel's steps, in order (M20b.1).
 *
 * Mirrors `ACTIVATION_STEPS` in the backend. The order is the funnel's meaning,
 * not a display preference, so it is a frozen tuple rather than something the UI
 * sorts — a re-ordered checklist would tell a merchant to do things in an order
 * the product does not support.
 */
export const ACTIVATION_STEPS = [
  'signed_up',
  'verified',
  'installed',
  'connected',
  'synced',
  'created',
  'assigned',
  'published',
  'selected',
  'ordered',
] as const;

export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

export interface ActivationStepState {
  step: ActivationStep;
  reached: boolean;
}

export interface TenantActivation {
  tenantId: string;

  /**
   * When this tenant signed up, as an ISO timestamp.
   *
   * The anchor for every "stalled before X" question: each step is a boolean, so
   * the funnel can say *whether* a merchant connected but not *how long they have
   * not*. M20b.6's nudges key on it, and M20b.8 measures time-to-value from it.
   */
  signedUpAt: string;

  steps: ActivationStepState[];
  /** Reached `published` — the step that counts as activation. */
  activated: boolean;
  /**
   * The earliest step not yet reached, or null when every step is done.
   *
   * ⚠️ **Earliest, not furthest.** The funnel is not monotone: a merchant who
   * published and later disconnected their store has `published` true and
   * `connected` false, and the action they need is to reconnect.
   */
  nextStep: ActivationStep | null;
}

/** What each step asks of the merchant, in their words rather than the schema's. */
export const STEP_LABELS: Readonly<Record<ActivationStep, string>> = {
  signed_up: 'Create your account',
  verified: 'Verify your email',
  installed: 'Install the Optionia plugin',
  connected: 'Connect your store',
  synced: 'Sync your products',
  created: 'Create your first option set',
  assigned: 'Assign it to a product',
  published: 'Publish',
  selected: 'A customer chooses an option',
  ordered: 'An order arrives with options',
} as const;

/**
 * The step that counts as activation.
 *
 * The two steps after it are **value-realized**, not setup: they are things a
 * *customer* does, which the merchant cannot complete by following a checklist.
 * A UI that mixes them into the setup list asks the merchant to do something
 * they have no control over.
 */
export const ACTIVATION_STEP: ActivationStep = 'published';

/** Whether a step is something the merchant can act on. */
export function isSetupStep(step: ActivationStep): boolean {
  return ACTIVATION_STEPS.indexOf(step) <= ACTIVATION_STEPS.indexOf(ACTIVATION_STEP);
}

export async function getActivation(): Promise<TenantActivation> {
  const { data } = await api.get<TenantActivation>('/activation/me');

  return data;
}

/**
 * Where a step's action takes the merchant, and what it costs to offer it.
 *
 * `null` means the step has no action at all — not that one is missing.
 */
export interface StepAction {
  /** Where the link goes. */
  href: string;
  /** The button's words. Imperative, naming the action rather than the step. */
  label: string;
  /**
   * The capability the caller must hold for this to be offered.
   *
   * 🔴 **All five tenant roles hold `analytics:view`**, which is what gates the
   * funnel — so `viewer` and `billing` see this checklist too, and neither can
   * connect a store, create a set or publish. `billing` cannot even *view*
   * stores or option sets. Linking them anywhere is a link to a `403`, which is
   * the exact defect the stores screen records having fixed once already.
   *
   * `null` means the action needs no capability — following it is always safe.
   */
  capability: UiCapability | null;
}

/**
 * The action for each setup step, or null where there is none.
 *
 * 📌 **A table in `lib`, not markup in the component.** It is testable without a
 * renderer, and it is the thing most likely to drift — a route renamed, a step
 * added — so it is somewhere a test can read it, exactly like `STEP_LABELS`.
 */
export const STEP_ACTIONS: Readonly<Record<ActivationStep, StepAction | null>> = {
  /** Done by definition — the account exists or the merchant is not here. */
  signed_up: null,

  /**
   * `/verify-email` handles an arrival with no token: it shows the resend
   * offer rather than trying to spend a token it does not have.
   */
  verified: { href: '/verify-email', label: 'Verify', capability: null },

  /**
   * The install screen M20b.3 built: the download, the WordPress steps, and a
   * connection check.
   */
  installed: { href: '/install', label: 'How to install', capability: null },

  /**
   * ⚠️ **Not a "Connect" button** (ADR-090). The dashboard cannot start a
   * handshake — `/connect` is the *approval* screen and needs `?request=&state=`
   * that only WordPress produces, because the plugin initiates. `/stores` is the
   * teaching surface: its empty state explains the plugin-side flow, and links on
   * to `/install`.
   */
  connected: { href: '/stores', label: 'Connect', capability: 'stores:connect' },

  /**
   * ⚠️ **No action** (ADR-091). `POST /v1/store/products*` is store realm, behind
   * `StoreTokenGuard` — a plugin credential the dashboard does not hold, so a
   * merchant cannot trigger a sync from the browser. Shown as a state, not a
   * task; the plugin's System Status carries the answer.
   */
  synced: null,

  created: { href: '/option-sets', label: 'Create one', capability: 'option_sets:edit' },

  /**
   * Assigning lives inside the editor, and the funnel carries **no set id**
   * (C2) — so this reaches the list, where each set shows a Draft/Published
   * badge and the merchant can see which one needs the work.
   */
  assigned: { href: '/option-sets', label: 'Assign', capability: 'option_sets:edit' },

  published: { href: '/option-sets', label: 'Publish', capability: 'option_sets:publish' },

  /** A customer's doing, not the merchant's — nothing to offer. */
  selected: null,
  ordered: null,
} as const;

/** This person's dashboard preferences (M20b.2). */
export interface DashboardPreferences {
  /** ISO timestamp, or null when the checklist has never been dismissed. */
  checklistDismissedAt: string | null;
}

export async function getPreferences(): Promise<DashboardPreferences> {
  const { data } = await api.get<DashboardPreferences>('/activation/preferences');

  return data;
}

/**
 * Dismiss the setup checklist, or show it again.
 *
 * 📌 One route both ways — `false` restores. A dismiss-only endpoint would need a
 * second one to undo it, which is two ways to write one column.
 */
export async function setChecklistDismissed(dismissed: boolean): Promise<DashboardPreferences> {
  const { data } = await api.patch<DashboardPreferences>('/activation/preferences', {
    dismissed,
  });

  return data;
}

/** The built plugin a merchant installs (M20b.3). */
export interface PluginRelease {
  version: string;
  filename: string;
  sizeBytes: number;
  /** Path on the API, without its `/v1` prefix — see `pluginDownloadUrl`. */
  downloadUrl: string;
}

export async function getPluginRelease(): Promise<PluginRelease> {
  const { data } = await api.get<PluginRelease>('/plugin/latest');

  return data;
}

/**
 * The absolute URL a browser downloads the plugin from.
 *
 * ⚠️ **Not fetched through `api.get()`.** This is a file the browser saves, so it
 * is an `<a href>` — and a relative path would resolve against the dashboard's
 * origin rather than the API's. The route is public (ADR-095), so no token is
 * needed and none can be attached to a plain link anyway.
 *
 * The API returns `/v1/plugin/download/<version>` and `API_BASE_URL` already ends
 * in `/v1`, so the prefix is dropped rather than doubled.
 */
export function pluginDownloadUrl(release: PluginRelease): string {
  return `${API_BASE_URL}${release.downloadUrl.replace(/^\/v1/, '')}`;
}
