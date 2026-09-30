/**
 * Screens anyone may see, signed in or out.
 *
 * 🔴 **No guard, and that is the point.** `(auth)` sends a signed-in visitor to
 * the dashboard and `(app)` sends a signed-out one to login; pricing belongs to
 * neither. A prospect comparing plans has no account, and a merchant checking
 * what the next tier costs should not be bounced away from the answer.
 *
 * 📌 The nearest precedent is `(token)`, which also asserts nothing about a
 * session — there because a link is the credential, here because the content is
 * public information.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen">{children}</main>;
}
