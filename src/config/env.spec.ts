import { ConfigurationError, loadConfig } from './env';

/**
 * Configuration validation is a security control, not a convenience.
 *
 * A sibling project shipped a real production password as a fallback default in
 * committed source, so any process with incomplete configuration silently
 * connected to production. These tests exist to make that class of failure
 * impossible here.
 */
describe('loadConfig', () => {
  const validEnv: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
  };

  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    // Start from a bare environment so a stray shell variable cannot make a
    // failing case pass.
    for (const key of Object.keys(process.env)) delete process.env[key];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  function withEnv(overrides: Record<string, string | undefined>): void {
    Object.assign(process.env, validEnv);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  it('loads a valid configuration', () => {
    withEnv({});

    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.database.name).toBe('optionia_woo_test');
    expect(config.security.corsOrigins).toEqual(['http://localhost:3000']);
    expect(config.isProduction).toBe(false);
  });

  describe('required variables', () => {
    it.each(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'])(
      'throws when %s is missing',
      (key) => {
        withEnv({ [key]: undefined });

        expect(() => loadConfig()).toThrow(ConfigurationError);
        expect(() => loadConfig()).toThrow(new RegExp(key));
      },
    );

    it('treats whitespace as missing', () => {
      withEnv({ DB_PASSWORD: '   ' });

      expect(() => loadConfig()).toThrow(/DB_PASSWORD/);
    });
  });

  describe('JWT secret', () => {
    it('rejects a secret shorter than 32 characters', () => {
      withEnv({ JWT_SECRET: 'tooshort' });

      expect(() => loadConfig()).toThrow(/at least 32 characters/);
    });

    it('rejects the placeholder in production', () => {
      withEnv({
        NODE_ENV: 'production',
        DB_SSL: 'true',
        JWT_SECRET: `changeme-${'x'.repeat(40)}`,
      });

      expect(() => loadConfig()).toThrow(/placeholder/);
    });
  });

  describe('CORS', () => {
    it('rejects a wildcard origin', () => {
      withEnv({ CORS_ORIGINS: '*' });

      expect(() => loadConfig()).toThrow(/must not be "\*"/);
    });

    it('rejects a wildcard hidden in a list', () => {
      withEnv({ CORS_ORIGINS: 'http://localhost:3000,*' });

      expect(() => loadConfig()).toThrow(/must not be "\*"/);
    });

    it('parses and trims a list', () => {
      withEnv({ CORS_ORIGINS: 'http://a.test , http://b.test' });

      expect(loadConfig().security.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    });
  });

  describe('production guards', () => {
    it('requires TLS to the database', () => {
      withEnv({ NODE_ENV: 'production', DB_SSL: 'false' });

      expect(() => loadConfig()).toThrow(/DB_SSL must be true in production/);
    });

    /**
     * Production also requires SMTP now, so this case must supply it. Without
     * that it would fail for the mail guard rather than proving anything about
     * TLS — the assertion it exists to make.
     */
    it('accepts production with TLS enabled', () => {
      withEnv({
        NODE_ENV: 'production',
        DB_SSL: 'true',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
      });

      const config = loadConfig();

      expect(config.isProduction).toBe(true);
      expect(config.database.ssl).toBe(true);
    });
  });

  describe('mail', () => {
    /**
     * Absence is meaningful. A developer running the suite with no credentials
     * must get a transport that sends nothing, or the first person to run
     * `npm test` mails a stranger.
     */
    it('falls back to the log transport when SMTP is not configured', () => {
      withEnv({});

      const config = loadConfig();

      expect(config.mail.transport).toBe('log');
      expect(config.mail.smtp).toBeNull();
    });

    it('uses SMTP when a host is configured', () => {
      withEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
      });

      const config = loadConfig();

      expect(config.mail.transport).toBe('smtp');
      expect(config.mail.smtp?.host).toBe('smtp.example.com');
      expect(config.mail.smtp?.port).toBe(587);
    });

    /**
     * A host with no credentials is a misconfiguration, not a reason to fall
     * back — falling back would send nothing while appearing configured.
     */
    it('rejects a host without credentials rather than falling back', () => {
      withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: undefined });

      expect(() => loadConfig()).toThrow(/SMTP_USER/);
    });

    /**
     * 465 is implicit TLS, 587 upgrades via STARTTLS. Getting this wrong fails
     * at connection time with an error that does not mention TLS.
     */
    it('infers TLS from the port, and lets it be overridden', () => {
      withEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
      });
      expect(loadConfig().mail.smtp?.secure).toBe(true);

      withEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
      });
      expect(loadConfig().mail.smtp?.secure).toBe(false);

      withEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
        SMTP_SECURE: 'true',
      });
      expect(loadConfig().mail.smtp?.secure).toBe(true);
    });

    /**
     * The security control. In production a discarded verification email is
     * indistinguishable from a working system until a merchant reports never
     * receiving one — so it is a boot failure, not a fallback.
     */
    it('refuses to boot in production without SMTP', () => {
      withEnv({ NODE_ENV: 'production', DB_SSL: 'true', SMTP_HOST: undefined });

      expect(() => loadConfig()).toThrow(/SMTP_HOST is required/);
    });

    it('explains why, rather than only stating the rule', () => {
      withEnv({ NODE_ENV: 'production', DB_SSL: 'true', SMTP_HOST: undefined });

      expect(() => loadConfig()).toThrow(/silently discarded/);
    });

    it('boots in production when SMTP is configured', () => {
      withEnv({
        NODE_ENV: 'production',
        DB_SSL: 'true',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'sender@example.com',
        SMTP_PASS: 'app-password',
      });

      expect(loadConfig().mail.transport).toBe('smtp');
    });

    it('defaults the From address and allows an override', () => {
      withEnv({});
      expect(loadConfig().mail.from).toContain('@');

      withEnv({ MAIL_FROM: 'Support <help@example.com>' });
      expect(loadConfig().mail.from).toBe('Support <help@example.com>');
    });
  });

  describe('type validation', () => {
    it('rejects an unknown NODE_ENV', () => {
      withEnv({ NODE_ENV: 'prod' });

      expect(() => loadConfig()).toThrow(/NODE_ENV must be one of/);
    });

    it('rejects an out-of-range port', () => {
      withEnv({ PORT: '99999' });

      expect(() => loadConfig()).toThrow(/PORT must be an integer/);
    });

    it('rejects a non-numeric port', () => {
      withEnv({ PORT: 'four thousand' });

      expect(() => loadConfig()).toThrow(/PORT must be an integer/);
    });

    it('rejects an ambiguous boolean', () => {
      withEnv({ DB_SSL: 'maybe' });

      expect(() => loadConfig()).toThrow(/must be a boolean/);
    });

    it.each([
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ])('accepts DB_SSL=%s', (input, expected) => {
      withEnv({ DB_SSL: input });

      expect(loadConfig().database.ssl).toBe(expected);
    });
  });
});
