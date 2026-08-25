import { QueryFailedError } from 'typeorm';

import { asUniqueViolation } from './unique-violation';

/** A `QueryFailedError` shaped like the mysql2 driver's. */
function duplicateError(message: string, code = 'ER_DUP_ENTRY'): QueryFailedError {
  const error = new QueryFailedError('INSERT …', [], new Error(message));
  Object.assign(error, { code, errno: code === 'ER_DUP_ENTRY' ? 1062 : 1213, sqlMessage: message });

  return error;
}

describe('asUniqueViolation', () => {
  it('names the field for a known index', () => {
    const result = asUniqueViolation(
      duplicateError("Duplicate entry 'g-key' for key 'options.uq_options_group_key'"),
    );

    expect(result?.detail.field).toBe('key');
    expect(result?.detail.code).toBe('DUPLICATE_KEY');
  });

  it('names the value key for the values index', () => {
    const result = asUniqueViolation(
      duplicateError("Duplicate entry 'o-red' for key 'option_values.uq_option_values_option_key'"),
    );

    expect(result?.detail.field).toBe('valueKey');
  });

  /** An unmapped index still beats a 500; it just cannot name the field. */
  it('still recognises an index it does not know', () => {
    const result = asUniqueViolation(
      duplicateError("Duplicate entry 'x' for key 'stores.uq_stores_tenant_url'"),
    );

    expect(result).not.toBeNull();
    expect(result?.detail.field).toBe('');
    expect(result?.index).toBe('uq_stores_tenant_url');
  });

  it('reads an index name with no table prefix', () => {
    const result = asUniqueViolation(duplicateError("Duplicate entry 'x' for key 'uq_options_group_key'"));

    expect(result?.detail.field).toBe('key');
  });

  /**
   * The driver message quotes the colliding value, which may be user data. It
   * must never reach the response.
   */
  it('does not echo the colliding value', () => {
    const result = asUniqueViolation(
      duplicateError("Duplicate entry 'secret-tenant-slug' for key 'options.uq_options_group_key'"),
    );

    expect(JSON.stringify(result?.detail)).not.toContain('secret-tenant-slug');
  });

  it('ignores a deadlock and other database errors', () => {
    expect(asUniqueViolation(duplicateError('Deadlock found', 'ER_LOCK_DEADLOCK'))).toBeNull();
  });

  it('ignores anything that is not a QueryFailedError', () => {
    expect(asUniqueViolation(new Error('nope'))).toBeNull();
    expect(asUniqueViolation(null)).toBeNull();
    expect(asUniqueViolation(undefined)).toBeNull();
  });

  it('recognises the error by errno when the code is absent', () => {
    const error = new QueryFailedError('INSERT …', [], new Error('dup'));
    Object.assign(error, { errno: 1062, sqlMessage: "Duplicate entry 'x' for key 'a.uq_options_group_key'" });

    expect(asUniqueViolation(error)?.detail.field).toBe('key');
  });
});
