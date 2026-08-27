import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditService } from './audit.service';
import { AuditLog } from './entities/audit-log.entity';

/**
 * The audit trail.
 *
 * Its own module because more than one feature records to it — team management
 * from Phase 6, option authoring from Phase 7, and billing later. `AuditService`
 * was previously provided inside `AuthModule`, which made it reachable only by
 * importing all of authentication to record one row.
 *
 * `TypeOrmModule` is exported alongside the service so a consumer can construct
 * anything that injects the repository, the same reason `AuthModule` exports it
 * (ADR from Phase 6: exporting a provider without its dependency makes every
 * consumer fail at boot, in a message naming the consumer rather than the cause).
 */
@Module({
  // `AuthModule` for the guard chain on the read endpoint. It does not import
  // this module, so there is no cycle — the dependency runs one way, from the
  // trail's reader to authentication.
  imports: [TypeOrmModule.forFeature([AuditLog]), AuthModule],
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService],
  exports: [AuditService, AuditQueryService, TypeOrmModule],
})
export class AuditModule {}
