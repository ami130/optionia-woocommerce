import { redirect } from 'next/navigation';

/**
 * The root sends people onward rather than rendering.
 *
 * `/dashboard` is behind `RequireMerchant`, which redirects a signed-out visitor
 * to `/login` — so one destination serves both cases and the root has no reason
 * to duplicate the decision.
 */
export default function RootPage() {
  redirect('/dashboard');
}
