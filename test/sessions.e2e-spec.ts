import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { RefreshToken } from '../src/auth/entities/refresh-token.entity';
import { RevokeReason, SessionsService } from '../src/auth/sessions.service';
import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { hashToken } from '../src/common/crypto/tokens';

/**
 * Refresh rotation and reuse detection, against a real database.
 *
 * This is the reason `refresh_tokens` exists — a stateless JWT cannot be detected
 * as replayed. The properties here are about *rows*: what is marked rotated, what
 * is revoked, and how far a revocation reaches. None of that is observable
 * through a mock.
 */
describe('SessionsService (integration)', () => {
  let dataSource: DataSource;
  let sessions: SessionsService;

  const USER_ID = 'session-test-user';
  const OTHER_USER = 'session-other-user';

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();

    // 30 days in milliseconds — the constructor takes a duration, not a count.
    sessions = new SessionsService(dataSource.getRepository(RefreshToken), 30 * 86_400_000);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM users WHERE id IN (?, ?)`, [USER_ID, OTHER_USER]);
  }

  beforeEach(async () => {
    await cleanup();

    for (const [id, email] of [
      [USER_ID, 'session-test@example.com'],
      [OTHER_USER, 'session-other@example.com'],
    ]) {
      await dataSource.query(
        `INSERT INTO users (id, email, passwordHash, name, locale, createdAt, updatedAt)
         VALUES (?, ?, '$2b$12$placeholder', 'Session Test', 'en', NOW(3), NOW(3))`,
        [id, email],
      );
    }
  });

  async function rowFor(plaintext: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await dataSource.query(
      `SELECT id, familyId, rotatedAt, revokedAt, revokedReason, replacedById
         FROM refresh_tokens WHERE tokenHash = ?`,
      [hashToken(plaintext)],
    );

    return row;
  }

  async function liveCount(userId = USER_ID): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM refresh_tokens WHERE userId = ? AND revokedAt IS NULL`,
      [userId],
    );

    return Number(row.n);
  }

  describe('issue', () => {
    it('stores a hash, never the token', async () => {
      const token = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      const row = await rowFor(token);

      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(token);
    });

    /**
     * Each login opens its own family, so signing out on one device must not end
     * a session on another.
     */
    it('gives each login its own family', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'phone');
      const second = await sessions.issue(USER_ID, '5.6.7.8', 'laptop');

      expect((await rowFor(first))?.familyId).not.toBe((await rowFor(second))?.familyId);
    });
  });

  describe('rotate', () => {
    it('returns a new token and marks the old one rotated', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');

      const outcome = await sessions.rotate(first, '1.2.3.4', 'agent');

      expect(outcome.failure).toBeNull();
      expect(outcome.token).not.toBe(first);

      const old = await rowFor(first);
      expect(old?.rotatedAt).not.toBeNull();
      expect(old?.replacedById).not.toBeNull();
    });

    /** The replacement continues the same session. */
    it('keeps the replacement in the same family', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      const outcome = await sessions.rotate(first, '1.2.3.4', 'agent');

      expect((await rowFor(outcome.token as string))?.familyId).toBe(
        (await rowFor(first))?.familyId,
      );
    });

    it('rotates repeatedly, as a long-lived session does', async () => {
      let token = await sessions.issue(USER_ID, '1.2.3.4', 'agent');

      for (let i = 0; i < 5; i += 1) {
        const outcome = await sessions.rotate(token, '1.2.3.4', 'agent');
        expect(outcome.failure).toBeNull();
        token = outcome.token as string;
      }

      expect(await liveCount()).toBe(6);
    });

    it('refuses an unknown token', async () => {
      const outcome = await sessions.rotate('never-issued', '1.2.3.4', 'agent');

      expect(outcome.failure).toBe('not_found');
    });

    it('refuses an expired token', async () => {
      const token = await sessions.issue(USER_ID, '1.2.3.4', 'agent');

      await dataSource.query(
        `UPDATE refresh_tokens SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE tokenHash = ?`,
        [hashToken(token)],
      );

      expect((await sessions.rotate(token, '1.2.3.4', 'agent')).failure).toBe('expired');
    });
  });

  describe('reuse detection', () => {
    /**
     * The property this table exists for. Presenting a spent token means a copy
     * was stolen: the legitimate holder has the replacement.
     */
    it('detects a token presented twice', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      await sessions.rotate(first, '1.2.3.4', 'agent');

      const replay = await sessions.rotate(first, '9.9.9.9', 'attacker');

      expect(replay.failure).toBe('reused');
      expect(replay.token).toBeNull();
    });

    /**
     * Revoking only the replayed row would log the victim out while leaving the
     * attacker signed in with the newest token. The whole family goes.
     */
    it('revokes the entire family, not just the replayed token', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      const second = (await sessions.rotate(first, '1.2.3.4', 'agent')).token as string;
      const third = (await sessions.rotate(second, '1.2.3.4', 'agent')).token as string;

      // The attacker replays a token from earlier in the chain.
      await sessions.rotate(first, '9.9.9.9', 'attacker');

      // The newest token — which the attacker may be holding — is dead too.
      expect((await sessions.rotate(third, '1.2.3.4', 'agent')).failure).toBe('revoked');
      expect(await liveCount()).toBe(0);
    });

    it('records why the family was revoked', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      await sessions.rotate(first, '1.2.3.4', 'agent');
      await sessions.rotate(first, '9.9.9.9', 'attacker');

      expect((await rowFor(first))?.revokedReason).toBe(RevokeReason.REUSE_DETECTED);
    });

    /** One compromised session must not end a session on another device. */
    it('leaves other sessions for the same user untouched', async () => {
      const phone = await sessions.issue(USER_ID, '1.2.3.4', 'phone');
      const laptop = await sessions.issue(USER_ID, '5.6.7.8', 'laptop');

      await sessions.rotate(phone, '1.2.3.4', 'phone');
      await sessions.rotate(phone, '9.9.9.9', 'attacker');

      expect((await sessions.rotate(laptop, '5.6.7.8', 'laptop')).failure).toBeNull();
    });
  });

  describe('revocation', () => {
    it('ends a session on logout', async () => {
      const token = await sessions.issue(USER_ID, '1.2.3.4', 'agent');

      expect(await sessions.revoke(token)).toBe(true);
      expect((await sessions.rotate(token, '1.2.3.4', 'agent')).failure).toBe('revoked');
    });

    /**
     * Logout revokes the family, so a token already rotated out cannot be used to
     * continue the session afterwards.
     */
    it('ends the whole family on logout', async () => {
      const first = await sessions.issue(USER_ID, '1.2.3.4', 'agent');
      const second = (await sessions.rotate(first, '1.2.3.4', 'agent')).token as string;

      await sessions.revoke(second);

      expect(await liveCount()).toBe(0);
    });

    /**
     * Whoever knew the old password may still hold a refresh token, so changing
     * it has to be enough to lock them out everywhere.
     */
    it('ends every session for a user after a password change', async () => {
      await sessions.issue(USER_ID, '1.2.3.4', 'phone');
      await sessions.issue(USER_ID, '5.6.7.8', 'laptop');
      await sessions.issue(OTHER_USER, '1.1.1.1', 'other');

      await sessions.revokeAllForUser(USER_ID, RevokeReason.PASSWORD_CHANGED);

      expect(await liveCount(USER_ID)).toBe(0);
      // Another user's sessions are untouched.
      expect(await liveCount(OTHER_USER)).toBe(1);
    });
  });
});
