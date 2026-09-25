import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { RequireStaffRole, StaffGuard } from '../admin/staff.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffRole } from '../common/database/enums';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { TaxReportQueryDto } from './dto/tax-report.dto';
import { TaxReportService, type TaxReport } from './tax-report.service';

/**
 * The compliance question ADR-115 commits ParseLab to answering (M22.E6).
 *
 * 🔴 **Platform staff, and deliberately NOT tenant-scoped.** This is *our* tax
 * position across every merchant — the opposite of `GET /billing/invoices`,
 * which is one merchant's own history. A route that answered this for a tenant
 * would be answering a different question with the same numbers.
 *
 * ⚠️ **`READ_ONLY` may read it.** An accountant preparing a return needs the
 * figures and must never be able to change a price; that is exactly the role's
 * purpose.
 */
@Controller('admin/billing')
@ApiBearerAuth('staff')
@UseGuards(JwtAuthGuard, StaffGuard)
export class TaxReportController {
  constructor(private readonly report: TaxReportService) {}

  /**
   * Tax collected, by country and currency, over a period.
   *
   * 📌 **The period is required, not defaulted.** A tax return is filed for a
   * stated period, and a report that quietly chose one would be a figure
   * someone might file without noticing which quarter it covered.
   */
  @Get('tax-report')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS, StaffRole.READ_ONLY)
  @ApiErrors(200, 400, 401, 403, 429)
  async taxReport(@Query() query: TaxReportQueryDto): Promise<TaxReport> {
    return this.report.collected({
      from: new Date(query.from),
      to: new Date(query.to),
    });
  }
}
