/**
 * Where the dashboard keeps its credentials.
 *
 * **Decided 2026-09-02, Phase 13 Stage 1.** The API returns both tokens in the
 * JSON body and sets no cookies, so the browser must hold them and the choice is
 * this client's.
 *
 * | | Where | Why |
 * |---|---|---|
 * | Access token | this module's memory | Never written to disk, gone on reload, unreadable from storage. Its fifteen-minute life bounds the damage further |
 * | Refresh token | `localStorage` | A reload must not sign a merchant out; something has to survive it |
 *
 * ## What this buys, and what it does not
 *
 * An XSS on this page can still call the API as the user for as long as the page
 * is open — no browser-side scheme prevents that. What it prevents is a
 * **long-lived credential being read off disk** and replayed later from
 * elsewhere. That is the difference between an incident and a persistent
 * compromise.
 *
 * httpOnly cookies would close the rest, and were deferred rather than
 * dismissed: they need the API to set and clear cookies, CSRF protection on
 * every mutation, and same-site handling between this origin and the API's.
 *
 * ## Why a module, not a React context
 *
 * The API client is not a component and cannot read a hook. Keeping the tokens
 * here means one owner; a context mirroring them would be a second copy that can
 * disagree, and the disagreement would look like a random sign-out.
 */

const REFRESH_KEY = 'optionia.refresh';

/** When a context last began a refresh, so others can wait rather than race (F64). */
const REFRESH_CLAIM_KEY = 'optionia.refresh.claimed';

/**
 * The access token. Deliberately not exported directly.
 *
 * Module scope rather than `globalThis`: nothing outside this file can read it,
 * so a leak has to go through the functions below, which is a short list to
 * audit.
 */
let accessToken: string | null = null;

/** Listeners notified when the session ends, so the UI can route to sign-in. */
const signOutListeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * The refresh token, or null.
 *
 * Wrapped in try/catch because `localStorage` **throws** rather than returning
 * null in a private window, in a browser set to block site data, and inside some
 * embedded webviews. An unhandled throw here happens before the app renders, so
 * the symptom is a blank page rather than a sign-in screen.
 */
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setRefreshToken(token: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (token === null) {
      window.localStorage.removeItem(REFRESH_KEY);
    } else {
      window.localStorage.setItem(REFRESH_KEY, token);
    }
  } catch {
    /*
     * Storage unavailable. The session still works for this page -- the access
     * token is in memory -- and is simply lost on reload. Signing the user out
     * because their browser will not persist a token would be worse than the
     * session being short.
     */
  }
}

/**
 * When some context last began exchanging the refresh token (F64).
 *
 * 🔴 **`localStorage`, because the contexts that race are separate JS
 * contexts.** `refreshInFlight` in the API client guards one page; a full
 * navigation empties it while the refresh token here survives, so two
 * overlapping contexts each start their own exchange with the same token and
 * the API revokes the family as reuse. This is the one piece of state both
 * sides can see.
 *
 * ⚠️ **Same try/catch discipline as the token itself.** Storage throws rather
 * than returning null in a private window — and an unreadable claim must read
 * as *"nobody is refreshing"*, so a browser that blocks site data still
 * refreshes rather than locking its own session out.
 */
export function getRefreshClaimedAt(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(REFRESH_CLAIM_KEY);

    if (raw === null) {
      return null;
    }

    const parsed = Number(raw);

    /* A value another version wrote, or a partial write. Not a claim. */
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setRefreshClaimedAt(at: number | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (at === null) {
      window.localStorage.removeItem(REFRESH_CLAIM_KEY);
    } else {
      window.localStorage.setItem(REFRESH_CLAIM_KEY, String(at));
    }
  } catch {
    /*
     * Storage unavailable, so this context cannot coordinate with any other.
     * It proceeds alone — which is the behaviour that existed before the claim,
     * and a narrower risk than refusing to refresh at all.
     */
  }
}

/** Store both, after a sign-in or a refresh. */
export function setSession(tokens: { accessToken: string; refreshToken: string }): void {
  setAccessToken(tokens.accessToken);
  setRefreshToken(tokens.refreshToken);
}

/**
 * Forget everything and tell the app.
 *
 * Called when a refresh fails: the session is unrecoverable, and leaving a dead
 * token in place would make every subsequent request fail one at a time instead
 * of once.
 */
export function clearSession(): void {
  setAccessToken(null);
  setRefreshToken(null);

  for (const listener of signOutListeners) {
    listener();
  }
}

/** Subscribe to sign-out. Returns the unsubscribe. */
export function onSignOut(listener: () => void): () => void {
  signOutListeners.add(listener);

  return () => signOutListeners.delete(listener);
}
