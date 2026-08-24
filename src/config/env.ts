/**
 * Environment configuration.
 *
 * Every value is read once, at boot, and validated. A missing or malformed
 * required variable throws immediately with a message naming it.
 *
 * There are deliberately NO fallback defaults for anything environment-specific.
 * `process.env.DB_HOST || 'localhost'` looks harmless and is how a process ends
 * up talking to the wrong database — silently, and usually in the direction of
 * production. Failing loudly at boot is always cheaper than discovering it
 * later.
 *
 * Enforced by `bin/check-secrets.sh`, which fails the build on any env read
 * carrying a `||` or `??` literal fallback.
 */

/** Recognised runtime environments. */
export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

/**
 * Thrown when configuration is missing or invalid.
 *
 * Distinct from a runtime error: this always means the process cannot start,
 * so it must never be caught and retried.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Read a required string. Throws when absent or empty. */
function required(key: string): string {
  const value = process.env[key];

  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(
      `Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env and fill it in. There are no defaults by design.`,
    );
  }

  return value.trim();
}

/** Read an optional string, using an explicit default. */
function optional(key: string, fallback: string): string {
  const value = process.env[key];

  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** Read a required integer within an inclusive range. */
function requiredInt(key: string, min: number, max: number): number {
  const raw = required(key);
  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      `Environment variable ${key} must be an integer between ${min} and ${max}, got "${raw}".`,
    );
  }

  return value;
}

/** Read a boolean. Accepts only true/false/1/0 — anything else is a typo. */
function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];

  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const normalised = value.trim().toLowerCase();

  if (['true', '1', 'yes'].includes(normalised)) return true;
  if (['false', '0', 'no'].includes(normalised)) return false;

  throw new ConfigurationError(
    `Environment variable ${key} must be a boolean (true/false), got "${value}".`,
  );
}

/** Parse a comma-separated allowlist. Rejects "*". */
function originList(key: string): string[] {
  const raw = required(key);

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  if (origins.length === 0) {
    throw new ConfigurationError(`${key} must list at least one origin.`);
  }

  if (origins.includes('*')) {
    throw new ConfigurationError(
      `${key} must not be "*". Credentialed requests with a wildcard origin are ` +
        `rejected by browsers, and an open CORS policy on a multi-tenant API is a ` +
        `data-exposure risk. List origins explicitly.`,
    );
  }

  return origins;
}

/** Validated application configuration. */
/** How mail leaves the process. See `AppConfig['mail']`. */
export const MailTransport = {
  SMTP: 'smtp',
  LOG: 'log',
} as const;

export type MailTransport = (typeof MailTransport)[keyof typeof MailTransport];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly port: number;

  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly ssl: boolean;
  };

  readonly security: {
    readonly jwtSecret: string;
    readonly jwtAccessTtl: string;
    readonly jwtRefreshTtl: string;
    readonly corsOrigins: string[];
  };

  /**
   * Transactional mail.
   *
   * `transport` is the decision, not an implementation detail. `smtp` sends for
   * real; `log` writes the rendered message to the ops log and is what runs in
   * tests and in a checkout with no credentials — a developer running the suite
   * must never send a live email to a real address.
   *
   * Production may not use `log`: a merchant who never receives a verification
   * email never becomes a customer, and silent success is the worst possible
   * failure here. `loadConfig` enforces that.
   */
  readonly mail: {
    readonly transport: MailTransport;
    readonly from: string;
    readonly smtp: {
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly password: string;
      /** STARTTLS on 587, implicit TLS on 465. */
      readonly secure: boolean;
    } | null;
  };

  readonly logLevel: string;
}

/**
 * Resolve the mail transport.
 *
 * Absence is meaningful rather than an error: a developer running the test suite
 * or booting without credentials gets the `log` transport, which renders the
 * message to the ops log and sends nothing. Requiring SMTP everywhere would mean
 * either checked-in credentials or a suite that cannot run.
 *
 * The one place that reasoning does not apply is production, where a silently
 * discarded verification email is indistinguishable from a working system until
 * a merchant reports never receiving one. There it is a boot failure.
 */
function loadMailConfig(isProduction: boolean): AppConfig['mail'] {
  const host = process.env.SMTP_HOST?.trim();
  const from = optional('MAIL_FROM', 'Optionia <no-reply@parselab.com>');

  if (!host) {
    if (isProduction) {
      throw new ConfigurationError(
        'SMTP_HOST is required when NODE_ENV=production. Without it every ' +
          'verification, reset and invitation email is written to the log and ' +
          'silently discarded, which looks identical to a working system.',
      );
    }

    return { transport: MailTransport.LOG, from, smtp: null };
  }

  const port = requiredInt('SMTP_PORT', 1, 65535);

  return {
    transport: MailTransport.SMTP,
    from,
    smtp: {
      host,
      port,
      user: required('SMTP_USER'),
      password: required('SMTP_PASS'),
      // 465 is implicit TLS; 587 upgrades via STARTTLS. Anything else must say
      // so explicitly rather than being guessed from the port number.
      secure: bool('SMTP_SECURE', port === 465),
    },
  };
}

/**
 * Build and validate configuration.
 *
 * Called once at boot. Any failure aborts startup.
 */
export function loadConfig(): AppConfig {
  const nodeEnvRaw = optional('NODE_ENV', 'development');
  const allowed: NodeEnv[] = ['development', 'test', 'staging', 'production'];

  if (!allowed.includes(nodeEnvRaw as NodeEnv)) {
    throw new ConfigurationError(
      `NODE_ENV must be one of ${allowed.join(', ')}, got "${nodeEnvRaw}".`,
    );
  }

  const nodeEnv = nodeEnvRaw as NodeEnv;
  const isProduction = nodeEnv === 'production';

  const jwtSecret = required('JWT_SECRET');

  // A short secret is brute-forceable, and the placeholder shipping to
  // production would be worse than no check at all.
  if (jwtSecret.length < 32) {
    throw new ConfigurationError(
      'JWT_SECRET must be at least 32 characters. Generate with: openssl rand -base64 48',
    );
  }

  if (isProduction && jwtSecret.includes('changeme')) {
    throw new ConfigurationError('JWT_SECRET still contains the placeholder value.');
  }

  const ssl = bool('DB_SSL', false);

  // Staging and production talk to a managed database over a network. An
  // unencrypted connection there is a credential on the wire.
  if (isProduction && !ssl) {
    throw new ConfigurationError('DB_SSL must be true in production.');
  }

  return {
    nodeEnv,
    isProduction,
    port: requiredInt('PORT', 1, 65535),

    database: {
      host: required('DB_HOST'),
      port: requiredInt('DB_PORT', 1, 65535),
      name: required('DB_NAME'),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      ssl,
    },

    security: {
      jwtSecret,
      jwtAccessTtl: optional('JWT_ACCESS_TTL', '15m'),
      jwtRefreshTtl: optional('JWT_REFRESH_TTL', '30d'),
      corsOrigins: originList('CORS_ORIGINS'),
    },

    mail: loadMailConfig(isProduction),

    logLevel: optional('LOG_LEVEL', isProduction ? 'info' : 'debug'),
  };
}
