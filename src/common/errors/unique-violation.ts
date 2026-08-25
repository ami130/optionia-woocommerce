import { QueryFailedError } from 'typeorm';

import type { ErrorDetail } from '../http/api-response.types';

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';
const ER_DUP_ENTRY_ERRNO = 1062;

/** Deadlock and lock-wait timeout: transient, and the caller may retry. */
const ER_LOCK_DEADLOCK = 'ER_LOCK_DEADLOCK';
const ER_LOCK_WAIT_TIMEOUT = 'ER_LOCK_WAIT_TIMEOUT';

/**
 * Which field a unique index belongs to, by index name.
 *
 * **Keyed on the constraint, not parsed out of the message.** The driver's text
 * is `Duplicate entry 'x' for key 'options.uq_options_group_key'` — it contains
 * the offending *value*, which may be user data, and its format is the driver's
 * to change. The index name is a thing we chose and can look up.
 *
 * An index missing from this map still produces a clean 409 rather than a 500;
 * it simply cannot name the field.
 */
const FIELD_BY_INDEX: Readonly<Record<string, string>> = {
  uq_options_group_key: 'key',
  uq_option_values_option_key: 'valueKey',
};

/**
 * Recognise a unique-constraint violation.
 *
 * Every check-then-insert has a window: two requests can both pass a
 * "does this key exist?" query and both attempt the insert. The database
 * closes that window — the constraint is the guarantee — but without this the
 * loser's `QueryFailedError` reaches the exception filter as an unhandled
 * database error and the caller gets a **500 for what is plainly a 400**.
 *
 * Widening the pre-check cannot fix that; only the constraint is atomic. So the
 * pre-check stays (it produces the precise, common-case error) and this
 * translates the race that slips past it.
 */
export function asUniqueViolation(
  error: unknown,
): { index: string | null; detail: ErrorDetail } | null {
  if (!isDuplicateEntry(error)) {
    return null;
  }

  const index = indexNameOf(error);
  const field = index ? (FIELD_BY_INDEX[index] ?? null) : null;

  return {
    index,
    detail: {
      field: field ?? '',
      code: 'DUPLICATE_KEY',
      params: {
        message: field
          ? `That ${field} is already in use.`
          : 'A value in this request is already in use.',
      },
    },
  };
}

function isDuplicateEntry(error: unknown): error is QueryFailedError {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driver = error as QueryFailedError & {
    code?: string;
    errno?: number;
    driverError?: { code?: string; errno?: number };
  };

  return (
    driver.code === ER_DUP_ENTRY ||
    driver.errno === ER_DUP_ENTRY_ERRNO ||
    driver.driverError?.code === ER_DUP_ENTRY ||
    driver.driverError?.errno === ER_DUP_ENTRY_ERRNO
  );
}

/**
 * The index name from the driver's message.
 *
 * Only the trailing `'table.index'` is read, and only to look up a field name —
 * the message itself is never shown to a caller, because it quotes the value
 * that collided.
 */
function indexNameOf(error: QueryFailedError): string | null {
  const message = (error as QueryFailedError & { sqlMessage?: string }).sqlMessage ?? error.message;
  const match = /for key '(?:[^'.]+\.)?([^']+)'/.exec(message);

  return match ? match[1] : null;
}

/**
 * Whether a database error is a transient lock conflict.
 *
 * A deadlock is **not a bug and not the caller's mistake** — it is two correct
 * transactions touching the same rows in different orders, which MySQL resolves
 * by rolling one back. Reported as a 500 it looks like an outage and a client
 * gives up; reported as a conflict it says exactly what happened and that
 * retrying will probably work.
 *
 * Seen here when a create locks a parent while a concurrent delete is locking
 * that parent's children — the very ordering that prevents a live child under a
 * deleted parent.
 */
export function isTransientLockConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driver = error as QueryFailedError & {
    code?: string;
    driverError?: { code?: string };
  };
  const code = driver.code ?? driver.driverError?.code;

  return code === ER_LOCK_DEADLOCK || code === ER_LOCK_WAIT_TIMEOUT;
}
