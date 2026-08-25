import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OptionGroup } from './entities/option-group.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
import { OptionSetsController } from './option-sets.controller';
import { OptionSetsRepository } from './option-sets.repository';
import { OptionSetsService } from './option-sets.service';
import { OptionTypeValidator } from './types/option-type.validator';

/**
 * Option authoring.
 *
 * `AuthModule` is imported for the guard chain, and exports `TypeOrmModule` so
 * `TenantGuard` can be constructed here — a lesson from Phase 6, where exporting
 * the guard without its repository made every consumer fail at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OptionSet, OptionGroup, Option, OptionValue]),
    AuthModule,
    AuditModule,
  ],
  controllers: [OptionSetsController],
  providers: [OptionSetsRepository, OptionSetsService, OptionTypeValidator],
  exports: [OptionSetsRepository, OptionSetsService, OptionTypeValidator],
})
export class OptionSetsModule {}
