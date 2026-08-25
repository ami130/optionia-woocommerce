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
  // `OptionTypeValidator` is registered here but has no caller yet, and that is
  // correct at 7e: option *sets* carry no type JSON — `validation`, `pricing`
  // and `display` live on options, which 7f adds. It is provided now so 7f
  // injects it rather than re-deciding where validation belongs.
  //
  // ⚠️ M7.3's acceptance — "malformed pricing config is rejected at the API
  // boundary" — is therefore NOT yet demonstrated end-to-end. 7f owes that test.
  providers: [OptionSetsRepository, OptionSetsService, OptionTypeValidator],
  exports: [OptionSetsRepository, OptionSetsService, OptionTypeValidator],
})
export class OptionSetsModule {}
