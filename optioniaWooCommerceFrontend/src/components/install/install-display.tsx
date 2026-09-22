import Link from 'next/link';

import { ErrorState, LoadingRows } from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { pluginDownloadUrl, type PluginRelease } from '@/lib/activation/api';
import { cn } from '@/lib/utils';

export function Download({ release }: { release: PluginRelease }) {
  return (
    <div className="space-y-2">
      <a
        className={cn(buttonVariants({ variant: 'default' }))}
        href={pluginDownloadUrl(release)}
        /*
         * No `target="_blank"`: the response is an attachment, so the browser
         * saves it without navigating. Opening a tab would flash an empty one.
         */
        download={release.filename}
      >
        Download {release.filename}
      </a>

      <p className="text-muted-foreground text-xs">
        Version {release.version} · {Math.round(release.sizeBytes / 1024)} KB
      </p>
    </div>
  );
}

/**
 * Whether the store is connected yet (ADR-094).
 *
 * ⚠️ **It checks the *connection*, and says so.** M20b.3 asks for an "I've
 * installed it — check" button that "verifies by heartbeat" — but heartbeat is
 * store-realm and its credential is issued *by* the handshake, so it exists only
 * after connection. Before that the cloud holds no attributable record that a
 * merchant's plugin exists: a pending connection request carries no tenant until
 * it is approved.
 *
 * So the honest button checks what can be checked. A control labelled "check my
 * install" that could only ever report on the connection would be a promise the
 * system cannot keep.
 */
export function ConnectionCheck({
  checking,
  failed,
  connected,
  onRecheck,
}: {
  checking: boolean;
  failed: boolean;
  connected: boolean;
  onRecheck: () => void;
}) {
  if (checking) {
    return <LoadingRows rows={1} />;
  }

  if (failed) {
    return <ErrorState error={new Error('Could not check your stores.')} onRetry={onRecheck} />;
  }

  if (connected) {
    return (
      <Alert>
        <AlertTitle>Your store is connected</AlertTitle>
        <AlertDescription>
          Nothing more to do here.{' '}
          <Link href="/option-sets" className="underline">
            Create your first option set
          </Link>
          .
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        onClick={onRecheck}
      >
        Check connection
      </button>
      <span className="text-muted-foreground text-sm">No store is connected yet.</span>
    </div>
  );
}
