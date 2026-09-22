import type { DataSource } from 'typeorm';

import { seedSuperAdmin } from './super-admin.seed';

/**
 * The two guards that run before any database work.
 *
 * This account can impersonate any merchant, so its password minimum is a
 * security control rather than a validation nicety. It had never executed in an
 * automated check: CI runs `db:seed` but sets no `SEED_ADMIN_*` variables, so
 * only the skip path was ever taken (ADR-021).
 *
 * Both guards return or throw before `getRepository` is reached, so they are
 * testable without a database. The connection here is a proxy that fails loudly
 * if the code under test tries to use it — a test that silently opened a real
 * connection would be worse than no test, since it could write to whatever
 * database happened to be configured.
 */
const unusableConnection = new Proxy({} as DataSource, {
  get(_target, property) {
    throw new Error(
      `seedSuperAdmin touched the database (.${String(property)}) before its ` +
        `guards passed — the guards must run first.`,
    );
  },
});

describe('seedSuperAdmin guards', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...original };
    jest.restoreAllMocks();
  });

  describe('when credentials are absent', () => {
    /**
     * Skipping rather than failing keeps `db:seed` useful for a developer who
     * only wants plans, which is the common case.
     */
    it('skips without touching the database', async () => {
      await expect(seedSuperAdmin(unusableConnection)).resolves.toBeUndefined();
    });

    it('skips when only the email is set', async () => {
      process.env.SEED_ADMIN_EMAIL = 'admin@example.com';

      await expect(seedSuperAdmin(unusableConnection)).resolves.toBeUndefined();
    });

    it('skips when only the password is set', async () => {
      process.env.SEED_ADMIN_PASSWORD = 'a-long-enough-password';

      await expect(seedSuperAdmin(unusableConnection)).resolves.toBeUndefined();
    });

    /**
     * An empty or whitespace-only email is absent, not valid. Without the trim
     * it would pass the guard and be stored as the account's login.
     */
    it('treats a whitespace-only email as absent', async () => {
      process.env.SEED_ADMIN_EMAIL = '   ';
      process.env.SEED_ADMIN_PASSWORD = 'a-long-enough-password';

      await expect(seedSuperAdmin(unusableConnection)).resolves.toBeUndefined();
    });
  });

  describe('password minimum', () => {
    beforeEach(() => {
      process.env.SEED_ADMIN_EMAIL = 'admin@example.com';
    });

    it('rejects a password shorter than 12 characters', async () => {
      process.env.SEED_ADMIN_PASSWORD = 'short';

      await expect(seedSuperAdmin(unusableConnection)).rejects.toThrow(
        /at least 12 characters/,
      );
    });

    /**
     * The message says why the rule exists. A developer who hits this at 3am
     * should not have to read the source to decide whether to work around it.
     */
    it('explains why the rule exists', async () => {
      process.env.SEED_ADMIN_PASSWORD = 'short';

      await expect(seedSuperAdmin(unusableConnection)).rejects.toThrow(
        /impersonate any merchant/,
      );
    });

    it('rejects at 11 characters and refuses before any database work', async () => {
      process.env.SEED_ADMIN_PASSWORD = 'x'.repeat(11);

      await expect(seedSuperAdmin(unusableConnection)).rejects.toThrow(
        /at least 12 characters/,
      );
    });

    /**
     * 12 is accepted, so the boundary is `< 12` rather than `<= 12`. Proven by
     * the failure that follows: the guard passes and the code reaches the
     * database, which this connection refuses.
     */
    it('accepts exactly 12 characters and proceeds to the database', async () => {
      process.env.SEED_ADMIN_PASSWORD = 'x'.repeat(12);

      await expect(seedSuperAdmin(unusableConnection)).rejects.toThrow(
        /touched the database/,
      );
    });
  });
});
