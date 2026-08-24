import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { Store } from './store.entity';

/**
 * A store's API credential.
 *
 * Rotation creates a new row rather than updating this one, so a compromised
 * credential's usage history survives its revocation — which is what makes
 * "when was this last used, and from where" answerable after an incident.
 */
@Entity('store_credentials')
@Index('ix_store_credentials_hash', ['tokenHash'])
export class StoreCredential extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  /**
   * SHA-256 of the token. The plaintext is shown once and never stored.
   *
   * The plugin holds the only copy. If a merchant loses it, the credential is
   * rotated rather than recovered — which is the correct behaviour and worth
   * the support cost.
   */
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  /**
   * First 8 characters of the plaintext.
   *
   * For support identification only — enough to confirm "the credential ending
   * in X" without being enough to authenticate.
   */
  @Column({ type: 'char', length: 8 })
  tokenPrefix: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  scopes: string;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  expiresAt: Date | null;
}
