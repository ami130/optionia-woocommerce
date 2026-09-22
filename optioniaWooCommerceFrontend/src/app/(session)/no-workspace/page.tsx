/**
 * Signed in, verified, and a member of nothing.
 *
 * Reachable when every membership has been revoked. It is its own destination
 * because sending them to `/login` would loop: they are signed in, and signing
 * in again changes nothing.
 */
export default function NoWorkspacePage() {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">No workspace</h1>
      <p className="text-muted-foreground text-sm">
        Your account is not a member of any workspace. Ask an owner to invite you.
      </p>
    </div>
  );
}
