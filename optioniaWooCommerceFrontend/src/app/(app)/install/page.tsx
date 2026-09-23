'use client';

import { useQuery } from '@tanstack/react-query';
import { LoadingRows } from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { ConnectionCheck, Download } from '@/components/install/install-display';
import { getActivation, getPluginRelease } from '@/lib/activation/api';

/**
 * Getting the plugin into a merchant's WordPress (M20b.3).
 *
 * 🔴 **The milestone calls this "the weakest link"**: the merchant is in a
 * browser tab on the dashboard and has to end up with a plugin installed on a
 * different system. Every step loses people, so the instructions are on one
 * screen, in order, with the download beside them.
 *
 * ⚠️ **This replaces a link to `https://wordpress.org/plugins/`** — the generic
 * directory index, where Optionia is not listed and will not be until
 * [M35.2](../../../../developePlan.md). That link taught nothing; it was filed
 * during the Step 0 audit and is closed here.
 */
export default function InstallPage() {
  const release = useQuery({ queryKey: ['plugin', 'latest'], queryFn: getPluginRelease });
  const activation = useQuery({ queryKey: ['activation'], queryFn: getActivation });

  const connected =
    activation.data?.steps.find((step) => step.step === 'connected')?.reached === true;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Install the Optionia plugin</h1>
        <p className="text-muted-foreground text-sm">
          Optionia runs as a WordPress plugin on your own site. Download it here, install it
          from your WordPress admin, then connect it to this account.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="font-medium">1. Download the plugin</h2>

          {release.isPending ? (
            <LoadingRows rows={2} />
          ) : release.isError || release.data === undefined ? (
            /*
             * ⚠️ **A missing build is not a broken dashboard.** In development
             * nobody has run `bin/package.sh`, and the API answers 404 — so this
             * says what to do rather than showing a generic failure.
             */
            <Alert>
              <AlertTitle>No download is available yet</AlertTitle>
              <AlertDescription>
                No plugin build has been published. If you are running Optionia locally, build
                one with <code>bash bin/package.sh</code> in the plugin repository.
              </AlertDescription>
            </Alert>
          ) : (
            <Download release={release.data} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="font-medium">2. Install it in WordPress</h2>

          {/*
            Numbered, in the words the WordPress admin actually uses — "Plugins →
            Add New Plugin → Upload Plugin" is what the merchant will read on
            their own screen, and paraphrasing it is how instructions stop
            matching.
          */}
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open your WordPress admin and go to <strong>Plugins → Add New Plugin</strong>.
            </li>
            <li>
              Choose <strong>Upload Plugin</strong> at the top of the page.
            </li>
            <li>Select the file you just downloaded, then choose <strong>Install Now</strong>.</li>
            <li>
              When it finishes, choose <strong>Activate Plugin</strong>.
            </li>
          </ol>

          {/*
            📌 Screenshots belong here and are deliberately absent: they need a
            real WordPress admin to capture, so they are content rather than code.
            The layout takes them without changing.
          */}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="font-medium">3. Connect it to this account</h2>

          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>
              In your WordPress admin, open <strong>Optionia</strong> in the sidebar.
            </li>
            <li>
              Choose <strong>Connect</strong>. You will be sent back here to approve it.
            </li>
          </ol>

          {/*
            🔴 **The connection starts in WordPress, not here** (ADR-090). The
            dashboard cannot begin a handshake — `/connect` is the *approval*
            screen and needs a request the plugin creates — so this screen tells
            the merchant where the button is rather than offering one that cannot
            work.
          */}
          <ConnectionCheck
            checking={activation.isPending}
            failed={activation.isError}
            connected={connected}
            onRecheck={() => void activation.refetch()}
          />
        </CardContent>
      </Card>
    </div>
  );
}
