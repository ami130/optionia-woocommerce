import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { ConfigVersionModule } from '../common/config-version.module';
import { AuthModule } from '../auth/auth.module';
import { OptionGroup } from './entities/option-group.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
import { CascadeService } from './cascade.service';
import { ParentSetService } from './parent-set';
import { PublishService } from './publishing/publish.service';
import { ConfigDocumentBuilder } from './serialization/config-document';
import { OptionSetTreeLoader } from './serialization/option-set-tree.loader';
import { OptionSetSerializer } from './serialization/option-set.serializer';
import { HardDeleteService } from './hard-delete.service';
import { OptionGroupsController } from './option-groups.controller';
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionGroupsService } from './option-groups.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { OptionSetAssignment } from './entities/option-set-assignment.entity';
import { ProductsModule } from '../products/products.module';
import { OptionSetsController } from './option-sets.controller';
import { OptionValuesController } from './option-values.controller';
import { OptionValuesRepository } from './option-values.repository';
import { OptionValuesService } from './option-values.service';
import { OptionsController } from './options.controller';
import { OptionsRepository } from './options.repository';
import { OptionsService } from './options.service';
import { PresentationalItem } from './entities/presentational-item.entity';
import { PresentationalItemsController } from './presentational-items.controller';
import { PresentationalItemsRepository } from './presentational-items.repository';
import { PresentationalItemsService } from './presentational-items.service';
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
    TypeOrmModule.forFeature([
      OptionSet,
      OptionGroup,
      Option,
      OptionValue,
      OptionSetAssignment,
      PresentationalItem,
    ]),
    AuthModule,
    AuditModule,
    ConfigVersionModule,
    // The catalogue's ownership check: an assignment may only target a product
    // in its own set's store (finding A3). Imported rather than re-querying
    // `store_products` here, so "what counts as scoped" has one answer.
    ProductsModule,
  ],
  controllers: [
    OptionSetsController,
    AssignmentsController,
    OptionGroupsController,
    OptionsController,
    OptionValuesController,
    PresentationalItemsController,
  ],
  // `OptionTypeValidator` is injected by `OptionsService` (option type JSON) and
  // `OptionValuesService` (value `priceConfig`), which is where M7.3's
  // acceptance — "malformed pricing config is rejected at the API boundary" —
  // is met. Option *sets* carry no type JSON, which is why nothing called it
  // until 7f.
  providers: [
    AssignmentsService,
    OptionSetsRepository,
    OptionSetsService,
    OptionGroupsRepository,
    OptionGroupsService,
    OptionsRepository,
    OptionsService,
    OptionValuesRepository,
    OptionValuesService,
    PresentationalItemsRepository,
    PresentationalItemsService,
    OptionTypeValidator,
    CascadeService,
    HardDeleteService,
    OptionSetSerializer,
    OptionSetTreeLoader,
    PublishService,
    ConfigDocumentBuilder,
    ParentSetService,
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
    CascadeService,
    HardDeleteService,
    OptionSetSerializer,
    OptionSetTreeLoader,
    PublishService,
    ConfigDocumentBuilder,
    ParentSetService,
  ],
})
export class OptionSetsModule {}
