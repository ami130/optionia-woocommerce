import { diff } from './audit-diff';

describe('diff', () => {
  it('records a create as a change from nothing', () => {
    expect(diff(null, { name: 'Set' })).toEqual({ name: { from: null, to: 'Set' } });
  });

  it('records a delete as a change to nothing', () => {
    expect(diff({ name: 'Set' }, null)).toEqual({ name: { from: 'Set', to: null } });
  });

  it('records before and after for an update', () => {
    expect(diff({ name: 'A' }, { name: 'B' })).toEqual({ name: { from: 'A', to: 'B' } });
  });

  /** The point is what changed; equal values bury it. */
  it('omits fields that did not change', () => {
    expect(diff({ name: 'A', status: 'draft' }, { name: 'B', status: 'draft' })).toEqual({
      name: { from: 'A', to: 'B' },
    });
  });

  it('is empty when nothing changed', () => {
    expect(diff({ name: 'A' }, { name: 'A' })).toEqual({});
  });

  it('covers fields present on only one side', () => {
    expect(diff({ removed: 1 }, { added: 2 })).toEqual({
      removed: { from: 1, to: null },
      added: { from: null, to: 2 },
    });
  });

  it('compares JSON columns structurally, not by reference', () => {
    expect(diff({ pricing: { type: 'fixed' } }, { pricing: { type: 'fixed' } })).toEqual({});
    expect(diff({ pricing: { type: 'fixed' } }, { pricing: { type: 'percentage' } })).toEqual({
      pricing: { from: { type: 'fixed' }, to: { type: 'percentage' } },
    });
  });

  it('compares dates by value', () => {
    const when = '2026-01-01T00:00:00.000Z';

    expect(diff({ at: new Date(when) }, { at: new Date(when) })).toEqual({});
  });

  it('treats false and zero as values, not absence', () => {
    expect(diff({ enabled: true }, { enabled: false })).toEqual({
      enabled: { from: true, to: false },
    });
    expect(diff({ count: 1 }, { count: 0 })).toEqual({ count: { from: 1, to: 0 } });
  });

  it('returns an empty diff for two empty sides', () => {
    expect(diff(null, null)).toEqual({});
  });
});
