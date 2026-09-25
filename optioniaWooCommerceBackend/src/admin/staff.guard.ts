import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { getContext } from '../common/context/request-context';
import { StaffRole } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PlatformStaff } from './entities/platform-staff.entity';

export const REQUIRED_STAFF_ROLES = 'required_staff_roles';

/**
 * Declare which platform roles may reach a route.
 *
 * ⚠️ **Every staff route must declare something.** The guard fails closed on a
 * route that declares nothing, for the reason `CapabilityGuard` records: a
 * previous version of that guard returned true for an undeclared route, and a
 * probe found a `viewer` reaching a publish endpoint and getting 200.
 */
export const RequireStaffRole = (...roles: readonly StaffRole[]): MethodDecorator &
  ClassDecorator => SetMetadata(REQUIRED_STAFF_ROLES, roles);

/**
 * The platform realm, which is not the tenant realm (M22.1a).
 *
 * 🔴 **A tenant admin editing what they pay is not a feature, it is a
 * vulnerability.** This system has two separate realms — `TenantRole` for a
 * merchant's own people, and `platform_staff` for ParseLab's — and plan pricing
 * belongs exclusively to the second. Nothing about being an owner of a tenant
 * grants any of this.
 *
 * ## Why the row is read on every request
 *
 * ⚠️ **Staff status is not in the token.** A revoked staff member must lose
 * access on their next request, not when their access token happens to expire —
 * the same reasoning `TenantGuard` uses for reading the membership row rather
 * than trusting a claim. Revocation that takes fifteen minutes to apply is not
 * revocation.
 *
 * 📌 **`revokedAt IS NULL` is the check**, because the row is kept after
 * revocation: who had access and when is exactly what an audit asks later.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(PlatformStaff)
    private readonly staff: Repository<PlatformStaff>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly StaffRole[] | undefined>(
      REQUIRED_STAFF_ROLES,
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined || required.length === 0) {
      /*
       * 🔴 **Fails closed**, exactly as `CapabilityGuard` does. A staff route
       * that forgot to declare its roles is a staff route anyone authenticated
       * could reach, and the cost of that here is someone editing prices.
       */
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'This route is behind the staff guard but declares no required role.',
      );
    }

    const userId = getContext()?.userId;

    if (userId === undefined || userId === null) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const membership = await this.staff.findOne({
      where: { userId, revokedAt: IsNull() },
    });

    /*
     * ⚠️ **404-shaped silence, not a helpful 403.** Telling an ordinary user
     * "you are not platform staff" confirms the realm exists and is worth
     * attacking. `FORBIDDEN` with a flat message says no more than it must.
     */
    if (membership === null || !required.includes(membership.role)) {
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not permitted.');
    }

    return true;
  }
}
