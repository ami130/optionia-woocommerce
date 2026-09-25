import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { TenantRole } from '../common/database/enums';
import { TenantMember } from '../tenants/entities/tenant-member.entity';

/** Someone who should hear about this tenant's billing. */
export interface BillingContact {
  readonly email: string;
  readonly name: string;
  readonly role: TenantRole;
}

/**
 * Who to tell when a payment fails (M23.3, ADR-116).
 *
 * ## Why this exists at all
 *
 * 🔴 **`src/billing/` had no path from a tenant to a person.** ADR-116 promises
 * *"a dashboard banner and dunning mail"* and the mail was unbuildable: nothing
 * in billing could address an email. That is why this is a service rather than
 * two lines inside the lifecycle handler.
 *
 * ## Who receives it
 *
 * 📌 **The owner and every `billing`-role member.** A tenant that hired someone
 * for billing wants them to know, and the owner is ultimately liable for the
 * account — telling only one of them means either the person who can act does
 * not hear, or the person responsible does not.
 *
 * ⚠️ **Not `admin`.** The capability table is explicit that an admin holds no
 * billing capability at all; mailing them about a failed card would tell
 * somebody a thing the product will not let them fix.
 */
@Injectable()
export class BillingContactsService {
  constructor(
    @InjectRepository(TenantMember)
    private readonly members: Repository<TenantMember>,
  ) {}

  /**
   * 🔴 **Unverified addresses are excluded.** A tenant can invite anyone, and
   * mailing an address nobody has confirmed degrades deliverability for every
   * merchant who *is* reachable — the same reasoning `MailService` applies to a
   * suppressed address, applied one step earlier.
   *
   * 📌 **`revokedAt IS NULL`** — the column is `revokedAt`, not `removedAt`; I
   * guessed the latter and the entity said otherwise. A revoked member keeps
   * their row so an audit can answer who had access and when, which is exactly
   * why filtering matters here.
   *
   * ⚠️ **An empty list is a real answer**, not an error. A tenant whose only
   * member is unverified has nobody to tell, and the caller logs that rather
   * than failing a webhook over it.
   */
  async forTenant(tenantId: string): Promise<BillingContact[]> {
    const rows = await this.members.find({
      where: [
        { tenantId, role: TenantRole.OWNER, revokedAt: IsNull() },
        { tenantId, role: TenantRole.BILLING, revokedAt: IsNull() },
      ],
      relations: { user: true },
    });

    const contacts = rows
      .filter((member) => member.user?.emailVerifiedAt != null)
      .map((member) => ({
        email: member.user.email,
        name: member.user.name,
        role: member.role,
      }));

    /*
     * 📌 **De-duplicated by address, owner first.** One person can hold two
     * memberships, and two copies of "your payment failed" reads as a system
     * that has lost track of itself.
     */
    const seen = new Set<string>();

    return contacts
      .sort((a, b) => (a.role === TenantRole.OWNER ? -1 : b.role === TenantRole.OWNER ? 1 : 0))
      .filter((contact) => {
        const key = contact.email.toLowerCase();

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });
  }
}
