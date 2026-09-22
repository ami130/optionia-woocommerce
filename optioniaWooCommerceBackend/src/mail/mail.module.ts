import { Module } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { loadConfig, MailTransport } from '../config/env';
import { EmailDelivery } from './entities/email-delivery.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { MailService } from './mail.service';
import type { MailTransportDriver } from './mailer';
import { LogTransport } from './transports/log.transport';
import { SmtpTransport } from './transports/smtp.transport';

/**
 * Wires the transport chosen by configuration.
 *
 * The choice happens exactly once, here. No flow asks which transport is active,
 * and no transport is imported outside this file — which is what makes replacing
 * SMTP with a provider (D4) a change to this module alone.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailDelivery, EmailSuppression])],
  providers: [
    {
      provide: MailService,
      inject: [
        getRepositoryToken(EmailDelivery),
        getRepositoryToken(EmailSuppression),
      ],
      useFactory: (
        deliveries: Repository<EmailDelivery>,
        suppressions: Repository<EmailSuppression>,
      ): MailService => {
        const config = loadConfig();

        const transport: MailTransportDriver =
          config.mail.transport === MailTransport.SMTP
            ? new SmtpTransport(config)
            : new LogTransport();

        return new MailService(transport, config.mail.from, deliveries, suppressions);
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
