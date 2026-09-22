import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { EmailDelivery } from './entities/email-delivery.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { MailModule } from './mail.module';
import { MailService } from './mail.service';

/**
 * Transport selection.
 *
 * The choice is made in this factory and nowhere else, which makes "no SMTP host
 * means nothing is sent" a property of this file alone. It had no test, so a
 * factory that always returned SMTP would have passed every other suite while
 * mailing real people from a developer's machine.
 */
describe('MailModule', () => {
  const saved = { ...process.env };

  /**
   * `loadConfig` validates the entire environment, not just the mail keys, so a
   * partial one fails on JWT_SECRET before reaching the transport decision.
   */
  const VALID_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    DB_SSL: 'false',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
  };

  async function buildWith(env: Record<string, string | undefined>): Promise<MailService> {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, VALID_ENV);

    Object.entries(env).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });

    const moduleRef = await Test.createTestingModule({ imports: [MailModule] })
      .overrideProvider(getRepositoryToken(EmailDelivery))
      .useValue({ create: (r: unknown) => r, save: (r: unknown) => Promise.resolve(r) })
      .overrideProvider(getRepositoryToken(EmailSuppression))
      .useValue({ findOne: () => Promise.resolve(null) })
      .compile();

    return moduleRef.get(MailService);
  }

  /** Reading the private field is deliberate: the transport is not otherwise
   * observable, and the alternative is asserting on a log line, which is a
   * weaker signal than the object itself. */
  function transportName(service: MailService): string {
    return (service as unknown as { transport: { name: string } }).transport.name;
  }

  afterEach(() => {
    process.env = { ...saved };
  });

  /**
   * The default for a fresh checkout and the entire test suite. Getting this
   * wrong means the first person to run `npm test` mails a stranger.
   */
  it('selects the log transport when no SMTP host is configured', async () => {
    const service = await buildWith({ SMTP_HOST: undefined });

    expect(transportName(service)).toBe('log');
  });

  it('selects SMTP when a host is configured', async () => {
    const service = await buildWith({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'sender@example.com',
      SMTP_PASS: 'app-password',
    });

    expect(transportName(service)).toBe('smtp');
  });

  it('provides a MailService that the rest of the app can inject', async () => {
    const service = await buildWith({ SMTP_HOST: undefined });

    expect(service).toBeInstanceOf(MailService);
  });
});
