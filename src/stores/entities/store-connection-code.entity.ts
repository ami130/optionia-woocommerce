import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { Store } from './store.entity';

/**
 * One connection handshake, from `initiate` to `exchange` (M8.1).
 *
 * ## Why one row rather than two tables
 *
 * The flow is strictly linear — a request is created, approved once, redeemed
 * once — and the two artefacts it produces have different lifetimes rather than
 * different identities. Two tables would need a foreign key between rows that
 * both expire, which is a reference to something that may already be gone.
 *
 * The row carries **two clocks**: `requestExpiresAt` (30 minutes, because a
 * human signs up and reads an approval screen) and `codeExpiresAt` (5 minutes,
 * M8.1's acceptance, because redemption is machine-to-machine and an intercepted
 * code should be dead before anyone can use it).
 *
 * ## Nothing secret is readable here
 *
 * `state` and the authorization code are stored as SHA-256 hashes; `challenge`
 * is already a hash by construction (PKCE S256) and is stored as sent — hashing
 * it again would make verification impossible.
 *
 * A dump of this table therefore yields no usable CSRF token and no redeemable
 * code, which is the property that lets `state` travel through the browser
 * safely.
 */
@Entity('store_connection_codes')
// The lookup at `exchange`: a code is presented and must be found in one probe.
@Index('ix_store_connection_codes_code', ['codeHash'], { unique: true })
// The lookup at `authorize`: by primary key, so no index beyond it is needed.
@Index('ix_store_connection_codes_tenant', ['tenantId'])
export class StoreConnectionCode extends BaseEntity {
  /**
   * The site that started the handshake.
   *
   * Recorded before any tenant exists, because `initiate` is called by a plugin
   * holding no credential. `exchange` requires the presented `site_url` to equal
   * this exactly — one of M8.1's four bindings.
   */
  @Column({ type: 'varchar', length: 255 })
  siteUrl: string;

  /**
   * Where the approved code is delivered.
   *
   * Validated at `initiate` to share an origin with `siteUrl`: accepting an
   * arbitrary callback would let an attacker start a handshake for someone
   * else's shop and have the code delivered to a host they control.
   */
  @Column({ type: 'varchar', length: 500 })
  callback: string;

  /**
   * `SHA-256(state)`.
   *
   * The plaintext travels `authorize_url` → dashboard → callback and is never
   * persisted. `authorize` verifies the echoed value against this hash, so a
   * request approved with the wrong state is refused.
   */
  @Column({ type: 'char', length: 64 })
  stateHash: string;

  /**
   * The PKCE challenge, `base64url(SHA-256(verifier))`, stored as sent.
   *
   * **Not hashed again.** It is already a digest, and `exchange` verifies by
   * hashing the presented verifier and comparing — a second hash here would
   * compare two different things and never match.
   */
  @Column({ type: 'char', length: 43 })
  challenge: string;

  /** Telemetry: which plugin build started this handshake. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  pluginVersion: string | null;

  /**
   * `SHA-256(code)`, set when a merchant approves.
   *
   * Null until then — the code does not exist during the request phase, which is
   * what makes a single row honest about the two stages rather than pretending
   * both artefacts exist from the start.
   */
  @Column({ type: 'char', length: 64, nullable: true })
  codeHash: string | null;

  /**
   * The tenant that approved, known only at `authorize`.
   *
   * Nullable because a handshake begins before anyone has signed in: the plugin
   * calls `initiate` with no credential at all, and which workspace it will join
   * is exactly what the merchant decides on the approval screen.
   */
  @Column({ type: 'char', length: 36, nullable: true })
  tenantId: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant | null;

  /** The store created at `authorize`. Null for the same reason as `tenantId`. */
  @Column({ type: 'char', length: 36, nullable: true })
  storeId: string | null;

  @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'storeId' })
  store: Store | null;

  /** 30 minutes from `initiate`. A human is in the middle of this one. */
  @Column({ type: 'datetime', precision: 3 })
  requestExpiresAt: Date;

  /** When the merchant approved. Null while pending; set once, never reset. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  approvedAt: Date | null;

  /** 5 minutes from approval (M8.1). Null until a code exists. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  codeExpiresAt: Date | null;

  /**
   * When the code was redeemed.
   *
   * Single-use is enforced by a conditional write — `UPDATE … WHERE
   * redeemedAt IS NULL` — rather than a read followed by a write, because two
   * simultaneous redemptions of one code must not both succeed (ADR-029).
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  redeemedAt: Date | null;
}
