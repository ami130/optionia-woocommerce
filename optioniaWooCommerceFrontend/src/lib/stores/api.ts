import { api } from '@/lib/api/client';

/** A store as `GET /stores` reports it. */
export interface StoreSummary {
  id: string;
  name: string;
  storeUrl: string;
  status: StoreStatus;
  connectedAt: string | null;
  /** Null means **never checked in**, which is not the same as stale. */
  lastSeenAt: string | null;
  configVersion: number;
  pluginVersion: string | null;
  wpVersion: string | null;
  wcVersion: string | null;
  phpVersion: string | null;
}

/**
 * The five states a store can be in.
 *
 * Not a boolean: `revoked` means reconnect, `error` means read the log, and
 * `connecting` means a handshake someone abandoned. Collapsing them to
 * connected/not would tell a merchant nothing they can act on.
 */
export type StoreStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'revoked';

/** What a pending connection request is asking for. */
export interface ConnectionRequest {
  site_url: string;
  plugin_version: string | null;
  expires_at: string;
}

export interface DisconnectResult {
  status: StoreStatus;
  credentials_revoked: number;
}

export async function listStores(): Promise<StoreSummary[]> {
  const { data } = await api.get<StoreSummary[]>('/stores');

  return data;
}

/**
 * Read a pending request, so the approval screen can name the site.
 *
 * `state` is required and is the credential: a pending request has no tenant
 * yet, so holding the id alone must not be enough.
 */
export async function describeRequest(
  request: string,
  state: string,
): Promise<ConnectionRequest> {
  const { data } = await api.post<ConnectionRequest>('/connect/requests/describe', {
    request,
    state,
  });

  return data;
}

/**
 * Approve the connection.
 *
 * Returns a URL pointing at the **merchant's own site**: the plugin completes the
 * exchange there, and the "connected" confirmation appears in WordPress rather
 * than here.
 */
export async function authorizeConnection(
  request: string,
  state: string,
): Promise<{ redirect_url: string }> {
  const { data } = await api.post<{ redirect_url: string }>('/connect/authorize', {
    request,
    state,
  });

  return data;
}

export async function disconnectStore(id: string): Promise<DisconnectResult> {
  const { data } = await api.post<DisconnectResult>(`/stores/${id}/disconnect`);

  return data;
}
