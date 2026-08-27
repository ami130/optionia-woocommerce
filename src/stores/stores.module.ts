import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { loadConfig } from '../config/env';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { StoreConnectionCode } from './entities/store-connection-code.entity';
import { StoreCredential } from './entities/store-credential.entity';
import { Store } from './entities/store.entity';

/**
 * Store connection (M8.1, M8.2).
 *
 * `forFeature` registers the three store entities — ADR-039 recorded this as an
 * explicit `[8d]` requirement, because migrations discover entities by glob and
 * so **no gate catches the omission**: everything passes and the first symptom is
 * a resolution failure at runtime.
 *
 * `AuthModule` is imported for the guard chain and re-exports `TypeOrmModule`, so
 * `TenantGuard` can be constructed here — the Phase 6 lesson about exporting a
 * guard without the repository it injects.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Store, StoreCredential, StoreConnectionCode]),
    AuthModule,
    AuditModule,
  ],
  controllers: [ConnectController],
  providers: [
    {
      provide: ConnectService,
      inject: [DataSource, AuditService],
      useFactory: (dataSource: DataSource, audit: AuditService): ConnectService =>
        // The dashboard URL is read once, here, so no flow builds a link from a
        // value it guessed — `authorize_url` must point at the dashboard, never
        // at the API.
        new ConnectService(dataSource, audit, loadConfig().appUrl),
    },
  ],
  exports: [ConnectService],
})
export class StoresModule {}
