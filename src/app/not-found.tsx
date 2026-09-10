import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';

/**
 * A route that does not exist.
 *
 * Next renders its own bare 404 without this, which says "404" and nothing else
 * — no branding, no way back, and no hint whether the page is gone or was never
 * there. M13.7 already keeps *navigation* off unbuilt routes by disabling those
 * items rather than hiding them, so the realistic arrival here is a typed or
 * stale URL, and the useful answer is a way onward.
 *
 * A server component on purpose: there is no state, and shipping JavaScript to
 * render a dead end costs a merchant a download for nothing.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-muted-foreground max-w-md text-sm">
          That address does not exist. Some parts of Optionia are still on the way — those
          appear greyed out in the navigation rather than hidden.
        </p>
      </div>

      {/* `buttonVariants` rather than `<Button asChild>`: this project's Button
          takes no `asChild`, and a nested <button><a> would be invalid HTML. */}
      <Link href="/dashboard" className={buttonVariants()}>
        Back to dashboard
      </Link>
    </div>
  );
}
