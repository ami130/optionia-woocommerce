import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OptionGroup } from './entities/option-group.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
import { OptionGroupsController } from './option-groups.controller';
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionGroupsService } from './option-groups.service';
import { OptionSetsController } from './option-sets.controller';
import { OptionValuesController } from './option-values.controller';
import { OptionValuesRepository } from './option-values.repository';
import { OptionValuesService } from './option-values.service';
import { OptionsController } from './options.controller';
import { OptionsRepository } from './options.repository';
import { OptionsService } from './options.service';
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
  controllers: [
    OptionSetsController,
    OptionGroupsController,
    OptionsController,
    OptionValuesController,
  ],
  // `OptionTypeValidator` is injected by `OptionsService` (option type JSON) and
  // `OptionValuesService` (value `priceConfig`), which is where M7.3's
  // acceptance — "malformed pricing config is rejected at the API boundary" —
  // is met. Option *sets* carry no type JSON, which is why nothing called it
  // until 7f.
  providers: [
    OptionSetsRepository,
    OptionSetsService,
    OptionGroupsRepository,
    OptionGroupsService,
    OptionsRepository,
    OptionsService,
    OptionValuesRepository,
    OptionValuesService,
    OptionTypeValidator,
  ],
  exports: [
    OptionSetsRepository,
    OptionSetsService,
    OptionGroupsRepository,
    OptionGroupsService,
    OptionsRepository,
    OptionsService,
    OptionValuesRepository,
    OptionValuesService,
    OptionTypeValidator,
  ],
})
export class OptionSetsModule {}
