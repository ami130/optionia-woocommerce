import { DomainException } from '../common/errors/domain.exception';

/**
 * Refuse a write whose loaded version is no longer current (M7.4b).
 *
 * ## Why a pre-flight check *and* a predicate on the write
 *
 * The predicate in `OptionSetsRepository.applyChange` is what makes the
 * guarantee airtight: read-compare-write leaves a window in which another
 * editor commits between the read and the write, and the comparison passes on a
 * value that is already stale. Only the database can decide that atomically.
 *
 * This exists for the cases a predicate cannot cover:
 *
 * - a request that turns out to change nothing, and so never reaches a write —
 *   a stale client saving an unchanged name must still be told, or the *next*
 *   save is the silent overwrite;
 * - a request whose conflict should be reported before expensive work begins,
 *   like publish serializing a whole tree.
 *
 * ## Why `rowVersion` is optional
 *
 * Omitting it means "I have not loaded a version", which scripts, migrations
 * and background jobs legitimately have not. Requiring it would break every
 * non-dashboard caller to protect against a failure mode — two editors
 * overwriting each other — that only editors have.
 */
export function assertVersionMatches(current: number, expected?: number): void {
  if (expected !== undefined && expected !== current) {
    throw DomainException.versionMismatch(
      'This option set was changed by someone else.',
      current,
    );
  }
}
