import { describe, expect, it } from 'vitest';

import type { StoreStatus, StoreSummary } from './api';
import { healthLabel, isProblem, storeHealth } from './health';

const NOW = new Date('2026-09-02T12:00:00.000Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();

const store = (over: Partial<StoreSummary> = {}): StoreSummary => ({
  id: 's-1',
  name: 'Acme',
  storeUrl: 'https://acme.example',
  status: 'connected',
  connectedAt: hoursAgo(48),
  lastSeenAt: hoursAgo(2),
  configVersion: 7,
  pluginVersion: '1.0.0',
  wpVersion: '6.5',
  wcVersion: '11.0.1',
  phpVersion: '8.4',
  ...over,
});

describe('storeHealth', () => {
  /**
   * 🔴 **The heartbeat is daily**, so twenty hours of silence is normal.
   *
   * An hourly threshold would report every working store as broken, which is the
   * fastest way to teach a merchant to ignore this page.
   */
  it.each([1, 12, 20, 47])('treats %s hours of silence as healthy', (hours) => {
    expect(storeHealth(store({ lastSeenAt: hoursAgo(hours) }), NOW)).toBe('healthy');
  });

  it('flags a store that has missed two days', () => {
    expect(storeHealth(store({ lastSeenAt: hoursAgo(49) }), NOW)).toBe('stale');
  });

  /**
   * **Never seen is not stale.** A store connected an hour ago has not yet run
   * its first daily heartbeat; calling that a fault would flag every new
   * connection at the moment a merchant is most likely to be watching.
   */
  it('separates never-seen from stale', () => {
    expect(storeHealth(store({ lastSeenAt: null }), NOW)).toBe('never-seen');
  });

  /**
   * Status beats staleness: a revoked store needs reconnecting, not
   * investigating, and reporting silence would send a merchant to look at the
   * wrong thing.
   */
  it.each<[StoreStatus, string]>([
    ['error', 'needs-attention'],
    ['revoked', 'needs-attention'],
    ['disconnected', 'needs-attention'],
    ['connecting', 'connecting'],
  ])('reports %s as %s even when stale', (status, expected) => {
    expect(storeHealth(store({ status, lastSeenAt: hoursAgo(500) }), NOW)).toBe(expected);
  });
});

describe('healthLabel', () => {
  /** Each of the five states says something different, and something actionable. */
  it('gives revoked its own instruction', () => {
    expect(healthLabel('needs-attention', 'revoked')).toContain('reconnect');
  });

  it('distinguishes disconnected from an error', () => {
    expect(healthLabel('needs-attention', 'disconnected')).toBe('Disconnected');
    expect(healthLabel('needs-attention', 'error')).toBe('Something went wrong');
  });

  it('does not call a new connection a fault', () => {
    expect(healthLabel('never-seen', 'connected')).toContain('awaiting');
  });
});

describe('isProblem', () => {
  it.each<[ReturnType<typeof storeHealth>, boolean]>([
    ['healthy', false],
    ['never-seen', false],
    ['connecting', false],
    ['stale', true],
    ['needs-attention', true],
  ])('%s → %s', (health, expected) => {
    expect(isProblem(health)).toBe(expected);
  });
});
