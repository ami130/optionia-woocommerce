import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';

import * as requestContext from '../common/context/request-context';
import { StaffRole } from '../common/database/enums';
import { PlatformStaff } from './entities/platform-staff.entity';
import { StaffGuard } from './staff.guard';

/**
 * The platform realm's boundary (M22.1a).
 *
 * 🔴 **The fail-closed branch is unreachable from the e2e suite**, because every
 * route declares its roles — so a mutation removing that branch survived there.
 * It is defence for the route somebody adds next, and only a unit test can
 * exercise it.
 */
describe('StaffGuard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function build(seed: { roles?: readonly StaffRole[]; membership?: PlatformStaff | null }) {
    const reflector = {
      getAllAndOverride: () => seed.roles,
    } as unknown as Reflector;

    const staff = {
      findOne: jest.fn(async () => seed.membership ?? null),
    } as unknown as Repository<PlatformStaff>;

    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;

    return { guard: new StaffGuard(reflector, staff), context, staff };
  }

  const member = { userId: 'user_1', role: StaffRole.BILLING_OPS } as PlatformStaff;

  /**
   * 🔴 **A staff route that forgot to declare its roles must be refused.**
   * `CapabilityGuard` records what the alternative costs: it returned true for
   * an undeclared route, justified by a comment claiming a test enforced
   * declaration, and a probe found a `viewer` publishing with a 200.
   */
  it('refuses a route that declares no roles', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context, staff } = build({ roles: undefined });

    await expect(guard.canActivate(context)).rejects.toThrow('declares no required role');

    /* ⚠️ And it refuses before looking anyone up — the route is the fault. */
    expect(staff.findOne).not.toHaveBeenCalled();
  });

  it('refuses a route that declares an empty role list', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context } = build({ roles: [] });

    await expect(guard.canActivate(context)).rejects.toThrow('declares no required role');
  });

  it('refuses when there is no authenticated user', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue(undefined as never);
    const { guard, context } = build({ roles: [StaffRole.BILLING_OPS] });

    await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
  });

  it('refuses a user with no staff row', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context } = build({ roles: [StaffRole.BILLING_OPS], membership: null });

    await expect(guard.canActivate(context)).rejects.toThrow('Not permitted');
  });

  it('refuses a staff member whose role is not listed', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context } = build({
      roles: [StaffRole.SUPER_ADMIN],
      membership: member,
    });

    await expect(guard.canActivate(context)).rejects.toThrow('Not permitted');
  });

  it('admits a staff member whose role is listed', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context } = build({
      roles: [StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS],
      membership: member,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  /**
   * ⚠️ **Revocation must apply on the next request, not when a token expires.**
   * The row is read every time for this reason — revocation that takes fifteen
   * minutes is not revocation.
   */
  it('looks the membership up excluding revoked rows', async () => {
    jest.spyOn(requestContext, 'getContext').mockReturnValue({ userId: 'user_1' } as never);
    const { guard, context, staff } = build({
      roles: [StaffRole.BILLING_OPS],
      membership: member,
    });

    await guard.canActivate(context);

    const [call] = (staff.findOne as jest.Mock).mock.calls as [
      [{ where: { userId: string; revokedAt: unknown } }],
    ];

    expect(call[0].where.userId).toBe('user_1');
    expect(call[0].where.revokedAt).toBeDefined();
  });
});
