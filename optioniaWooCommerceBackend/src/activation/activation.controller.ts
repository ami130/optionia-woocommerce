import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { getContext } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { ActivationService, type TenantActivation } from './activation.service';
import { SetChecklistDismissedDto } from './dto/preferences.dto';
import { PreferencesService, type DashboardPreferences } from './preferences.service';

/**
 * Where this merchant stands in the activation funnel (M20b.1, M20b.2).
 *
 * ## Why this is tenant-realm and not a platform-wide funnel
 *
 * M20b.1 describes an aggregate — *"of merchants who signed up this month, what
 * fraction published?"* — which is a **staff** question spanning every tenant, and
 * `ActivationService.funnel()` answers it. It is deliberately **not exposed here.**
 *
 * There is no guard that could protect it today. `CapabilityGuard` resolves a role
 * from a `tenant_members` row and refuses any request without a `tenantId`, so it
 * cannot express "platform staff only"; `STAFF_CAPABILITIES` and the
 * `platform_staff` table are both defined and neither is read by any guard.
 * [Phase 26](#phase-26--super-admin) owns that realm — the plan's own tree says
 * `admin/ # Phase 26 — super admin, separate guard` — and **M26.6 already owns the
 * platform-wide "activation funnel"** by name.
 *
 * Exposing the aggregate on a tenant-guarded route would hand every merchant the
 * signup and revenue-adjacent counts of every other merchant. The service method
 * is built, tested and ready for M26.6 to mount; what ships now is the half that
 * has an honest guard.
 */
@Controller('activation')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class ActivationController {
  constructor(
    private readonly service: ActivationService,
    private readonly preferences: PreferencesService,
  ) {}

  /**
   * This tenant's own funnel position.
   *
   * The tenant comes from the request context, never from a path or query
   * parameter — there is no id for a caller to substitute, so cross-tenant reads
   * are not merely refused, they are unrepresentable (ADR-010).
   *
   * `ANALYTICS_VIEW` rather than a new capability: this is a read of the tenant's
   * own progress, which is what that capability already covers, and inventing a
   * capability per screen is how permission matrices become unauditable.
   */
  @Get('me')
  @RequireCapability(Capability.ANALYTICS_VIEW)
  @ApiErrors(200, 401, 403, 404, 429)
  async me(): Promise<TenantActivation> {
    const tenantId = getContext()?.tenantId;

    /**
     * Unreachable behind `TenantGuard`, and asserted rather than assumed: a
     * later change to the guard chain that dropped the tenant would otherwise
     * turn this into a query for `WHERE t.id = undefined`, which MySQL answers
     * with an empty set and the service reports as "tenant not found" — a
     * confusing 404 in place of a clear auth failure.
     */
    if (!tenantId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.forTenant(tenantId);
  }

  /**
   * This person's dashboard preferences (M20b.2).
   *
   * ⚠️ **Per user, not per tenant** (ADR-088). The setup checklist tracks a
   * person's own first run, so a colleague invited next month sees their own.
   * The user comes from the request context — there is no id to substitute.
   *
   * `ANALYTICS_VIEW` for the same reason `me` uses it: this is a read of the
   * caller's own dashboard state, and a capability per screen makes the
   * permission matrix unauditable.
   */
  @Get('preferences')
  @RequireCapability(Capability.ANALYTICS_VIEW)
  @ApiErrors(200, 401, 403, 429)
  async readPreferences(): Promise<DashboardPreferences> {
    return this.preferences.forUser(this.callerId());
  }

  /**
   * Dismiss the setup checklist, or show it again.
   *
   * 📌 **Not audit-logged, deliberately.** `AuditService` records that "reading
   * your own profile is not an event" and omits `refresh` and `me` for the same
   * reason. Hiding a checklist is a UI preference, not something a reader of the
   * trail is looking for — and logging it would put a row in the log every time
   * a merchant tidied their dashboard.
   */
  @Patch('preferences')
  @RequireCapability(Capability.ANALYTICS_VIEW)
  @ApiErrors(200, 400, 401, 403, 429)
  async updatePreferences(
    @Body() dto: SetChecklistDismissedDto,
  ): Promise<DashboardPreferences> {
    return this.preferences.setChecklistDismissed(this.callerId(), dto.dismissed);
  }

  /**
   * The signed-in user, asserted rather than assumed.
   *
   * Unreachable behind `JwtAuthGuard`, and checked for the same reason `me`
   * checks its tenant: a later change to the guard chain would otherwise turn
   * this into a query for `WHERE userId = undefined`, which MySQL answers with
   * an empty set and the service reports as "never dismissed".
   */
  private callerId(): string {
    const userId = getContext()?.userId;

    if (!userId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return userId;
  }
}
