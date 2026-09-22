/**
 * Screens a **link** reaches, with no guard at all.
 *
 * 🔴 `/reset-password` began in `(auth)`, behind `RequireAnonymous` — so a
 * merchant who was signed in and clicked the link in their email was silently
 * bounced to the dashboard, with the reset impossible until they signed out and
 * nothing telling them so. That is the common case, not the edge one: people
 * reset a password they have forgotten *on another device*.
 *
 * The token in the URL is the credential here, not the session. Anyone holding
 * it may use it, and whether they happen to have a session is irrelevant — so
 * this group asserts nothing about one.
 *
 * `/verify-email` is the near neighbour and deliberately **not** here: a
 * *verified* user should be sent away rather than shown a screen telling them to
 * do what they have already done, so it keeps `(verify)`.
 */
export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
