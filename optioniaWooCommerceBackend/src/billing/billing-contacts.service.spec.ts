import { Repository } from 'typeorm';

import { TenantRole } from '../common/database/enums';
import { TenantMember } from '../tenants/entities/tenant-member.entity';
import { BillingContactsService } from './billing-contacts.service';

/**
 * Who hears that a payment failed (M23.3, ADR-116).
 *
 * 🔴 **`src/billing/` had no path from a tenant to a person**, which is why
 * ADR-116's promised dunning mail was unbuildable rather than merely unbuilt.
 */
describe('BillingContactsService', () => {
  function member(over: Partial<TenantMember> & { email?: string; verified?: boolean }) {
    const { email = 'owner@example.test', verified = true, ...rest } = over;

    return {
      tenantId: 'tenant_1',
      role: TenantRole.OWNER,
      revokedAt: null,
      user: {
        email,
        name: 'A Merchant',
        emailVerifiedAt: verified ? new Date() : null,
      },
      ...rest,
    } as unknown as TenantMember;
  }

  function build(rows: TenantMember[]) {
    const members = {
      find: jest.fn(async () => rows),
    } as unknown as Repository<TenantMember>;

    return { service: new BillingContactsService(members), members };
  }

  /**
   * 📌 **Owner AND billing.** A tenant that hired someone for billing wants
   * them to know; the owner is ultimately liable. Telling only one means either
   * the person who can act does not hear, or the person responsible does not.
   */
  it('returns the owner and every billing-role member', async () => {
    const { service } = build([
      member({ email: 'owner@example.test' }),
      member({ role: TenantRole.BILLING, email: 'finance@example.test' }),
    ]);

    await expect(service.forTenant('tenant_1')).resolves.toEqual([
      { email: 'owner@example.test', name: 'A Merchant', role: TenantRole.OWNER },
      { email: 'finance@example.test', name: 'A Merchant', role: TenantRole.BILLING },
    ]);
  });

  /**
   * ⚠️ **Not `admin`.** The capability table is explicit that an admin holds no
   * billing capability — mailing them about a failed card would tell somebody
   * about a thing the product will not let them fix.
   */
  it('asks only for owner and billing roles', async () => {
    const { service, members } = build([]);

    await service.forTenant('tenant_1');

    const [call] = (members.find as jest.Mock).mock.calls as [
      [{ where: Array<{ role: string }> }],
    ];

    expect(call[0].where.map((clause) => clause.role).sort()).toEqual(['billing', 'owner']);
  });

  /**
   * 🔴 **An unverified address is not mailed.** A tenant can invite anyone, and
   * mailing an unconfirmed address degrades deliverability for every merchant
   * who *is* reachable.
   */
  it('excludes a member whose email was never verified', async () => {
    const { service } = build([
      member({ email: 'unverified@example.test', verified: false }),
    ]);

    await expect(service.forTenant('tenant_1')).resolves.toEqual([]);
  });

  /** ⚠️ Revoked members keep their row for the audit; they are not contacts. */
  it('asks the database to exclude revoked memberships', async () => {
    const { service, members } = build([]);

    await service.forTenant('tenant_1');

    const [call] = (members.find as jest.Mock).mock.calls as [
      [{ where: Array<{ revokedAt: unknown }> }],
    ];

    expect(call[0].where.every((clause) => clause.revokedAt !== undefined)).toBe(true);
  });

  /**
   * 📌 **One person, one email.** A member can hold two memberships, and two
   * copies of "your payment failed" reads as a system that has lost track of
   * itself.
   */
  it('de-duplicates one person holding two roles, owner first', async () => {
    const { service } = build([
      member({ role: TenantRole.BILLING, email: 'Same@example.test' }),
      member({ role: TenantRole.OWNER, email: 'same@example.test' }),
    ]);

    const contacts = await service.forTenant('tenant_1');

    expect(contacts).toHaveLength(1);
    expect(contacts[0].role).toBe(TenantRole.OWNER);
  });

  /**
   * ⚠️ **An empty list is a real answer, not an error.** A tenant whose only
   * member is unverified has nobody to tell, and a webhook must not fail over
   * it — the provider would retry an event that can never succeed.
   */
  it('returns an empty list rather than throwing', async () => {
    const { service } = build([]);

    await expect(service.forTenant('tenant_1')).resolves.toEqual([]);
  });
});
