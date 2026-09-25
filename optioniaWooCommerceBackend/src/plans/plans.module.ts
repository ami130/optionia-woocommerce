import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformStaff } from '../admin/entities/platform-staff.entity';
import { StaffGuard } from '../admin/staff.guard';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { Plan } from './entities/plan.entity';
import { PlanPrice } from './entities/plan-price.entity';
import { TaxReportController } from '../billing/tax-report.controller';
import { TaxReportService } from '../billing/tax-report.service';
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
  /*
   * 📌 **The tax report lives here, not in `CheckoutModule`.** Both are billing,
   * but this module is the *staff* realm — `StaffGuard` and the platform roles —
   * and the report is ParseLab's own tax position, not a merchant's history.
   * Grouping by realm rather than by subject keeps the guard chain obvious.
   */
  controllers: [PlansAdminController, TaxReportController],
  providers: [PlansAdminService, TaxReportService, StaffGuard],
  exports: [PlansAdminService, TaxReportService],
})
export class PlansModule {}
