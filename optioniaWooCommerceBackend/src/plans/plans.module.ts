import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformStaff } from '../admin/entities/platform-staff.entity';
import { StaffGuard } from '../admin/staff.guard';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { Plan } from './entities/plan.entity';
import { PlanPrice } from './entities/plan-price.entity';
import { PlansAdminController } from './plans-admin.controller';
import { PlansAdminService } from './plans-admin.service';

/**
 * Plan administration for platform staff (M22.1a).
 *
 * 📌 **`src/plans/` held entities only until now** — the table was editable in
 * principle and by nothing in practice, which made the owner's decision that
 * *"pricing will be fully dynamic … everything can customise by admin"* true of
 * the schema and false of the product.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Plan, PlanPrice, PlatformStaff]),
    AuthModule,
    AuditModule,
  ],
  controllers: [PlansAdminController],
  providers: [PlansAdminService, StaffGuard],
  exports: [PlansAdminService],
})
export class PlansModule {}
