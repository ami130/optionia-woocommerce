import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One person's dashboard preferences (M20b.2, ADR-088).
 *
 * ## Why per-user rather than per-tenant
 *
 * The setup checklist tracks a **person's** progress through their own first
 * run. A colleague invited next month has not done that run and must see their
 * own checklist — a tenant-level flag would hide it from someone who has never
 * seen it.
 *
 * Measured when this was decided: 36 tenants, **0 multi-member**. But
 * `tenant_invitations` and the `members:invite` capability both exist, so
 * multi-member is a designed capability rather than a hypothetical, and keying
 * this on the tenant would be a bug waiting for the first invitation.
 *
 * ## Why a table rather than `localStorage`
 *
 * A dismissal in the browser does not follow the merchant to their laptop, and
 * the same surface is needed by [M20b.6](../../../developePlan.md)'s unsubscribe
 * preference and by later settings — so it is built once rather than three
 * times. `localStorage` remains right for per-view conveniences; this is not
 * one.
 *
 * ## Why not `tenantId`
 *
 * ⚠️ **Deliberately absent, and this is the one table where that is correct.** A
 * preference belongs to the person, not to the workspace they are looking at:
 * someone who belongs to two tenants dismisses the checklist once. The route
 * that reads this resolves the user from the request context and never takes an
 * id, so there is nothing to scope by tenant and nothing for a caller to
 * substitute.
 */
@Entity('user_preferences')
@Index('uq_user_preferences_user', ['userId'], { unique: true })
export class UserPreference extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  userId: string;

  /**
   * `CASCADE`: a preference has no meaning without the person who holds it.
   *
   * Unlike a store or an option set, nothing is lost by deleting it with the
   * user — it is a UI convenience, not a record of anything they did.
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * When this person dismissed the setup checklist, or null if they have not.
   *
   * 📌 **A timestamp rather than a boolean.** "Dismissed" and "dismissed on the
   * 3rd" cost the same to store, and the second answers questions the first
   * cannot — whether people dismiss before or after activating, and whether a
   * nudge ([M20b.6](../../../developePlan.md)) should treat a months-old
   * dismissal differently from this morning's.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  checklistDismissedAt: Date | null;
}
