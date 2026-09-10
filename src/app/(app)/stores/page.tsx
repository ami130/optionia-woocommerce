'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AsyncState, EmptyState, ErrorState } from '@/components/layout/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useSession } from '@/components/providers/session-provider';
import { roleCan } from '@/lib/auth/capabilities';
import { disconnectStore, listStores, type StoreSummary } from '@/lib/stores/api';
import { healthLabel, isProblem, storeHealth } from '@/lib/stores/health';
import { cn } from '@/lib/utils';

/**
 * Connected stores and their health (M13.3).
 *
 * ⚠️ **An in-flight handshake is invisible here.** No store row exists
 * cloud-side until a merchant approves, so a plugin sitting in `connecting`
 * shows nothing on this page. The empty state says where to look rather than
 * implying the list is complete — otherwise a merchant who started a connection
 * and wandered off sees "no stores" and concludes it failed.
 */
export default function StoresPage() {
  const queryClient = useQueryClient();
  const { me } = useSession();

  /**
   * Whether to offer Disconnect at all.
   *
   * 🔴 Stage 0 granted `stores:view` to `editor` and `viewer`, so both reach this
   * page — but neither holds `stores:connect`. The button was offered to all of
   * them and answered `403` on click. A hint, not enforcement: the API refuses
   * regardless, and this only stops the UI promising something it cannot do.
   */
  const canDisconnect = roleCan(me?.role, 'stores:connect');

  const query = useQuery({ queryKey: ['stores'], queryFn: listStores });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Stores</h1>
        <p className="text-muted-foreground text-sm">
          The WooCommerce stores this workspace serves options to.
        </p>
      </div>

      <AsyncState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyState
            title="No stores connected yet"
            description={
              'Install the Optionia plugin on your WooCommerce site and press Connect. ' +
              'A connection you have started but not yet approved will not appear here until you do.'
            }
            action={
              <a
                className="text-sm underline"
                href="https://wordpress.org/plugins/"
                target="_blank"
                rel="noreferrer"
              >
                How to install the plugin
              </a>
            }
          />
        }
      >
        {(stores) => (
          <ul className="space-y-3">
            {stores.map((store) => (
              <li key={store.id}>
                <StoreRow
                  store={store}
                  canDisconnect={canDisconnect}
                  onDisconnected={() => void queryClient.invalidateQueries({ queryKey: ['stores'] })}
                />
              </li>
            ))}
          </ul>
        )}
      </AsyncState>
    </div>
  );
}

function StoreRow({
  store,
  canDisconnect,
  onDisconnected,
}: {
  store: StoreSummary;
  canDisconnect: boolean;
  onDisconnected: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const health = storeHealth(store);

  const disconnect = useMutation({
    mutationFn: () => disconnectStore(store.id),
    onSuccess: () => {
      setConfirming(false);
      onDisconnected();
    },
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-medium break-all">{store.storeUrl}</p>
            <p className={cn('text-sm', isProblem(health) ? 'text-destructive' : 'text-muted-foreground')}>
              {healthLabel(health, store.status)}
            </p>
          </div>

          {store.status === 'disconnected' || !canDisconnect ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          )}
        </div>

        <dl className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Detail label="Last check-in" value={formatLastSeen(store.lastSeenAt)} />
          <Detail label="Configuration" value={`v${store.configVersion}`} />
          <Detail label="Plugin" value={store.pluginVersion ?? '—'} />
          <Detail label="WooCommerce" value={store.wcVersion ?? '—'} />
        </dl>

        {disconnect.error === null || disconnect.error === undefined ? null : (
          <ErrorState error={disconnect.error} />
        )}

        {disconnect.data === undefined ? null : (
          <Alert>
            <AlertDescription>
              {/*
                Specific rather than "done": the API reports how many credentials
                it revoked, and a merchant reconnecting wants to know the old
                ones are dead.
              */}
              {/*
                Specific rather than "done" — except when there is nothing to be
                specific about. A store whose plugin never completed the exchange
                has no credentials, and "0 credentials revoked" reads as a bug
                rather than as a fact. Measured during the Stage 3 audit.
              */}
              {disconnect.data.credentials_revoked === 0
                ? 'Disconnected. This store had no active credentials.'
                : `Disconnected. ${disconnect.data.credentials_revoked} ${
                    disconnect.data.credentials_revoked === 1 ? 'credential' : 'credentials'
                  } revoked.`}
            </AlertDescription>
          </Alert>
        )}

        {!confirming || disconnect.data !== undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription className="space-y-3">
              <p>
                Disconnecting stops this store serving options immediately and revokes its
                credentials. Reconnecting later means approving a new handshake from WordPress.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  {disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
                  Keep it connected
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="text-foreground font-medium">{value}</dd>
    </div>
  );
}

/**
 * How long ago, in words.
 *
 * "Never" is deliberate and distinct from a duration: a store connected minutes
 * ago has not yet run its first **daily** heartbeat, and rendering that as an
 * enormous age would read as a fault.
 */
function formatLastSeen(lastSeenAt: string | null): string {
  if (lastSeenAt === null) {
    return 'Never';
  }

  const minutes = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60_000);

  if (minutes < 60) {
    return `${Math.max(minutes, 0)} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}
