/**
 * The validator a storefront presents to ask "has anything changed?".
 *
 * ## Why not a hash of the body
 *
 * The obvious ETag is a digest of the response. It would be wrong here twice
 * over: computing it means building the whole document — the expensive thing a
 * conditional request exists to avoid — and the body is not byte-stable anyway,
 * since `generated_at` and `meta.timestamp` are stamped per request.
 *
 * `config_version` is the store's content revision. It advances on publish and
 * rollback and on nothing else, which is exactly the question being asked.
 *
 * ## Why it is scoped to the store
 *
 * A bare `"42"` is a claim about a number, not about a store, and two stores
 * sitting at version 42 hold entirely different documents. Any shared cache
 * keyed on the validator alone — a proxy, a future CDN, a test harness — would
 * serve one merchant's options to another. Scoping it makes that collision
 * impossible rather than merely unlikely.
 *
 * ## Why it is weak
 *
 * `W/` says "semantically equivalent", not "byte-identical". Two responses at
 * the same version carry different `generated_at` stamps, so a strong validator
 * would be a claim this endpoint cannot honour. `If-None-Match` compares weak
 * validators with the weak comparison function, which is the one that matches
 * what is actually being promised.
 */

/** Build the validator for a store at a given config version. */
export function configEtag(storeId: string, configVersion: number | string): string {
  return `W/"${storeId}-${configVersion}"`;
}

/**
 * Whether the client already holds this version.
 *
 * `If-None-Match` may carry a list, and `*` matches any existing
 * representation (RFC 9110 §13.1.2). Both are handled here rather than by the
 * caller, so a header written by a well-behaved client is never mistaken for a
 * miss — a false miss is a full document build and a full download, which is
 * the cost this endpoint exists to avoid.
 *
 * Comparison is weak: the `W/` prefix is stripped from both sides before
 * comparing, because a client that echoes a weak validator without its prefix
 * is asking the same question.
 */
export function matchesEtag(header: string | undefined, current: string): boolean {
  if (!header) {
    return false;
  }

  const normalise = (value: string): string => value.trim().replace(/^W\//, '');
  const target = normalise(current);

  return header
    .split(',')
    .map(normalise)
    .some((candidate) => candidate === '*' || candidate === target);
}
