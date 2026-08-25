import { BaseEntity, isSentinelDate, LIVE_SENTINEL, SoftDeletableEntity } from './base.entity';

class TestEntity extends BaseEntity {
  /** Expose the protected hook for testing. */
  public generateId(): void {
    (this as unknown as { assignId(): void }).assignId();
  }
}

class TestSoftDeletable extends SoftDeletableEntity {
  constructor() {
    super();
    // Mirrors the column default, which MySQL applies on insert.
    this.deletedAt = LIVE_SENTINEL;
  }
}

describe('BaseEntity', () => {
  it('assigns a UUID on insert', () => {
    const entity = new TestEntity();
    entity.generateId();

    expect(entity.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * v7 embeds a millisecond timestamp in its leading bits, so ids sort
   * chronologically and inserts stay index-friendly. TypeORM's built-in
   * `@PrimaryGeneratedColumn('uuid')` emits v4, which is random and fragments
   * the primary-key index. See ADR-004.
   */
  it('generates version 7, not version 4', () => {
    const entity = new TestEntity();
    entity.generateId();

    // The version nibble is the first character of the third group.
    expect(entity.id.charAt(14)).toBe('7');
  });

  it('generates time-ordered ids', async () => {
    const first = new TestEntity();
    first.generateId();

    await new Promise((resolve) => setTimeout(resolve, 2));

    const second = new TestEntity();
    second.generateId();

    expect(second.id > first.id).toBe(true);
  });

  it('does not overwrite an id that was set explicitly', () => {
    const entity = new TestEntity();
    entity.id = '01234567-89ab-7def-8123-456789abcdef';
    entity.generateId();

    expect(entity.id).toBe('01234567-89ab-7def-8123-456789abcdef');
  });
});

describe('SoftDeletableEntity', () => {
  /**
   * The whole reason for the sentinel. With a nullable `deleted_at`, MySQL's
   * unique index treats every live row as distinct (`NULL != NULL`) and permits
   * unlimited duplicates — verified against MySQL 9.6. See ADR-014.
   */
  it('marks a live row with the sentinel, not null', () => {
    const entity = new TestSoftDeletable();

    expect(entity.deletedAt).not.toBeNull();
    expect(entity.deletedAt.getTime()).toBe(LIVE_SENTINEL.getTime());
    expect(entity.isLive).toBe(true);
  });

  it('records a real timestamp on delete', () => {
    const entity = new TestSoftDeletable();
    const at = new Date('2026-08-24T10:00:00.000Z');

    entity.markDeleted(at);

    expect(entity.isLive).toBe(false);
    expect(entity.deletedAt).toEqual(at);
  });

  it('keeps the original time when deleted twice', () => {
    const entity = new TestSoftDeletable();
    const first = new Date('2026-08-24T10:00:00.000Z');

    entity.markDeleted(first);
    entity.markDeleted(new Date('2026-09-01T10:00:00.000Z'));

    expect(entity.deletedAt).toEqual(first);
  });

  it('restores to the sentinel', () => {
    const entity = new TestSoftDeletable();

    entity.markDeleted();
    entity.restore();

    expect(entity.isLive).toBe(true);
    expect(entity.deletedAt.getTime()).toBe(LIVE_SENTINEL.getTime());
  });

  /**
   * The comment on the previous version of this test stated the requirement
   * correctly — the column holds the literal `1970-01-01 00:00:00.000`
   * regardless of timezone — and then asserted the UTC epoch, which satisfies it
   * only on a UTC machine.
   *
   * On UTC+6 the constant and the stored literal were six hours apart, so
   * `isLive` was false for every live row and a restored row matched nothing.
   */
  it('is midnight on 1970-01-01 in wall-clock terms', () => {
    expect(LIVE_SENTINEL.getFullYear()).toBe(1970);
    expect(LIVE_SENTINEL.getMonth()).toBe(0);
    expect(LIVE_SENTINEL.getDate()).toBe(1);
    expect(LIVE_SENTINEL.getHours()).toBe(0);
    expect(LIVE_SENTINEL.getMinutes()).toBe(0);
    expect(LIVE_SENTINEL.getSeconds()).toBe(0);
  });

  /** The constant and the check must agree, or a live row is not live. */
  it('is recognised by isSentinelDate', () => {
    expect(isSentinelDate(LIVE_SENTINEL)).toBe(true);
  });
});
