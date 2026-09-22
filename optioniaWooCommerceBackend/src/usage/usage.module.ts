import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsageRecord } from './entities/usage-record.entity';
import { UsageService } from './usage.service';

/**
 * Metered usage against plan limits (M15.6).
 *
 * ⚠️ **`forFeature` registers the entity even though nothing injects a
 * repository for it.** ADR-039 records why that matters: migrations discover
 * entities by glob, and **no gate catches the omission** — everything passes and
 * the first symptom is a schema that silently disagrees with the code.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord])],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
